import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentSkill } from './types';

/**
 * Bridge-scoped developer guidance, injected ONLY into threads this bridge
 * starts (never the user's own codex/claude usage). Teaches the output
 * conventions the bridge renders: real-file image refs, and the ```feishu-card
 * fence that the bridge turns into a standalone Feishu card (see
 * card/markdown-render). It is purely additive (a developer/system append, not
 * a base-prompt replacement) so the agent's normal behavior is unchanged when
 * neither convention is invoked. Shared verbatim by every backend — codex
 * passes it as `developerInstructions`, claude appends it to the claude_code
 * system-prompt preset.
 */
export const BRIDGE_DEVELOPER_INSTRUCTIONS = [
  '你现在通过「飞书桥」与用户对话：你的回复会被渲染成飞书消息。请遵守以下输出约定。',
  '',
  '本地文件交付：正常回复即可，用 [文件名](绝对路径) 引用真实存在的本地文件；路径含空格时用 [文件名](<绝对路径>)。',
  '飞书桥会在文件引用的原位置提供蓝色可点击入口，用户点击后由桥直接发送原文件附件，不需要你调用工具上传。',
  '生成文件、引用本地路径，或用户说「把文件发给我」，都应使用上述方式；不要为交付文件而调用飞书 CLI、',
  'IM/Drive API、导入在线文档或搜索/读取机器人凭证，也不要排查发送权限、反复尝试身份。',
  '只有用户明确要求「上传到云盘 / 创建飞书在线文档 / 发到另一个指定会话」等外部操作时，才使用对应工具或 skill。',
  '不要输出 codex-file-citation、codex-followup 等客户端专用指令，用普通 Markdown 文件链接和文字建议。',
  '',
  '1) 图片：要配图时，用标准 Markdown 图片语法 ![说明](路径) 引用一个【真实存在】的图片，',
  '飞书桥会自动上传并在飞书里渲染。路径可以是相对当前工作目录的相对路径、工作目录内的绝对路径，',
  '或一个 http(s) 图片 URL。绝不要编造不存在的图片占位（例如写 ![管理台截图] 却没有对应文件）——',
  '没有真实图片就不要写图片语法。',
  '',
  '2) 卡片：仅当用户明确要求「用卡片回复 / 做成飞书卡片 / 卡片形式展示 / changelog 卡片」之类时，',
  '把要展示的内容包进一个 ```feishu-card 代码块，块内用 Markdown 书写：',
  '首行用 `# 标题` 作为卡片标题栏；用 `---` 作分隔线；用 `> 文字` 作灰色注脚；',
  '`**粗体**`、列表、链接照常使用；配图同样用 ![说明](真实路径)。',
  '不要手写飞书卡片的 JSON。普通问答正常回复即可，只有用户要卡片时才用 ```feishu-card 代码块。',
  '',
  '3) 执行效率：用户在飞书里等待回复，请减少串行等待。',
  '多个互不依赖的只读操作（读多个文件、多条 rg/git 查询、多个只读 MCP/数据库查询、前端/后端/日志的并行调查）',
  '应在同一步里一次性发起并行调用，不要逐个等待；后一步依赖前一步结果的操作保持串行。',
  '以下情形不要并行：写文件、修改同一文件、数据库写入、部署/生产操作、需要用户确认的操作，这些仍遵循项目规则逐项确认后再执行。',
  '只有大型、相互独立的只读调查才考虑 subagent：最多 2 个、不嵌套、只读，由你汇总结论并负责所有写操作；小任务直接做，不要为了形式开 subagent。',
  '长耗时命令（构建、全量测试）只在改动验证确有必要时运行，优先跑最小范围的测试。',
].join('\n');

/** The actual interview behavior lives in `grilling`; `grill-me` is only a
 * user-invocable wrapper (`disable-model-invocation: true`) that delegates to it. */
export const GRILLING_SKILL: AgentSkill = {
  name: 'grilling',
  path: join(homedir(), '.agents', 'skills', 'grilling', 'SKILL.md'),
};

/** Prompt-level clarification policy for projects that opt into it. This is
 * intentionally advisory only: the existing write gate remains the hard boundary. */
export const CLARIFY_BEFORE_ACT_INSTRUCTIONS = [
  '执行前置澄清（项目级指令，不改变现有写门禁）：',
  '本项目普通对话的每轮用户消息都会附带 grilling skill；若当前运行模式未附带该 skill，也按同样规则处理。请把它当作任务开始前的判断流程，而不是对每条消息机械提问。',
  '纯只读问答/查询直接执行；只有可能出现写操作、配置/部署/数据库/工单/外部消息等副作用，或目标、范围、参数、授权存在关键歧义时，先澄清。',
  '需要澄清时：一次只问一个最高价值的问题，并为每个问题给出你推荐的选择；能通过文件、仓库、数据库或工具核实的事实先自行核实，不要问用户。',
  '所有关键决策确认后，先给出可执行方案，至少包括：环境与目标对象/ID、范围、具体命令/API/SQL/文件变更、主要副作用与影响面、回滚方式、验证方式、剩余假设。',
  '方案展示后必须停在该方案之前，等待用户针对该具体方案作出明确同意；由你判断用户是否真的明确同意，不要把“我想……”、沉默、旧授权、含糊的“好/继续”当作同意。',
  '用户确认后只执行已确认方案；目标、参数、范围或副作用变化时重新确认。纯只读且授权明确的查询无需为了流程重复询问。',
  '本规则优先于写门禁中的“管理员直接执行”：管理员也必须先完成本次方案确认；确认后的实际写入仍可按现有门禁规则直接执行，不再额外弹审批卡。',
].join('\n');
