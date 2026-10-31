import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DIST = path.resolve(import.meta.dirname, '../../apps/firefox-extension/dist');
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(DIST, name, 'manifest.json'), 'utf8')) as { permissions: string[]; optional_permissions?: string[]; description: string; host_permissions: string[] };
const built = fs.existsSync(path.join(DIST, 'chrome-bodies', 'manifest.json'));

// Needs `npm run build` first (CI does that).
describe.skipIf(!built)('extension manifests', () => {
  it('never lists "debugger" as an optional permission: Chrome refuses it ("cannot be listed as optional") and would silently drop it', () => {
    for (const t of ['chrome', 'chrome-bodies', 'firefox', 'chrome-e2e', 'firefox-e2e']) expect(read(t).optional_permissions ?? [], t).not.toContain('debugger');
  });

  it('keeps the normal builds low-privilege: only the chrome-bodies build holds debugger, and says so', () => {
    expect(read('chrome').permissions).not.toContain('debugger');
    expect(read('firefox').permissions).not.toContain('debugger');
    const bodies = read('chrome-bodies');
    expect(bodies.permissions).toContain('debugger');
    expect(bodies.description).toMatch(/debugging this browser/);
    expect(read('chrome').permissions.filter((p) => p !== 'debugger')).toEqual(bodies.permissions.filter((p) => p !== 'debugger'));
  });

  it('keeps Firefox able to request its body permissions at run time, and downloads optional everywhere', () => {
    expect(read('firefox').optional_permissions).toEqual(expect.arrayContaining(['webRequestBlocking', 'webRequestFilterResponse', 'downloads']));
    for (const t of ['chrome', 'chrome-bodies']) expect(read(t).optional_permissions).toEqual(['downloads']);
  });

  it('asks for no permission beyond the documented set', () => {
    const allowed = new Set(['tabs', 'storage', 'scripting', 'webRequest', 'alarms', 'debugger']);
    for (const t of ['chrome', 'chrome-bodies', 'firefox']) for (const p of read(t).permissions) expect(allowed.has(p), `${t}: ${p}`).toBe(true);
    expect(read('chrome').host_permissions).toEqual(['<all_urls>']);
  });
});
