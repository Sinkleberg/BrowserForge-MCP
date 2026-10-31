// Builds the cross-browser extension: dist/firefox, dist/chrome (+ -e2e variants with optional permissions pre-granted for tests).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const chromeKey = fs.readFileSync(path.join(root, 'manifests/chrome-key.txt'), 'utf8').trim();

const common = {
  name: 'BrowserForge',
  version: VERSION,
  description: 'Lets a local AI agent operate this browser and inspect HTTP APIs. Talks only to a server on 127.0.0.1.',
  icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
  action: { default_title: 'BrowserForge', default_popup: 'popup.html', default_icon: { 16: 'icons/16.png', 32: 'icons/32.png' } },
  content_scripts: [
    { matches: ['http://*/*', 'https://*/*'], js: ['page-hook.js'], run_at: 'document_start', all_frames: false, world: 'MAIN' },
    { matches: ['http://*/*', 'https://*/*'], js: ['content.js'], run_at: 'document_idle', all_frames: false },
  ],
  host_permissions: ['<all_urls>'],
};

function manifest(target, e2e, bodies = false) {
  const firefox = target === 'firefox';
  // Chrome rejects "debugger" as an optional permission ("cannot be listed as optional"), so response-body capture there is a separate
  // build (`chrome-bodies`) where it is required. Firefox can ask for its body permissions at run time.
  const optional = firefox ? ['downloads', 'webRequestBlocking', 'webRequestFilterResponse'] : ['downloads'];
  const base = ['tabs', 'storage', 'scripting', 'webRequest', 'alarms'];
  const required = !firefox && (bodies || e2e) ? ['debugger'] : [];
  const m = {
    manifest_version: 3,
    ...common,
    ...(bodies ? { description: `${common.description} This build can also capture response bodies, using Chrome's debugger permission (Chrome then shows a "debugging this browser" banner on captured tabs).` } : {}),
    permissions: e2e ? [...base, ...optional, ...required] : [...base, ...required],
    ...(e2e ? {} : { optional_permissions: optional }),
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
  };
  if (e2e) m.web_accessible_resources = [{ resources: ['popup.html', 'popup.js', 'popup.css', 'approve.html', 'approve.js'], matches: ['http://127.0.0.1/*'] }]; // lets tests open the popup in a tab
  if (firefox) {
    m.background = { scripts: ['background.js'] };
    m.browser_specific_settings = { gecko: { id: 'browserforge@browserforge.local', strict_min_version: '140.0', data_collection_permissions: { required: ['none'] } }, gecko_android: { strict_min_version: '142.0' } };
  } else {
    m.background = { service_worker: 'background.js' };
    m.minimum_chrome_version = '116';
    m.key = chromeKey;
  }
  return m;
}

// --- tiny PNG icon generator (no dependencies) ---
function crc32(buf) {
  let c, crc = ~0;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const px = Buffer.alloc(size * size * 4);
  const r = size * 0.22;
  const inRound = (x, y) => {
    const cx = Math.min(Math.max(x, r), size - 1 - r), cy = Math.min(Math.max(y, r), size - 1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const u = size / 16;
  // Anvil-ish glyph: a white "F" built from rectangles on a blue rounded square.
  const glyph = (x, y) => (x >= 4 * u && x < 6.4 * u && y >= 3 * u && y < 13 * u) || (x >= 4 * u && x < 12 * u && y >= 3 * u && y < 5.4 * u) || (x >= 4 * u && x < 10 * u && y >= 7 * u && y < 9.2 * u);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const o = (y * size + x) * 4;
    if (!inRound(x, y)) continue;
    const g = glyph(x, y);
    px[o] = g ? 255 : 9; px[o + 1] = g ? 255 : 105; px[o + 2] = g ? 255 : 218; px[o + 3] = 255;
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function buildTarget(name, target, e2e, bodies = false) {
  const out = path.join(dist, name);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'icons'), { recursive: true });
  const shared = { bundle: true, format: 'iife', target: ['firefox128', 'chrome116'], sourcemap: false, minify: false, logLevel: 'warning', platform: 'browser', tsconfig: path.join(root, 'tsconfig.json'), legalComments: 'none', minifySyntax: !e2e, define: { __E2E__: String(e2e) } };
  await build({ ...shared, entryPoints: { background: path.join(root, 'src/background.ts'), content: path.join(root, 'src/content.ts'), popup: path.join(root, 'src/popup.ts'), approve: path.join(root, 'src/approve.ts'), 'page-hook': path.join(root, 'src/page-hook.ts') }, outdir: out });
  for (const f of fs.readdirSync(path.join(root, 'static'))) fs.copyFileSync(path.join(root, 'static', f), path.join(out, f));
  for (const s of [16, 32, 48, 128]) fs.writeFileSync(path.join(out, 'icons', `${s}.png`), png(s));
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest(target, e2e, bodies), null, 2));
  console.log(`built ${path.relative(process.cwd(), out)}`);
}

await buildTarget('firefox', 'firefox', false);
await buildTarget('chrome', 'chrome', false);
await buildTarget('chrome-bodies', 'chrome', false, true);
await buildTarget('firefox-e2e', 'firefox', true);
await buildTarget('chrome-e2e', 'chrome', true);

if (process.argv.includes('--package')) {
  const art = path.resolve(root, '../../artifacts');
  fs.mkdirSync(art, { recursive: true });
  // Run web-ext's script with this node: node_modules/.bin/web-ext is a shell script, which Windows cannot start directly.
  const webext = path.resolve(root, '../../node_modules/web-ext/bin/web-ext.js');
  for (const t of ['firefox', 'chrome', 'chrome-bodies']) {
    execFileSync(process.execPath, [webext, 'build', '--source-dir', path.join(dist, t), '--artifacts-dir', art, '--filename', `browserforge-${t}-${VERSION}.zip`, '--overwrite-dest'], { stdio: 'inherit' });
  }
  // The Chrome Web Store refuses a manifest with a "key" (the store assigns its own ID), so the store uploads are built from copies without it.
  // The unpacked builds keep the key so "Load unpacked" always gets the same ID.
  for (const t of ['chrome', 'chrome-bodies']) {
    const storeDir = path.join(dist, `${t}-store`);
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.cpSync(path.join(dist, t), storeDir, { recursive: true });
    const m = JSON.parse(fs.readFileSync(path.join(storeDir, 'manifest.json'), 'utf8'));
    delete m.key;
    fs.writeFileSync(path.join(storeDir, 'manifest.json'), JSON.stringify(m, null, 2));
    execFileSync(process.execPath, [webext, 'build', '--source-dir', storeDir, '--artifacts-dir', art, '--filename', `browserforge-${t}-store-${VERSION}.zip`, '--overwrite-dest'], { stdio: 'inherit' });
  }
  console.log(`packages written to ${art}`);
}
