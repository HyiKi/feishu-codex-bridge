import { lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths } from '../config/paths';
import { log } from './logger';

/**
 * Vonvon Bot 导入这台电脑上的 bridge 数据之后，会在 bridge 数据目录写下
 * `vonvon-migration.json`（`{ version, migratedAt, bots, vonvonVersion }`）。标记在，
 * 就说明这些 bot 已经归 Vonvon Bot 管：bridge 再启动一份，两个进程连同一个飞书应用，
 * 卡片回调会被轮流分走（见 single-instance.ts 顶部），所以 bridge 不能再起来。
 *
 * 只在 macOS 上查：Vonvon Bot 目前只有 Mac 版，只会在 Mac 上写标记、占锁。Windows、Linux
 * 上一律当没迁移，行为和 0.6.14 完全一样。
 *
 * 判据只有「标记文件在不在」，不解析内容：读不了、格式坏了、是目录、是悬空链接……
 * 只要 lstat 成功就当作已迁移。宁可错拒，也不在 Vonvon Bot 占着 bot 的时候放行（和单实例锁
 * 读不懂就拒绝的口径一致）。结果分三种：
 *   - migrated：lstat 成功，标记确实在；
 *   - clear：确实不在（ENOENT / ENOTDIR）；
 *   - unreadable：连标记在不在都看不清（数据目录没有搜索权限、EIO……）。照样拒绝启动
 *     （fail-closed），但换一句话，也不去卸 launchd 服务——可能只是暂时的读错误。
 */
export type VonvonMigrationState =
  | { kind: 'clear' }
  | { kind: 'migrated'; marker: string }
  | { kind: 'unreadable'; marker: string; code: string };

/** 要拦住启动的两种状态。 */
export type VonvonMigrationBlock = Exclude<VonvonMigrationState, { kind: 'clear' }>;

/** 看迁移标记。`file` 和 `platform` 仅测试注入，生产固定读 bridge 数据目录和 process.platform。 */
export function checkVonvonMigration(
  file: string = paths.vonvonMigrationFile,
  platform: NodeJS.Platform = process.platform,
): VonvonMigrationState {
  if (platform !== 'darwin') return { kind: 'clear' };
  try {
    lstatSync(file);
    return { kind: 'migrated', marker: file };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    // 数据目录或标记不存在（ENOTDIR：数据目录路径上有个普通文件）→ 没迁移。
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'clear' };
    // EACCES、EIO 等：标记在不在说不准，照样拦，但提示换成「读不了目录」。
    return { kind: 'unreadable', marker: file, code };
  }
}

/** 拒绝启动时的提示（`start` / `restart` / `run` 共用）。 */
export function migratedRefusal(state: VonvonMigrationBlock): string {
  if (state.kind === 'unreadable') {
    return [
      `✗ 读不了 bridge 的数据目录 ${dirname(state.marker)}（${state.code}），没法确认这台电脑的 bot 有没有迁到 Vonvon Bot，所以 bridge 先不启动。`,
      '  请检查这个目录的权限后重试。',
    ].join('\n');
  }
  return [
    '✗ 这台电脑上的 bot 已经迁到 Vonvon Bot，请在 Vonvon Bot 里使用，bridge 不会再启动。',
    '  确实要回到 bridge：',
    '    1. 先在 Vonvon Bot 里移除这些 Bot（只停用不行，Vonvon Bot 仍会占着它们）；',
    '    2. 再删掉这个标记文件：',
    `       ${state.marker}`,
    '    3. 然后运行 `feishu-codex-bridge start`。',
  ].join('\n');
}

/** `stop` / `status` / Web 预览看到标记时的一行提示。 */
export function migratedNote(state: VonvonMigrationBlock): string {
  if (state.kind === 'unreadable') {
    return `提示：读不了 bridge 的数据目录 ${dirname(state.marker)}（${state.code}），没法确认这台电脑的 bot 有没有迁到 Vonvon Bot，请检查权限。`;
  }
  return `提示：这台电脑上的 bot 已经迁到 Vonvon Bot，请在 Vonvon Bot 里使用，bridge 不会再启动（迁移标记：${state.marker}）。`;
}

/**
 * 启动类命令的入口闸。要拦就打印原因、把退出码置 1，返回拦下它的状态；不用拦返回
 * undefined。必须在拿单实例锁、跑向导、读 bot 配置之前调用。
 */
export function refuseIfMigrated(
  command: 'start' | 'restart' | 'run',
  file: string = paths.vonvonMigrationFile,
  platform: NodeJS.Platform = process.platform,
): VonvonMigrationBlock | undefined {
  const state = checkVonvonMigration(file, platform);
  if (state.kind === 'clear') return undefined;
  console.error(migratedRefusal(state));
  log.info('migration', 'refused', {
    command,
    reason: state.kind,
    ...(state.kind === 'unreadable' ? { code: state.code } : {}),
  });
  process.exitCode = 1;
  return state;
}

/** `stop` / `status` / `web`：要提示就打印一行，返回 true（调用方据此不再打印推荐）。 */
export function printMigratedNote(
  file: string = paths.vonvonMigrationFile,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const state = checkVonvonMigration(file, platform);
  if (state.kind === 'clear') return false;
  console.log(migratedNote(state));
  return true;
}
