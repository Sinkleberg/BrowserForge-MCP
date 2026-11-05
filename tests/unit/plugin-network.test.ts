import { afterEach, describe, expect, it, vi } from 'vitest';
import { describePermissions, normalizePermissions, parseManifest, samePermissions } from '@browserforge/plugin-sdk';
import { createTestApi } from '@browserforge/plugin-sdk/testing';

const base = { id: 'network-demo', toolPrefix: 'netdemo', description: 'Network test', permissions: { network: ['https://api.github.com'] } };
const cleanups: (() => void)[] = [];
afterEach(() => { vi.unstubAllGlobals(); while (cleanups.length) cleanups.pop()!(); });
function api(grant: 'manifest' | 'none' = 'manifest') {
  const t = createTestApi(base, { grant }); cleanups.push(t.cleanup); return t.api;
}

describe('public network permissions', () => {
  it('normalizes legacy grants without introducing a permission, and detects origin changes', () => {
    const old = { browser: false, files: { read: [], write: [] }, exec: [] };
    expect(normalizePermissions(old)).toEqual(old);
    expect(samePermissions(old, { ...old, network: [] })).toBe(true);
    expect(samePermissions(old, { ...old, network: ['https://api.github.com'] })).toBe(false);
    expect(samePermissions({ ...old, network: ['https://a.test'] }, { ...old, network: ['https://b.test'] })).toBe(false);
    const manifest = parseManifest({ ...base, permissions: { network: ['https://api.github.com', 'https://api.github.com'] } });
    expect(manifest.permissions.network).toEqual(['https://api.github.com']);
    expect(describePermissions(manifest)).toEqual(['Read public data from: https://api.github.com (HTTPS GET/HEAD only; no credentials or redirects)']);
  });

  it.each(['http://api.github.com', 'https://*.github.com', 'https://api.github.com/', 'https://api.github.com/path', 'https://api.github.com?q=x', 'https://user:secret@api.github.com', 'https://api.github.com#fragment'])('rejects a non-origin permission: %s', (origin) => {
    expect(() => parseManifest({ ...base, permissions: { network: [origin] } })).toThrow(/exact HTTPS origin/);
  });

  it('only sends public GET/HEAD with fixed headers, no credentials and no redirect following', async () => {
    const request = vi.fn(async (_url: URL, _opts: RequestInit) => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', request);
    const response = await api().fetch('https://api.github.com/repos/demo/example');
    expect(response.body).toBe('{"ok":true}');
    expect(request.mock.calls[0]).toEqual([new URL('https://api.github.com/repos/demo/example'), expect.objectContaining({ method: 'GET', credentials: 'omit', redirect: 'manual', headers: { accept: 'application/json', 'user-agent': 'BrowserForge-plugin' } })]);
    await api().fetch('https://api.github.com/repos/demo/example', { method: 'HEAD' });
    expect(request.mock.calls[1]?.[1]).toMatchObject({ method: 'HEAD' });
  });

  it.each(['https://evil.test', 'https://api.github.com.evil.test/x', 'http://api.github.com/x', 'https://user:secret@api.github.com/x'])('refuses an unapproved URL before sending: %s', async (url) => {
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    await expect(api().fetch(url)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses an ungranted origin, write methods and invalid timeouts before sending', async () => {
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    await expect(api('none').fetch('https://api.github.com')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    for (const method of ['POST', 'PUT', 'DELETE']) await expect(api().fetch('https://api.github.com', { method: method as 'GET' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    for (const timeoutMs of [NaN, Infinity, 0, 30_001]) await expect(api().fetch('https://api.github.com', { timeoutMs })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses redirects rather than contacting their destination', async () => {
    const request = vi.fn(async () => new Response('', { status: 302, headers: { location: 'https://evil.test' } }));
    vi.stubGlobal('fetch', request);
    await expect(api().fetch('https://api.github.com')).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: 'Network redirects are refused' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('bounds the decoded body even when content-length is absent or false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(1024 * 1024 + 1), { headers: { 'content-length': '1' } })));
    await expect(api().fetch('https://api.github.com')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('times out a request and returns a safe error without reflecting network details', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: URL, opts: RequestInit) => new Promise((_resolve, reject) => {
      opts.signal!.addEventListener('abort', () => reject(new Error('network secret')), { once: true });
    })));
    await expect(api().fetch('https://api.github.com', { timeoutMs: 100 })).rejects.toMatchObject({ code: 'TIMEOUT', message: 'Network request timed out' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network secret'); }));
    await expect(api().fetch('https://api.github.com')).rejects.toMatchObject({ code: 'INTERNAL', message: 'Public network request failed' });
  });
});
