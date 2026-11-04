// Builds the installable package: one JavaScript file (no node_modules to fetch), the built extensions, the zips for the browser stores,
// skills, the RenderCV plugin and docs, then `npm pack`. Run after `npm run build` (or use `npm run release`). Works the same on every OS.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = rootPkg.version;
const out = path.join(root, 'release', `browserforge-mcp-${version}`);
const extDist = path.join(root, 'apps', 'firefox-extension', 'dist');

const need = (p, hint) => {
  if (!fs.existsSync(p)) throw new Error(`${p} is missing. ${hint}`);
};
need(path.join(root, 'apps', 'mcp-server', 'dist', 'cli.js'), 'Run npm run build first.');
for (const k of ['chrome', 'chrome-bodies', 'firefox']) need(path.join(extDist, k, 'manifest.json'), 'Run npm run build first.');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'bin'), { recursive: true });

// 1. The server and CLI as a single file.
await build({
  entryPoints: [path.join(root, 'apps', 'mcp-server', 'dist', 'cli.js')],
  outfile: path.join(out, 'bin', 'browserforge.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // ws can use two optional native speed-ups; it works without them.
  external: ['bufferutil', 'utf-8-validate'],
  // esbuild keeps the entry file's own `#!` line at the very top, so the banner must not add a second one.
  banner: { js: "import { createRequire as __bfCreateRequire } from 'node:module';\nconst require = __bfCreateRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});
try {
  fs.chmodSync(path.join(out, 'bin', 'browserforge.mjs'), 0o755);
} catch {
  /* Windows has no modes */
}

// 2. The built extensions (unpacked, for "Load unpacked") and the store zips.
for (const k of ['chrome', 'chrome-bodies', 'firefox']) fs.cpSync(path.join(extDist, k), path.join(out, 'extension', k), { recursive: true });
const art = path.join(root, 'artifacts');
if (fs.existsSync(art)) {
  fs.mkdirSync(path.join(out, 'extension', 'zips'), { recursive: true });
  for (const f of fs.readdirSync(art)) if (f.endsWith(`${version}.zip`)) fs.copyFileSync(path.join(art, f), path.join(out, 'extension', 'zips', f));
}

// 3. Things people add after installing: skills, plugins, examples, docs. (No node_modules, no personal files.)
const copyDir = (from, to) => fs.existsSync(from) && fs.cpSync(from, to, { recursive: true, filter: (s) => !/node_modules|\.venv|__pycache__/.test(s) });
copyDir(path.join(root, 'skills'), path.join(out, 'share', 'skills'));
copyDir(path.join(root, 'plugins'), path.join(out, 'share', 'plugins'));
copyDir(path.join(root, 'examples'), path.join(out, 'share', 'examples'));
copyDir(path.join(root, 'docs'), path.join(out, 'docs'));
for (const f of ['README.md', 'LICENSE', 'CONTRIBUTING.md']) if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(out, f));

// 4. The package manifest. Everything is bundled, so there are no dependencies to install.
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({
  name: '@el-makina-ai/browserforge-mcp',
  version,
  description: rootPkg.description,
  license: rootPkg.license,
  type: 'module',
  bin: { browserforge: 'bin/browserforge.mjs' },
  engines: { node: '>=22' },
  publishConfig: { access: 'public' },
  files: ['bin', 'extension', 'share', 'docs', 'README.md', 'LICENSE', 'CONTRIBUTING.md'],
  keywords: ['mcp', 'browser', 'automation', 'firefox', 'chrome', 'ai-agent'],
  repository: { type: 'git', url: 'git+https://github.com/zoghlamimostafa/BrowserForge-MCP.git' },
}, null, 2));

// 5. The tarball `npm install -g` takes. (npm's own script is run with this node: on Windows `npm` is a .cmd file.)
const npmCli = process.platform === 'win32' ? [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')] : null;
const [cmd, pre] = npmCli ? [process.execPath, npmCli] : ['npm', []];
const dest = path.join(root, 'release');
const name = execFileSync(cmd, [...pre, 'pack', out, '--pack-destination', dest, '--silent'], { encoding: 'utf8' }).trim().split('\n').pop();
console.log(`package: ${path.join(dest, name)}`);
console.log(`folder : ${out}`);
