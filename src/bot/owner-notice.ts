import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import type { AppConfig } from '../config/schema';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';

export function assertBridgeNotImported(home: string): void {
  const marker = join(home, '.feishu-codex-bridge', 'migrated-to-vonvon-bot.json');
  try {
    lstatSync(marker);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw new Error(`无法检查 Vonvon Bot 导入标记 ${marker}；为避免两个客户端同时连接，Bridge 已拒绝启动。`, { cause: error });
  }
  throw new Error(`此 Bridge 已导入 Vonvon Bot（${marker}），请使用 Vonvon Bot 启动。`);
}

export type OwnerNoticeOutcome =
  | { kind: 'no-owner' }
  | { kind: 'already-delivered' }
  | { kind: 'delivered' }
  | { kind: 'not-sent'; reason: 'state-unreadable' | 'preparation-failed'; error: unknown }
  | { kind: 'delivery-unconfirmed'; error: unknown }
  | { kind: 'delivered-unrecorded'; error: unknown };

const noticeVersion = 'vonvon-bot-import-v1';
const attempts = new Map<string, Promise<OwnerNoticeOutcome>>();

export async function notifyOwnerOfVonvonBot(input: {
  cfg: AppConfig;
  channel: LarkChannel;
}): Promise<OwnerNoticeOutcome> {
  try {
    const { resolveOwner } = await import('../config/schema');
    const owner = resolveOwner(input.cfg);
    if (!owner) return { kind: 'no-owner' };
    const key = createHash('sha256').update(JSON.stringify([noticeVersion, input.cfg.accounts.app.id, owner])).digest('hex');
    let pending = attempts.get(key);
    if (!pending) {
      pending = deliver(input.channel, owner, key).catch((error): OwnerNoticeOutcome => ({ kind: 'not-sent', reason: 'preparation-failed', error }));
      attempts.set(key, pending);
    }
    return await pending;
  } catch (error) {
    return { kind: 'not-sent', reason: 'preparation-failed', error };
  }
}

async function deliver(channel: LarkChannel, owner: string, key: string): Promise<OwnerNoticeOutcome> {
  const { paths } = await import('../config/paths');
  const directory = join(paths.appDir, 'owner-notices');
  const flag = join(directory, `${key}.json`);
  let exists = true;
  try {
    const state = await lstat(flag);
    if (!state.isFile()) throw new Error('Owner notice receipt is not a regular file');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') exists = false;
    else return { kind: 'not-sent', reason: 'state-unreadable', error };
  }
  if (exists) {
    try {
      const value: unknown = JSON.parse(await readFile(flag, 'utf8'));
      if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== noticeVersion
        || !('messageId' in value) || typeof value.messageId !== 'string' || !value.messageId.trim()) {
        throw new Error('Invalid owner notice receipt');
      }
      return { kind: 'already-delivered' };
    } catch (error) {
      return { kind: 'not-sent', reason: 'state-unreadable', error };
    }
  }
  const { vonvonImportNotice } = await import('../service/desktop-release');
  const { buildOwnerImportNoticeCard } = await import('../card/dm-cards');
  const { sendManagedCard } = await import('../card/managed');
  const card = buildOwnerImportNoticeCard(vonvonImportNotice());
  let messageId: string;
  try {
    const sent = await sendManagedCard(channel, owner, card, undefined, false, 'open_id');
    if (!sent.messageId?.trim()) throw new Error('Owner notice delivery returned no message ID');
    messageId = sent.messageId;
  } catch (error) {
    return { kind: 'delivery-unconfirmed', error };
  }
  const temporary = join(directory, `.${key}.${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify({ version: noticeVersion, messageId }));
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, flag);
    if (process.platform !== 'win32') {
      const dir = await open(directory, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    }
    return { kind: 'delivered' };
  } catch (error) {
    return { kind: 'delivered-unrecorded', error };
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
