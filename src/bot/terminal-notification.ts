import {
  sendCompletionReminderReply,
  type CompletionReminderReplyDeps,
  type CompletionReminderReplyInput,
  type CompletionReminderReplyResult,
} from './completion-reminder';
import type { CompletionReminderOutcome } from '../config/schema';
import { log } from '../core/logger';

export type TerminalCardNotificationInput = CompletionReminderReplyInput;
export type TerminalCardNotificationDeps = CompletionReminderReplyDeps;

type NotifiableOutcome = 'done' | 'error' | 'idle_timeout';

function isNotifiableOutcome(outcome: CompletionReminderOutcome): outcome is NotifiableOutcome {
  return outcome === 'done' || outcome === 'error' || outcome === 'idle_timeout';
}

/** Build the short native `post` used when the completion-reminder policy did
 * not emit its own message. The structured `at` node is what makes Feishu
 * actually notify the user; a card markdown `<at>` only renders visually. */
export function buildTerminalCardMentionContent(input: {
  requesterOpenId: string;
  outcome: NotifiableOutcome;
}): string {
  const headline =
    input.outcome === 'done'
      ? ' ✅ 回答已完成，结果见上方卡片。'
      : input.outcome === 'idle_timeout'
        ? ' ⏱ 本轮响应超时，详情见上方卡片。'
        : ' ⚠️ 本轮执行失败，详情见上方卡片。';
  return JSON.stringify({
    zh_cn: {
      title: '',
      content: [[{ tag: 'at', user_id: input.requesterOpenId }, { tag: 'text', text: headline }]],
    },
  });
}

/**
 * Emit exactly one native @ message after a run card reaches its terminal
 * state. The existing completion reminder gets first refusal (it may be
 * policy-gated or a failed-card fallback); if it skips, send a minimal generic
 * mention instead. `cardMsgId` is the at-most-once key across both paths.
 */
export async function sendTerminalCardNotification(
  deps: TerminalCardNotificationDeps,
  input: TerminalCardNotificationInput,
): Promise<CompletionReminderReplyResult> {
  const reminder = await sendCompletionReminderReply(deps, input);
  if (reminder !== 'skipped') return reminder;

  // A terminal card that failed to update is handled by the reminder fallback
  // above. Only a successfully finalized card gets the generic notification.
  if (!input.cardUpdated || !input.requesterOpenId || !isNotifiableOutcome(input.outcome)) return 'skipped';
  if (deps.dedupe.seen(input.cardMsgId)) return 'skipped';

  const content = buildTerminalCardMentionContent({
    requesterOpenId: input.requesterOpenId,
    outcome: input.outcome,
  });
  try {
    await deps.channel.rawClient.im.v1.message.reply({
      path: { message_id: input.cardMsgId },
      data: { msg_type: 'post', content, reply_in_thread: input.replyInThread },
    });
    log.info('card', 'terminal-mention', { terminal: input.outcome });
    return 'sent';
  } catch (err) {
    log.fail('card', err, { phase: 'terminal-mention', terminal: input.outcome });
    return 'failed';
  }
}
