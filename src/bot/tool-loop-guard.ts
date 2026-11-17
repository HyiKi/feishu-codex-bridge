import type { AgentEvent } from '../agent/types';

/** One gentle nudge per turn, after this many tool calls with no visible text. */
export const TOOL_LOOP_NUDGE_THRESHOLD = 8;

export const TOOL_LOOP_NUDGE_TEXT = [
  '【Bridge 运行提示，不是新任务】',
  '你已经连续调用多次工具，但还没有向用户输出结论。',
  '请立即基于已有证据收敛：先给结论，再列出最多 3 条关键依据；如果证据仍不足，只补一个最关键的核验，然后回答。',
  '不要再做无关的重复读取、重复查询或扩大排查范围。',
].join('\n');

export interface ToolLoopGuardOptions {
  threshold?: number;
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
  private readonly canNudge?: () => boolean;
  private toolCallCount = 0;
  private nudged = false;

  constructor(opts: ToolLoopGuardOptions = {}) {
    this.threshold = opts.threshold ?? TOOL_LOOP_NUDGE_THRESHOLD;
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
      return false;
    }
    if (evt.type !== 'tool_use') return false;

    this.toolCallCount += 1;
    if (this.nudged || this.toolCallCount < this.threshold) return false;
    if (this.canNudge && !this.canNudge()) return false;

    this.nudged = true;
    return true;
  }
}
