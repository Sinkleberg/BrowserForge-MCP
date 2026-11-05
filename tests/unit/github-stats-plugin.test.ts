import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApi } from '@browserforge/plugin-sdk/testing';
// @ts-expect-error plain JS example plugin
import plugin from '../../examples/plugins/github-stats/index.js';

const manifest = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../examples/plugins/github-stats/package.json'), 'utf8')).browserforge;
const cleanups: (() => void)[] = [];
afterEach(() => { vi.unstubAllGlobals(); while (cleanups.length) cleanups.pop()!(); });
const run = async () => {
  const t = createTestApi(manifest); cleanups.push(t.cleanup);
  return plugin.tools[0].run({ owner: 'demo-org', repo: 'example' }, t.api);
};
const mock = (overrides: Record<string, Response> = {}) => {
  const request = vi.fn(async (url: URL) => {
    if (overrides[url.pathname]) return overrides[url.pathname];
    if (url.pathname === '/repos/demo-org/example') return Response.json({ stargazers_count: 8, forks_count: 3, open_issues_count: 12 });
    if (url.pathname === '/search/issues') {
      expect(url.searchParams.get('q')).toBe('repo:demo-org/example is:issue is:open');
      return Response.json({ total_count: 5, incomplete_results: false });
    }
    if (url.pathname.endsWith('/releases/latest')) return Response.json({ tag_name: 'v1.0', name: 'Demo release', published_at: '2026-01-01T00:00:00Z' });
    throw new Error('Unexpected request');
  });
  vi.stubGlobal('fetch', request); return request;
};

describe('public GitHub stats example', () => {
  it('declares only its public origin, is read-only and validates owner/repo input', () => {
    expect(manifest.permissions).toEqual({ network: ['https://api.github.com'] });
    const tool = plugin.tools[0];
    expect(tool.readOnly).toBe(true);
    for (const args of [{ owner: '../evil', repo: 'x' }, { owner: 'demo', repo: '../x' }, { owner: 'demo', repo: '..' }]) expect(tool.input.safeParse(args).success).toBe(false);
  });

  it('returns bounded untrusted public data and counts issues without pull requests', async () => {
    const request = mock();
    const result = await run();
    expect(result).toMatchObject({ untrustedWebContent: true, origin: 'plugin:github-stats:github', data: { repository: 'demo-org/example', stars: 8, forks: 3, openIssues: 5, latestRelease: { tag: 'v1.0', name: 'Demo release', publishedAt: '2026-01-01T00:00:00Z' } } });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('treats a missing latest release as null', async () => {
    mock({ '/repos/demo-org/example/releases/latest': new Response('', { status: 404 }) });
    expect((await run()).data.latestRelease).toBeNull();
  });

  it.each([403, 429])('stops with a clear rate-limit error for HTTP%s', async (status) => {
    const request = mock({ '/repos/demo-org/example': new Response('sensitive upstream text', { status }) });
    await expect(run()).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED', message: expect.stringContaining(`HTTP ${status}`), retryable: true });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not turn a missing repository into empty statistics', async () => {
    mock({ '/repos/demo-org/example': new Response('', { status: 404 }) });
    await expect(run()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses incomplete counts and malformed JSON', async () => {
    mock({ '/search/issues': Response.json({ total_count: 5, incomplete_results: true }) });
    await expect(run()).rejects.toMatchObject({ message: expect.stringContaining('incomplete') });
    mock({ '/repos/demo-org/example': new Response('not JSON') });
    await expect(run()).rejects.toMatchObject({ message: 'GitHub returned invalid JSON' });
  });
});
