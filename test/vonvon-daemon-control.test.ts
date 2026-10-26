import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDaemonControl } from '../src/cli/commands/daemon-control';

// Web 只读预览的「启动」按钮经 `__daemon-control start` 装后台服务。迁移标记在时它和 `start`
// 一样拒绝，不装服务；没标记照常装。数据目录指到临时目录，绝不碰真实的 ~/.feishu-codex-bridge。

const h = vi.hoisted(() => ({
  marker: '/nonexistent-bridge-dir-for-test/vonvon-migration.json',
  install: vi.fn(),
}));

vi.mock('../src/config/paths', () => ({
  paths: {
    get vonvonMigrationFile() {
      return h.marker;
    },
  },
}));
vi.mock('../src/core/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() } }));
vi.mock('../src/service/adapter', () => ({
  getServiceAdapter: () => ({ install: h.install }),
  isServiceRunning: vi.fn(),
}));

let dir: string;
beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'vonvon-dc-'));
  h.marker = join(dir, 'vonvon-migration.json');
  h.install.mockResolvedValue({ installed: true, running: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('__daemon-control start', () => {
  it('没有迁移标记：照常装服务', async () => {
    await runDaemonControl('start');
    expect(h.install).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Vonvon Bot 写的标记', '{"version":1,"migratedAt":1,"bots":["cli_a"],"vonvonVersion":"0.7.0"}'],
    ['内容损坏的标记', '{half-written'],
  ])('%s：不装服务', async (_name, content) => {
    writeFileSync(h.marker, content);
    await runDaemonControl('start');
    expect(h.install).not.toHaveBeenCalled();
  });
});
