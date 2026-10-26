import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VONVON_RECOMMENDATION } from '../src/core/vonvon-notice';
import { runRestart, runStart, runStatus, runStop } from '../src/cli/commands/daemon';
import { runRun } from '../src/cli/commands/run';

// 0.6.15 的命令入口：Vonvon Bot 的迁移标记在，start / restart / run（含 launchd 拉起的、
// supervisor 子进程）一律拒绝，而且发生在读 bot 配置、跑向导、拿单实例锁之前；stop / status
// 只给一行提示；没迁移时 macOS 上 start / status 多一行推荐，Windows、Linux 不变。
// 数据目录用 vi.mock 指到临时目录，绝不碰真实的 ~/.feishu-codex-bridge。

const h = vi.hoisted(() => ({
  marker: '/nonexistent-bridge-dir-for-test/vonvon-migration.json',
  notice: '/nonexistent-bridge-dir-for-test/vonvon-notice.json',
  label: 'ai.feishu-codex-bridge.bot',
  loadBots: vi.fn(),
  activeBots: vi.fn(),
  ensureOnboarded: vi.fn(),
  announceEventsWhenLive: vi.fn(),
  startBridge: vi.fn(),
  runSupervisor: vi.fn(),
  acquire: vi.fn(),
  uninstallLaunchd: vi.fn(),
  statusLaunchd: vi.fn(),
  mountWebConsole: vi.fn(),
  install: vi.fn(),
  uninstall: vi.fn(),
  restart: vi.fn(),
  status: vi.fn(),
  create: vi.fn(),
}));

vi.mock('../src/config/paths', () => ({
  useBotDir: vi.fn(),
  paths: {
    get vonvonMigrationFile() {
      return h.marker;
    },
    get vonvonNoticeFile() {
      return h.notice;
    },
  },
}));
vi.mock('../src/core/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() } }));
vi.mock('../src/config/bots', () => ({ loadBots: h.loadBots, activeBots: h.activeBots }));
vi.mock('../src/bot/onboarding', () => ({
  ensureOnboarded: h.ensureOnboarded,
  announceEventsWhenLive: h.announceEventsWhenLive,
}));
vi.mock('../src/bot/bridge', () => ({ startBridge: h.startBridge }));
vi.mock('../src/bot/supervisor', () => ({ runSupervisor: h.runSupervisor }));
vi.mock('../src/core/single-instance', () => ({
  acquireSingleInstanceLock: h.acquire,
  BridgeAlreadyRunningError: class extends Error {},
}));
vi.mock('../src/service/launchd', () => ({
  LAUNCHD_LABEL: h.label,
  uninstallLaunchd: h.uninstallLaunchd,
  statusLaunchd: h.statusLaunchd,
}));
vi.mock('../src/service/win-startup', () => ({ clearServicePid: vi.fn(), recordServicePid: vi.fn() }));
vi.mock('../src/service/adapter', () => ({
  getServiceAdapter: () => ({ install: h.install, uninstall: h.uninstall, restart: h.restart, status: h.status }),
}));
vi.mock('../src/web/discovery', () => ({ readWebConsole: () => undefined }));
vi.mock('../src/web/mount', () => ({ mountWebConsole: h.mountWebConsole }));
vi.mock('../src/admin/ops', () => ({ AdminWriteError: class extends Error {} }));
vi.mock('../src/admin/ipc', () => ({ createAdminIpcResponder: vi.fn() }));
vi.mock('../src/admin/service', () => ({ createAdminService: vi.fn(() => ({})) }));
vi.mock('../src/agent', () => ({ installBackendDep: vi.fn(), uninstallBackendDep: vi.fn() }));
vi.mock('../src/cli/commands/daemon-control', () => ({ spawnDaemonControl: vi.fn() }));

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const setPlatform = (value: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { ...realPlatform, value });
};

let dir: string;
let out: () => string;
let errOut: () => string;
const text = (spy: { mock: { calls: unknown[][] } }): string => spy.mock.calls.map((a) => a.join(' ')).join('\n');

/** 放一个迁移标记：内容由调用方定（坏的、空的都行）。 */
const migrate = (content = '{"version":1,"migratedAt":1,"bots":["cli_a"],"vonvonVersion":"0.7.0"}'): void => {
  writeFileSync(h.marker, content);
};

const bot = { name: 'a', appId: 'cli_a', tenant: 'feishu', active: true };
const ready = { cfg: { accounts: { app: { id: 'cli_a' } }, preferences: { access: { ownerOpenId: 'ou_owner' } } }, secret: 's' };

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'vonvon-gate-'));
  h.marker = join(dir, 'vonvon-migration.json');
  h.notice = join(dir, 'bots', 'cli_a', 'vonvon-notice.json');
  mkdirSync(join(dir, 'bots', 'cli_a'), { recursive: true });
  h.loadBots.mockResolvedValue({ bots: [bot] });
  h.activeBots.mockReturnValue([bot]);
  h.ensureOnboarded.mockResolvedValue(ready);
  h.startBridge.mockResolvedValue({
    channel: { rawClient: { im: { v1: { message: { create: h.create } } } } },
    adminExecute: vi.fn(),
    shutdown: vi.fn(),
  });
  h.create.mockResolvedValue({ code: 0 });
  h.mountWebConsole.mockResolvedValue(undefined);
  h.acquire.mockReturnValue(() => {});
  h.install.mockResolvedValue({ platformName: 'launchd (macOS)', installed: true, running: true });
  h.uninstall.mockResolvedValue(undefined);
  h.restart.mockResolvedValue({ platformName: 'launchd (macOS)', installed: true, running: true });
  h.status.mockResolvedValue({
    platformName: 'launchd (macOS)',
    servicePath: '/p/x.plist',
    installed: true,
    running: true,
    stdoutPath: '/p/out',
    stderrPath: '/p/err',
    pid: '123',
  });
  h.uninstallLaunchd.mockResolvedValue(undefined);
  h.statusLaunchd.mockReturnValue({ pid: undefined });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  out = () => text(log);
  errOut = () => text(err);
  delete process.env.XPC_SERVICE_NAME;
  process.exitCode = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, 'platform', realPlatform);
  delete process.env.XPC_SERVICE_NAME;
  process.exitCode = 0;
  rmSync(dir, { recursive: true, force: true });
});

/** run 被拒时，这些「启动」动作一个都不能发生。 */
function expectNothingStarted(): void {
  expect(h.loadBots).not.toHaveBeenCalled();
  expect(h.activeBots).not.toHaveBeenCalled();
  expect(h.ensureOnboarded).not.toHaveBeenCalled();
  expect(h.acquire).not.toHaveBeenCalled();
  expect(h.startBridge).not.toHaveBeenCalled();
  expect(h.runSupervisor).not.toHaveBeenCalled();
  expect(h.mountWebConsole).not.toHaveBeenCalled();
  expect(h.create).not.toHaveBeenCalled();
}

describe('run：看到迁移标记就拒绝启动（先于向导、bot 配置、单实例锁）', () => {
  it.each([
    ['Vonvon Bot 写的标记', undefined],
    ['内容损坏的标记', '{half-written'],
    ['空标记', ''],
  ])('%s', async (_name, content) => {
    migrate(content);
    await runRun();
    expectNothingStarted();
    expect(process.exitCode).toBe(1);
    expect(errOut()).toContain('已经迁到 Vonvon Bot');
    expect(errOut()).toContain(h.marker); // 写出标记文件路径
  });

  it('标记是个目录（读不了）也拒绝', async () => {
    mkdirSync(h.marker);
    await runRun();
    expectNothingStarted();
    expect(process.exitCode).toBe(1);
  });

  it('supervisor 拉起的子进程（run --bot）同样拒绝', async () => {
    migrate();
    await runRun('cli_a');
    expectNothingStarted();
    expect(process.exitCode).toBe(1);
  });

  it('终端里手动 run 被拒：不碰 launchd 服务', async () => {
    setPlatform('darwin');
    migrate();
    await runRun();
    expect(h.uninstallLaunchd).not.toHaveBeenCalled();
    expect(errOut()).not.toContain('后台服务已一并卸载');
  });
});

describe('run：launchd 拉起时被拒，要把服务卸掉（plist 的 KeepAlive=true，只退出会被反复拉起刷屏）', () => {
  it('XPC_SERVICE_NAME 等于服务标签 → 先打印说明、再 uninstallLaunchd（它会把本进程一起带走）', async () => {
    setPlatform('darwin');
    process.env.XPC_SERVICE_NAME = h.label;
    migrate();
    await runRun();
    expect(h.uninstallLaunchd).toHaveBeenCalledTimes(1);
    expect(errOut()).toContain('后台服务已一并卸载');
    expect(errOut()).toContain('feishu-codex-bridge start');
    expectNothingStarted();
    expect(process.exitCode).toBe(1);
    // 说明必须先于卸载打印：bootout 之后进程就没了。
    const printed = vi.mocked(console.error).mock.invocationCallOrder.at(-1)!;
    expect(printed).toBeLessThan(h.uninstallLaunchd.mock.invocationCallOrder[0]!);
  });

  it('变量没带上时，用 launchctl 查服务的 pid 是不是自己', async () => {
    setPlatform('darwin');
    h.statusLaunchd.mockReturnValue({ pid: String(process.pid) });
    migrate();
    await runRun();
    expect(h.uninstallLaunchd).toHaveBeenCalledTimes(1);
  });

  it('launchctl 的 pid 是别的进程（比如另一个服务实例）→ 不卸载', async () => {
    setPlatform('darwin');
    h.statusLaunchd.mockReturnValue({ pid: String(process.pid + 1) });
    migrate();
    await runRun();
    expect(h.uninstallLaunchd).not.toHaveBeenCalled();
  });

  it('非 macOS 即使带着这个变量也不碰 launchd', async () => {
    setPlatform('linux');
    process.env.XPC_SERVICE_NAME = h.label;
    migrate();
    await runRun();
    expect(h.uninstallLaunchd).not.toHaveBeenCalled();
    expect(h.statusLaunchd).not.toHaveBeenCalled();
  });

  it('卸载失败：不抛出，仍然拒绝（退出码 1）', async () => {
    setPlatform('darwin');
    process.env.XPC_SERVICE_NAME = h.label;
    h.uninstallLaunchd.mockRejectedValue(new Error('bootout failed'));
    migrate();
    await expect(runRun()).resolves.toBeUndefined();
    expect(process.exitCode).toBe(1);
  });
});

describe('start / restart：看到标记就拒绝，什么都不装', () => {
  it('start 被拒：不读 bot、不进向导、不装服务', async () => {
    migrate('not json');
    await runStart();
    expect(process.exitCode).toBe(1);
    expect(h.install).not.toHaveBeenCalled();
    expect(h.loadBots).not.toHaveBeenCalled();
    expect(h.ensureOnboarded).not.toHaveBeenCalled();
    expect(errOut()).toContain('请在 Vonvon Bot 里使用');
    expect(errOut()).toContain(h.marker);
    expect(out()).not.toContain(VONVON_RECOMMENDATION);
  });

  it('restart 被拒：不 kickstart 服务', async () => {
    migrate();
    await runRestart();
    expect(process.exitCode).toBe(1);
    expect(h.restart).not.toHaveBeenCalled();
  });
});

describe('stop / status：标记在时给一行提示', () => {
  it('stop 照常停服务，再提示一行', async () => {
    migrate();
    await runStop();
    expect(h.uninstall).toHaveBeenCalledTimes(1);
    expect(out()).toContain('后台服务已停止');
    expect(out()).toContain('已经迁到 Vonvon Bot');
    expect(out()).toContain(h.marker);
    expect(process.exitCode).toBe(0);
  });

  it('stop 没有标记：不提示', async () => {
    await runStop();
    expect(out()).not.toContain('Vonvon Bot');
  });

  it('status 有标记：提示迁移，不再推荐（即使在 macOS）', async () => {
    setPlatform('darwin');
    migrate();
    await runStatus();
    expect(out()).toContain('已经迁到 Vonvon Bot');
    expect(out()).not.toContain(VONVON_RECOMMENDATION);
    expect(process.exitCode).toBe(0);
  });
});

describe('没迁移：只有 macOS 的 start / status 多一行推荐，Windows、Linux 和 0.6.14 一样', () => {
  it('macOS：start 输出推荐', async () => {
    setPlatform('darwin');
    await runStart();
    expect(h.install).toHaveBeenCalledTimes(1);
    expect(out()).toContain(VONVON_RECOMMENDATION);
  });

  it('macOS：status 输出推荐', async () => {
    setPlatform('darwin');
    await runStatus();
    expect(out()).toContain(VONVON_RECOMMENDATION);
  });

  it.each(['linux', 'win32'] as const)('%s：start 和 status 都不提 Vonvon Bot', async (platform) => {
    setPlatform(platform);
    await runStart();
    await runStatus();
    await runStop();
    expect(h.install).toHaveBeenCalledTimes(1);
    expect(out() + errOut()).not.toContain('Vonvon');
    expect(process.exitCode).toBe(0);
  });

  it('macOS 的 stop 不加推荐（只在 start / status 加）', async () => {
    setPlatform('darwin');
    await runStop();
    expect(out()).not.toContain(VONVON_RECOMMENDATION);
  });
});

describe('run 启动成功后：macOS 给主人发一次私聊，失败不影响启动', () => {
  // vitest 的 worker 是带 IPC 的子进程（process.send 有值），run 会把它当成 supervisor 子进程；
  // 这里要走独立 daemon 的分支。
  const realSend = process.send;
  beforeEach(() => {
    (process as { send?: unknown }).send = undefined;
  });
  afterEach(() => {
    (process as { send?: unknown }).send = realSend;
  });

  /** runSingle 最后会永远挂着等连接；这里只等到它走过启动那一段。 */
  async function startRun(): Promise<void> {
    vi.spyOn(process, 'once').mockImplementation(() => process); // 不注册真实的信号处理
    void runRun();
    await vi.waitFor(() => expect(h.mountWebConsole).toHaveBeenCalled());
  }

  it('macOS：启动后给主人私聊一次，并记下', async () => {
    setPlatform('darwin');
    await startRun();
    await vi.waitFor(() => expect(h.create).toHaveBeenCalledTimes(1));
    const call = h.create.mock.calls[0]![0] as { params: { receive_id_type: string }; data: { receive_id: string } };
    expect(call.params.receive_id_type).toBe('open_id');
    expect(call.data.receive_id).toBe('ou_owner');
    expect(h.acquire).toHaveBeenCalledTimes(1);
  });

  it('macOS：第二次启动（记录已在）不再发', async () => {
    setPlatform('darwin');
    writeFileSync(h.notice, '{"version":1}');
    await startRun();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.create).not.toHaveBeenCalled();
  });

  it('macOS：私聊发失败，bot 照常启动完成', async () => {
    setPlatform('darwin');
    h.create.mockRejectedValue(new Error('send failed'));
    await startRun(); // waitFor 到 mountWebConsole 说明启动流程走完了
    await vi.waitFor(() => expect(h.create).toHaveBeenCalled());
    expect(h.startBridge).toHaveBeenCalledTimes(1);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('Linux：启动正常，不发私聊', async () => {
    setPlatform('linux');
    await startRun();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.create).not.toHaveBeenCalled();
  });
});
