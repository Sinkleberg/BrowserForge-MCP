import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPathSpec, minimalEnv, standardConfigDir } from '@browserforge/shared';
import { checkSpec } from '../../apps/mcp-server/src/plugins/installer.js';
import { findExtensionDir, setupReport, type SetupInput } from '../../apps/mcp-server/src/setup.js';

describe('where BrowserForge keeps its files', () => {
  it('uses %APPDATA% on Windows, ~/.config elsewhere, and BROWSERFORGE_HOME above all', () => {
    expect(standardConfigDir('win32', { APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming' }, 'C:\\Users\\Ada')).toBe('C:\\Users\\Ada\\AppData\\Roaming\\browserforge');
    expect(standardConfigDir('win32', {}, 'C:\\Users\\Ada')).toBe('C:\\Users\\Ada\\AppData\\Roaming\\browserforge');
    expect(standardConfigDir('linux', {}, '/home/ada')).toBe('/home/ada/.config/browserforge');
    expect(standardConfigDir('darwin', {}, '/Users/ada')).toBe('/Users/ada/.config/browserforge');
    expect(standardConfigDir('linux', { XDG_CONFIG_HOME: '/x' }, '/home/ada')).toBe('/x/browserforge');
    expect(standardConfigDir('win32', { BROWSERFORGE_HOME: 'D:\\bf', APPDATA: 'C:\\a' }, 'C:\\Users\\Ada')).toBe('D:\\bf');
  });
});

describe('plugin sources', () => {
  it.each(['./plugin', '../plugin', '/opt/plugin', '~/plugins/x', 'C:\\Users\\Ada\\my plugin', 'C:/Users/Ada/plugin', '\\\\server\\share\\plugin'])('treats %s as a folder', (s) => {
    expect(isPathSpec(s)).toBe(true);
  });
  it.each(['browserforge-plugin-x', '@scope/pkg', 'github:user/repo', 'https://example.com/p.tgz', 'git+https://github.com/u/r.git'])('treats %s as a package or URL', (s) => {
    expect(isPathSpec(s)).toBe(false);
  });
  it('lets a folder path contain spaces (no shell is involved) but not a package name', () => {
    expect(() => checkSpec('C:\\Users\\Ada\\my plugin')).not.toThrow();
    expect(() => checkSpec('/home/ada/my plugin')).not.toThrow();
    expect(() => checkSpec('my plugin')).toThrow();
    expect(() => checkSpec('--global')).toThrow();
  });
});

describe('what a child process may inherit', () => {
  it('has a path and a language, and not the server\'s secrets', () => {
    process.env.BROWSERFORGE_SECRET_TEST = 'sekrit';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    try {
      const env = minimalEnv();
      expect(env.LANG).toBe('C.UTF-8');
      expect(env.PATH ?? env.Path).toBeDefined();
      expect(JSON.stringify(env)).not.toMatch(/sekrit|sk-test/);
    } finally {
      delete process.env.BROWSERFORGE_SECRET_TEST;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

describe('setup instructions', () => {
  const base: SetupInput = { version: '1.2.3', nodeVersion: 'v22.1.0', platform: 'linux', configDir: '/home/ada/.config/browserforge', port: 7345, extensionToken: 'TOKEN123', mcpTokenFile: '/home/ada/.config/browserforge/mcp-token', dirs: { chrome: '/pkg/extension/chrome', firefox: '/pkg/extension/firefox' } };
  it('names the folders and the token, and uses the shell of the system', () => {
    const linux = setupReport(base);
    expect(linux).toContain('/pkg/extension/chrome');
    expect(linux).toContain('TOKEN123');
    expect(linux).toContain('$(cat "/home/ada/.config/browserforge/mcp-token")');
    const win = setupReport({ ...base, platform: 'win32', configDir: 'C:\\Users\\Ada\\AppData\\Roaming\\browserforge', mcpTokenFile: 'C:\\Users\\Ada\\AppData\\Roaming\\browserforge\\mcp-token' });
    expect(win).toContain('(Get-Content "C:\\Users\\Ada\\AppData\\Roaming\\browserforge\\mcp-token").Trim()');
    expect(win).toMatch(/not enforced/);
    expect(win).not.toContain('$(cat');
  });
  it('says so when Node is too old or the extension was not built', () => {
    expect(setupReport({ ...base, nodeVersion: 'v18.19.0' })).toMatch(/too old/);
    expect(setupReport({ ...base, dirs: {} })).toMatch(/not built/);
  });
});

describe('finding the built extension', () => {
  const roots: string[] = [];
  afterEach(() => { for (const r of roots.splice(0)) if (path.basename(r).startsWith('bf-ext-')) fs.rmSync(r, { recursive: true, force: true }); });
  const tree = (files: string[]) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-ext-'));
    roots.push(root);
    for (const f of files) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), '{}'); }
    return root;
  };
  it('finds it next to the program in an installed package', () => {
    const root = tree(['extension/chrome/manifest.json', 'bin/browserforge.mjs']);
    expect(findExtensionDir('chrome', pathToUrl(path.join(root, 'bin', 'browserforge.mjs')))).toBe(path.join(root, 'extension', 'chrome'));
    expect(findExtensionDir('firefox', pathToUrl(path.join(root, 'bin', 'browserforge.mjs')))).toBeUndefined();
  });
  it('finds it in the build output of a checkout', () => {
    const root = tree(['apps/firefox-extension/dist/firefox/manifest.json', 'apps/mcp-server/dist/cli.js']);
    expect(findExtensionDir('firefox', pathToUrl(path.join(root, 'apps', 'mcp-server', 'dist', 'cli.js')))).toBe(path.join(root, 'apps', 'firefox-extension', 'dist', 'firefox'));
  });
});
const pathToUrl = (p: string) => new URL(`file://${p.startsWith('/') ? '' : '/'}${p.replace(/\\/g, '/')}`).href;
