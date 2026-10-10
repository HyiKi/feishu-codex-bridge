import { lstatSync } from 'node:fs';
import { join } from 'node:path';

export function assertBridgeNotImported(home: string): void {
  const marker = join(home, '.feishu-codex-bridge', 'migrated-to-vonvon-bot.json');
  try {
    lstatSync(marker);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw new Error(`无法检查 Vonvon Bot 导入标记 ${marker}；为避免两个客户端同时连接，Bridge 已拒绝启动。`, { cause: error });
  }
  throw new Error(`此 Bridge 已导入 Vonvon Bot（${marker}），请使用 Vonvon Bot 启动。`);
}
