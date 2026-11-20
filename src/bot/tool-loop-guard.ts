import type { AgentEvent } from '../agent/types';

/** One progress check per turn, after this many tool calls with no visible text. */
export const TOOL_LOOP_NUDGE_THRESHOLD = 20;

/** A repeated identical tool call is a stronger loop signal than a long investigation. */
export const TOOL_LOOP_REPEAT_THRESHOLD = 4;

export const TOOL_LOOP_NUDGE_TEXT = [
  '【Bridge 进度检查，不是新任务，也不要求现在回答】',
  '你已经连续执行多次工具调用，当前仍在调查中。',
  '请先确认：是否还有会改变根因判断的关键边界条件尚未验证？',
  '如果有，继续完成该决定性核验，不要因为这条提示提前下结论。',
  '如果没有，直接回答；无法核验的关键事实必须写明具体“未核实”项和缺失证据，不能写成“已确认”。',
  '只停止重复读取或重复查询，不要停止新的决定性证据。',
].join('\n');

export interface ToolLoopGuardOptions {
  threshold?: number;
  repeatThreshold?: number;
  /** Allows the caller to delay the nudge while a write approval is pending. */
  canNudge?: () => boolean;
}

/**
 * Tracks tool calls made since the assistant last emitted visible text. Reasoning
 * deltas do not count as text: the problem this guards against is a long private
 * tool loop with no user-visible progress.
 */
export class ToolLoopGuard {
  private readonly threshold: number;
  private readonly repeatThreshold: number;
  private readonly canNudge?: () => boolean;
  private toolCallCount = 0;
  private lastToolSignature: string | undefined;
  private repeatCount = 0;
  private nudged = false;

  constructor(opts: ToolLoopGuardOptions = {}) {
    this.threshold = opts.threshold ?? TOOL_LOOP_NUDGE_THRESHOLD;
    this.repeatThreshold = opts.repeatThreshold ?? TOOL_LOOP_REPEAT_THRESHOLD;
    this.canNudge = opts.canNudge;
  }

  get toolUses(): number {
    return this.toolCallCount;
  }

  get didNudge(): boolean {
    return this.nudged;
  }

  /** Returns true exactly once, when the caller should send the soft nudge. */
  observe(evt: AgentEvent): boolean {
    if (
      (evt.type === 'text_delta' && evt.delta.trim()) ||
      (evt.type === 'text' && evt.text.trim())
    ) {
      this.toolCallCount = 0;
      this.lastToolSignature = undefined;
      this.repeatCount = 0;
      return false;
    }
    if (evt.type !== 'tool_use') return false;

    this.toolCallCount += 1;
    const signature = `${evt.title}\n${evt.detail ?? ''}`;
    if (signature === this.lastToolSignature) {
      this.repeatCount += 1;
    } else {
      this.lastToolSignature = signature;
      this.repeatCount = 1;
    }
    const repeatedLoop = this.repeatCount >= this.repeatThreshold;
    const longLoop = this.toolCallCount >= this.threshold;
    if (this.nudged || (!repeatedLoop && !longLoop)) return false;
    if (this.canNudge && !this.canNudge()) return false;

    this.nudged = true;
    return true;
  }
}
