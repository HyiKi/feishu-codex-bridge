import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { AppConfig } from '../src/config/schema';
import { sendManagedCard } from '../src/card/managed';

vi.mock('../src/card/managed', () => ({ sendManagedCard: vi.fn() }));
vi.mock('../src/service/desktop-release', async (original) => ({ ...await original<typeof import('../src/service/desktop-release')>(), getDesktopRelease: vi.fn(async () => null) }));

const channel = {} as LarkChannel;
let home: string;
const config = (appId = 'app_a', owner = 'ou_a'): AppConfig => ({ accounts: { app: { id: appId, secret: '', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: owner } } });
async function operation() { return (await import('../src/bot/owner-notice')).notifyOwnerOfVonvonBot; }
async function directory() { return join((await import('../src/config/paths')).paths.appDir, 'owner-notices'); }

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  home = mkdtempSync(join(tmpdir(), 'notice-delivery-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('VONVON_BOT_DOWNLOAD_PAGE', '');
  vi.mocked(sendManagedCard).mockResolvedValue({ messageId: 'om_receipt', cardId: 'card_receipt' });
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

it('records a confirmed delivery privately and skips across module restart', async () => {
  expect(await (await operation())({ cfg: config(), channel })).toEqual({ kind: 'delivered' });
  const dir = await directory();
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
  expect(JSON.parse(readFileSync(join(dir, files[0]!), 'utf8'))).toEqual({ version: 'vonvon-bot-import-v1', messageId: 'om_receipt' });
  if (process.platform !== 'win32') expect(statSync(join(dir, files[0]!)).mode & 0o777).toBe(0o600);
  expect(sendManagedCard).toHaveBeenCalledWith(channel, 'ou_a', expect.any(Object), undefined, false, 'open_id');
  vi.resetModules();
  expect(await (await operation())({ cfg: config(), channel })).toEqual({ kind: 'already-delivered' });
  expect(sendManagedCard).toHaveBeenCalledTimes(1);
});

it('delivers import guidance without looking up the legacy Bridge release', async () => {
  const { getDesktopRelease } = await import('../src/service/desktop-release');
  expect(await (await operation())({ cfg: config(), channel })).toEqual({ kind: 'delivered' });
  expect(sendManagedCard).toHaveBeenCalledTimes(1);
  expect(getDesktopRelease).not.toHaveBeenCalled();
});

it('coalesces concurrent attempts and isolates application and owner keys', async () => {
  const notify = await operation();
  await Promise.all([notify({ cfg: config(), channel }), notify({ cfg: config(), channel })]);
  expect(sendManagedCard).toHaveBeenCalledTimes(1);
  await notify({ cfg: config('app_b'), channel });
  await notify({ cfg: config('app_a', 'ou_b'), channel });
  expect(sendManagedCard).toHaveBeenCalledTimes(3);
});

it.each(['missing', 'failure'])('does not record %s delivery and suppresses in-process retries', async (kind) => {
  if (kind === 'missing') vi.mocked(sendManagedCard).mockResolvedValue({ messageId: ' ', cardId: 'card_receipt' });
  else vi.mocked(sendManagedCard).mockRejectedValue(new Error('offline'));
  const notify = await operation();
  expect((await notify({ cfg: config(), channel })).kind).toBe('delivery-unconfirmed');
  expect((await notify({ cfg: config(), channel })).kind).toBe('delivery-unconfirmed');
  expect(sendManagedCard).toHaveBeenCalledTimes(1);
  const dir = await directory();
  expect(() => readdirSync(dir)).toThrow();
  vi.resetModules();
  vi.mocked(sendManagedCard).mockResolvedValue({ messageId: 'om_retry', cardId: 'card_retry' });
  expect((await (await operation())({ cfg: config(), channel })).kind).toBe('delivered');
  expect(sendManagedCard).toHaveBeenCalledTimes(2);
});

it('skips ownerless configs and uses only the existing first-admin fallback', async () => {
  const cfg = config();
  cfg.preferences = {};
  expect(await (await operation())({ cfg, channel })).toEqual({ kind: 'no-owner' });
  expect(sendManagedCard).not.toHaveBeenCalled();
  cfg.preferences = { access: { admins: ['ou_legacy', 'ou_other'] } };
  expect((await (await operation())({ cfg, channel })).kind).toBe('delivered');
  expect(sendManagedCard).toHaveBeenCalledWith(channel, 'ou_legacy', expect.any(Object), undefined, false, 'open_id');
});

it.each(['corrupt', 'unreadable', 'dangling-link'])('fails closed on %s receipt state', async (kind) => {
  await (await operation())({ cfg: config(), channel });
  const dir = await directory();
  const flag = join(dir, readdirSync(dir)[0]!);
  if (kind === 'corrupt') writeFileSync(flag, '{');
  else {
    rmSync(flag);
    if (kind === 'dangling-link') symlinkSync(join(dir, 'absent'), flag, process.platform === 'win32' ? 'junction' : 'file');
    else mkdirSync(flag);
  }
  vi.resetModules();
  expect(await (await operation())({ cfg: config(), channel })).toMatchObject({ kind: 'not-sent', reason: 'state-unreadable' });
  expect(sendManagedCard).toHaveBeenCalledTimes(1);
});

it('reports confirmed delivery whose receipt cannot be written', async () => {
  vi.mocked(sendManagedCard).mockImplementation(async () => {
    const dir = await directory();
    mkdirSync(join(dir, '..'), { recursive: true });
    writeFileSync(dir, 'blocks directory creation');
    return { messageId: 'om_receipt', cardId: 'card_receipt' };
  });
  expect((await (await operation())({ cfg: config(), channel })).kind).toBe('delivered-unrecorded');
});

it.each([false, true])('holds channel and app lock until deferred delivery settles, mount failure %s', async (mountFails) => {
  let settle!: (value: { messageId: string; cardId: string }) => void;
  const deferred = new Promise<{ messageId: string; cardId: string }>((resolve) => { settle = resolve; });
  vi.mocked(sendManagedCard).mockReturnValue(deferred);
  const shutdown = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const waitForRequest = vi.fn(async () => {});
  const mount = vi.fn(async () => {
    if (mountFails) throw new Error('mount failed');
    return { close, url: '', port: 0 };
  });
  vi.doMock('../src/bot/onboarding', () => ({ ensureOnboarded: async () => ({ cfg: config(), secret: '' }), announceEventsWhenLive: async () => {} }));
  vi.doMock('../src/bot/bridge', () => ({ startBridge: async () => ({ channel, shutdown }) }));
  vi.doMock('../src/web/mount', () => ({ mountWebConsole: mount }));
  const originalSend = Object.getOwnPropertyDescriptor(process, 'send');
  Reflect.deleteProperty(process, 'send');
  try {
    const { paths } = await import('../src/config/paths');
    const { runRun } = await import('../src/cli/commands/run');
    let completed = false;
    const running = runRun('app_a', { control: { requested: true, waitForRequest, dispose() {} } })
      .then(() => { completed = true; return undefined; }, (error: unknown) => { completed = true; return error; });
    await vi.waitFor(() => expect(sendManagedCard).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mount).toHaveBeenCalledTimes(1));
    expect(completed).toBe(false);
    expect(shutdown).not.toHaveBeenCalled();
    expect(existsSync(paths.processesFile)).toBe(true);
    if (!mountFails) expect(waitForRequest).toHaveBeenCalledTimes(1);
    settle({ messageId: 'om_receipt', cardId: 'card_receipt' });
    const error = await running;
    if (mountFails) expect(error).toEqual(new Error('mount failed'));
    else expect(error).toBeUndefined();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(existsSync(paths.processesFile)).toBe(false);
  } finally {
    settle({ messageId: 'om_receipt', cardId: 'card_receipt' });
    if (originalSend) Object.defineProperty(process, 'send', originalSend);
    vi.doUnmock('../src/bot/onboarding');
    vi.doUnmock('../src/bot/bridge');
    vi.doUnmock('../src/web/mount');
  }
});
