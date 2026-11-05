import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REDACTED, redactBody, redactHeaders, redactUrl, resolveSafePath, safeEqual, toPublicError, BrowserForgeError, containsSecretLike, createLogger, safeSegment } from '@browserforge/shared';

describe('redaction', () => {
  it('redacts sensitive headers but keeps benign ones', () => {
    const out = redactHeaders([
      { name: 'Authorization', value: 'Bearer abc.def.ghi-secretvalue' },
      { name: 'Cookie', value: 'sid=1' },
      { name: 'Accept', value: 'application/json' },
      { name: 'X-Api-Key', value: 'k' },
    ]);
    expect(out.map((h) => h.value)).toEqual([REDACTED, REDACTED, 'application/json', REDACTED]);
  });
  it('redacts query params, userinfo and JWT-like values', () => {
    const u = redactUrl('https://user:pw@example.com/a?token=abc&page=2&api_key=zzz');
    expect(u).not.toContain('abc');
    expect(u).not.toContain('pw@');
    expect(u).toContain('page=2');
  });
  it('redacts JSON bodies by key and by pattern', () => {
    const body = JSON.stringify({ email: 'a@b.c', password: 'hunter2', nested: { access_token: 'x1', note: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.sig12345678' } });
    const out = redactBody(body, 'application/json')!;
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('x1"');
    expect(out).not.toContain('eyJhbGci');
    expect(out).toContain('a@b.c');
    expect(containsSecretLike(out)).toBe(false);
  });
  it('redacts form-urlencoded bodies', () => {
    const out = redactBody('user=bob&password=pw1&csrf_token=zz', 'application/x-www-form-urlencoded')!;
    expect(out).toContain('user=bob');
    expect(out).not.toContain('pw1');
  });
});

describe('errors', () => {
  it('never leaks internal error messages', () => {
    expect(toPublicError(new Error('/home/me/secret.txt ENOENT')).message).not.toContain('secret');
    expect(toPublicError(new BrowserForgeError('TIMEOUT', 'slow', { retryable: true })).retryable).toBe(true);
  });
});

describe('path safety', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-path-'));
  fs.writeFileSync(path.join(root, 'cv.pdf'), 'x');
  it('allows files inside the root', () => {
    expect(resolveSafePath(path.join(root, 'cv.pdf'), [root])).toContain('cv.pdf');
    expect(resolveSafePath('new/sub/file.txt', [root], root)).toContain('sub');
  });
  it('rejects traversal, NUL and outside paths', () => {
    expect(() => resolveSafePath(path.join(root, '..', 'etc', 'passwd'), [root])).toThrow();
    expect(() => resolveSafePath('/etc/passwd', [root])).toThrow();
    expect(() => resolveSafePath('a\0b', [root])).toThrow();
  });
  it('rejects symlink escapes', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-outside-'));
    try {
      const link = path.join(root, 'link');
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      expect(() => resolveSafePath(path.join(link, 'passwd'), [root])).toThrow();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
  it('sanitises segments', () => {
    const seg = safeSegment('../../x y');
    expect(seg).not.toMatch(/[/\\\s]/);
    expect(seg.startsWith('.')).toBe(false);
  });
});

describe('misc', () => {
  it('safeEqual compares in constant time semantics', () => {
    expect(safeEqual('a', 'a')).toBe(true);
    expect(safeEqual('a', 'b')).toBe(false);
  });
  it('logger drops content-bearing keys', () => {
    const lines: string[] = [];
    const log = createLogger('info', (l) => lines.push(l));
    log.info('tool call', { text: 'SECRET PAGE TEXT', tool: 'x' });
    expect(lines[0]).not.toContain('SECRET PAGE TEXT');
    expect(lines[0]).toContain('"tool":"x"');
  });
});
