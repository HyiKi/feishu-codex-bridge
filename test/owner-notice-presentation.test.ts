import { afterEach, expect, it, vi } from 'vitest';
import { vonvonImportNotice, type DesktopRelease } from '../src/service/desktop-release';
import { buildDmMenuCard, buildOwnerImportNoticeCard, buildUpdateCard } from '../src/card/dm-cards';

afterEach(() => vi.unstubAllEnvs());

it('offers import guidance without a link when no download page is configured', () => {
  vi.stubEnv('VONVON_BOT_DOWNLOAD_PAGE', '');
  const notice = vonvonImportNotice();
  expect(notice.download).toEqual({ kind: 'unconfigured' });
  expect(JSON.stringify(buildOwnerImportNoticeCard(notice))).toContain('导入');
  expect(JSON.stringify(buildOwnerImportNoticeCard(notice))).not.toContain('open_url');
});

it('labels an official configured page as publication unverified', () => {
  vi.stubEnv('VONVON_BOT_DOWNLOAD_PAGE', 'https://github.com/modelzen/vonvon-bot/releases/latest');
  const notice = vonvonImportNotice();
  expect(notice.download).toEqual({ kind: 'candidate-page', url: 'https://github.com/modelzen/vonvon-bot/releases/latest' });
  expect(notice.text).toContain('尚未验证');
  expect(JSON.stringify(buildOwnerImportNoticeCard(notice))).toContain('发布状态未验证');
});

it.each([
  'http://github.com/modelzen/vonvon-bot/releases',
  'https://github.com@evil.test/modelzen/vonvon-bot/releases',
  'https://user:pass@github.com/modelzen/vonvon-bot/releases',
  'https://github.com/modelzen/vonvon-bridge/releases',
  'https://github.com/modelzen/vonvon-bot/releases/download/v1/fake.pkg',
  'https://github.com/modelzen/vonvon-bot/releases?x=1',
  'invalid',
])('rejects untrusted or non-page candidate %s', (url) => {
  vi.stubEnv('VONVON_BOT_DOWNLOAD_PAGE', url);
  expect(vonvonImportNotice().download.kind).toBe('unconfigured');
});

it.each(['vonvon-bridge', 'vonvon-bot'])('does not advertise a guessed %s installer as published', (repo) => {
  vi.stubEnv('VONVON_BOT_DOWNLOAD_PAGE', `https://github.com/modelzen/${repo}/releases/download/v0.7.0/fake.pkg`);
  const notice = vonvonImportNotice();
  expect(notice.download).toEqual({ kind: 'unconfigured' });
  expect(JSON.stringify(buildOwnerImportNoticeCard(notice))).not.toContain('open_url');
});

it('renders arbitrary notice content as plain text without markdown interpretation', () => {
  const text = '<at id="all">@all</at> [click](https://evil.test)';
  const rendered = buildOwnerImportNoticeCard({ text, download: { kind: 'unconfigured' } });
  expect(JSON.stringify(rendered)).toContain(JSON.stringify({ tag: 'plain_text', content: text }));
  expect(JSON.stringify(rendered)).not.toContain('open_url');
});

it('shows import guidance in menu and update cards without relabeling an old Bridge release', () => {
  vi.stubEnv('VONVON_BOT_DOWNLOAD_PAGE', '');
  const oldRelease = { version: '0.7.0', installers: [{ platform: 'macOS', url: 'https://github.com/modelzen/vonvon-bridge/releases/download/v0.7.0/old.pkg' }] } satisfies DesktopRelease;
  const menu = JSON.stringify(buildDmMenuCard({ desktopRelease: oldRelease }));
  const update = JSON.stringify(buildUpdateCard({ phase: 'checked', current: '0.7.0', latest: '0.7.0', hasUpdate: false, desktopRelease: oldRelease }));
  for (const content of [menu, update]) {
    expect(content).toContain('导入已有 Bridge 配置');
    expect(content).not.toContain('old.pkg');
    expect(content).not.toContain('open_url');
  }
});

it('offers only the unverified official candidate in menu and update cards', () => {
  vi.stubEnv('VONVON_BOT_DOWNLOAD_PAGE', 'https://github.com/modelzen/vonvon-bot/releases/latest');
  for (const content of [
    JSON.stringify(buildDmMenuCard()),
    ...(['checking', 'checked', 'updating', 'done', 'error'] as const).map((phase) => JSON.stringify(buildUpdateCard({ phase, current: '0.7.0', latest: '0.7.0', hasUpdate: false }))),
  ]) {
    expect(content).toContain('发布状态未验证');
    expect(content).toContain('https://github.com/modelzen/vonvon-bot/releases/latest');
  }
});

it('embeds the notice safely in the existing overview HTML', async () => {
  vi.stubEnv('VONVON_BOT_DOWNLOAD_PAGE', 'https://github.com/modelzen/vonvon-bot/releases/latest');
  vi.resetModules();
  const { UI_HTML } = await import('../src/web/ui');
  expect(UI_HTML).toContain('导入 Vonvon Bot');
  expect(UI_HTML).toContain('发布状态尚未验证');
  expect(UI_HTML).toContain('https://github.com/modelzen/vonvon-bot/releases/latest');
  expect(UI_HTML).not.toContain('Vonvon-Bridge-0.7.0');
  expect(UI_HTML).toContain('textContent');
});

it('does not put a malformed configured page into the embedded script', async () => {
  vi.stubEnv('VONVON_BOT_DOWNLOAD_PAGE', 'https://github.com/modelzen/vonvon-bot/releases/latest</script><script>alert(1)</script>');
  vi.resetModules();
  const { UI_HTML } = await import('../src/web/ui');
  expect(UI_HTML).not.toContain('alert(1)');
  expect(UI_HTML).toContain('"kind":"unconfigured"');
});
