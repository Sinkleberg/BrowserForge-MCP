import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CaptchaSolver, assertLoopbackCapskipUrl } from '../../apps/mcp-server/src/tools/captcha.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} } as never;

let server: http.Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

/** A stand-in for the CapSkip app: records the submitted form, answers polls with the given replies in order. */
async function fakeCapskip(polls: string[], submit = '{"status":1,"request":"job1"}') {
  const seen: { form?: URLSearchParams; polls: number } = { polls: 0 };
  server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/in.php') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => { seen.form = new URLSearchParams(body); res.end(submit); });
      return;
    }
    if (req.url?.startsWith('/res.php')) res.end(polls[Math.min(seen.polls++, polls.length - 1)]);
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const solver = new CaptchaSolver({ enabled: true, url, apiKey: 'k', timeoutSeconds: 5, pollIntervalSeconds: 0.01 }, logger);
  return { seen, solver };
}

describe('CapSkip solver', () => {
  it('only accepts a CapSkip on this machine', () => {
    expect(assertLoopbackCapskipUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(() => assertLoopbackCapskipUrl('https://solver.example.com')).toThrow(/this machine/);
    expect(() => new CaptchaSolver({ enabled: true, url: 'http://10.0.0.5:8080' }, logger)).toThrow(/this machine/);
  });

  it('solves reCAPTCHA v2, waiting through empty and not-ready replies', async () => {
    const { seen, solver } = await fakeCapskip(['', '{"status":0,"request":"CAPCHA_NOT_READY"}', '{"status":1,"request":"TOKEN"}']);
    const r = await solver.solve({ kind: 'recaptcha_v2', siteKey: 'SK', invisible: true }, 'https://site.test/login');
    expect(r).toMatchObject({ solved: true, token: 'TOKEN', responseField: '#g-recaptcha-response' });
    expect(Object.fromEntries(seen.form!)).toMatchObject({ method: 'userrecaptcha', googlekey: 'SK', pageurl: 'https://site.test/login', invisible: '1', enterprise: '0', key: 'k' });
  });

  it('sends the version and action for reCAPTCHA v3', async () => {
    const { seen, solver } = await fakeCapskip(['{"status":1,"request":"T3"}']);
    await solver.solve({ kind: 'recaptcha_v3', siteKey: 'SK', action: 'login', enterprise: true }, 'https://site.test/');
    expect(Object.fromEntries(seen.form!)).toMatchObject({ method: 'userrecaptcha', version: 'v3', action: 'login', enterprise: '1' });
  });

  it('returns the User-Agent a Turnstile token is bound to', async () => {
    const { seen, solver } = await fakeCapskip(['{"status":1,"request":"CF","useragent":"UA/1"}']);
    const r = await solver.solve({ kind: 'turnstile', siteKey: 'TK' }, 'https://site.test/');
    expect(r).toMatchObject({ solved: true, token: 'CF', userAgent: 'UA/1', responseField: '[name=cf-turnstile-response]' });
    expect(Object.fromEntries(seen.form!)).toMatchObject({ method: 'turnstile', sitekey: 'TK' });
  });

  it('reports a refusal, a solver error and an unreachable app without throwing', async () => {
    const refused = await fakeCapskip([], '{"status":0,"request":"ERROR_WRONG_USER_KEY"}');
    expect(await refused.solver.solve({ kind: 'turnstile', siteKey: 'x' }, 'https://s.test/')).toMatchObject({ solved: false, error: expect.stringContaining('ERROR_WRONG_USER_KEY') });
    await new Promise<void>((r) => server!.close(() => r()));

    const failed = await fakeCapskip(['{"status":0,"request":"ERROR_CAPTCHA_UNSOLVABLE"}']);
    expect(await failed.solver.solve({ kind: 'turnstile', siteKey: 'x' }, 'https://s.test/')).toMatchObject({ solved: false, error: expect.stringContaining('ERROR_CAPTCHA_UNSOLVABLE') });
    await new Promise<void>((r) => server!.close(() => r()));

    const down = new CaptchaSolver({ enabled: true, url: 'http://127.0.0.1:9', timeoutSeconds: 1 }, logger);
    expect(await down.solve({ kind: 'turnstile', siteKey: 'x' }, 'https://s.test/')).toMatchObject({ solved: false, error: expect.stringContaining('unreachable') });
    server = undefined;
  });

  it('never attempts hCaptcha, and skips it when something solvable is present', async () => {
    const solver = new CaptchaSolver({ enabled: true }, logger);
    expect(await solver.solve({ kind: 'hcaptcha', siteKey: 'h' }, 'https://s.test/')).toMatchObject({ solved: false, error: expect.stringContaining('not supported') });
    expect(CaptchaSolver.pick([{ kind: 'hcaptcha', siteKey: 'h' }])).toBeUndefined();
    expect(CaptchaSolver.pick([{ kind: 'hcaptcha', siteKey: 'h' }, { kind: 'turnstile', siteKey: 't' }])?.kind).toBe('turnstile');
  });
});
