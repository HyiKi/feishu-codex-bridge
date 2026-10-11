import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  distribution: vi.fn(),
  latest: vi.fn(),
  install: vi.fn(),
}));

vi.mock('../src/service/distribution', () => ({ runtimeDistribution: mocks.distribution }));
vi.mock('../src/service/update', () => ({
  packageName: () => '@modelzen/feishu-codex-bridge',
  currentVersion: () => '0.7.0',
  latestVersion: mocks.latest,
  isNewer: (latest: string, current: string) => latest !== current,
  isDevSource: () => false,
  installLatest: mocks.install,
  daemonRunning: () => false,
  restartDaemon: vi.fn(),
}));

import { runUpdate } from '../src/cli/commands/update';

beforeEach(() => {
  mocks.distribution.mockResolvedValue({ kind: 'other' });
  mocks.latest.mockResolvedValue('0.7.0');
  mocks.install.mockResolvedValue({ ok: true });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubEnv('VONVON_BOT_DOWNLOAD_PAGE', '');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  process.exitCode = 0;
});

function output(): string {
  return vi.mocked(console.log).mock.calls.flat().join('\n');
}

function expectOneNotice(): void {
  expect(output().split('可在 Vonvon Bot 中导入已有 Bridge 配置').length - 1).toBe(1);
  expect(output()).not.toContain('Vonvon Bridge 桌面版 v');
}

it('prints one import notice after a normal no-update result', async () => {
  await runUpdate();
  expect(output()).toContain('已是最新版本');
  expectOneNotice();
});

it('prints one import notice after offline lookup without changing failure status', async () => {
  mocks.latest.mockResolvedValue(null);
  await runUpdate();
  expect(output()).toContain('查不到最新版本');
  expect(process.exitCode).toBe(1);
  expectOneNotice();
});

it('prints one import notice after a bundled return', async () => {
  mocks.distribution.mockResolvedValue({ kind: 'bundled' });
  await runUpdate();
  expect(mocks.latest).not.toHaveBeenCalled();
  expectOneNotice();
});

it('prints one import notice when update setup throws and preserves that error', async () => {
  mocks.distribution.mockRejectedValue(new Error('distribution failed'));
  await expect(runUpdate()).rejects.toThrow('distribution failed');
  expectOneNotice();
});
