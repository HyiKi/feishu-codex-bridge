import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildProgressTitlePrompt,
  cleanProgressTitle,
  ProgressTitleController,
} from '../src/bot/progress-title';

afterEach(() => {
  vi.useRealTimers();
});

describe('progress title sidecar', () => {
  it('sanitizes model output and rejects detail leaks', () => {
    expect(cleanProgressTitle('{"title":"核对包裹税费"}')).toBe('核对包裹税费');
    expect(cleanProgressTitle('```json\n{"title":"查询物流订单"}\n```')).toBe('查询物流订单');
    expect(cleanProgressTitle('核对包裹税费')).toBe('核对包裹税费');
    expect(cleanProgressTitle('/Users/example/private')).toBeUndefined();
    expect(cleanProgressTitle('https://example.com')).toBeUndefined();
    expect(cleanProgressTitle('Checking package fee')).toBeUndefined();
    expect(Array.from(cleanProgressTitle('核'.repeat(30)) ?? '')).toHaveLength(16);
  });

  it('builds a bounded prompt around the goal, hidden reasoning, and tools', () => {
    const prompt = buildProgressTitlePrompt({
      goal: 'G'.repeat(2_000),
      reasoning: '前文'.repeat(1_000) + '正在核对税费',
      toolTitles: ['query', 'read_file', 'exec'],
      previousTitle: '查询物流订单',
    });
    expect(prompt).toContain('正在核对税费');
    expect(prompt).toContain('上一个标题');
    expect(prompt).toContain('查询物流订单');
    expect(Array.from(prompt).length).toBeLessThan(5_000);
  });

  it('emits a fallback immediately, then replaces it with the generated Chinese title', async () => {
    const changes: string[] = [];
    const generate = vi.fn().mockResolvedValue('核对包裹税费');
    const controller = new ProgressTitleController({
      goal: '查这个包裹的税费',
      generate,
      minIntervalMs: 0,
      onChange: (title) => changes.push(title),
    });

    controller.start();
    controller.observe({ type: 'tool_use', itemId: 't1', title: 'query', kind: 'tool' });
    await vi.waitFor(() => expect(changes).toContain('核对包裹税费'));

    expect(changes[0]).toBe('分析问题');
    expect(changes).toContain('调用工具');
    expect(generate).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('deduplicates summary/content reasoning and throttles rapid updates', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const generate = vi.fn().mockResolvedValue('查询物流订单');
    const controller = new ProgressTitleController({
      goal: '查询订单',
      generate,
      minIntervalMs: 5_000,
      onChange: () => undefined,
    });

    controller.start();
    controller.observe({ type: 'thinking', itemId: 'summary', text: 'Need query the order table' });
    await vi.advanceTimersByTimeAsync(0);
    expect(generate).toHaveBeenCalledTimes(1);

    controller.observe({ type: 'thinking', itemId: 'content', text: 'Need query the order table' });
    await vi.advanceTimersByTimeAsync(0);
    expect(generate).toHaveBeenCalledTimes(1);

    controller.observe({ type: 'thinking', itemId: 'next', text: 'Need verify the tracking number' });
    expect(generate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(generate).toHaveBeenCalledTimes(2);

    controller.dispose();
  });

  it('keeps the fallback when generation fails or times out', async () => {
    const errors: unknown[] = [];
    const controller = new ProgressTitleController({
      goal: '分析配置',
      generate: vi.fn().mockImplementation(() => Promise.reject(new Error('sidecar down'))),
      minIntervalMs: 0,
      onChange: () => undefined,
      onError: (error) => errors.push(error),
    });

    controller.start();
    controller.observe({ type: 'thinking', itemId: 'r1', text: 'Need inspect config' });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    controller.dispose();
  });
});
