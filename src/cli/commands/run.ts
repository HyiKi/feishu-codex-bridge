import { ensureOnboarded, announceEventsWhenLive } from '../../bot/onboarding';
import { startBridge } from '../../bot/bridge';
import { runSupervisor } from '../../bot/supervisor';
import { acquireSingleInstanceLock, BridgeAlreadyRunningError } from '../../core/single-instance';
import { refuseIfMigrated } from '../../core/vonvon-migration';
import { sendVonvonNoticeOnce } from '../../core/vonvon-notice';
import { LAUNCHD_LABEL, statusLaunchd, uninstallLaunchd } from '../../service/launchd';
import { clearServicePid, recordServicePid } from '../../service/win-startup';
import { activeBots, loadBots } from '../../config/bots';
import { log } from '../../core/logger';
import { AdminWriteError } from '../../admin/ops';
import { createAdminIpcResponder } from '../../admin/ipc';
import { createAdminService } from '../../admin/service';
import { installBackendDep, uninstallBackendDep } from '../../agent';
import { spawnDaemonControl } from './daemon-control';
import { mountWebConsole, type MountedWebConsole } from '../../web/mount';

/**
 * `run` — foreground long-connection bot(s).
 *
 * Dispatch:
 *   - `run --bot <name>` (explicit selector) → run that ONE bot inline.
 *   - `run` with a single active bot (or a legacy single-bot install) → run it
 *     inline, exactly as before. This keeps the proven npx single-process path.
 *   - `run` with multiple active bots (`bot use` picked a set) → hand off to the
 *     multi-process supervisor, one child process per bot.
 *
 * Inline runs onboard first (scan-QR if no bot is configured yet — "init if not
 * initialized"), take the per-bot single-instance lock, then bring up the
 * bridge. SIGINT/SIGTERM trigger a graceful teardown that closes every codex
 * session (no orphan app-servers) and drops the WS before exiting.
 *
 * 入口先看 Vonvon Bot 的迁移标记（早于向导、bot 配置和单实例锁）：bot 已经迁走就
 * 拒绝启动。监督子进程（`run --bot`）和 launchd 拉起的 `run` 同样走这里。
 */
export async function runRun(botName?: string): Promise<void> {
  if (refuseIfMigrated('run')) {
    await unloadLaunchdJobAfterRefusal();
    return;
  }

  // Explicit selector always runs exactly that one bot inline (this is also how
  // the supervisor launches each child: `run --bot <appId>`).
  if (botName) {
    await runSingle(botName);
    return;
  }

  // No selector: bring up the active set. 0/1 → inline (preserve the simple
  // single-process path, incl. first-run onboarding); ≥2 → supervisor.
  const active = activeBots(await loadBots());
  // 零 bot + 非交互（典型：用户把一句话发给 codex/claude，它非交互地 run，没 TTY 没法
  // 终端扫码）→ 起「引导控制台」：不连任何 bot，只挂可写 Web 控制台让用户在浏览器里扫码
  // 创建第一个机器人（registerBotByQr 自给自足，不需要在跑的 bot）。TTY 仍走终端扫码向导。
  if (active.length === 0 && !process.stdout.isTTY) {
    await runOnboardingConsole();
    return;
  }
  if (active.length > 1) {
    await runSupervisor(active);
    return;
  }
  await runSingle(active[0]?.name);
}

/**
 * 本进程是不是 launchd 服务拉起的：launchd 给它起的进程设了 `XPC_SERVICE_NAME`（等于
 * 服务标签）；万一这个变量没带上，再问 launchd 这个服务的 pid 是不是自己。在终端里手动
 * `run` 两条都不成立。
 */
function isLaunchdJob(): boolean {
  if (process.platform !== 'darwin') return false;
  if (process.env.XPC_SERVICE_NAME === LAUNCHD_LABEL) return true;
  try {
    return statusLaunchd().pid === String(process.pid);
  } catch {
    return false;
  }
}

/**
 * 被 launchd 拉起的 `run` 因为迁移标记拒绝启动后，把 launchd 服务一并卸掉。plist 里
 * `KeepAlive` 是 true：只退出的话 launchd 每隔十几秒就拉起一次、被拒一次，日志被刷屏。
 * 做法和 `stop` 一样（`uninstallLaunchd`：删 plist、bootout 卸载），所以重新登录后也不会
 * 再自启；要回到 bridge 的人删掉标记后重新 `start` 即可。在终端里手动 `run` 被拒时不碰
 * 任何服务。bootout 会把本进程一起带走，所以提示必须先打印、卸载放最后。
 */
async function unloadLaunchdJobAfterRefusal(): Promise<void> {
  if (!isLaunchdJob()) return;
  console.error('  bridge 的后台服务已一并卸载，不会再被反复拉起；删掉标记后重新运行 `feishu-codex-bridge start` 即可恢复。');
  log.info('run', 'migrated-unload-launchd');
  try {
    await uninstallLaunchd();
  } catch (err) {
    log.fail('run', err, { phase: 'migrated-unload-launchd' });
  }
}

/**
 * 零 bot 引导守护：还没有任何机器人时，不报错退出，而是只起一个**可写**的 Web 控制台，
 * 用户在浏览器里扫码创建第一个机器人即可（registerBotByQr 不依赖任何在跑的 bot）。创建后
 * 重启 daemon（空注册表→首 bot 自动成为 current/active）该 bot 即上线。这是「一句话安装」
 * 落地体验的关键：codex/claude 非交互地起好它 + 打印网址，用户全程在浏览器里点完。
 */
async function runOnboardingConsole(): Promise<void> {
  let releaseLock: () => void;
  try {
    releaseLock = acquireSingleInstanceLock('__onboarding__');
  } catch (err) {
    if (err instanceof BridgeAlreadyRunningError) {
      // If we were spawned by startNow (Windows service), it eagerly wrote our
      // pid to service.pid before we lost the lock — drop it so it doesn't stick
      // as a dead pid (clearServicePid only unlinks if it still points at us).
      clearServicePid();
      console.error(`✗ ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  recordServicePid();
  const startedAt = Date.now();
  const webConsole = await mountWebConsole(
    createAdminService({
      daemonStartedAt: startedAt,
      // 引导态没有 bot → 不注入 executeWrite/liveStatus；但全局能力齐备：扫码建 bot
      // （registerBotByQr 自给自足）、按需下载后端、重启/升级。
      restartDaemon: () => spawnDaemonControl('restart'),
      applyUpdate: () => spawnDaemonControl('update'),
      stopDaemon: () => spawnDaemonControl('stop'),
      installBackend: installBackendDep,
      uninstallBackend: uninstallBackendDep,
    }),
  );
  if (!webConsole) {
    console.error('✗ Web 控制台未能启动，无法进入引导（端口被占用？）。');
    releaseLock();
    process.exitCode = 1;
    return;
  }
  console.log('\n还没有配置任何飞书机器人 —— 已进入「引导控制台」，到浏览器里扫码创建第一个：');
  if (process.stdout.isTTY) {
    console.log(`\n🌐 ${webConsole.url}`);
    console.log('   仅本机可访问（127.0.0.1）；URL 含 token 勿外传。\n');
  } else {
    console.log(
      `\n🌐 Web 控制台已启动（127.0.0.1:${webConsole.port}）。运行 ` +
        '`feishu-codex-bridge web` 获取带 token 的登录链接，在浏览器里扫码创建机器人；建完重启即上线。\n',
    );
  }
  log.info('run', 'onboarding-console-up', { port: webConsole.port });

  let stopping = false;
  const stop = (sig: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    console.log(`\n收到 ${sig}，正在退出引导控制台…`);
    void (webConsole.close() ?? Promise.resolve())
      .catch(() => undefined)
      .finally(() => {
        releaseLock();
        process.exit(0);
      });
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => stop(sig));
  }
  await new Promise<never>(() => {});
}

/** Run a single bot inline in this process. `botName` undefined → the implicit
 *  current/default bot (with first-run onboarding allowed). */
async function runSingle(botName?: string): Promise<void> {
  const ready = await ensureOnboarded({ allowCreate: !botName, bot: botName });
  if (!ready) {
    process.exitCode = 1;
    return;
  }
  const { cfg, secret } = ready;

  // Refuse to run alongside another bridge for the same app — two long
  // connections split card callbacks and make buttons flaky (see module doc).
  let releaseLock: () => void;
  try {
    releaseLock = acquireSingleInstanceLock(cfg.accounts.app.id);
  } catch (err) {
    if (err instanceof BridgeAlreadyRunningError) {
      // startNow (Windows service) eagerly wrote our pid to service.pid before we
      // lost the lock — drop it so it doesn't linger as a dead pid (no-op unless
      // service.pid still points at us; the live winner keeps its own).
      clearServicePid();
      console.error(`✗ ${err.message}`);
      log.info('run', 'already-running', { pid: err.pid });
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  // If launched as the Windows background service, publish our PID so
  // `status`/`stop` can find us (no-op for a foreground run / other platforms /
  // a supervised child, whose service env flag the supervisor strips).
  recordServicePid();

  const fallbackCwd = process.env.FEISHU_CODEX_CWD || process.cwd();
  console.log('\n正在启动长连接 bot…');
  console.log('私聊我 `/new <名>` 建项目；在项目群里 @我 干活。Ctrl+C 退出。\n');
  const handle = await startBridge({ cfg, appSecret: secret, fallbackCwd });
  // 配置长连接需要 bridge 在线，启动后继续检查用户发布的订阅更新。
  void announceEventsWhenLive(ready);
  // macOS 上第一次成功启动时，给主人私聊一次 Vonvon Bot 推荐。不等它、不会抛，失败只记日志。
  void sendVonvonNoticeOnce({ cfg, channel: handle.channel });

  // ── Web 控制台 / supervisor IPC（按进程形态二选一）────────────────────────
  let webConsole: MountedWebConsole | undefined;
  if (process.send) {
    // supervisor 子进程（'ipc' stdio）：控制台由 supervisor 聚合挂载，本进程只
    // 接写请求——在进程内执行（registry withLock + 共享校验 + 驱逐 LIVE 会话，
    // 这正是写操作必须 IPC 转发、不能 supervisor 文件直写的原因）。status 请求
    // 回报真实 WS 连接状态，替代锁文件探测。
    const respond = createAdminIpcResponder(
      async (op) => {
        if (op.kind === 'status') {
          return { connection: handle.channel.getConnectionStatus?.()?.state ?? 'unknown' };
        }
        await handle.adminExecute(op);
        return { done: true };
      },
      (msg) => void process.send?.(msg),
    );
    process.on('message', respond);
  } else {
    // 独立 daemon（单 bot inline）：进程内挂全局控制台。本 bot 的写/实时状态走
    // 进程内 orchestrator；其他已注册 bot 仍可只读快照（写需该 bot 进程在跑——
    // 多 bot 写请用 `bot use` 选多个后由 supervisor 聚合）。
    const ownAppId = cfg.accounts.app.id;
    const startedAt = Date.now();
    webConsole = await mountWebConsole(
      createAdminService({
        executeWrite: async (botId, op) => {
          if (botId !== ownAppId) {
            throw new AdminWriteError(
              '该机器人不归本进程管：当前是单 bot 运行模式，只能改本 bot 的项目。多 bot 请 `bot use` 勾选后重启，由 supervisor 聚合管理。',
            );
          }
          await handle.adminExecute(op);
        },
        liveStatus: async (botId) =>
          botId === ownAppId
            ? {
                running: true,
                pid: process.pid,
                startedAt,
                connection: handle.channel.getConnectionStatus?.()?.state ?? 'unknown',
              }
            : undefined,
        daemonStartedAt: startedAt,
        // 重启 / 升级 / 停止走 detached helper：本进程被 service stop 杀掉后由 helper 续命。
        restartDaemon: () => spawnDaemonControl('restart'),
        applyUpdate: () => spawnDaemonControl('update'),
        stopDaemon: () => spawnDaemonControl('stop'),
        // 按需后端安装在 daemon 进程内直跑（owns runtime，装完即能解析加载）。
        installBackend: installBackendDep,
        uninstallBackend: uninstallBackendDep,
      }),
    );
    if (webConsole) {
      if (process.stdout.isTTY) {
        // 含 token 的 URL 只在前台 TTY 打印；后台 daemon 的 stdout 会被 launchd/
        // systemd 重定向落盘——token 绝不进日志，后台改用 `web` 命令经 0600 发现
        // 文件跳转。
        console.log(`🌐 Web 控制台：${webConsole.url}`);
        console.log('   仅本机可访问（127.0.0.1）；URL 含 token 勿外传。也可随时 `feishu-codex-bridge web` 重新打开。\n');
      } else {
        console.log(`🌐 Web 控制台已内嵌启动（127.0.0.1:${webConsole.port}）：运行 \`feishu-codex-bridge web\` 获取登录链接。`);
      }
    }
  }

  let stopping = false;
  const stop = (sig: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    console.log(`\n收到 ${sig}，正在优雅退出（关闭所有 codex 会话）…`);
    void (webConsole?.close() ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => handle.shutdown())
      .catch((err) => log.fail('run', err, { phase: 'shutdown' }))
      .finally(() => {
        releaseLock();
        process.exit(0);
      });
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => stop(sig));
  }

  // keep the process alive; the WS connection drives everything.
  await new Promise<never>(() => {});
}
