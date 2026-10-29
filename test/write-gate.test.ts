import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardDispatcher } from '../src/card/dispatcher';
import {
  WRITE_GATE_APPROVE,
  WRITE_GATE_DENIED_NOTICE,
  WRITE_GATE_DENY,
  WriteGate,
  buildWriteGateCard,
  type WriteGateRunContext,
} from '../src/bot/write-gate';

const CHAT = 'oc_chat';
const CARD_MSG = 'om_card';
const run: WriteGateRunContext = { chatId: CHAT, replyTo: 'om_user', replyInThread: true, requesterOpenId: 'ou_user' };
const WRITE = 'mcp-call call dms-mcp-server createDataChangeOrder --args-file -';
const READ = 'mcp-call call dms-mcp-server getDatabase --args {}';

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function collect(node: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (Array.isArray(node)) node.forEach((n) => collect(n, out));
  else if (node && typeof node === 'object') {
    const rec = node as Record<string, unknown>;
    if (typeof rec.a === 'string' && typeof rec.id === 'string') out.push(rec);
    Object.values(rec).forEach((n) => collect(n, out));
  }
  return out;
}

describe('WriteGate', () => {
  const cardCreate = vi.fn(async (_: any) => ({ data: { card_id: 'card_1' } }));
  const cardUpdate = vi.fn(async (_: any) => ({ code: 0 }));
  const reply = vi.fn(async (_: any) => ({ data: { message_id: CARD_MSG } }));
  const send = vi.fn(async (..._: any[]) => ({}));
  const channel = {
    rawClient: {
      cardkit: { v1: { card: { create: cardCreate, update: cardUpdate } } },
      im: { v1: { message: { reply, create: vi.fn() } } },
    },
    send,
  } as never;
  const admins = new Set(['ou_admin']);
  const onApproved = vi.fn(async (_: any) => undefined);
  let gate: WriteGate;
  let dispatcher: CardDispatcher;

  const click = (actionId: string, id: string, openId: string, messageId = CARD_MSG, chatId = CHAT) =>
    dispatcher.handle({ messageId, chatId, operator: { openId }, action: { value: { a: actionId, id }, tag: 'button' } } as never);
  const lastCard = (): string => cardCreate.mock.calls.at(-1)![0].data.data as string;
  const lastId = (): string => collect(JSON.parse(lastCard()))[0]!.id as string;
  const approver = () => gate.approverFor(() => ({ ...run, sessionKey: () => 'topic_1' }), '/work');
  const req = (command: string) => ({ command, cwd: '/work', threadId: 't1' });
  const signal = new AbortController().signal;

  beforeEach(() => {
    vi.clearAllMocks();
    admins.clear();
    admins.add('ou_admin');
    gate = new WriteGate({ channel, isAdmin: (id) => admins.has(id), adminOpenIds: () => ['ou_admin'], onApproved });
    dispatcher = new CardDispatcher(channel, {} as never);
    gate.register(dispatcher);
  });

  it('runs reads without any card', async () => {
    await expect(approver()(req(READ), signal)).resolves.toBe(true);
    expect(cardCreate).not.toHaveBeenCalled();
  });

  it('runs a write directly when the current sender is an admin', async () => {
    const adminApprover = gate.approverFor(
      () => ({ ...run, requesterOpenId: 'ou_admin', sessionKey: () => 'topic_1' }),
      '/work',
    );
    await expect(adminApprover(req(WRITE), signal)).resolves.toBe(true);
    expect(cardCreate).not.toHaveBeenCalled();
    expect(gate.pendingCount).toBe(0);
  });

  it('does not let a bridge-generated continuation inherit the admin bypass', async () => {
    const continuationApprover = gate.approverFor(
      () => ({ ...run, requesterOpenId: 'ou_admin', allowAdminWriteBypass: false, sessionKey: () => 'topic_1' }),
      '/work',
    );
    await expect(continuationApprover(req(WRITE), signal)).resolves.toBe(false);
    await flush();
    expect(cardCreate).toHaveBeenCalledTimes(1);
    expect(gate.pendingCount).toBe(1);
  });

  it('refuses a write immediately (no waiting) and posts one card that @s the admins', async () => {
    await expect(approver()(req(WRITE), signal)).resolves.toBe(false);
    await flush();
    expect(cardCreate).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]![0].path.message_id).toBe('om_user');
    expect(reply.mock.calls[0]![0].data.reply_in_thread).toBe(true);
    expect(lastCard()).toContain('createDataChangeOrder');
    expect(lastCard()).toContain('<at id=ou_admin></at>');
    expect(lastCard()).toContain('不设时限');
    expect(gate.pendingCount).toBe(1);
  });

  it('does not post a second card while the same command is awaiting approval', async () => {
    await approver()(req(WRITE), signal);
    await approver()(req(WRITE), signal);
    await approver()(req(`/bin/zsh -lc '${WRITE}'`), signal);
    await flush();
    expect(cardCreate).toHaveBeenCalledTimes(1);
  });

  it('an admin approval grants that exact script once and wakes the agent', async () => {
    await approver()(req(`/bin/zsh -lc '${WRITE}'`), signal);
    await flush();
    await click(WRITE_GATE_APPROVE, lastId(), 'ou_admin');
    await flush();
    expect(onApproved).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: CHAT, cardMessageId: CARD_MSG, sessionKey: 'topic_1', approverOpenId: 'ou_admin', command: WRITE }),
    );
    expect(gate.hasGrant('t1', WRITE)).toBe(true);
    await expect(approver()(req(`/bin/zsh -lc '${WRITE}'`), signal)).resolves.toBe(true);
    await expect(approver()(req(`/bin/zsh -lc '${WRITE}'`), signal)).resolves.toBe(false);
  });

  it('a grant covers only that script and only that thread', async () => {
    await approver()(req(WRITE), signal);
    await flush();
    await click(WRITE_GATE_APPROVE, lastId(), 'ou_admin');
    await flush();
    const other = 'mcp-call call dms-mcp-server approveOrder --args {}';
    await expect(approver()(req(other), signal)).resolves.toBe(false);
    await expect(approver()({ ...req(WRITE), threadId: 't2' }, signal)).resolves.toBe(false);
    await expect(approver()(req(WRITE), signal)).resolves.toBe(true);
  });

  it('denying closes the card, grants nothing and does not wake the agent', async () => {
    await approver()(req(WRITE), signal);
    await flush();
    await click(WRITE_GATE_DENY, lastId(), 'ou_admin');
    await flush();
    expect(onApproved).not.toHaveBeenCalled();
    expect(gate.hasGrant('t1', WRITE)).toBe(false);
    expect(gate.pendingCount).toBe(0);
  });

  it('a non-admin click is refused with a notice and the card stays actionable', async () => {
    await approver()(req(WRITE), signal);
    await flush();
    const id = lastId();
    await click(WRITE_GATE_APPROVE, id, 'ou_user');
    expect(send).toHaveBeenCalledWith(CHAT, { markdown: `⚠️ ${WRITE_GATE_DENIED_NOTICE}` }, expect.anything());
    expect(onApproved).not.toHaveBeenCalled();
    expect(gate.hasGrant('t1', WRITE)).toBe(false);
    expect(gate.pendingCount).toBe(1);
    await click(WRITE_GATE_APPROVE, id, 'ou_admin');
    await flush();
    expect(onApproved).toHaveBeenCalledTimes(1);
  });

  it('checks admin status at click time, not when the card was sent', async () => {
    await approver()(req(WRITE), signal);
    await flush();
    admins.delete('ou_admin');
    await click(WRITE_GATE_APPROVE, lastId(), 'ou_admin');
    expect(onApproved).not.toHaveBeenCalled();
    expect(gate.pendingCount).toBe(1);
  });

  it('rejects forged ids, other cards and other chats', async () => {
    await approver()(req(WRITE), signal);
    await flush();
    const id = lastId();
    await click(WRITE_GATE_APPROVE, '../../x', 'ou_admin');
    await click(WRITE_GATE_APPROVE, id, 'ou_admin', 'om_forwarded');
    await click(WRITE_GATE_APPROVE, id, 'ou_admin', CARD_MSG, 'oc_other');
    expect(onApproved).not.toHaveBeenCalled();
    expect(gate.pendingCount).toBe(1);
  });

  it('a second click on a settled card is told it is stale and does nothing', async () => {
    await approver()(req(WRITE), signal);
    await flush();
    const id = lastId();
    await click(WRITE_GATE_APPROVE, id, 'ou_admin');
    await flush();
    send.mockClear();
    await click(WRITE_GATE_DENY, id, 'ou_admin');
    expect(onApproved).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(CHAT, { markdown: expect.stringContaining('已处理或已失效') }, expect.anything());
  });

  it('fails closed with no run bound, and tells the chat when the card cannot be sent', async () => {
    const orphan = gate.approverFor(() => undefined, '/work');
    await expect(orphan(req(WRITE), signal)).resolves.toBe(false);
    expect(cardCreate).not.toHaveBeenCalled();
    cardCreate.mockRejectedValueOnce(new Error('boom'));
    await expect(approver()(req(WRITE), signal)).resolves.toBe(false);
    await flush();
    await flush();
    expect(send).toHaveBeenCalledWith(CHAT, { markdown: expect.stringContaining('审批卡发送失败') }, expect.anything());
    expect(gate.pendingCount).toBe(0);
  });
});

describe('buildWriteGateCard', () => {
  it('@s the admins on the pending card and states there is no time limit', () => {
    const body = JSON.stringify(buildWriteGateCard({ id: 'abc', command: 'x', reasons: ['r'], adminOpenIds: ['ou_a', 'ou_b'] }));
    expect(body).toContain('<at id=ou_a></at>');
    expect(body).toContain('<at id=ou_b></at>');
    expect(body).toContain('不设时限');
  });
  it('masks secrets in the shown command and never embeds the command in callback values', () => {
    const body = JSON.stringify(
      buildWriteGateCard({
        id: 'abc',
        command: 'curl -X POST -H "Authorization: Bearer s3cr3t.token.value" -d password=hunter2 http://x',
        reasons: ['curl 写请求'],
      }),
    );
    expect(body).not.toMatch(/hunter2|s3cr3t/);
    for (const value of collect(JSON.parse(body))) expect(Object.keys(value).sort()).toEqual(['__r', 'a', 'id'].filter((k) => k in value).sort());
  });
  it('drops the buttons once decided', () => {
    const body = JSON.stringify(buildWriteGateCard({ id: 'abc', command: 'x', reasons: ['r'], status: 'approved', decidedBy: 'ou_admin' }));
    expect(body).not.toContain('wg.approve');
    expect(body).toContain('已批准');
  });
});
