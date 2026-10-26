import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  migratedNote,
  migratedRefusal,
  printMigratedNote,
  refuseIfMigrated,
  vonvonMigrationMarker,
} from '../src/core/vonvon-migration';

// Vonvon Bot 导入完成后在 bridge 数据目录写 vonvon-migration.json。bridge 只认「文件在不在」，
// 不解析内容：读不了、格式坏了、不是普通文件都当作已迁移（宁可错拒，不在 Vonvon Bot 占着 bot 时放行）。

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

describe('vonvonMigrationMarker', () => {
  it('没有标记 → 没迁移', () => {
    expect(vonvonMigrationMarker(marker)).toBeUndefined();
  });

  it('数据目录本身不存在 → 没迁移（新装的用户）', () => {
    expect(vonvonMigrationMarker(join(dir, 'no-such-dir', 'vonvon-migration.json'))).toBeUndefined();
  });

  it('数据目录路径上是个普通文件（ENOTDIR）→ 没迁移', () => {
    writeFileSync(join(dir, 'not-a-dir'), '');
    expect(vonvonMigrationMarker(join(dir, 'not-a-dir', 'vonvon-migration.json'))).toBeUndefined();
  });

  it('Vonvon Bot 写的标记 → 已迁移', () => {
    writeFileSync(
      marker,
      JSON.stringify({ version: 1, migratedAt: 1_780_000_000_000, bots: ['cli_a'], vonvonVersion: '0.7.0' }),
    );
    expect(vonvonMigrationMarker(marker)).toBe(marker);
  });

  it.each([
    ['不是 JSON', '{half-written'],
    ['空文件', ''],
    ['JSON 但不是对象', '"migrated"'],
    ['缺字段的对象', '{}'],
    ['未来版本的格式', JSON.stringify({ version: 99, whatever: true })],
  ])('格式坏了（%s）→ 照样当作已迁移', (_name, content) => {
    writeFileSync(marker, content);
    expect(vonvonMigrationMarker(marker)).toBe(marker);
  });

  it('权限 000、读不了内容的标记 → 已迁移', () => {
    writeFileSync(marker, '{}');
    chmodSync(marker, 0o000);
    expect(vonvonMigrationMarker(marker)).toBe(marker);
  });

  it('标记是个目录 → 已迁移', () => {
    mkdirSync(marker);
    expect(vonvonMigrationMarker(marker)).toBe(marker);
  });

  it.skipIf(process.platform === 'win32')('悬空的符号链接也算存在 → 已迁移', () => {
    symlinkSync(join(dir, 'gone'), marker);
    expect(vonvonMigrationMarker(marker)).toBe(marker);
  });

  // root 不受目录权限限制，Windows 没有 POSIX 权限位。
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    '数据目录读不了、说不准标记在不在 → fail-closed，按已迁移',
    () => {
      const data = join(dir, 'data');
      mkdirSync(data);
      const file = join(data, 'vonvon-migration.json');
      chmodSync(data, 0o000);
      try {
        expect(vonvonMigrationMarker(file)).toBe(file);
      } finally {
        chmodSync(data, 0o700);
      }
    },
  );
});

describe('提示文案', () => {
  it('拒绝启动：说清楚迁到了 Vonvon Bot、要回来怎么做，并写出标记文件路径', () => {
    const text = migratedRefusal(marker);
    expect(text).toContain('已经迁到 Vonvon Bot');
    expect(text).toContain('请在 Vonvon Bot 里使用');
    expect(text).toContain('先在 Vonvon Bot 里停掉这些 bot');
    expect(text).toContain('删掉这个标记文件');
    expect(text).toContain(marker);
  });

  it('stop / status 的提示是一行，带标记路径', () => {
    const text = migratedNote(marker);
    expect(text.split('\n')).toHaveLength(1);
    expect(text).toContain('Vonvon Bot');
    expect(text).toContain(marker);
  });
});

describe('refuseIfMigrated / printMigratedNote', () => {
  it('有标记：打印拒绝原因、退出码置 1、返回标记路径', () => {
    writeFileSync(marker, 'garbage');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(refuseIfMigrated('start', marker)).toBe(marker);
    expect(process.exitCode).toBe(1);
    expect(err.mock.calls.map((a) => a.join(' ')).join('\n')).toContain(marker);
  });

  it('没有标记：什么都不做', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(refuseIfMigrated('run', marker)).toBeUndefined();
    expect(process.exitCode ?? 0).toBe(0);
    expect(err).not.toHaveBeenCalled();
  });

  it('printMigratedNote：有标记打一行并返回 true；没有则静默返回 false', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(printMigratedNote(marker)).toBe(false);
    expect(log).not.toHaveBeenCalled();
    writeFileSync(marker, '');
    expect(printMigratedNote(marker)).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain(marker);
    expect(process.exitCode ?? 0).toBe(0); // 提示不改退出码
  });
});
