import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPluginApi, type PluginApi, type PluginRuntime, type SettingValue } from './api.js';
import { parseManifest, type PluginManifestInput } from './manifest.js';

/**
 * A real PluginApi for unit tests: same permission checks as in production, but with temporary folders and a fake browser.
 *
 *   const { api, dirs, cleanup } = createTestApi(manifest, { settings: { cvDir: '/tmp/cvs' } });
 */
export function createTestApi(
  manifestInput: PluginManifestInput,
  opts: { settings?: Record<string, SettingValue>; browser?: PluginRuntime['browserCall']; grant?: 'manifest' | 'none' } = {},
): { api: PluginApi; dirs: PluginRuntime['dirs']; cleanup(): void } {
  const manifest = parseManifest(manifestInput);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `bf-plugin-test-${manifest.id}-`))); // resolved: on macOS /var is a link to /private/var, and the API returns resolved paths
  const dirs = { uploads: path.join(root, 'uploads'), exports: path.join(root, 'exports'), data: path.join(root, 'data') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const granted = opts.grant === 'none' ? { browser: false, files: { read: [], write: [] }, exec: [] } : manifest.permissions;
  const api = createPluginApi({ manifest, granted, settings: opts.settings ?? {}, dirs, browserCall: opts.browser });
  return { api, dirs, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
