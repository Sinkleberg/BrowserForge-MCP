// Makes docs/assets/social-preview.png (1280x640): the picture shown when the repository link is shared. Uses the demo poster, so it shows the real product.
// GitHub cannot set it from the API: upload it once under Settings > General > Social preview.
//   node scripts/demo/social-preview.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const poster = path.join(ROOT, 'docs/assets/demo-poster.png');
const icon = path.join(ROOT, 'apps/firefox-extension/dist/chrome/icons/128.png');
if (!fs.existsSync(poster)) throw new Error('Run npm run demo:record first (it writes docs/assets/demo-poster.png)');
const b64 = (f) => `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
const base = os.homedir() + '/.cache/ms-playwright';
const exe = process.env.BF_CHROMIUM ?? fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])).map((d) => path.join(base, d, 'chrome-linux64/chrome')).find(fs.existsSync);
const FONT = 'system-ui,-apple-system,"Segoe UI",Roboto,"DejaVu Sans",sans-serif';
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:1280px;height:640px;font-family:${FONT};color:#fff;overflow:hidden;
background:radial-gradient(900px 560px at 15% 10%,#2a3a6b 0%,#141a2b 55%,#0b0e16 100%)}
.l{position:absolute;left:70px;top:70px;width:560px}
.logo{display:flex;align-items:center;gap:16px}.logo img{width:64px;height:64px;border-radius:14px}
h1{font-size:52px;margin:0;letter-spacing:-.02em}h1 span{color:#7aa2ff}
.t{font-size:36px;line-height:1.22;font-weight:700;margin:34px 0 22px}
.s{font-size:22px;line-height:1.4;color:#bcc6dc}
.chips{position:absolute;left:70px;bottom:56px;display:flex;gap:12px}.c{font-size:19px;padding:8px 18px;border:1px solid #3a4666;border-radius:99px;background:#161d30;color:#c9d3ea}
.p{position:absolute;right:-70px;top:86px;width:700px;border-radius:14px;box-shadow:0 30px 70px rgba(0,0,0,.6);border:1px solid #3a4666;transform:rotate(-2deg)}
</style></head><body>
<div class="l"><div class="logo"><img src="${b64(icon)}" alt=""><h1>BrowserForge <span>MCP</span></h1></div>
<div class="t">Give your AI agent a real browser. You stay in control.</div>
<div class="s">An agent fills the form; the extension asks <b>you</b> before it submits. Local-first. Chrome + Firefox.</div></div>
<img class="p" src="${b64(poster)}" alt="">
<div class="chips"><div class="c">MCP server</div><div class="c">Claude Code · Codex</div><div class="c">OpenAPI from traffic</div><div class="c">MIT</div></div>
</body></html>`;
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
const out = path.join(ROOT, 'docs/assets/social-preview.png');
await page.screenshot({ path: out });
await browser.close();
console.log(`${out}  ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
