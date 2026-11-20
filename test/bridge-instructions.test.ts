import { describe, expect, it } from 'vitest';
import { BRIDGE_DEVELOPER_INSTRUCTIONS } from '../src/agent/bridge-instructions';

describe('bridge developer instructions', () => {
  it('answers supported facts before marking a specific evidence gap', () => {
    expect(BRIDGE_DEVELOPER_INSTRUCTIONS).toContain('先完整回答已有证据能确认的部分');
    expect(BRIDGE_DEVELOPER_INSTRUCTIONS).toContain('具体子结论');
    expect(BRIDGE_DEVELOPER_INSTRUCTIONS).toContain('已查来源、缺失依据和影响');
  });

  it('uses concrete Chinese states instead of an English placeholder', () => {
    expect(BRIDGE_DEVELOPER_INSTRUCTIONS).not.toMatch(/\bunknown\b/i);
    expect(BRIDGE_DEVELOPER_INSTRUCTIONS).toContain('不得输出英文占位词');
    expect(BRIDGE_DEVELOPER_INSTRUCTIONS).toContain('实际费用待出账后核实');
  });
});
