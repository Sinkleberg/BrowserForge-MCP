import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type ExtensionKind = 'chrome' | 'chrome-bodies' | 'firefox';
export const EXTENSION_KINDS: ExtensionKind[] = ['chrome', 'chrome-bodies', 'firefox'];

/**
 * Where the built extension is: next to the program in an installed package (<package>/extension/<kind>), or in the repository's build output
 * when running from a checkout. Returns undefined when it has not been built.
 */
export function findExtensionDir(kind: ExtensionKind, from: string = import.meta.url): string | undefined {
  const here = path.dirname(fileURLToPath(from));
  const candidates = [path.resolve(here, '..', 'extension', kind), path.resolve(here, '..', '..', 'firefox-extension', 'dist', kind)];
  return candidates.find((d) => fs.existsSync(path.join(d, 'manifest.json')));
}

export interface SetupInput {
  version: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
  configDir: string;
  port: number;
  extensionToken: string;
  mcpTokenFile: string;
  dirs: Partial<Record<ExtensionKind, string>>;
}

const nodeMajor = (v: string): number => Number(/^v?(\d+)/.exec(v)?.[1] ?? 0);

/** What a person needs to do next, in the words of their own system. Pure text so it can be tested everywhere. */
export function setupReport(i: SetupInput): string {
  const win = i.platform === 'win32';
  const ok = nodeMajor(i.nodeVersion) >= 22;
  const token = win ? `$((Get-Content "${i.mcpTokenFile}").Trim())` : `$(cat "${i.mcpTokenFile}")`;
  const where = (k: ExtensionKind) => i.dirs[k] ?? '(not built: run npm run build in the repository)';
  const lines = [
    `BrowserForge ${i.version}: setup`,
    '',
    `Node.js ${i.nodeVersion} ${ok ? 'is fine' : 'is too old: install Node.js 22 or newer from https://nodejs.org'}`,
    `Settings and logs: ${i.configDir}`,
    ...(win ? ['(On Windows, files are protected by your user profile. Folder and file modes are not enforced.)'] : []),
    '',
    '1. Start the server (keep it running):',
    `   browserforge serve --port ${i.port}`,
    '',
    '2. Load the browser extension:',
    '   Chrome, Edge, Brave: open chrome://extensions (edge://extensions), switch on Developer mode, press "Load unpacked" and pick:',
    `     ${where('chrome')}`,
    '     (use the "chrome-bodies" folder instead if you want captured response bodies:',
    `      ${where('chrome-bodies')} )`,
    '   Firefox: open about:debugging#/runtime/this-firefox, press "Load Temporary Add-on" and pick the manifest.json inside:',
    `     ${where('firefox')}`,
    '     (Firefox removes temporary add-ons when it restarts; see docs/INSTALL.md for a permanent install.)',
    '',
    '3. Connect the extension: click its toolbar icon, enter',
    `     Server: ws://127.0.0.1:${i.port}/ext`,
    `     Token:  ${i.extensionToken}`,
    '   and press Connect.',
    '',
    '4. Connect your AI client:',
    `   Claude Code:  claude mcp add --transport http browserforge http://127.0.0.1:${i.port}/mcp --header "Authorization: Bearer ${token}"`,
    '   Other clients: browserforge print-config codex',
    '',
    'Check everything with:  browserforge doctor',
  ];
  return lines.join('\n') + '\n';
}
