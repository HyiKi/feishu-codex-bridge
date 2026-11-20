import { describe, expect, it } from 'vitest';
import {
  REVALIDATION_GATE,
  isConfirmationRequest,
  isRootCauseRequest,
  shouldRevalidate,
  withRevalidationGate,
} from '../src/bot/reasoning-guard';

describe('reasoning guard', () => {
  it('recognizes explicit confirmation and root-cause wording', () => {
    expect(isConfirmationRequest('确认最终原因给我，并给方案')).toBe(true);
    expect(isRootCauseRequest('为什么这 163 件没有轨迹')).toBe(true);
    expect(isRootCauseRequest('帮我看下这个报错')).toBe(false);
  });

  it('requires revalidation for explicit confirmation when history exists', () => {
    expect(shouldRevalidate({ text: '确认最终原因', hasPrior: true, modelChanged: false })).toBe(true);
    expect(shouldRevalidate({ text: '确认最终原因', hasPrior: false, modelChanged: false })).toBe(false);
  });

  it('only escalates a model switch for root-cause questions', () => {
    expect(shouldRevalidate({ text: '继续排查这个原因', hasPrior: true, modelChanged: true })).toBe(true);
    expect(shouldRevalidate({ text: '继续刚才的任务', hasPrior: true, modelChanged: true })).toBe(false);
  });

  it('prepends the revalidation gate without dropping the user text', () => {
    const text = withRevalidationGate('确认最终原因');
    expect(text).toContain(REVALIDATION_GATE);
    expect(text.endsWith('确认最终原因')).toBe(true);
  });

  it('keeps uncertainty local instead of recommending an unknown fallback', () => {
    expect(REVALIDATION_GATE).toContain('尚未复验：<具体事实>');
    expect(REVALIDATION_GATE).toContain('缺哪条决定性证据');
    expect(REVALIDATION_GATE).not.toContain('或 unknown');
    expect(REVALIDATION_GATE).not.toContain('禁止写“最终原因”');
  });
});
