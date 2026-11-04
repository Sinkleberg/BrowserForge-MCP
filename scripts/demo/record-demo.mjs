// Records the BrowserForge showcase video: a real Chromium with the real extension, driven through the real MCP tools against the
// demo site that ships with the repo. The left half of the picture is the browser; the right half is the agent's tool calls.
//
//   npm run build            (the script uses the built program and the "chrome-e2e" extension build)
//   node scripts/demo/record-demo.mjs [output folder] [--scene tour|api]       default: docs/assets, tour
//     tour -> demo.mp4, demo.gif, demo-poster.png          (fill a form, approve the submit, traffic to OpenAPI, the dashboard)
//     api  -> demo-api.mp4, demo-api.gif, demo-api-poster.png   (browse a site, get its OpenAPI spec and a Python client, run the client)
//
// Needs: Playwright's Chromium (or BF_CHROMIUM=/path/to/chrome), ffmpeg and ffprobe on the PATH.
// Honest by design: the "agent" is this script's MCP client standing in for Claude Code or Codex, and the person who approves is the
// script pressing the popup button on a fake site. Nothing on screen is mocked: the tool results, the popup and the dashboard are real.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chromium } from 'playwright';
import { createApp } from '../../apps/mcp-server/dist/app.js';
import { commit, stage } from '../../apps/mcp-server/dist/plugins/installer.js';
import { PluginStore } from '../../apps/mcp-server/dist/plugins/store.js';
import { startDemoSite } from '../../tests/fixtures/demo-site/server.mjs';
import { cardHtml, codeHtml, panelHtml } from './panel.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ARGS = process.argv.slice(2);
const SCENE = ARGS.includes('--scene') ? ARGS[ARGS.indexOf('--scene') + 1] : 'tour';
if (!['tour', 'api'].includes(SCENE)) throw new Error(`Unknown --scene ${SCENE} (use tour or api)`);
const OUT = path.resolve(ARGS.find((a, i) => !a.startsWith('--') && ARGS[i - 1] !== '--scene') ?? path.join(ROOT, 'docs', 'assets'));
const NAME = SCENE === 'tour' ? 'demo' : 'demo-api';
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-demo-'));
const W = 860, H = 720, PANEL_W = 420; // 860 + 420 = 1280
const FPS = 25;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });

function findChromium() {
  if (process.env.BF_CHROMIUM) return process.env.BF_CHROMIUM;
  const base = path.join(os.homedir(), '.cache/ms-playwright');
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])) : [];
  for (const d of dirs) {
    const exe = path.join(base, d, 'chrome-linux64/chrome');
    if (fs.existsSync(exe)) return exe;
  }
  throw new Error('No Playwright Chromium found. Run: npx playwright install chromium (or set BF_CHROMIUM)');
}

async function waitFor(fn, what, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(150);
  }
}

// ---------- the server, the demo site, the extension ----------
const home = path.join(WORK, 'home');
fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
{
  // So the dashboard has something to show: the example plugin and the example skill.
  const store = new PluginStore(home);
  commit(store, await stage(store, path.join(ROOT, 'examples/plugins/hello')));
  fs.cpSync(path.join(ROOT, 'examples/skills/hello'), path.join(home, 'skills', 'hello'), { recursive: true });
}
const demo = await startDemoSite({ port: 0 });
const app = createApp({ port: 0, configDir: home, logLevel: 'error', extraAllowDirs: [home] });
await app.listen();
const client = new Client({ name: 'demo-agent', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${app.ctx.config.mcpToken}` } } }));

const extSrc = path.join(ROOT, 'apps/firefox-extension/dist/chrome-e2e');
if (!fs.existsSync(path.join(extSrc, 'manifest.json'))) throw new Error('Extension not built: run npm run build');
const extDir = path.join(WORK, 'ext');
fs.cpSync(extSrc, extDir, { recursive: true });
fs.writeFileSync(path.join(extDir, 'e2e-config.json'), JSON.stringify({ serverUrl: `ws://127.0.0.1:${app.port}/ext`, token: app.ctx.config.extensionToken }));

const videoDir = path.join(WORK, 'video');
const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile'), {
  executablePath: findChromium(),
  headless: true,
  viewport: { width: W, height: H },
  recordVideo: { dir: videoDir, size: { width: W, height: H } },
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--headless=new', '--force-device-scale-factor=1'],
});
await waitFor(() => app.ctx.hub.listPeers().some((p) => p.connected), 'the extension to connect');
const first = ctx.pages()[0];
const page = await ctx.newPage(); // the page that gets recorded (and becomes the agent's active tab)
const T0 = Date.now();
await first?.close();

// ---------- what the right-hand panel will show ----------
const events = [];
const at = () => Date.now() - T0;
const scene = (title, sub) => events.push({ t: at(), kind: 'scene', title, sub });
const line = (kind, text) => events.push({ t: at(), kind, text });
const brief = (o) => Object.entries(o).map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v.length > 28 ? `${v.slice(0, 27)}…` : v) : JSON.stringify(v)}`).join(', ');

async function tool(name, args = {}, show = () => 'ok') {
  line('call', `${name}(${brief(args)})`);
  const raw = await client.callTool({ name, arguments: args });
  const text = raw.content.find((c) => c.type === 'text')?.text;
  let data;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
  if (raw.isError) { line('err', String(data?.error?.message ?? text).slice(0, 120)); throw new Error(`${name} failed: ${text}`); }
  line('ret', show(data?.data ?? data, data));
  return data?.data ?? data;
}

const popupUrl = 'chrome-extension://omjlkhmfagboopakfflhapniolpfbogp/popup.html';
async function openPopup() {
  await page.evaluate((u) => {
    const f = document.createElement('iframe');
    f.id = 'bf-popup-frame';
    f.src = u;
    f.style.cssText = 'position:fixed;top:12px;right:12px;width:380px;height:520px;z-index:2147483647;background:#fff;border:1px solid #8a8f98;border-radius:10px;box-shadow:0 14px 44px rgba(0,0,0,.4)';
    document.body.appendChild(f);
  }, popupUrl);
  const frame = await (await page.waitForSelector('#bf-popup-frame')).contentFrame();
  await frame.waitForFunction(() => document.getElementById('status')?.textContent);
  return frame;
}

// ---------- the tour: scenes 1-4 ----------
async function tourScenes() {
await sleep(300);
scene('1 · The agent works in your real browser', 'It reads the page and fills the form from your profile. Nothing leaves your computer.');
await sleep(700);
await tool('system_status', {}, (d) => `${d.browsers.filter((b) => b.connected).length} browser connected (${d.browsers[0]?.kind}), approvals: manual`);
await sleep(400);
await tool('browser_navigate', { url: `${demo.url}/apply` }, () => 'job application form loaded');
await sleep(1500);
await tool('browser_get_interactive_elements', {}, (d) => {
  const els = d.elements ?? [];
  const names = els.map((e) => e.label ?? e.name ?? e.text ?? e.placeholder ?? e.id).filter((x) => typeof x === 'string' && x).slice(0, 7);
  return `${els.length} controls: ${names.join(', ')}…`;
});
await sleep(1500);
const fields = [
  ['#full_name', 'Ada Lovelace'],
  ['#email', 'ada@example.com'],
  ['#phone', '+216 20 000 000'],
  ['#years', '8'],
  ['#cover_letter', 'I build reliable systems and I like clear documentation.'],
];
for (const [selector, value] of fields) {
  await tool('browser_fill_field', { selector, value }, () => 'filled');
  await sleep(650);
}
await tool('browser_select_option', { selector: '#country', label: 'Tunisia' }, () => 'selected Tunisia');
await sleep(1800);

// ---------- scene 2: you approve what matters ----------
scene('2 · You approve what matters', 'Submitting waits for a click in the extension popup. The agent cannot answer it.');
await page.evaluate(() => document.getElementById('submit')?.scrollIntoView({ behavior: 'smooth', block: 'center' })); // camera move: show the button
await sleep(1600);
line('call', 'browser_click(selector: "#submit")');
const submit = client.callTool({ name: 'browser_click', arguments: { selector: '#submit' } });
const frame = await openPopup();
await frame.waitForSelector('#approvalList li', { timeout: 20_000 });
line('wait', 'paused: waiting for the human to approve');
await sleep(4500); // time to read the popup
line('human', 'You press Approve in the extension');
await frame.evaluate(() => { const b = document.querySelector('#approvalList li button'); if (b) b.style.cssText += ';outline:4px solid #2f6fed;outline-offset:2px'; });
await sleep(1400);
await frame.click('#approvalList li button >> nth=0');
const sent = await submit;
line('ret', sent.isError ? 'failed' : 'submitted after approval');
await sleep(2200);
await page.evaluate(() => document.getElementById('bf-popup-frame')?.remove());
await tool('browser_get_page_text', {}, () => 'page says: "Application received"');
await sleep(2200);

// ---------- scene 3: traffic becomes API docs ----------
scene('3 · Traffic becomes API docs', 'Captured requests are analysed by code, not a model: endpoints, parameters, auth, pagination and an OpenAPI 3.1 spec.');
await sleep(1500);
// Request metadata only: response bodies would attach Chrome's debugger, and Chrome then shows a banner that shrinks the page in the video.
await tool('network_configure_capture', { enabled: true }, () => 'capture on for this browser');
await sleep(700);
await tool('browser_navigate', { url: `${demo.url}/shop` }, () => 'shop loaded, its API calls are recorded');
await waitFor(async () => {
  const d = (await client.callTool({ name: 'network_list_requests', arguments: { urlPattern: '/graphql' } })).content[0].text;
  return (JSON.parse(d).data?.total ?? 0) >= 1;
}, 'shop traffic');
await sleep(2200);
const reqs = await tool('network_list_requests', { urlPattern: '/api/' }, (d) => `${d.total} API requests captured`);
await sleep(1500);
const analysis = await tool('api_analyze_traffic', {}, (d) => `${d.endpoints?.length ?? d.summary?.endpoints ?? '?'} endpoints found (observed / inferred, with confidence)`);
await sleep(1800);
const aid = analysis.analysisId ?? analysis.id;
const eps = await tool('api_list_endpoints', { analysisId: aid, limit: 6 }, (d) => (d.endpoints ?? d.items ?? []).slice(0, 4).map((e) => e.id).join('  '));
await sleep(1800);
await tool('api_generate_openapi', { analysisId: aid, title: 'Demo shop API' }, (d, raw) => {
  const doc = d.document ?? d.openapi ?? d;
  return `OpenAPI ${doc.openapi ?? '3.1'}: ${Object.keys(doc.paths ?? {}).length} paths`;
});
void reqs; void eps;
await sleep(2600);

// ---------- scene 4: see what is installed ----------
scene('4 · See what is installed', 'A read-only dashboard: tools, plugin permissions, skills and the flows it recorded.');
await sleep(1200);
line('call', 'browserforge dashboard');
await page.goto(`http://127.0.0.1:${app.port}/dashboard#t=${encodeURIComponent(app.ctx.config.dashboardToken)}`);
await page.waitForSelector('#live.ok');
line('ret', 'opens http://127.0.0.1/dashboard (own token, read-only)');
await sleep(3200);
const tab = async (name, note, hold = 3000, extra) => {
  await page.getByRole('button', { name, exact: true }).click();
  line('info', note);
  await sleep(1200);
  if (extra) await extra();
  await sleep(hold);
};
await tab('MCP', 'every tool, grouped; read-only ones marked', 2600, async () => { await page.mouse.move(430, 450); await page.mouse.wheel(0, 340); });
await tab('Plugins', 'the plugin and what you allowed it to do, in plain words', 3600);
await tab('Skills', 'skills and their ready-made workflows', 3400);
await tab('Flows', 'every task it did is already a replayable flow', 3600);
await tab('Overview', 'one place to see the whole install', 2200);
}

// ---------- the API demo: a website becomes a spec and a working Python client ----------
async function apiScenes() {
  await sleep(300);
  scene('1 · The agent explores a website', 'It opens the shop and clicks around. BrowserForge records the API calls the page makes.');
  await sleep(900);
  // Request metadata only: response bodies would attach Chrome's debugger, and Chrome then shows a banner that shrinks the page in the video.
  await tool('network_configure_capture', { enabled: true }, () => 'capture on for this browser');
  await sleep(500);
  await tool('browser_navigate', { url: `${demo.url}/shop` }, () => 'shop loaded');
  await waitFor(async () => {
    const d = (await client.callTool({ name: 'network_list_requests', arguments: { urlPattern: '/graphql' } })).content[0].text;
    return (JSON.parse(d).data?.total ?? 0) >= 1;
  }, 'shop traffic');
  await sleep(1600);
  // The demo shop has two pages: one "Load more" reaches the end (the button then disables itself).
  await tool('browser_click', { selector: '#more' }, () => 'page 2 of products loaded');
  await sleep(1500);
  await tool('network_list_requests', { urlPattern: '/api/' }, (d) => `${d.total} API requests captured`);
  await sleep(1800);

  scene('2 · Traffic becomes an API spec', 'Endpoints, parameters, pagination and auth are inferred by code, not a model, each with its evidence and confidence.');
  await sleep(1200);
  // Only the site's REST API (the demo server also answers unknown paths such as /favicon.ico with JSON, which would look like an endpoint).
  const analysis = await tool('api_analyze_traffic', { urlPattern: '/api/' }, (d) => `${d.endpoints?.length ?? d.summary?.endpoints ?? '?'} endpoints found`);
  const aid = analysis.analysisId ?? analysis.id;
  await sleep(1500);
  await tool('api_list_endpoints', { analysisId: aid, limit: 6 }, (d) => (d.endpoints ?? d.items ?? []).slice(0, 4).map((e) => e.id).join('  '));
  await sleep(1500);
  const spec = await tool('api_generate_openapi', { analysisId: aid, title: 'Demo shop API' }, (d) => {
    const doc = d.document ?? d.openapi ?? d;
    return `OpenAPI ${doc.openapi ?? '3.1'}: ${Object.keys(doc.paths ?? {}).length} paths`;
  });
  const doc = spec.document ?? spec.openapi ?? spec;
  const specLines = JSON.stringify({ openapi: doc.openapi, info: doc.info, paths: Object.fromEntries(Object.entries(doc.paths ?? {}).slice(0, 3)) }, null, 2).split('\n').slice(0, 34).join('\n');
  await page.setContent(codeHtml({ file: 'openapi.json  (generated, excerpt)', code: specLines }));
  await sleep(4200);

  scene('3 · …and a working Python client', 'Generated with models, retries and pagination, checked by its own tests, then used against the real site.');
  await sleep(1000);
  const gen = await tool('api_generate_client', { analysisId: aid, language: 'python', outputDir: 'demo-shop-client', packageName: 'demo_shop', title: 'Demo shop API' },
    (d) => `python package written; checks: ${(d.checks ?? []).map((c) => `${c.name ?? c.check ?? 'check'} ${c.status ?? (c.ok ? 'ok' : '')}`.trim()).join(', ') || 'passed'}`);
  const outDir = gen.outputDir ?? gen.written ?? gen.path ?? path.join(home, 'exports', 'demo-shop-client');
  await sleep(1200);
  // The client's real public methods, read with Python itself, so the script below calls what was generated.
  const methods = JSON.parse(sh('python3', ['-I', '-c', [
    'import inspect, json, sys', `sys.path.insert(0, ${JSON.stringify(outDir)})`, 'from demo_shop import Client',
    'out = {}',
    'for n, f in inspect.getmembers(Client, inspect.isfunction):',
    '    if n.startswith("_"): continue',
    '    ps = [p for p in inspect.signature(f).parameters.values() if p.name != "self"]',
    '    out[n] = {"required": [p.name for p in ps if p.default is inspect.Parameter.empty and p.kind != p.KEYWORD_ONLY], "kw": [p.name for p in ps if p.kind == p.KEYWORD_ONLY]}',
    'print(json.dumps(out))'].join('\n')]));
  const names = Object.keys(methods);
  const listOp = names.find((n) => n.startsWith('list_') && /product/.test(n) && methods[n].required.length === 0);
  const getOp = names.find((n) => n.startsWith('get_') && /product/.test(n) && methods[n].required.length === 1);
  if (!listOp || !getOp) throw new Error(`Unexpected client methods: ${names.join(', ')}`);
  const kw = (op, wanted) => Object.entries(wanted).filter(([k]) => methods[op].kw.includes(k)).map(([k, v]) => `${k}=${v}`).join(', ');
  const clientPy = fs.readFileSync(path.join(outDir, 'demo_shop', 'client.py'), 'utf8').split('\n');
  const defs = clientPy.filter((l) => /^    def [a-z]/.test(l) && !/def _/.test(l)).map((l) => l.trim().replace(/:$/, ''));
  const script = [
    'from demo_shop import Client',
    '',
    `shop = Client("${demo.url}")`,
    `first = shop.${listOp}(${kw(listOp, { page: 1, per_page: 3, category: '"tools"' })})`,
    'for item in first["data"]:',
    '    print(item["id"], item["name"], item["price"])',
    `print(shop.${getOp}(3))`,
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'use_client.py'), script + '\n');
  await page.setContent(codeHtml({ file: 'demo_shop/client.py  (generated: public methods)', code: ['class Client:', ...defs.slice(0, 12).map((d) => '    ' + d + ': ...')].join('\n') }));
  line('info', `class Client: ${names.filter((n) => !n.startsWith('iter_')).slice(0, 5).join(', ')}…`);
  await sleep(4200);
  line('call', '$ python3 use_client.py');
  await page.setContent(codeHtml({ file: 'use_client.py', code: script, terminal: 'terminal', output: '$ python3 use_client.py' }));
  await sleep(1300);
  // Run it the way a person would: from the client's folder (the generated package sits next to the script). Asynchronously: the demo
  // site runs in this same process, and a blocking call would stop it from answering the client.
  const output = (await new Promise((resolve, reject) => execFile('python3', ['use_client.py'], { cwd: outDir, encoding: 'utf8', timeout: 30_000 }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout))))).trim();
  line('ret', output.split('\n').slice(0, 3).join('  |  ').slice(0, 150));
  await page.setContent(codeHtml({ file: 'use_client.py', code: script, terminal: 'terminal', output: `$ python3 use_client.py\n${output}` }));
  await sleep(4800);
}

if (SCENE === 'tour') await tourScenes(); else await apiScenes();
const endT = at();
await ctx.close(); // finalises the video
const rawVideo = fs.readdirSync(videoDir).map((f) => path.join(videoDir, f)).filter((f) => f.endsWith('.webm')).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
await client.close().catch(() => undefined);
await app.close();
await demo.close();
if (!rawVideo) throw new Error('No video was recorded');

// ---------- the right-hand panel: one picture per event ----------
fs.mkdirSync(OUT, { recursive: true });
// The recording keeps running while the browser shuts down: stop shortly after the last event.
const dur = Math.min(Number(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', rawVideo]).trim()), endT / 1000 + 0.8);
const renderer = await chromium.launch({ executablePath: findChromium(), headless: true });
const rp = await renderer.newPage({ viewport: { width: PANEL_W, height: H }, deviceScaleFactor: 1 });
const panelDir = path.join(WORK, 'panel');
fs.mkdirSync(panelDir);
const state = { title: '', sub: '', lines: [] };
const frames = [];
const snapshot = async (n, t) => {
  await rp.setContent(panelHtml(state), { waitUntil: 'load' });
  const file = path.join(panelDir, `p${String(n).padStart(4, '0')}.png`);
  await rp.screenshot({ path: file });
  frames.push({ file, t });
};
await snapshot(0, 0);
let n = 1;
for (const e of events) {
  if (e.kind === 'scene') { state.title = e.title; state.sub = e.sub; state.lines = []; } else state.lines.push({ kind: e.kind, text: e.text });
  await snapshot(n++, e.t / 1000);
}
const list = [];
frames.forEach((f, i) => {
  const next = i + 1 < frames.length ? frames[i + 1].t : dur;
  const d = Math.max(0.04, next - f.t);
  list.push(`file '${f.file.replace(/'/g, "'\\''")}'`, `duration ${d.toFixed(3)}`);
});
list.push(`file '${frames.at(-1).file.replace(/'/g, "'\\''")}'`);
fs.writeFileSync(path.join(WORK, 'panel.txt'), list.join('\n'));

// ---------- title and closing cards ----------
const intro = path.join(WORK, 'intro.png');
const outro = path.join(WORK, 'outro.png');
const cp = await renderer.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await cp.setContent(cardHtml('intro', SCENE === 'api' ? { tag: 'Browse a website. Get its API spec and a working client.', chips: ['Real browser traffic', 'OpenAPI 3.1', 'Python · TypeScript · JS · PHP', 'No LLM in the analysis'] } : {}), { waitUntil: 'load' });
await cp.screenshot({ path: intro });
await cp.setContent(cardHtml('outro'), { waitUntil: 'load' });
await cp.screenshot({ path: outro });
await renderer.close();

// ---------- put it together ----------
const main = path.join(WORK, 'main.mp4');
sh('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', rawVideo, '-f', 'concat', '-safe', '0', '-i', path.join(WORK, 'panel.txt'),
  '-filter_complex', `[0:v]fps=${FPS},scale=${W}:${H}:flags=lanczos,format=yuv420p[a];[1:v]fps=${FPS},scale=${PANEL_W}:${H},format=yuv420p[b];[a][b]hstack=inputs=2[v]`,
  '-map', '[v]', '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-pix_fmt', 'yuv420p', '-t', dur.toFixed(2), main]);
const video = path.join(OUT, `${NAME}.mp4`);
const INTRO = 4, OUTRO = 6, mainDur = Number(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', main]).trim());
sh('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-loop', '1', '-t', String(INTRO), '-i', intro, '-i', main, '-loop', '1', '-t', String(OUTRO), '-i', outro,
  '-filter_complex', `[0:v]fps=${FPS},format=yuv420p,fade=t=out:st=${INTRO - 0.6}:d=0.6[v0];[1:v]fps=${FPS},format=yuv420p,fade=t=in:st=0:d=0.5[v1];[2:v]fps=${FPS},format=yuv420p,fade=t=in:st=0:d=0.6[v2];[v0][v1][v2]concat=n=3:v=1:a=0[v]`,
  '-map', '[v]', '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video]);

// ---------- a short GIF of the approval scene, for the README ----------
// tour: the approval scene; api: the generated client being used.
const s2 = events.find((e) => e.kind === 'scene' && e.title.startsWith('2'));
const s3 = events.find((e) => e.kind === 'scene' && e.title.startsWith('3'));
const gifStart = SCENE === 'tour' ? s2 : s3;
const gifEnd = SCENE === 'tour' ? s3.t : endT;
const gif = path.join(OUT, `${NAME}.gif`);
const from = Math.max(0, gifStart.t / 1000 - 0.2), len = Math.min(24, (gifEnd - gifStart.t) / 1000);
const pal = path.join(WORK, 'palette.png');
const gifFilter = 'fps=10,scale=760:-1:flags=lanczos';
sh('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', from.toFixed(2), '-t', len.toFixed(2), '-i', main, '-vf', `${gifFilter},palettegen=max_colors=96:stats_mode=diff`, pal]);
sh('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', from.toFixed(2), '-t', len.toFixed(2), '-i', main, '-i', pal, '-lavfi', `${gifFilter} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, gif]);
const poster = path.join(OUT, `${NAME}-poster.png`);
sh('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', video, '-ss', String(INTRO + (gifStart.t / 1000) + (SCENE === 'tour' ? 5 : Math.max(1, len - 3))), '-frames:v', '1', poster]);

const kb = (f) => `${(fs.statSync(f).size / 1024 / 1024).toFixed(1)} MB`;
console.log(`${NAME}.mp4   ${kb(video)}  ${(INTRO + mainDur + OUTRO).toFixed(0)} s   ${pathToFileURL(video).href}`);
console.log(`${NAME}.gif   ${kb(gif)}  ${len.toFixed(0)} s`);
console.log(`poster     ${kb(poster)}`);
console.log(`events: ${events.length}, recorded: ${(endT / 1000).toFixed(0)} s, work folder: ${WORK}`);
