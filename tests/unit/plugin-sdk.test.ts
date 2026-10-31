import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describePermissions, normalizePermissions, parseManifest, samePermissions, z, definePlugin, tool } from '@browserforge/plugin-sdk';
import { createTestApi } from '@browserforge/plugin-sdk/testing';

const base = { id: 'demo', toolPrefix: 'demo', description: 'Demo plugin' };
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function api(manifest: object, opts: Parameters<typeof createTestApi>[1] = {}) {
  const t = createTestApi({ ...base, ...manifest } as never, opts);
  cleanups.push(t.cleanup);
  return t;
}
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-sdk-')); cleanups.push(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

describe('manifest', () => {
  it('accepts a minimal plugin and normalises permissions', () => {
    const m = parseManifest({ ...base, permissions: { files: { read: ['data', 'data'] }, exec: ['b', 'a'] } });
    expect(m).toMatchObject({ kind: 'plugin', permissions: { browser: false, files: { read: ['data'], write: [] }, exec: ['a', 'b'] }, settings: {} });
  });
  it('rejects bad ids, prefixes, unknown fields and unsafe root specs', () => {
    expect(() => parseManifest({ ...base, id: 'Bad Id' })).toThrow(/id/);
    expect(() => parseManifest({ ...base, toolPrefix: 'x' })).toThrow(/toolPrefix/);
    expect(() => parseManifest({ id: 'ok', description: 'd' })).toThrow(/needs a toolPrefix/);
    expect(() => parseManifest({ ...base, surprise: true })).toThrow();
    for (const bad of ['/etc', '../x', 'home', 'data/../..', 'setting:a b']) expect(() => parseManifest({ ...base, permissions: { files: { read: [bad] } } }), bad).toThrow();
    expect(parseManifest({ id: 'skillz', kind: 'skill', description: 'no code' }).kind).toBe('skill');
  });
  it('compares permissions regardless of order and explains them in plain words', () => {
    expect(samePermissions(normalizePermissions({ exec: ['a', 'b'] }), normalizePermissions({ exec: ['b', 'a'] }))).toBe(true);
    expect(samePermissions(normalizePermissions({ browser: true }), normalizePermissions({}))).toBe(false);
    const lines = describePermissions(parseManifest({ ...base, settings: { cvDir: { type: 'path', description: 'Your CV folder' } }, permissions: { browser: true, files: { read: ['setting:cvDir'], write: ['uploads'] }, exec: ['setting:bin', 'python3'] } }));
    expect(lines.join('\n')).toMatch(/Drive your browser[\s\S]*Read files in: setting:cvDir \(Your CV folder\)[\s\S]*Create and change files in: uploads[\s\S]*python3/);
    expect(describePermissions(parseManifest(base))[0]).toMatch(/Nothing beyond/);
  });
});

describe('PluginApi files', () => {
  it('reads and writes inside granted roots only', () => {
    const cv = tmp();
    fs.writeFileSync(path.join(cv, 'a.yaml'), 'hello');
    const { api: a, dirs } = api({ settings: { cvDir: { type: 'path', description: 'x' } }, permissions: { files: { read: ['setting:cvDir'], write: ['setting:cvDir/tailored', 'data'] } } }, { settings: { cvDir: cv } });
    expect(a.files.read('setting:cvDir', 'a.yaml')).toBe('hello');
    const w = a.files.write('setting:cvDir/tailored', 'x/b.yaml', 'out');
    expect(w).toBe(path.join(fs.realpathSync(cv), 'tailored/x/b.yaml'));
    expect(fs.readFileSync(w, 'utf8')).toBe('out');
    expect(fs.statSync(w).mode & 0o077).toBe(0);
    a.files.write('data', 'n.json', '{}');
    expect(fs.existsSync(path.join(dirs.data, 'n.json'))).toBe(true);
    expect(a.files.list('setting:cvDir').map((e) => e.name).sort()).toEqual(['a.yaml', 'tailored']);
    expect(a.files.exists('setting:cvDir', 'a.yaml')).toBe(true);
    expect(a.files.exists('setting:cvDir', 'nope')).toBe(false);
  });

  it('refuses roots it was not granted, write-only roots for reads, path traversal and symlink escapes', () => {
    const cv = tmp();
    const secret = tmp();
    fs.writeFileSync(path.join(secret, 'secret.txt'), 'top secret');
    fs.symlinkSync(secret, path.join(cv, 'link'));
    const { api: a } = api({ settings: { cvDir: { type: 'path', description: 'x' } }, permissions: { files: { read: ['setting:cvDir'], write: ['data'] } } }, { settings: { cvDir: cv } });
    expect(() => a.files.read('exports', 'x')).toThrow(/not granted read access/);
    expect(() => a.files.write('setting:cvDir', 'x', 'y')).toThrow(/not granted write access/); // read ≠ write
    expect(() => a.files.read('data', 'x')).toThrow(/not granted read access/); // write ≠ read
    expect(() => a.files.read('setting:cvDir', '../../etc/passwd')).toThrow(/outside the allowed/);
    expect(() => a.files.read('setting:cvDir', 'link/secret.txt')).toThrow(/outside the allowed/);
    expect(() => a.files.write('data', '../escape.txt', 'x')).toThrow(/outside the allowed/);
    expect(() => a.files.read('setting:cvDir/../x', 'a')).toThrow();
  });

  it('asks for the setting when a path setting is empty', () => {
    const { api: a } = api({ settings: { cvDir: { type: 'path', description: 'x' } }, permissions: { files: { read: ['setting:cvDir'] } } });
    expect(() => a.files.read('setting:cvDir', 'a')).toThrow(/plugin config demo cvDir=/);
  });
});

describe('PluginApi copy and remove', () => {
  it('copies binary files between granted roots only, and removes only inside writable roots (never a whole root)', () => {
    const from = tmp();
    const bytes = Buffer.from([0, 255, 1, 2, 0x25, 0x50, 0x44, 0x46]);
    fs.writeFileSync(path.join(from, 'cv.pdf'), bytes);
    const { api: a, dirs } = api({ settings: { src: { type: 'path', description: 'x' } }, permissions: { files: { read: ['setting:src'], write: ['uploads/cv', 'data'] } } }, { settings: { src: from } });
    const dest = a.files.copy('setting:src', 'cv.pdf', 'uploads/cv', 'out/cv.pdf');
    expect(dest).toBe(path.join(dirs.uploads, 'cv/out/cv.pdf'));
    expect(fs.readFileSync(dest)).toEqual(bytes);
    expect(fs.statSync(dest).mode & 0o077).toBe(0);
    expect(() => a.files.copy('data', 'x', 'uploads/cv', 'y')).toThrow(/not granted read access/); // source must be readable
    expect(() => a.files.copy('setting:src', 'cv.pdf', 'exports', 'y')).toThrow(/not granted write access/);
    expect(() => a.files.copy('setting:src', '../../etc/passwd', 'data', 'p')).toThrow(/outside the allowed/);
    a.files.remove('uploads/cv', 'out');
    expect(fs.existsSync(path.join(dirs.uploads, 'cv/out'))).toBe(false);
    expect(() => a.files.remove('uploads/cv', '')).toThrow(/whole root/);
    expect(() => a.files.remove('setting:src', 'cv.pdf')).toThrow(/not granted write access/);
    expect(fs.existsSync(path.join(from, 'cv.pdf'))).toBe(true);
  });
});

describe('PluginApi exec', () => {
  it('runs only declared programs, without a shell, with a minimal environment and a time limit', async () => {
    process.env.SUPER_SECRET_KEY = 'leak-me';
    const dir = tmp();
    const script = path.join(dir, 'tool.sh');
    fs.writeFileSync(script, '#!/bin/sh\necho "args:$1"; echo "key:${SUPER_SECRET_KEY:-none}"; exit 3\n', { mode: 0o755 });
    const { api: a } = api({ settings: { bin: { type: 'path', description: 'x' } }, permissions: { exec: ['setting:bin'] } }, { settings: { bin: script } });
    const r = await a.exec(script, ['hello; rm -rf /']);
    expect(r.code).toBe(3);
    expect(r.stdout).toContain('args:hello; rm -rf /'); // passed as one literal argument
    expect(r.stdout).toContain('key:none'); // secrets in the server's environment are not inherited
    await expect(a.exec('/bin/ls', [])).rejects.toThrow(/not granted permission to run/);
    await expect(a.exec(script, [1 as never])).rejects.toThrow(/must be strings/);
    delete process.env.SUPER_SECRET_KEY;
  });

  it('allows a literal command name that was declared, and reports a missing program clearly', async () => {
    const { api: a } = api({ permissions: { exec: ['definitely-not-installed-xyz', 'true'] } });
    await expect(a.exec('definitely-not-installed-xyz', [])).rejects.toThrow(/not found/);
    expect((await a.exec('true', [])).code).toBe(0);
  });

  it('times out slow programs and restricts the working folder', async () => {
    const dir = tmp();
    const { api: a } = api({ settings: { work: { type: 'path', description: 'x' } }, permissions: { exec: ['sleep', 'pwd'], files: { read: ['setting:work'] } } }, { settings: { work: dir } });
    await expect(a.exec('sleep', ['5'], { timeoutMs: 1000 })).rejects.toThrow(/did not finish/);
    expect((await a.exec('pwd', [], { cwd: { root: 'setting:work' } })).stdout.trim()).toBe(fs.realpathSync(dir));
    await expect(a.exec('pwd', [], { cwd: { root: 'setting:work', rel: '../..' } })).rejects.toThrow(/outside the allowed/);
    await expect(a.exec('pwd', [], { cwd: { root: 'exports' } })).rejects.toThrow(/not granted/);
  });
});

describe('PluginApi browser and helpers', () => {
  it('needs the browser permission, then passes the call through', async () => {
    const seen: unknown[] = [];
    const browser = async (action: string, args: Record<string, unknown>) => { seen.push([action, args]); return { ok: true }; };
    await expect(api({}, { browser }).api.browser.call('click', {})).rejects.toThrow(/not granted permission to use the browser/);
    expect(await api({ permissions: { browser: true } }, { browser }).api.browser.call('click', { ref: 'r' })).toEqual({ ok: true });
    expect(seen).toEqual([['click', { ref: 'r' }]]);
    await expect(api({ permissions: { browser: true } }).api.browser.call('click')).rejects.toThrow(/No browser/);
  });
  it('marks outside content as untrusted and namespaced', () => {
    expect(api({}).api.untrusted('page', { x: 1 })).toMatchObject({ untrustedWebContent: true, origin: 'plugin:demo:page', data: { x: 1 } });
  });
  it('definePlugin and tool keep the typed input', async () => {
    const p = definePlugin({ tools: [tool({ name: 'demo_echo', description: 'echo', input: z.object({ text: z.string() }), readOnly: true, run: async ({ text }) => ({ text }) })] });
    expect(await p.tools[0]!.run({ text: 'hi' } as never, api({}).api)).toEqual({ text: 'hi' });
  });
});
