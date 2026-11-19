const CONFIRM_PATTERN = '确认.{0,8}(最终原因|根因|结论)|最终原因|结论已确认';
const ROOT_CAUSE_PATTERN =
  `为什么|为啥|原因|根因|漏挂|漏了|缺失|没有生成|未生成|没生成|没轨迹|无轨迹|${CONFIRM_PATTERN}|排查.{0,8}(原因|为什么)`;

const ROOT_CAUSE_RE = new RegExp(`(${ROOT_CAUSE_PATTERN})`, 'i');
const CONFIRM_RE = new RegExp(`(${CONFIRM_PATTERN}|给我.{0,8}结论)`, 'i');

export const REVALIDATION_GATE = [
  '【Bridge 复验要求，不是新任务】',
  '本轮涉及根因或结论确认。上一轮对话中的结论不是已核验事实。',
  '如果用户要求确认最终原因、模型已切换，或本轮要沿用上一轮结论，必须先重新核对一条决定性证据。',
  '无法重新核验时，明确写“沿用上一轮，尚未复验”或 unknown，禁止写“最终原因”“已确认”。',
].join('\n');

export function isRootCauseRequest(text: string): boolean {
  return ROOT_CAUSE_RE.test(text);
}

export function isConfirmationRequest(text: string): boolean {
  return CONFIRM_RE.test(text);
}

export function shouldRevalidate(input: {
  text: string;
  hasPrior: boolean;
  modelChanged: boolean;
}): boolean {
  /**
   * Explicit confirmation always warrants a recheck. A model switch alone is
   * broader, so only escalate it for root-cause questions to avoid injecting
   * this gate into ordinary follow-up chat.
   */
  if (!input.hasPrior) return false;
  if (input.modelChanged) return isRootCauseRequest(input.text);
  return isConfirmationRequest(input.text);
}

export function withRevalidationGate(text: string): string {
  return `${REVALIDATION_GATE}\n\n${text}`;
}
