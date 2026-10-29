// Dev loop: rebuild TypeScript and the extension on change, and restart the daemon.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = [];
const run = (cmd, args, label) => {
  const p = spawn(cmd, args, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
  p.on('exit', (code) => console.log(`[dev] ${label} exited (${code})`));
  children.push(p);
  return p;
};

await new Promise((resolve, reject) => spawn('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' }).on('exit', (c) => (c === 0 ? resolve() : reject(new Error('initial build failed')))));
run('node_modules/.bin/tsc', ['-b', '--watch', '--preserveWatchOutput'], 'tsc');
run('node', ['--watch-path=apps/mcp-server/dist', '--watch-path=packages', 'apps/mcp-server/dist/cli.js', 'serve'], 'server');

let timer;
const rebuildExtension = () => {
  clearTimeout(timer);
  timer = setTimeout(() => spawn('npm', ['run', 'build', '-w', '@browserforge/extension'], { cwd: root, stdio: 'inherit' }), 300);
};
fs.watch(path.join(root, 'apps/firefox-extension/src'), { recursive: true }, rebuildExtension);
fs.watch(path.join(root, 'apps/firefox-extension/static'), { recursive: true }, rebuildExtension);
console.log('[dev] watching. Load apps/firefox-extension/dist/firefox in about:debugging (reload after rebuilds). Ctrl+C to stop.');
process.on('SIGINT', () => { children.forEach((c) => c.kill()); process.exit(0); });
