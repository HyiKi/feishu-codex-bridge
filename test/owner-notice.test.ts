import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertBridgeNotImported } from '../src/bot/owner-notice';
import { runRun } from '../src/cli/commands/run';
import { ensureRegistry } from '../src/config/bots';
import { ensureOnboarded } from '../src/bot/onboarding';
import { runSupervisor } from '../src/bot/supervisor';

vi.mock('../src/config/bots', async (original) => ({ ...await original<typeof import('../src/config/bots')>(), ensureRegistry: vi.fn() }));
vi.mock('../src/bot/onboarding', () => ({ ensureOnboarded: vi.fn(), announceEventsWhenLive: vi.fn() }));
vi.mock('../src/bot/supervisor', () => ({ runSupervisor: vi.fn() }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});

let home: string;
const control = { requested: false, waitForRequest: async () => {}, dispose() {} };
const marker = () => join(home, '.feishu-codex-bridge', 'migrated-to-vonvon-bot.json');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bridge-owner-notice-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  rmSync(home, { recursive: true, force: true });
});

it('allows an absent marker even when the Vonvon data root has a same-named entry', () => {
  const unrelated = join(home, '.vonvon-bridge');
  mkdirSync(unrelated);
  writeFileSync(join(unrelated, 'migrated-to-vonvon-bot.json'), '');
  expect(() => assertBridgeNotImported(home)).not.toThrow();
});

it.each(['empty', 'malformed', 'directory', 'dangling link'])('refuses when the marker is a %s', (kind) => {
  mkdirSync(join(home, '.feishu-codex-bridge'));
  if (kind === 'directory') mkdirSync(marker());
  else if (kind === 'dangling link') symlinkSync(join(home, 'missing'), marker(), process.platform === 'win32' ? 'junction' : 'file');
  else writeFileSync(marker(), kind === 'malformed' ? '{' : '');
  expect(() => assertBridgeNotImported(home)).toThrow(/Vonvon Bot/);
});

it.skipIf(process.platform === 'win32')('fails closed when a real marker parent is not a directory', () => {
  writeFileSync(join(home, '.feishu-codex-bridge'), 'not a directory');
  try {
    assertBridgeNotImported(home);
    throw new Error('Expected marker inspection to fail');
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    expect(error.message).toMatch(/Vonvon Bot/);
    expect(error.cause).toMatchObject({ code: 'ENOTDIR' });
  }
});

it('retains a denied marker inspection as its refusal cause', () => {
  const denied = Object.assign(new Error('fixture marker inspection denied'), { code: 'EACCES' });
  vi.mocked(lstatSync).mockImplementationOnce(() => { throw denied; });
  try {
    assertBridgeNotImported(home);
    throw new Error('Expected marker inspection to fail');
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    expect(error.message).toMatch(/Vonvon Bot/);
    expect(error.cause).toBe(denied);
  }
});

it.each([undefined, 'selected-bot'])('refuses direct run before registry, onboarding, or supervisor for %s', async (botName) => {
  mkdirSync(join(home, '.feishu-codex-bridge'));
  writeFileSync(marker(), '{');
  await expect(runRun(botName, { control })).rejects.toThrow(/Vonvon Bot/);
  expect(ensureRegistry).not.toHaveBeenCalled();
  expect(ensureOnboarded).not.toHaveBeenCalled();
  expect(runSupervisor).not.toHaveBeenCalled();
});
