import { describe, expect, it, vi } from 'vitest';
import {
  buildTerminalCardMentionContent,
  sendTerminalCardNotification,
} from '../src/bot/terminal-notification';
import type { AppConfig } from '../src/config/schema';

function dedupe() {
  const ids = new Set<string>();
  return {
    seen(id: string) {
      if (ids.has(id)) return true;
      ids.add(id);
      return false;
    },
  };
}

function config(mode?: 'manual' | 'long' | 'failures' | 'always'): AppConfig {
  return {
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    ...(mode ? { preferences: { completionReminder: { mode, longTaskMinutes: 3 } } } : {}),
  };
}

function replyChannel(reply = vi.fn(async (_request: any) => ({}))) {
  return {
    reply,
    channel: { rawClient: { im: { v1: { message: { reply } } } } } as never,
  };
}

const base = {
  cardMsgId: 'om_card',
  requesterOpenId: 'ou_requester',
  outcome: 'done' as const,
  requestedAt: 1_000,
  manuallyRequested: false,
  summary: '检查报价',
  cardUpdated: true,
  replyInThread: true,
};

describe('terminal card mention', () => {
  it('builds a short native post with a real structured at node', () => {
    const content = JSON.parse(
      buildTerminalCardMentionContent({ requesterOpenId: 'ou_requester', outcome: 'done' }),
    );
    expect(content.zh_cn.content[0][0]).toEqual({ tag: 'at', user_id: 'ou_requester' });
    expect(content.zh_cn.content[0][1].text).toContain('回答已完成');
    expect(JSON.stringify(content)).not.toContain('@ou_requester');
  });

  it('sends one generic native reply when the reminder policy skips success', async () => {
    const { channel, reply } = replyChannel();
    const result = await sendTerminalCardNotification(
      { channel, cfg: config(), dedupe: dedupe(), now: () => 11_000 },
      base,
    );

    expect(result).toBe('sent');
    expect(reply).toHaveBeenCalledOnce();
    expect(reply.mock.calls[0]?.[0]).toMatchObject({
      path: { message_id: 'om_card' },
      data: { msg_type: 'post', reply_in_thread: true },
    });
    const content = JSON.parse(reply.mock.calls[0]![0].data.content);
    expect(content.zh_cn.content[0][0]).toEqual({ tag: 'at', user_id: 'ou_requester' });
  });

  it('does not add a second mention when the completion reminder already sends', async () => {
    const { channel, reply } = replyChannel();
    const result = await sendTerminalCardNotification(
      { channel, cfg: config('always'), dedupe: dedupe(), now: () => 11_000 },
      base,
    );

    expect(result).toBe('sent');
    expect(reply).toHaveBeenCalledOnce();
    const content = JSON.parse(reply.mock.calls[0]![0].data.content);
    expect(content.zh_cn.content[0][1].text).toContain('已完成 · 用时');
  });

  it('uses the existing reminder fallback when the terminal card update failed', async () => {
    const { channel, reply } = replyChannel();
    const result = await sendTerminalCardNotification(
      { channel, cfg: config(), dedupe: dedupe(), now: () => 11_000 },
      { ...base, cardUpdated: false },
    );

    expect(result).toBe('sent');
    expect(reply).toHaveBeenCalledOnce();
    const content = JSON.parse(reply.mock.calls[0]![0].data.content);
    expect(content.zh_cn.content[1][0].text).toContain('最终卡片更新失败');
  });

  it('dedupes by card message id across both notification paths', async () => {
    const { channel, reply } = replyChannel();
    const deps = { channel, cfg: config(), dedupe: dedupe(), now: () => 11_000 };

    await expect(sendTerminalCardNotification(deps, base)).resolves.toBe('sent');
    await expect(sendTerminalCardNotification(deps, base)).resolves.toBe('skipped');
    expect(reply).toHaveBeenCalledOnce();
  });

  it('never notifies for user interruption or cancellation', async () => {
    const { channel, reply } = replyChannel();
    const deps = { channel, cfg: config('always'), dedupe: dedupe(), now: () => 11_000 };

    await expect(sendTerminalCardNotification(deps, { ...base, outcome: 'interrupted' })).resolves.toBe('skipped');
    await expect(sendTerminalCardNotification(deps, { ...base, outcome: 'cancelled' })).resolves.toBe('skipped');
    expect(reply).not.toHaveBeenCalled();
  });
});
