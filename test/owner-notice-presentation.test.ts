import { afterEach, expect, it, vi } from 'vitest';
import { vonvonImportNotice } from '../src/service/desktop-release';
import { buildOwnerImportNoticeCard } from '../src/card/dm-cards';

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
