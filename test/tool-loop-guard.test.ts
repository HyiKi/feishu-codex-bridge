import { describe, expect, it } from 'vitest';
import { ToolLoopGuard } from '../src/bot/tool-loop-guard';

const tool = (itemId: string) =>
  ({ type: 'tool_use', itemId, title: `tool-${itemId}`, kind: 'tool' }) as const;

describe('ToolLoopGuard', () => {
  it('nudges once after the threshold when no visible text exists', () => {
    const guard = new ToolLoopGuard({ threshold: 3 });
    expect(guard.observe(tool('1'))).toBe(false);
    expect(guard.observe(tool('2'))).toBe(false);
    expect(guard.observe(tool('3'))).toBe(true);
    expect(guard.observe(tool('4'))).toBe(false);
    expect(guard.toolUses).toBe(4);
    expect(guard.didNudge).toBe(true);
  });

  it('allows a normal root-cause investigation before the default threshold', () => {
    const guard = new ToolLoopGuard();
    for (let i = 1; i <= 8; i += 1) {
      expect(guard.observe(tool(`${i}`))).toBe(false);
    }
    expect(guard.didNudge).toBe(false);
  });

  it('nudges when the same tool call repeats', () => {
    const guard = new ToolLoopGuard({ threshold: 20, repeatThreshold: 3 });
    expect(guard.observe(tool('same'))).toBe(false);
    expect(guard.observe(tool('same'))).toBe(false);
    expect(guard.observe(tool('same'))).toBe(true);
  });

  it('nudges after twenty distinct tools', () => {
    const guard = new ToolLoopGuard();
    for (let i = 1; i < 20; i += 1) {
      expect(guard.observe(tool(`${i}`))).toBe(false);
    }
    expect(guard.observe(tool('20'))).toBe(true);
  });

  it('restarts the silent-tool count after visible text', () => {
    const guard = new ToolLoopGuard({ threshold: 2 });
    expect(guard.observe({ type: 'text_delta', itemId: 'a', delta: '先给一个结论' })).toBe(false);
    expect(guard.observe(tool('1'))).toBe(false);
    expect(guard.observe(tool('2'))).toBe(true);
    expect(guard.didNudge).toBe(true);
  });

  it('treats whitespace-only text as still silent', () => {
    const guard = new ToolLoopGuard({ threshold: 1 });
    expect(guard.observe({ type: 'text_delta', itemId: 'a', delta: ' \n ' })).toBe(false);
    expect(guard.observe(tool('1'))).toBe(true);
  });

  it('re-checks canNudge instead of permanently consuming the threshold', () => {
    let canNudge = false;
    const guard = new ToolLoopGuard({ threshold: 2, canNudge: () => canNudge });
    expect(guard.observe(tool('1'))).toBe(false);
    expect(guard.observe(tool('2'))).toBe(false);
    canNudge = true;
    expect(guard.observe(tool('3'))).toBe(true);
  });
});
