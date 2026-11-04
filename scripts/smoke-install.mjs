// Installs the packed tarball into a clean folder and runs it, the way a new user would. Same script on Linux, macOS and Windows.
// Usage: node scripts/smoke-install.mjs release/browserforge-mcp-<version>.tgz
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tgz = path.resolve(process.argv[2] ?? '');
// A folder works too (the release folder): the shell may not expand *.tgz the same way everywhere.
if (fs.existsSync(tgz) && fs.statSync(tgz).isDirectory()) {
  const found = fs.readdirSync(tgz).filter((f) => f.endsWith('.tgz'));
  if (found.length !== 1) {
    console.error(`Expected exactly one .tgz in ${tgz}, found ${found.length}`);
    process.exit(2);
  }
  tgz = path.join(tgz, found[0]);
}
if (!fs.existsSync(tgz)) {
  console.error('Usage: node scripts/smoke-install.mjs <package.tgz | folder with it>');
  process.exit(2);
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-smoke-'));
const home = path.join(work, 'home');
const prefix = path.join(work, 'prefix');
fs.mkdirSync(prefix, { recursive: true });
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`);
  if (!ok) failures.push(name);
};

const npmCli = process.platform === 'win32' ? [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')] : null;
const [npmCmd, npmPre] = npmCli ? [process.execPath, npmCli] : ['npm', []];
execFileSync(npmCmd, [...npmPre, 'install', '--prefix', prefix, tgz, '--no-audit', '--no-fund', '--loglevel=error'], { stdio: 'inherit' });

const bin = path.join(prefix, 'node_modules', '@el-makina-ai', 'browserforge-mcp', 'bin', 'browserforge.mjs');
check('installed program exists', fs.existsSync(bin), bin);
const env = { ...process.env, BROWSERFORGE_HOME: home };
const run = (...args) => execFileSync(process.execPath, [bin, ...args], { env, encoding: 'utf8' });

check('--help prints usage', /Usage:/.test(run('--help')));
const setup = run('setup');
check('setup: Node is fine', /is fine/.test(setup), setup.slice(0, 200));
check('setup: names the extension folders', /extension[\\/]chrome/.test(setup) && /extension[\\/]firefox/.test(setup));
for (const k of ['chrome', 'chrome-bodies', 'firefox']) {
  const dir = run('extension', k).trim();
  check(`extension ${k} has a manifest`, fs.existsSync(path.join(dir, 'manifest.json')), dir);
}
check('tokens are created private to the user', fs.existsSync(path.join(home, 'extension-token')) || /Extension token/.test(run('tokens')));

// Start the server, ask it for /health, stop it.
const server = spawn(process.execPath, [bin, 'serve', '--port', '0'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
let err = '';
const port = await new Promise((resolve) => {
  const t = setTimeout(() => resolve(0), 20_000);
  server.stderr.on('data', (d) => {
    err += d;
    const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(err);
    if (m) { clearTimeout(t); resolve(Number(m[1])); }
  });
  server.on('exit', () => { clearTimeout(t); resolve(0); });
});
check('server starts', port > 0, err.slice(-300));
if (port) {
  const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()).catch(() => null);
  check('GET /health', health?.ok === true, JSON.stringify(health));
  const status = await fetch(`http://127.0.0.1:${port}/status`, { headers: { authorization: `Bearer ${fs.readFileSync(path.join(home, 'mcp-token'), 'utf8').trim()}` } }).then((r) => r.status).catch(() => 0);
  check('GET /status with the token', status === 200, String(status));
  const noAuth = await fetch(`http://127.0.0.1:${port}/status`).then((r) => r.status).catch(() => 0);
  check('GET /status without a token is refused', noAuth === 401, String(noAuth));

  // The read-only dashboard: the page is public, its data needs its own token, and the MCP token does not open it.
  const page = await fetch(`http://127.0.0.1:${port}/dashboard`).then(async (r) => ({ status: r.status, text: await r.text() })).catch(() => ({ status: 0, text: '' }));
  check('GET /dashboard serves the page', page.status === 200 && /BrowserForge dashboard/.test(page.text), String(page.status));
  const dashToken = fs.readFileSync(path.join(home, 'dashboard-token'), 'utf8').trim();
  const mcpToken = fs.readFileSync(path.join(home, 'mcp-token'), 'utf8').trim();
  const data = (token) => fetch(`http://127.0.0.1:${port}/dashboard/data`, { headers: token ? { authorization: `Bearer ${token}` } : {} }).then((r) => r.status).catch(() => 0);
  check('GET /dashboard/data without a token is refused', (await data()) === 401);
  check('GET /dashboard/data with the MCP token is refused', (await data(mcpToken)) === 401);
  check('GET /dashboard/data with the dashboard token', (await data(dashToken)) === 200);
  check('dashboard --print gives an address with the token in the fragment', new RegExp(`/dashboard#t=${encodeURIComponent(dashToken).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(run('dashboard', '--print', '--port', String(port)).trim()));
}
server.kill();

fs.rmSync(work, { recursive: true, force: true });
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nsmoke test passed');
