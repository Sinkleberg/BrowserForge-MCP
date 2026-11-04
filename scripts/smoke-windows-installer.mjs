// Checks a BrowserForge that the Windows installer has just put on a machine: the command, the bundled Node and npm, the server, the
// dashboard, the PATH entry, and a clean uninstall that keeps the user's data. Run it with a Node that is NOT the installed one (a running
// node.exe cannot be deleted by the uninstaller); every BrowserForge command below goes through the installed browserforge.cmd and so uses the bundled Node:
//   node scripts\smoke-windows-installer.mjs <install dir>
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'win32') {
  console.error('This check is for Windows.');
  process.exit(2);
}
const dir = path.resolve(process.argv[2] ?? '');
if (!fs.existsSync(path.join(dir, 'browserforge.cmd'))) {
  console.error(`No browserforge.cmd in ${dir}. Usage: node smoke-windows-installer.mjs <install dir>`);
  process.exit(2);
}

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`);
  if (!ok) failures.push(name);
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-win-home-'));
const env = { ...process.env, BROWSERFORGE_HOME: home };
const shim = path.join(dir, 'browserforge.cmd');
// cmd.exe is started with its own quoting rules: the whole command line goes in one extra pair of quotes.
const cmdLine = (args) => ['/d', '/s', '/c', `""${shim}" ${args}"`];
const runShim = (args) => execFileSync('cmd.exe', cmdLine(args), { env, encoding: 'utf8', windowsVerbatimArguments: true });
const pathValue = () => {
  try {
    return execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], { encoding: 'utf8' });
  } catch {
    return '';
  }
};

// What was installed.
for (const rel of ['node\\node.exe', 'node\\node_modules\\npm\\bin\\npm-cli.js', 'app\\bin\\browserforge.mjs', 'app\\extension\\chrome\\manifest.json', 'app\\extension\\firefox\\manifest.json', 'app\\share\\skills', 'browserforge.ico', 'unins000.exe']) {
  check(`installed: ${rel}`, fs.existsSync(path.join(dir, rel)));
}
check('the installer added the install folder to the user PATH', pathValue().toLowerCase().includes(dir.toLowerCase()), pathValue().slice(0, 200));

// The command works through the shim, with the bundled Node.
check('browserforge --help prints usage', /Usage:/.test(runShim('--help')));
const setup = runShim('setup');
check('setup: bundled Node is new enough', /is fine/.test(setup), setup.slice(0, 200));
check('setup: points to both stores', /chromewebstore\.google\.com/.test(setup) && /addons\.mozilla\.org/.test(setup));
check('setup: names the extension folder inside the install', setup.toLowerCase().includes(path.join(dir, 'app', 'extension', 'chrome').toLowerCase()));
check('the extension folder it names has a manifest', fs.existsSync(path.join(runShim('extension chrome').trim(), 'manifest.json')));

// The server, through the shim.
const server = spawn('cmd.exe', cmdLine('serve --port 0'), { env, stdio: ['ignore', 'ignore', 'pipe'], windowsVerbatimArguments: true });
let err = '';
const port = await new Promise((resolve) => {
  const t = setTimeout(() => resolve(0), 30_000);
  server.stderr.on('data', (d) => {
    err += d;
    const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(err);
    if (m) { clearTimeout(t); resolve(Number(m[1])); }
  });
  server.on('exit', () => { clearTimeout(t); resolve(0); });
});
check('server starts', port > 0, err.slice(-300));
if (port) {
  const base = `http://127.0.0.1:${port}`;
  const status = (p, token) => fetch(base + p, { headers: token ? { authorization: `Bearer ${token}` } : {} }).then((r) => r.status).catch(() => 0);
  const read = (f) => fs.readFileSync(path.join(home, f), 'utf8').trim();
  check('GET /health', (await status('/health')) === 200);
  check('GET /status without a token is refused', (await status('/status')) === 401);
  check('GET /status with the MCP token', (await status('/status', read('mcp-token'))) === 200);
  check('GET /dashboard serves the page', (await status('/dashboard')) === 200);
  check('GET /dashboard/data without a token is refused', (await status('/dashboard/data')) === 401);
  check('GET /dashboard/data with the MCP token is refused', (await status('/dashboard/data', read('mcp-token'))) === 401);
  check('GET /dashboard/data with the dashboard token', (await status('/dashboard/data', read('dashboard-token'))) === 200);
  const url = runShim(`dashboard --print --port ${port}`).trim();
  check('dashboard --print gives a local address with the token in the fragment', url.startsWith(`${base}/dashboard#t=`), url.replace(/#t=.*/, '#t=<hidden>'));
}
// taskkill /T ends cmd.exe and the node.exe under it, so nothing keeps the install folder locked.
try {
  execFileSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
} catch {
  /* already gone */
}
await new Promise((r) => setTimeout(r, 1500));

// Uninstall: the program and the PATH entry go, the user's data stays.
const dataDir = path.join(home, 'extension-token');
check('the server left its data in the home folder', fs.existsSync(dataDir));
try {
  execFileSync(path.join(dir, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { stdio: 'ignore' });
} catch (e) {
  check('uninstaller ran', false, String(e));
}
// The uninstaller hands over to a copy of itself and returns: wait until the folder is empty of our files.
for (let i = 0; i < 60 && fs.existsSync(shim); i++) await new Promise((r) => setTimeout(r, 1000));
check('uninstall removed the command', !fs.existsSync(shim));
check('uninstall removed the bundled Node', !fs.existsSync(path.join(dir, 'node', 'node.exe')));
check('uninstall removed the PATH entry', !pathValue().toLowerCase().includes(dir.toLowerCase()), pathValue().slice(0, 200));
check("uninstall kept the user's own data", fs.existsSync(dataDir));

fs.rmSync(home, { recursive: true, force: true });
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nWindows installer smoke test passed');
