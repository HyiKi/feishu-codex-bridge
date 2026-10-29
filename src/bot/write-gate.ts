import { randomUUID } from 'node:crypto';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { CommandApprover } from '../agent/types';
import { classifyCommand, redactCommand, unwrapShell } from '../agent/command-gate';
import { actions, button, card, md, note, type CardObject } from '../card/cards';
import type { CardDispatcher } from '../card/dispatcher';
import { sendManagedCard, updateManagedCard } from '../card/managed';
import { log } from '../core/logger';

export const WRITE_GATE_APPROVE = 'wg.approve';
export const WRITE_GATE_DENY = 'wg.deny';
export const WRITE_GATE_DENIED_NOTICE = '当前无权执行此操作，请由管理员操作';
export const WRITE_GATE_STALE_NOTICE = '这条审批已处理或已失效（bridge 重启过），请让 agent 重新发起';
const COMMAND_CLIP = 1800;

type Verdict = 'approved' | 'denied';

interface Pending {
  id: string;
  key: string;
  chatId: string;
  cardMessageId?: string;
  replyInThread: boolean;
  command: string;
  reasons: string[];
  requesterOpenId?: string;
  sessionKey?: string;
}

export interface WriteGateRunContext {
  chatId: string;
  /** the message the approval card is posted under */
  replyTo: string;
  replyInThread: boolean;
  /** who asked for the run, shown on the card */
  requesterOpenId?: string;
  /** bridge session key of the run; read lazily because a new topic only gets
   * its real key once its first card exists */
  sessionKey?: () => string | undefined;
  /** False for bridge-generated continuation turns (for example an approval
   * follow-up): those carry an admin sender id but were not initiated by that
   * admin, so they must not inherit the admin write bypass. Defaults to true. */
  allowAdminWriteBypass?: boolean;
}

export interface WriteGateApproval {
  chatId: string;
  cardMessageId: string;
  replyInThread: boolean;
  sessionKey?: string;
  /** the exact script the admin approved */
  command: string;
  approverOpenId: string;
  requesterOpenId?: string;
}

export interface WriteGateOptions {
  channel: LarkChannel;
  /** live admin check — evaluated for the current sender and on every click,
   * never cached. An admin's own write is allowed without an approval card. */
  isAdmin: (openId: string) => boolean;
  /** open_ids to @ on the approval card */
  adminOpenIds?: () => string[];
  /** Re-verifies the click still comes from an allowed chat. */
  isChatAllowed?: (chatId: string) => boolean;
  /** Called after an admin approves; should hand the agent a message to run it. */
  onApproved?: (approval: WriteGateApproval) => void | Promise<void>;
}

export interface WriteGateCardInput {
  id: string;
  command: string;
  reasons: string[];
  requesterOpenId?: string;
  adminOpenIds?: string[];
  status?: 'pending' | Verdict;
  decidedBy?: string;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…（已截断）` : text;
}

function fence(text: string): string {
  const marker = text.includes('```') ? '````' : '```';
  return `${marker}bash\n${text}\n${marker}`;
}

function at(openId: string): string {
  return `<at id=${openId}></at>`;
}

/** Same script ⇒ same key, regardless of the shell wrapper or whitespace layout. */
function commandKey(threadId: string, command: string): string {
  return `${threadId}\u0000${unwrapShell(command).replace(/\s+/g, ' ').trim()}`;
}

export function buildWriteGateCard(input: WriteGateCardInput): CardObject {
  const status = input.status ?? 'pending';
  const title =
    status === 'approved' ? '✅ 已批准，正在通知 agent 执行'
      : status === 'denied' ? '⛔ 已拒绝，未执行'
        : '🔐 ERP 写操作待管理员批准';
  const elements = [
    md(`**${title}**`),
    md(`**命令**\n${fence(clip(redactCommand(input.command), COMMAND_CLIP))}`),
    md(`**判定依据**\n${input.reasons.map((reason) => `- ${reason}`).join('\n')}`),
  ];
  if (status === 'pending') {
    const admins = (input.adminOpenIds ?? []).map(at).join(' ');
    elements.push(
      md(`${admins ? `${admins} ` : ''}请管理员点击下方「批准执行」或「拒绝」。批准前不会执行，不设时限。`),
      note(input.requesterOpenId ? `发起人 ${at(input.requesterOpenId)}` : '仅管理员可操作'),
      actions([
        button('✅ 批准执行', { a: WRITE_GATE_APPROVE, id: input.id }, 'primary'),
        button('⛔ 拒绝', { a: WRITE_GATE_DENY, id: input.id }, 'danger'),
      ]),
    );
  } else if (input.decidedBy) {
    elements.push(note(`操作人 ${at(input.decidedBy)}`));
  }
  return card(elements, { forward: false, summary: '🔐 ERP 写操作待管理员批准' });
}

/**
 * ERP write gate. A write initiated by an admin runs directly. For any other
 * sender, a gated command is NOT held open: the approver answers "refused" at
 * once (so the agent's turn finishes and tells people what needs approving) and
 * an approval card is posted. When an admin clicks 批准, a one-time grant for
 * that exact script is recorded and the agent is told to run it; denying only
 * closes the card. Nothing times out.
 */
export class WriteGate {
  private readonly pending = new Map<string, Pending>();
  private readonly pendingKeys = new Set<string>();
  private readonly grants = new Set<string>();

  constructor(private readonly opts: WriteGateOptions) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  hasGrant(threadId: string, command: string): boolean {
    return this.grants.has(commandKey(threadId, command));
  }

  approverFor(ctx: (threadId: string) => WriteGateRunContext | undefined, cwd: string | undefined): CommandApprover {
    return async (req) => {
      const verdict = classifyCommand(req.command, { cwd: req.cwd ?? cwd });
      if (!verdict.gated) return true;
      const key = commandKey(req.threadId, req.command);
      if (this.grants.delete(key)) {
        log.info('write-gate', 'grant-used');
        return true;
      }
      const run = ctx(req.threadId);
      if (!run) {
        log.warn('write-gate', 'no-run-context', { reasons: verdict.reasons.length });
        return false;
      }
      if (
        run.allowAdminWriteBypass !== false &&
        run.requesterOpenId &&
        this.opts.isAdmin(run.requesterOpenId)
      ) {
        log.info('write-gate', 'admin-bypass', { reasons: verdict.reasons.length });
        return true;
      }
      if (!this.pendingKeys.has(key)) this.request(run, req.command, verdict.reasons, key);
      return false;
    };
  }

  private request(run: WriteGateRunContext, command: string, reasons: string[], key: string): void {
    const entry: Pending = {
      id: randomUUID().replace(/-/g, ''),
      key,
      chatId: run.chatId,
      replyInThread: run.replyInThread,
      command,
      reasons,
      requesterOpenId: run.requesterOpenId,
      sessionKey: run.sessionKey?.(),
    };
    this.pending.set(entry.id, entry);
    this.pendingKeys.add(key);
    log.info('write-gate', 'requested', { reasons: reasons.length });
    void (async () => {
      try {
        const sent = await sendManagedCard(
          this.opts.channel,
          run.chatId,
          buildWriteGateCard({
            id: entry.id,
            command,
            reasons,
            requesterOpenId: run.requesterOpenId,
            adminOpenIds: this.opts.adminOpenIds?.(),
          }),
          run.replyTo,
          run.replyInThread,
        );
        entry.cardMessageId = sent.messageId;
      } catch (err) {
        log.fail('write-gate', err, { phase: 'send-card' });
        this.drop(entry);
        await this.opts.channel
          .send(run.chatId, { markdown: '⚠️ 有 ERP 写操作需要管理员批准，但审批卡发送失败，请重新发起这项操作。' }, { replyTo: run.replyTo, replyInThread: run.replyInThread })
          .catch(() => undefined);
      }
    })();
  }

  private drop(entry: Pending): void {
    this.pending.delete(entry.id);
    this.pendingKeys.delete(entry.key);
  }

  private async repaint(entry: Pending, verdict: Verdict, by: string): Promise<void> {
    if (!entry.cardMessageId) return;
    // Let Feishu's click interaction window close first, or the update is dropped.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await updateManagedCard(
      this.opts.channel,
      entry.cardMessageId,
      buildWriteGateCard({ id: entry.id, command: entry.command, reasons: entry.reasons, status: verdict, decidedBy: by }),
    ).catch((err) => log.fail('write-gate', err, { phase: 'repaint' }));
  }

  private async decide(entry: Pending, approve: boolean, openId: string): Promise<void> {
    this.drop(entry);
    log.info('write-gate', 'verdict', { verdict: approve ? 'approved' : 'denied', by: openId.slice(-6) });
    void this.repaint(entry, approve ? 'approved' : 'denied', openId);
    if (!approve) return;
    this.grants.add(entry.key);
    try {
      await this.opts.onApproved?.({
        chatId: entry.chatId,
        cardMessageId: entry.cardMessageId ?? '',
        replyInThread: entry.replyInThread,
        sessionKey: entry.sessionKey,
        command: unwrapShell(entry.command),
        approverOpenId: openId,
        requesterOpenId: entry.requesterOpenId,
      });
    } catch (err) {
      log.fail('write-gate', err, { phase: 'on-approved' });
    }
  }

  /** Click handler. Mirrors the file-download rule: callback values carry only an
   * opaque id; permission is re-checked live at click time. */
  register(dispatcher: CardDispatcher): void {
    const handle = (approve: boolean) => (ctx: {
      channel: LarkChannel;
      evt: { messageId: string; chatId: string; operator?: { openId?: string } };
      value: Record<string, unknown>;
    }): void => {
      const id = typeof ctx.value.id === 'string' ? ctx.value.id : '';
      const reply = (markdown: string, replyInThread: boolean): void => {
        void ctx.channel.send(ctx.evt.chatId, { markdown }, { replyTo: ctx.evt.messageId, replyInThread }).catch(() => undefined);
      };
      const entry = this.pending.get(id);
      if (!entry) {
        if (/^[a-f0-9]{32}$/.test(id)) reply(`⚠️ ${WRITE_GATE_STALE_NOTICE}`, false);
        return;
      }
      if (entry.cardMessageId !== ctx.evt.messageId || entry.chatId !== ctx.evt.chatId) return;
      const openId = ctx.evt.operator?.openId ?? '';
      if (!openId || !this.opts.isAdmin(openId) || this.opts.isChatAllowed?.(entry.chatId) === false) {
        reply(`⚠️ ${WRITE_GATE_DENIED_NOTICE}`, entry.replyInThread);
        log.info('write-gate', 'click-rejected', { by: openId.slice(-6) });
        return;
      }
      void this.decide(entry, approve, openId);
    };
    dispatcher.on(WRITE_GATE_APPROVE, handle(true));
    dispatcher.on(WRITE_GATE_DENY, handle(false));
  }
}

/** Developer guidance for gated threads: what a refused write means and what to
 * do next, so the model neither retries nor routes around the gate. */
export const WRITE_GATE_INSTRUCTIONS = [
  '本项目启用了 ERP 写操作门禁：管理员本人发起的写操作直接执行；其他成员发起的写操作需要管理员批准；读操作不受影响。',
  '非管理员发起的写命令第一次执行时会被拒绝，这不是故障：飞书桥已经在群里发出审批卡，管理员点击「批准执行」后才能运行。',
  '遇到这种拒绝时：不要重试、不要换命令或工具、不要改写成脚本绕过；在本轮回复里说清楚「需要管理员批准什么」',
  '（环境、目标、原值/新值，以及你准备执行的操作），提醒管理员到审批卡上点击批准或拒绝，然后正常结束本轮，不要等待。',
  '管理员批准后你会收到一条消息，附带已批准的命令：届时原样执行该命令一次，不要修改，并汇报结果。管理员拒绝则不会有后续消息。',
].join('\n');
