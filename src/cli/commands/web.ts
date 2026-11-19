import { createReadonlyAdminService, NotWiredYetError } from '../../admin/service';
import { checkVonvonMigration, migratedNote, printMigratedNote } from '../../core/vonvon-migration';
import { readWebConsole, stableWebConsoleToken } from '../../web/discovery';
import { createWebServer } from '../../web/server';
import { openUrl } from '../../utils/open-url';
import { spawnDaemonControl } from './daemon-control';

/**
 * 只读预览里「启动」按钮的执行器。bot 已经迁到 Vonvon Bot（或者看不清迁没迁）时和 `start`
 * 一样不启动：detached helper 那头也会拒，但那是事后的、用户看不到，所以这里先抛
 * {@link NotWiredYetError}（HTTP 501），前端把原因显示成提示，而不是「启动已发起」。
 * `opts` 仅测试注入。
 */
export function startDaemonFromPreview(
  opts: { file?: string; platform?: NodeJS.Platform; spawn?: () => void } = {},
): void {
  const state = checkVonvonMigration(opts.file, opts.platform);
  if (state.kind !== 'clear') throw new NotWiredYetError('▶️ 启动 daemon', migratedNote(state));
  (opts.spawn ?? (() => spawnDaemonControl('start')))();
}

/**
 * `feishu-codex-bridge web [--port]` —— 本机 Web 控制台。
 *
 * daemon（run/start）在跑时，控制台已内嵌在 daemon 进程里（写操作可用、连接
 * 状态实时）：检测发现文件（~/.feishu-codex-bridge/web-console.json，daemon
 * 写入、退出清理、pid 活性校验）命中就直接打开 daemon 的控制台 URL——绝不再
 * 起一个只读副本跟 daemon 抢心智。
 *
 * daemon 没跑时退化为只读预览：直读 ~/.feishu-codex-bridge 下的
 * bots/projects/sessions 文件渲染快照（运行状态靠单实例锁文件探测），写操作
 * 一律 501 引导先起 daemon。仅绑定 127.0.0.1 + 随机 token。
 */
export async function runWeb(opts: { port?: number } = {}): Promise<void> {
  // ── daemon 控制台已在 → 直接打开，不再起副本 ───────────────────────────
  const live = readWebConsole();
  if (live) {
    const url = `http://127.0.0.1:${live.port}/?token=${live.token}`;
    console.log(`🌐 检测到 daemon 的 Web 控制台已在运行（PID ${live.pid}，写操作可用），直接打开：`);
    console.log(`\n   ${url}\n`);
    if (openUrl(url)) console.log('   已尝试在浏览器打开；没弹出就手动复制上面链接。');
    console.log('   · 仅本机可访问（127.0.0.1）；URL 含 token，请勿外传/截图。');
    return;
  }

  // bot 已经迁到 Vonvon Bot：预览仍可看，但「启动」不会拉起 bridge，先说清楚。
  printMigratedNote();

  // 预览默认用**临时端口**（port=0），绝不抢规范端口 51847——那是 daemon 控制台的权威
  // 端口（见 web/mount.ts）。这样「点启动 → daemon 起来占 51847 → 前端自动跳到 51847」，
  // 之后重启都稳定在 51847，不再换来换去。用户可 --port 显式指定。
  const port = opts.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`✗ 无效端口：${opts.port}`);
    process.exitCode = 1;
    return;
  }

  // 只读预览唯一放行的宿主级动作：「启动 daemon」。detached helper 装好后台服务并
  // 拉起（与本预览进程脱钩）。预览不占 51847，daemon 起来即可拿到 51847；注入 liveConsole
  // （readWebConsole）后前端检测到 daemon 已起就自动把页面带去那条可写控制台（见
  // server.ts /api/console/live）。token 用稳定 token——切过去后那条 URL 长期有效不 401。
  // 没启动只读，但放行两个宿主级动作：启动 + 更新（升级 npm 包；没 daemon 在跑时
  // doUpdate 装最新版即可，重启那步是 no-op）。其余写仍 501。
  const service = createReadonlyAdminService({
    startDaemon: () => startDaemonFromPreview(),
    applyUpdate: () => spawnDaemonControl('update'),
  });
  const web = createWebServer({ service, token: stableWebConsoleToken(), liveConsole: () => readWebConsole() });

  let url: string;
  try {
    ({ url } = await web.listen(port));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      console.error(`✗ 端口 ${port} 已被占用，换一个试试：feishu-codex-bridge web --port ${port + 1}`);
    } else {
      console.error(`✗ Web 控制台启动失败：${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('🌐 Web 控制台（只读预览）已启动，浏览器打开：');
  console.log(`\n   ${url}\n`);
  if (openUrl(url)) console.log('   已尝试在浏览器打开；没弹出就手动复制上面链接。');
  console.log('   · 仅本机可访问（127.0.0.1）；URL 含一次性 token，请勿外传/截图。');
  console.log('   · daemon 未在跑：当前为只读预览（直读本机文件）。先 `run`/`start` 再开 `web` 可用写操作。');
  console.log('   · Ctrl+C 退出。');

  const shutdown = (): void => {
    void web.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
