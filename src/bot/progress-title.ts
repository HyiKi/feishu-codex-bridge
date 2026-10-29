import type { AgentEvent } from '../agent/types';

/** Keep the status line compact enough for mobile cards. */
export const PROGRESS_TITLE_MAX_CHARS = 16;

const DEFAULT_MIN_INTERVAL_MS = 5_000;
/** The first title call warms the isolated Codex sidecar/model and can take
 * ~17s on this machine; warmed calls are ~2.5s. Keep it background-only. */
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_GENERATIONS = 12;
const GOAL_SOURCE_MAX_CHARS = 800;
const REASONING_SOURCE_MAX_CHARS = 1_200;
const TOOL_SOURCE_MAX_CHARS = 120;
const TOOL_TITLES_MAX = 3;

export interface ProgressTitleInput {
  goal: string;
  reasoning: string;
  toolTitles: readonly string[];
  previousTitle?: string;
}

export type ProgressTitleGenerator = (
  input: ProgressTitleInput,
) => Promise<string | undefined>;

export interface ProgressTitleControllerOptions {
  goal: string;
  generate?: ProgressTitleGenerator;
  onChange(title: string): void;
  onError?(error: unknown): void;
  initialTitle?: string;
  minIntervalMs?: number;
  timeoutMs?: number;
  maxGenerations?: number;
}

function takeTail(value: string, maxChars: number): string {
  const chars = Array.from(value.trim());
  return chars.length <= maxChars ? chars.join('') : chars.slice(-maxChars).join('');
}

function takeHead(value: string, maxChars: number): string {
  const chars = Array.from(value.trim());
  return chars.length <= maxChars ? chars.join('') : chars.slice(0, maxChars).join('');
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * Build the sidecar prompt. The reasoning excerpt is private input only: the
 * sidecar must reduce it to an action title and never repeat its content.
 */
export function buildProgressTitlePrompt(input: ProgressTitleInput): string {
  const goal = takeHead(input.goal, GOAL_SOURCE_MAX_CHARS);
  const reasoning = takeTail(input.reasoning, REASONING_SOURCE_MAX_CHARS);
  const tools = input.toolTitles
    .slice(-TOOL_TITLES_MAX)
    .map((title) => takeHead(oneLine(title), TOOL_SOURCE_MAX_CHARS));

  return [
    '你是飞书任务进度标题生成器。根据下面的信息，概括 Agent 当前正在执行的动作。',
    '只输出一个 JSON 对象，格式：{"title":"中文动作标题"}。',
    '',
    '要求：',
    `- 标题必须是简体中文，4-${PROGRESS_TITLE_MAX_CHARS} 个汉字，动词开头；`,
    '- 只描述当前或下一步动作，例如“核对包裹税费”“查询物流订单”“检查配置”；',
    '- 不得复述推理过程，不得解释原因，不得输出英文句子；',
    '- 不得包含路径、URL、文件名、订单号、金额、代码、字段值或任何敏感标识；',
    '- 不要输出引号、Markdown、emoji 或标点；',
    '- 如果当前动作与上一个标题基本相同，保持上一个标题。',
    '',
    '<用户目标>',
    goal || '（未提供）',
    '</用户目标>',
    '',
    '<最近内部计划，仅供理解意图>',
    reasoning || '（暂无）',
    '</最近内部计划>',
    '',
    '<最近工具动作>',
    tools.length ? tools.map((tool, index) => `${String(index + 1)}. ${tool}`).join('\n') : '（暂无）',
    '</最近工具动作>',
    '',
    `<上一个标题>${input.previousTitle ?? '（暂无）'}</上一个标题>`,
  ].join('\n');
}

/** Remove model formatting and reject labels that would leak details or break the card. */
export function cleanProgressTitle(raw: string): string | undefined {
  let title = raw
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .replace(/\r?\n/gu, ' ')
    .trim();

  const jsonTitle = /"title"\s*:\s*"((?:\\.|[^"\\])*)"/u.exec(title)?.[1];
  if (jsonTitle !== undefined) {
    title = jsonTitle.replace(/\\"/gu, '"').replace(/\\n/gu, ' ');
  }

  title = oneLine(title)
    .replace(/^[\s"'`{}[\],:：-]+/u, '')
    .replace(/[\s"'`{}[\],:：-]+$/u, '')
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .trim();

  if (!title) return undefined;
  if (/https?:\/\//iu.test(title) || /[/\\]/u.test(title)) return undefined;
  if (/[$€£¥]/u.test(title)) return undefined;
  if (!/\p{Script=Han}/u.test(title)) return undefined;

  const chars = Array.from(title);
  if (chars.length > PROGRESS_TITLE_MAX_CHARS) {
    title = chars.slice(0, PROGRESS_TITLE_MAX_CHARS).join('');
  }
  return title || undefined;
}

function fallbackForTool(evt: Extract<AgentEvent, { type: 'tool_use' }>): string {
  switch (evt.kind) {
    case 'command':
      return '执行命令';
    case 'file':
      return '修改文件';
    case 'search':
      return '检索资料';
    default:
      return '调用工具';
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Coalesces reasoning/tool events into a background title sidecar. It never
 * blocks the main run: one request is in flight at a time, updates are throttled,
 * and timeout/failure falls back to the deterministic action label.
 */
export class ProgressTitleController {
  private readonly goal: string;
  private readonly generate?: ProgressTitleGenerator;
  private readonly onChange: (title: string) => void;
  private readonly onError?: (error: unknown) => void;
  private readonly initialTitle: string;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly maxGenerations: number;

  private latestReasoning = '';
  private latestReasoningKey = '';
  private readonly toolTitles: string[] = [];
  private lastTitle?: string;
  private hasGeneratedTitle = false;
  private inFlight = false;
  private pending = false;
  private disposed = false;
  private generations = 0;
  private lastRequestAt = Number.NEGATIVE_INFINITY;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(opts: ProgressTitleControllerOptions) {
    this.goal = opts.goal;
    this.generate = opts.generate;
    this.onChange = opts.onChange;
    this.onError = opts.onError;
    this.initialTitle = opts.initialTitle ?? '分析问题';
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxGenerations = opts.maxGenerations ?? DEFAULT_MAX_GENERATIONS;
  }

  start(): void {
    if (this.disposed) return;
    this.emit(this.initialTitle);
  }

  observe(evt: AgentEvent): void {
    if (this.disposed) return;

    if (evt.type === 'thinking') {
      const reasoning = evt.text.trim();
      const key = oneLine(reasoning);
      if (!reasoning || key === this.latestReasoningKey) return;
      this.latestReasoning = reasoning;
      this.latestReasoningKey = key;
      this.request();
      return;
    }

    if (evt.type === 'tool_use') {
      const tool = oneLine(evt.title);
      if (tool) {
        this.toolTitles.push(tool);
        if (this.toolTitles.length > TOOL_TITLES_MAX) this.toolTitles.shift();
      }
      if (!this.hasGeneratedTitle) this.emit(fallbackForTool(evt));
      this.request();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.pending = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private emit(title: string): void {
    const clean = oneLine(title);
    if (!clean || clean === this.lastTitle) return;
    this.lastTitle = clean;
    try {
      this.onChange(clean);
    } catch (error) {
      this.onError?.(error);
    }
  }

  private request(): void {
    if (this.disposed || !this.generate || this.generations >= this.maxGenerations) return;
    if (this.inFlight) {
      this.pending = true;
      return;
    }

    const waitMs = this.minIntervalMs - (Date.now() - this.lastRequestAt);
    if (waitMs > 0) {
      this.pending = true;
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          if (this.pending && !this.disposed) {
            this.pending = false;
            this.request();
          }
        }, waitMs);
        this.timer.unref?.();
      }
      return;
    }

    void this.run();
  }

  private async run(): Promise<void> {
    if (this.disposed || !this.generate || this.generations >= this.maxGenerations) return;

    this.inFlight = true;
    this.lastRequestAt = Date.now();
    this.generations += 1;
    const input: ProgressTitleInput = {
      goal: this.goal,
      reasoning: this.latestReasoning,
      toolTitles: [...this.toolTitles],
      previousTitle: this.lastTitle,
    };

    try {
      const generated = await withTimeout(this.generate(input), this.timeoutMs);
      const title = generated ? cleanProgressTitle(generated) : undefined;
      if (title && !this.disposed) {
        this.hasGeneratedTitle = true;
        this.emit(title);
      }
    } catch (error) {
      this.onError?.(error);
    } finally {
      this.inFlight = false;
      if (this.pending && !this.disposed) {
        this.pending = false;
        this.request();
      }
    }
  }
}
