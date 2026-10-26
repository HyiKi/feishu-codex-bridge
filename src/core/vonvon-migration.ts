import { lstatSync } from 'node:fs';
import { paths } from '../config/paths';
import { log } from './logger';

/**
 * Vonvon Bot 导入这台电脑上的 bridge 数据之后，会在 bridge 数据目录写下
 * `vonvon-migration.json`（`{ version, migratedAt, bots, vonvonVersion }`）。标记在，
 * 就说明这些 bot 已经归 Vonvon Bot 管：bridge 再启动一份，两个进程连同一个飞书应用，
 * 卡片回调会被轮流分走（见 single-instance.ts 顶部），所以 bridge 不能再起来。
 *
 * 判据只有「标记文件在不在」，不解析内容：读不了、格式坏了、是目录、是悬空链接……
 * 一律当作已迁移。宁可错拒，也不在 Vonvon Bot 占着 bot 的时候放行（和单实例锁
 * 读不懂就拒绝的口径一致）。
 */

/** 标记文件在（或者看不清它在不在）就返回路径；确认没有就返回 undefined。 */
export function vonvonMigrationMarker(file: string = paths.vonvonMigrationFile): string | undefined {
  try {
    lstatSync(file);
    return file;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // 数据目录或标记不存在（ENOTDIR：数据目录路径上有个普通文件）→ 没迁移。
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    // EACCES、EIO 等：标记在不在说不准，按已迁移处理。
    return file;
  }
}

/** 拒绝启动时的提示（`start` / `restart` / `run` 共用）。 */
export function migratedRefusal(marker: string): string {
  return [
    '✗ 这台电脑上的 bot 已经迁到 Vonvon Bot，请在 Vonvon Bot 里使用，bridge 不会再启动。',
    '  确实要回到 bridge：先在 Vonvon Bot 里停掉这些 bot，再删掉这个标记文件：',
    `    ${marker}`,
  ].join('\n');
}

/** `stop` / `status` 看到标记时的一行提示。 */
export function migratedNote(marker: string): string {
  return `提示：这台电脑上的 bot 已经迁到 Vonvon Bot，请在 Vonvon Bot 里使用，bridge 不会再启动（迁移标记：${marker}）。`;
}

/**
 * 启动类命令的入口闸。看到迁移标记就打印原因、把退出码置 1，返回标记路径；没有标记
 * 返回 undefined。必须在拿单实例锁、跑向导、读 bot 配置之前调用。
 */
export function refuseIfMigrated(
  command: 'start' | 'restart' | 'run',
  file: string = paths.vonvonMigrationFile,
): string | undefined {
  const marker = vonvonMigrationMarker(file);
  if (!marker) return undefined;
  console.error(migratedRefusal(marker));
  log.info('migration', 'refused', { command });
  process.exitCode = 1;
  return marker;
}

/** `stop` / `status`：有标记就打印一行提示，返回 true（调用方据此不再打印推荐）。 */
export function printMigratedNote(file: string = paths.vonvonMigrationFile): boolean {
  const marker = vonvonMigrationMarker(file);
  if (!marker) return false;
  console.log(migratedNote(marker));
  return true;
}
