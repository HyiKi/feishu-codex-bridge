import { describe, expect, it } from 'vitest';
import { BRIDGE_DEVELOPER_INSTRUCTIONS } from '../src/agent/bridge-instructions';

describe('bridge developer instructions', () => {
  it('answers supported facts before marking a specific evidence gap', () => {
    expect(BRIDGE_DEVELOPER_INSTRUCTIONS).toContain('先完整回答已有证据能确认的部分');
    expect(BRIDGE_DEVELOPER_INSTRUCTIONS).toContain('具体子结论');
    expect(BRIDGE_DEVELOPER_INSTRUCTIONS).toContain('已查来源、缺失依据和影响');
  });

  it('reserves unknown for execution state', () => {
    expect(BRIDGE_DEVELOPER_INSTRUCTIONS).not.toContain('无法验证的分支写 unknown');
    expect(BRIDGE_DEVELOPER_INSTRUCTIONS).toContain('unknown 只用于工具或写入执行状态本身未知');
  });
});
