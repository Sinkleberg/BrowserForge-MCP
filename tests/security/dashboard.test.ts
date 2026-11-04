import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../../apps/mcp-server/src/app.js';
import { DASHBOARD_CSS, DASHBOARD_HTML, DASHBOARD_JS } from '../../apps/mcp-server/src/dashboard/page.js';

let app: App;
let dir: string;
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-dashsec-'));
  app = createApp({ port: 0, configDir: dir, logLevel: 'error' });
  await app.listen();
});
afterAll(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const get = (p: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${app.port}${p}`, { headers });
/** fetch will not let a program choose its Host header, so the rebinding checks use a plain request. */
const rawGet = (p: string, headers: Record<string, string>) =>
  new Promise<number>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.port, path: p, headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
    req.on('error', reject);
    req.end();
  });

describe('dashboard security', () => {
  it('lets nothing run but its own two files, and nothing frame it', async () => {
    for (const p of ['/dashboard', '/dashboard/app.js', '/dashboard/app.css']) {
      const r = await get(p);
      const csp = r.headers.get('content-security-policy') ?? '';
      expect(csp, p).toContain("default-src 'none'");
      expect(csp, p).toContain("script-src 'self'");
      expect(csp, p).not.toMatch(/unsafe-inline|unsafe-eval|\*|https?:/);
      expect(csp, p).toContain("frame-ancestors 'none'");
      expect(r.headers.get('x-content-type-options'), p).toBe('nosniff');
      expect(r.headers.get('referrer-policy'), p).toBe('no-referrer');
      expect(r.headers.get('cache-control'), p).toBe('no-store');
    }
  });

  it('has no inline script, style or handler, because the policy would block them', () => {
    expect(DASHBOARD_HTML).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(DASHBOARD_HTML).not.toMatch(/\son[a-z]+\s*=/i);
    expect(DASHBOARD_HTML).not.toMatch(/<style|style=/i);
  });

  it('never turns text from plugins, skills or flows into HTML', () => {
    for (const bad of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function/, /setTimeout\s*\(\s*['"]/]) expect(DASHBOARD_JS).not.toMatch(bad);
    expect(DASHBOARD_CSS).not.toMatch(/url\(\s*['"]?https?:/i); // nothing is fetched from elsewhere
  });

  it('takes the token from the fragment only, and removes it from the address bar', () => {
    expect(DASHBOARD_JS).toContain('location.hash');
    expect(DASHBOARD_JS).toContain('history.replaceState');
    expect(DASHBOARD_JS).not.toMatch(/location\.search|URLSearchParams/);
    expect(DASHBOARD_JS).not.toMatch(/localStorage/); // gone when the tab closes
  });

  it('does not accept the token in the address or in a cookie', async () => {
    const token = app.ctx.config.dashboardToken;
    expect((await get(`/dashboard/data?token=${token}`)).status).toBe(401);
    expect((await get(`/dashboard/data?t=${token}&access_token=${token}`)).status).toBe(401);
    expect((await get('/dashboard/data', { cookie: `token=${token}; dashboard-token=${token}` })).status).toBe(401);
    expect((await get('/dashboard/data', { authorization: token })).status).toBe(401); // needs the word Bearer
  });

  it('refuses DNS-rebinding Host headers, even for the page and with the token', async () => {
    for (const host of ['evil.example.com', '127.0.0.1.evil.com', 'localhost.evil.com:7345']) {
      for (const p of ['/dashboard', '/dashboard/data']) {
        expect(await rawGet(p, { host, authorization: `Bearer ${app.ctx.config.dashboardToken}` }), `${host}${p}`).toBe(403);
      }
    }
  });

  it('keeps its token as private as the others', () => {
    const file = path.join(dir, 'dashboard-token');
    expect(fs.existsSync(file)).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect(fs.readFileSync(file, 'utf8').trim().length).toBeGreaterThanOrEqual(32);
  });
});
