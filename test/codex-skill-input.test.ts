import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import { shutdownResidentClients } from '../src/agent/codex-appserver/client-pool';
import { writeNodeExecutable } from './helpers/node-executable';

const FAKE_SERVER = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
let buf = '';
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const record = (method, input) => fs.appendFileSync(
  path.join(__dirname, 'skill-inputs'),
  JSON.stringify({ method, input }) + '\\n',
);
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (typeof msg.id !== 'number') continue;
    if (msg.method === 'turn/start') {
      record(msg.method, msg.params.input);
      send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 't1' } } });
      send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'th_skill', turn: { id: 't1' } } });
      continue;
    }
    if (msg.method === 'turn/steer') {
      record(msg.method, msg.params.input);
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
      continue;
    }
    const result = msg.method === 'thread/start' ? { thread: { id: 'th_skill' } } : {};
    send({ jsonrpc: '2.0', id: msg.id, result });
  }
});
setInterval(() => {}, 1 << 30);
`;

const dir = mkdtempSync(join(tmpdir(), 'codex-skill-input-'));
const { bin } = writeNodeExecutable(dir, 'codex', FAKE_SERVER);
const recordFile = join(dir, 'skill-inputs');

interface RecordedInput {
  method: string;
  input: Array<Record<string, unknown>>;
}

function recordedInputs(): RecordedInput[] {
  if (!existsSync(recordFile)) return [];
  return readFileSync(recordFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordedInput);
}

async function withFakeCodex<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.CODEX_BIN;
  process.env.CODEX_BIN = bin;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
  }
}

afterAll(async () => {
  await shutdownResidentClients();
  rmSync(dir, { recursive: true, force: true });
});

describe('codex native skill input', () => {
  it('attaches thread skills to both turn/start and turn/steer', async () => {
    await withFakeCodex(async () => {
      const skill = { name: 'grilling', path: '/tmp/grilling/SKILL.md' };
      const backend = new CodexAppServerBackend();
      const thread = await backend.startThread({ cwd: dir, skills: [skill] });
      const run = thread.runStreamed({ text: 'hello' });

      await vi.waitFor(() =>
        expect(recordedInputs().filter((entry) => entry.method === 'turn/start')).toHaveLength(1),
      );
      await vi.waitFor(() => expect(run.turnId()).toBe('t1'));
      await thread.steer({ text: 'guide' }, 't1');
      await vi.waitFor(() =>
        expect(recordedInputs().filter((entry) => entry.method === 'turn/steer')).toHaveLength(1),
      );

      expect(recordedInputs()).toEqual([
        {
          method: 'turn/start',
          input: [
            { type: 'text', text: 'hello', text_elements: [] },
            { type: 'skill', name: 'grilling', path: '/tmp/grilling/SKILL.md' },
          ],
        },
        {
          method: 'turn/steer',
          input: [
            { type: 'text', text: 'guide', text_elements: [] },
            { type: 'skill', name: 'grilling', path: '/tmp/grilling/SKILL.md' },
          ],
        },
      ]);

      await thread.close();
    });
  });
});
