import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReadonlyAdminService, NotWiredYetError } from '../src/admin/service';
import { startDaemonFromPreview } from '../src/cli/commands/web';
import { createWebServer } from '../src/web/server';

// Web 只读预览里点「启动」：bot 已经迁到 Vonvon Bot 时，bridge 不会再启动，页面要如实告诉用户，
// 不能提示「启动已发起」然后一直等下去。数据目录指到临时目录，绝不碰真实的 ~/.feishu-codex-bridge。

const TOKEN = 'preview-test-token';

let dir: string;
let marker: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vonvon-preview-'));
  marker = join(dir, 'vonvon-migration.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('startDaemonFromPreview', () => {
  it('没有标记：照常拉起 helper', () => {
    const spawn = vi.fn();
    startDaemonFromPreview({ file: marker, platform: 'darwin', spawn });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('有标记：不拉起，抛 NotWiredYetError，文案是迁移提示（带标记路径）而不是「需要 daemon 在跑」', () => {
    writeFileSync(marker, '{"version":1}');
    const spawn = vi.fn();
    let caught: unknown;
    try {
      startDaemonFromPreview({ file: marker, platform: 'darwin', spawn });
    } catch (err) {
      caught = err;
    }
    expect(spawn).not.toHaveBeenCalled();
    expect(caught).toBeInstanceOf(NotWiredYetError);
    const message = (caught as Error).message;
    expect(message).toContain('已经迁到 Vonvon Bot');
    expect(message).toContain(marker);
    expect(message).not.toContain('需要 daemon 在跑');
  });

  it.each(['linux', 'win32'] as const)('%s：有标记也照常拉起（Vonvon Bot 只有 Mac 版）', (platform) => {
    writeFileSync(marker, '{"version":1}');
    const spawn = vi.fn();
    startDaemonFromPreview({ file: marker, platform, spawn });
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('预览页的「启动」按钮（POST /api/daemon/start）', () => {
  async function post(file: string, spawn: () => void): Promise<{ status: number; body: { message?: string; error?: string } }> {
    const service = createReadonlyAdminService({
      startDaemon: () => startDaemonFromPreview({ file, platform: 'darwin', spawn }),
    });
    const web = createWebServer({ service, token: TOKEN, logDir: dir });
    const { port } = await web.listen(0); // 临时端口，起了就关
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/daemon/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      return { status: res.status, body: (await res.json()) as { message?: string; error?: string } };
    } finally {
      await web.close();
    }
  }

  it('已迁移：501 + 迁移提示，不是 202「启动已发起」', async () => {
    writeFileSync(marker, '{"version":1}');
    const spawn = vi.fn();
    const { status, body } = await post(marker, spawn);
    expect(status).toBe(501);
    expect(body.error).toBe('not_wired_yet');
    expect(body.message).toContain('已经迁到 Vonvon Bot');
    expect(body.message).not.toContain('启动已发起');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('没迁移：202，helper 被拉起一次', async () => {
    const spawn = vi.fn();
    const { status, body } = await post(marker, spawn);
    expect(status).toBe(202);
    expect(body.message).toContain('启动已发起');
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
