import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogFile, createLogger, readLogs } from '@browserforge/shared';

const roots: string[] = [];
const tmp = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-log-'));
  roots.push(root);
  return path.join(root, 'logs');
};
afterEach(() => {
  for (const root of roots.splice(0)) if (path.basename(root).startsWith('bf-log-')) fs.rmSync(root, { recursive: true, force: true });
});

const line = (msg: string, level = 'info', t = new Date().toISOString()) => JSON.stringify({ t, level, msg });

describe('log file', () => {
  it('writes private files in a private folder, one per day', () => {
    const dir = tmp();
    const day1 = Date.parse('2026-03-01T10:00:00Z');
    let now = day1;
    const f = createLogFile(dir, { now: () => now });
    f.write(line('a'));
    now = Date.parse('2026-03-02T10:00:00Z');
    f.write(line('b'));
    f.close();
    expect(fs.readdirSync(dir).sort()).toEqual(['server-2026-03-01.log', 'server-2026-03-02.log']);
    if (process.platform !== 'win32') expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, 'server-2026-03-01.log')).mode & 0o777).toBe(0o600);
  });

  it('starts a new part when a day grows past maxBytes', () => {
    const dir = tmp();
    const f = createLogFile(dir, { maxBytes: 200, now: () => Date.parse('2026-03-01T10:00:00Z') });
    for (let i = 0; i < 12; i++) f.write(line(`message number ${i}`));
    f.close();
    const files = fs.readdirSync(dir).sort();
    expect(files.length).toBeGreaterThan(1);
    expect(files).toContain('server-2026-03-01.1.log');
    expect(readLogs(dir, { now: Date.parse('2026-03-01T11:00:00Z') }).map((l) => l.msg)).toEqual(Array.from({ length: 12 }, (_v, i) => `message number ${i}`));
  });

  it('deletes files older than the retention period and keeps recent ones', () => {
    const dir = tmp();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'server-2026-01-01.log'), line('old') + '\n');
    fs.writeFileSync(path.join(dir, 'server-2026-02-25.log'), line('recent') + '\n');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not mine');
    const f = createLogFile(dir, { retentionDays: 14, now: () => Date.parse('2026-03-01T10:00:00Z') });
    f.write(line('today'));
    f.close();
    expect(fs.readdirSync(dir).sort()).toEqual(['notes.txt', 'server-2026-02-25.log', 'server-2026-03-01.log']);
  });

  it('never throws when the folder cannot be written', () => {
    const blocker = path.join(os.tmpdir(), `bf-blocker-${process.pid}`);
    fs.writeFileSync(blocker, 'x');
    try {
      const f = createLogFile(path.join(blocker, 'logs'));
      expect(() => f.write(line('x'))).not.toThrow();
      expect(() => f.close()).not.toThrow();
    } finally {
      fs.rmSync(blocker, { force: true });
    }
  });
});

describe('reading logs', () => {
  const seed = () => {
    const dir = tmp();
    fs.mkdirSync(dir, { recursive: true });
    const base = Date.parse('2026-03-01T12:00:00Z');
    const rows = [
      JSON.stringify({ t: new Date(base - 3 * 3600_000).toISOString(), level: 'debug', msg: 'old debug' }),
      JSON.stringify({ t: new Date(base - 90 * 60_000).toISOString(), level: 'warn', msg: 'earlier warning' }),
      '{"t":"2026-03-01T11:00:00.000Z","level":"info","msg":"torn li', // a half-written line from a crash
      JSON.stringify({ t: new Date(base - 10 * 60_000).toISOString(), level: 'error', msg: 'recent error', code: 'NOT_CONNECTED' }),
      JSON.stringify({ t: new Date(base - 5 * 60_000).toISOString(), level: 'info', msg: 'recent info' }),
    ];
    fs.writeFileSync(path.join(dir, 'server-2026-03-01.log'), rows.join('\n') + '\n');
    return { dir, base };
  };

  it('skips torn lines and returns oldest first', () => {
    const { dir } = seed();
    expect(readLogs(dir).map((l) => l.msg)).toEqual(['old debug', 'earlier warning', 'recent error', 'recent info']);
  });
  it('filters by level, period and tail', () => {
    const { dir, base } = seed();
    expect(readLogs(dir, { minLevel: 'warn' }).map((l) => l.msg)).toEqual(['earlier warning', 'recent error']);
    expect(readLogs(dir, { sinceMs: 60 * 60_000, now: base }).map((l) => l.msg)).toEqual(['recent error', 'recent info']);
    expect(readLogs(dir, { tail: 1 }).map((l) => l.msg)).toEqual(['recent info']);
  });
  it('returns nothing for a missing folder', () => {
    expect(readLogs(path.join(os.tmpdir(), 'bf-does-not-exist-xyz'))).toEqual([]);
  });
});

describe('logger with a file', () => {
  it('writes every level to the file but only the chosen level to the terminal', () => {
    const term: string[] = [];
    const file: string[] = [];
    const log = createLogger('warn', (l) => term.push(l), { write: (l) => file.push(l) });
    log.debug('quiet detail', { tool: 'x' });
    log.warn('loud problem', { tool: 'y' });
    expect(term).toHaveLength(1);
    expect(term[0]).toContain('loud problem');
    expect(file).toHaveLength(2);
    expect(file[0]).toContain('quiet detail');
  });

  it('applies the same redaction to the file as to the terminal', () => {
    const file: string[] = [];
    const log = createLogger('error', () => undefined, { write: (l) => file.push(l) });
    log.info('tool call', { text: 'SECRET PAGE TEXT', value: 'hunter2', args: { password: 'pw' }, headers: { cookie: 'sid=1' }, error: 'failed with Bearer abcdefghijklmnopqrstuvwxyz0123456789', tool: 'browser_type' });
    const all = file.join('\n');
    for (const secret of ['SECRET PAGE TEXT', 'hunter2', 'sid=1', 'abcdefghijklmnopqrstuvwxyz0123456789']) expect(all).not.toContain(secret);
    expect(all).toContain('browser_type');
  });

  it('cuts very long strings', () => {
    const file: string[] = [];
    createLogger('error', () => undefined, { write: (l) => file.push(l) }).info('x', { error: 'e'.repeat(5000) });
    expect(file[0]!.length).toBeLessThan(700);
  });
});
