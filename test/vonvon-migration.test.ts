import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkVonvonMigration,
  migratedNote,
  migratedRefusal,
  printMigratedNote,
  refuseIfMigrated,
} from '../src/core/vonvon-migration';

// Vonvon Bot 导入完成后在 bridge 数据目录写 vonvon-migration.json。bridge 只认「文件在不在」，
// 不解析内容：读不了、格式坏了、不是普通文件都当作已迁移（宁可错拒，不在 Vonvon Bot 占着 bot 时放行）。
// 连在不在都看不清（数据目录没有搜索权限）是第三种：照样拒绝，但提示换成「读不了目录」。
// Vonvon Bot 只有 Mac 版，只在 darwin 上查；Windows、Linux 一律当没迁移，和 0.6.14 一样。

const D = 'darwin';
const migrated = (file: string) => ({ kind: 'migrated' as const, marker: file });

let dir: string;
let marker: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vonvon-marker-'));
  marker = join(dir, 'vonvon-migration.json');
});
afterEach(() => {
  process.exitCode = 0;
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('checkVonvonMigration', () => {
  it('没有标记 → 没迁移', () => {
    expect(checkVonvonMigration(marker, D)).toEqual({ kind: 'clear' });
  });

  it('数据目录本身不存在 → 没迁移（新装的用户）', () => {
    expect(checkVonvonMigration(join(dir, 'no-such-dir', 'vonvon-migration.json'), D)).toEqual({ kind: 'clear' });
  });

  it('数据目录路径上是个普通文件（ENOTDIR）→ 没迁移', () => {
    writeFileSync(join(dir, 'not-a-dir'), '');
    expect(checkVonvonMigration(join(dir, 'not-a-dir', 'vonvon-migration.json'), D)).toEqual({ kind: 'clear' });
  });

  it('Vonvon Bot 写的标记 → 已迁移', () => {
    writeFileSync(
      marker,
      JSON.stringify({ version: 1, migratedAt: 1_780_000_000_000, bots: ['cli_a'], vonvonVersion: '0.7.0' }),
    );
    expect(checkVonvonMigration(marker, D)).toEqual(migrated(marker));
  });

  it.each([
    ['不是 JSON', '{half-written'],
    ['空文件', ''],
    ['JSON 但不是对象', '"migrated"'],
    ['缺字段的对象', '{}'],
    ['未来版本的格式', JSON.stringify({ version: 99, whatever: true })],
  ])('格式坏了（%s）→ 照样当作已迁移', (_name, content) => {
    writeFileSync(marker, content);
    expect(checkVonvonMigration(marker, D)).toEqual(migrated(marker));
  });

  it('权限 000、读不了内容的标记 → 已迁移（lstat 成功）', () => {
    writeFileSync(marker, '{}');
    chmodSync(marker, 0o000);
    expect(checkVonvonMigration(marker, D)).toEqual(migrated(marker));
  });

  it('标记是个目录 → 已迁移', () => {
    mkdirSync(marker);
    expect(checkVonvonMigration(marker, D)).toEqual(migrated(marker));
  });

  it.skipIf(process.platform === 'win32')('悬空的符号链接也算存在 → 已迁移', () => {
    symlinkSync(join(dir, 'gone'), marker);
    expect(checkVonvonMigration(marker, D)).toEqual(migrated(marker));
  });

  // root 不受目录权限限制，Windows 没有 POSIX 权限位。
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    '数据目录没有搜索权限、说不准标记在不在 → unreadable（fail-closed），带错误码',
    () => {
      const data = join(dir, 'data');
      mkdirSync(data);
      const file = join(data, 'vonvon-migration.json');
      chmodSync(data, 0o000);
      try {
        expect(checkVonvonMigration(file, D)).toEqual({ kind: 'unreadable', marker: file, code: 'EACCES' });
      } finally {
        chmodSync(data, 0o700);
      }
    },
  );

  it.each(['linux', 'win32', 'freebsd'] as const)('%s：有标记也当没迁移（Vonvon Bot 只有 Mac 版）', (platform) => {
    writeFileSync(marker, '{}');
    expect(checkVonvonMigration(marker, platform)).toEqual({ kind: 'clear' });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    '非 macOS：数据目录读不了也不拦（读错误不该让 Windows、Linux 的 bridge 起不来）',
    () => {
      const data = join(dir, 'data');
      mkdirSync(data);
      chmodSync(data, 0o000);
      try {
        expect(checkVonvonMigration(join(data, 'vonvon-migration.json'), 'linux')).toEqual({ kind: 'clear' });
      } finally {
        chmodSync(data, 0o700);
      }
    },
  );
});

describe('提示文案', () => {
  it('拒绝启动：说清楚迁到了 Vonvon Bot、要回来先「移除」Bot（只停用不行），并写出标记文件路径', () => {
    const text = migratedRefusal(migrated(marker));
    expect(text).toContain('已经迁到 Vonvon Bot');
    expect(text).toContain('请在 Vonvon Bot 里使用');
    expect(text).toContain('移除这些 Bot');
    expect(text).toContain('只停用不行');
    expect(text).toContain('删掉这个标记文件');
    expect(text).toContain(marker);
    expect(text).toContain('feishu-codex-bridge start');
    expect(text).not.toContain('停掉这些 bot');
  });

  it('读不了数据目录：不说已经迁移，不叫人去删标记，写出目录和错误码', () => {
    const text = migratedRefusal({ kind: 'unreadable', marker, code: 'EACCES' });
    expect(text).toContain('读不了 bridge 的数据目录');
    expect(text).toContain(dir);
    expect(text).toContain('EACCES');
    expect(text).toContain('权限');
    expect(text).not.toContain('已经迁到 Vonvon Bot');
    expect(text).not.toContain('删掉这个标记文件');
  });

  it('stop / status 的提示是一行，带标记路径', () => {
    const text = migratedNote(migrated(marker));
    expect(text.split('\n')).toHaveLength(1);
    expect(text).toContain('Vonvon Bot');
    expect(text).toContain(marker);
  });

  it('读不了数据目录的提示也是一行', () => {
    const text = migratedNote({ kind: 'unreadable', marker, code: 'EIO' });
    expect(text.split('\n')).toHaveLength(1);
    expect(text).toContain('EIO');
    expect(text).not.toContain('已经迁到 Vonvon Bot');
  });
});

describe('refuseIfMigrated / printMigratedNote', () => {
  it('有标记：打印拒绝原因、退出码置 1、返回已迁移的状态', () => {
    writeFileSync(marker, 'garbage');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(refuseIfMigrated('start', marker, D)).toEqual(migrated(marker));
    expect(process.exitCode).toBe(1);
    expect(err.mock.calls.map((a) => a.join(' ')).join('\n')).toContain(marker);
  });

  it('没有标记：什么都不做', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(refuseIfMigrated('run', marker, D)).toBeUndefined();
    expect(process.exitCode ?? 0).toBe(0);
    expect(err).not.toHaveBeenCalled();
  });

  it('非 macOS：有标记也什么都不做，退出码不变', () => {
    writeFileSync(marker, '');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(refuseIfMigrated('run', marker, 'linux')).toBeUndefined();
    expect(refuseIfMigrated('start', marker, 'win32')).toBeUndefined();
    expect(process.exitCode ?? 0).toBe(0);
    expect(err).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    '数据目录读不了：照样拒绝（退出码 1），但提示是读不了目录，不是已迁移',
    () => {
      const data = join(dir, 'data');
      mkdirSync(data);
      const file = join(data, 'vonvon-migration.json');
      chmodSync(data, 0o000);
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(refuseIfMigrated('run', file, D)).toMatchObject({ kind: 'unreadable', code: 'EACCES' });
      } finally {
        chmodSync(data, 0o700);
      }
      expect(process.exitCode).toBe(1);
      const printed = err.mock.calls.map((a) => a.join(' ')).join('\n');
      expect(printed).toContain('读不了 bridge 的数据目录');
      expect(printed).not.toContain('已经迁到 Vonvon Bot');
      expect(printed).not.toContain('删掉这个标记文件');
    },
  );

  it('printMigratedNote：有标记打一行并返回 true；没有则静默返回 false；非 macOS 静默', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(printMigratedNote(marker, D)).toBe(false);
    expect(log).not.toHaveBeenCalled();
    writeFileSync(marker, '');
    expect(printMigratedNote(marker, 'linux')).toBe(false);
    expect(log).not.toHaveBeenCalled();
    expect(printMigratedNote(marker, D)).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain(marker);
    expect(process.exitCode ?? 0).toBe(0); // 提示不改退出码
  });
});
