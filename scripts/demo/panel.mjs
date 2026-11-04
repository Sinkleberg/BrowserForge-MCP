// The look of the demo video's right-hand panel (the agent's tool calls) and its title and closing cards. Plain HTML, rendered to pictures
// by record-demo.mjs. No remote fonts or images, so the video can be recorded offline.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const FONT = `system-ui, -apple-system, "Segoe UI", Roboto, "DejaVu Sans", sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace`;

const iconPath = path.join(ROOT, 'apps/firefox-extension/dist/chrome/icons/128.png');
const icon = fs.existsSync(iconPath) ? `data:image/png;base64,${fs.readFileSync(iconPath).toString('base64')}` : '';

const MARK = { call: '▸', ret: '✓', err: '✗', wait: '⏸', human: '●', info: '·' };
const COLOR = { call: '#ffd479', ret: '#7ee787', err: '#ff7b72', wait: '#f0a050', human: '#79c0ff', info: '#9aa4b2' };

export function panelHtml({ title, sub, lines }) {
  const rows = lines.slice(-16).map((l) => {
    const indent = l.kind === 'ret' ? 'padding-left:16px;' : '';
    const weight = l.kind === 'human' || l.kind === 'wait' ? 'font-weight:700;' : '';
    return `<div class="l" style="color:${COLOR[l.kind] ?? '#ddd'};${indent}${weight}"><span class="m">${MARK[l.kind] ?? ''}</span> ${esc(l.text)}</div>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;height:100%;background:#0f131a;color:#e7ebf1;font-family:${FONT}}
.p{height:720px;display:flex;flex-direction:column;border-left:1px solid #252c38}
.h{padding:18px 20px 14px;border-bottom:1px solid #252c38;background:#131923}
.k{font-size:11px;letter-spacing:.12em;color:#6f7b8e;text-transform:uppercase}
.t{font-size:20px;font-weight:700;line-height:1.25;margin-top:8px;color:#fff;min-height:50px}
.s{font-size:13.5px;line-height:1.45;color:#b4bdca;margin-top:6px;min-height:58px}
.log{flex:1;display:flex;flex-direction:column;justify-content:flex-end;padding:14px 18px;overflow:hidden;font-family:${MONO};font-size:12.5px;line-height:1.5}
.l{margin:3px 0;overflow-wrap:anywhere}.m{display:inline-block;width:14px;text-align:center;opacity:.9}
.f{padding:10px 18px;border-top:1px solid #252c38;font-size:10.5px;line-height:1.4;color:#6f7b8e;background:#131923}
</style></head><body><div class="p">
<div class="h"><div class="k">AI agent · MCP tool calls</div><div class="t">${esc(title)}</div><div class="s">${esc(sub)}</div></div>
<div class="log">${rows}</div>
<div class="f">A scripted MCP client stands in for Claude Code or Codex. The browser, the tools and everything they return are real.</div>
</div></body></html>`;
}

/** kind: 'intro' | 'outro'. opts.tag replaces the intro's tagline, opts.chips its chips (for the API demo). */
export function cardHtml(kind, opts = {}) {
  const base = `*{box-sizing:border-box}html,body{margin:0;width:1280px;height:720px;font-family:${FONT};color:#fff;
background:radial-gradient(1100px 600px at 20% 15%,#26345f 0%,#141a2b 55%,#0b0e16 100%)}
.w{width:1280px;height:720px;display:flex;flex-direction:column;justify-content:center;padding:0 110px}`;
  if (kind === 'intro') {
    return `<!doctype html><html><head><meta charset="utf-8"><style>${base}
.logo{display:flex;align-items:center;gap:22px}.logo img{width:84px;height:84px;border-radius:18px}
h1{font-size:76px;margin:0;letter-spacing:-.02em}h1 span{color:#7aa2ff}
.tag{font-size:34px;line-height:1.3;color:#d6deee;margin:34px 0 44px;max-width:900px}
.chips{display:flex;gap:16px;flex-wrap:wrap}.chip{font-size:22px;padding:10px 22px;border:1px solid #3a4666;border-radius:99px;color:#c4cee3;background:#161d30}
</style></head><body><div class="w">
<div class="logo">${icon ? `<img src="${icon}" alt="">` : ''}<h1>BrowserForge <span>MCP</span></h1></div>
<div class="tag">${esc(opts.tag ?? 'Give your AI agent a real browser, with you in control.')}</div>
<div class="chips">${(opts.chips ?? ['Your real session', 'You approve what matters', '100% local', 'Chrome · Firefox']).map((c) => `<div class="chip">${esc(c)}</div>`).join('')}</div>
</div></body></html>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>${base}
h2{font-size:56px;margin:0 0 34px;letter-spacing:-.01em}
.row{display:flex;gap:18px;margin-bottom:34px;flex-wrap:wrap}.b{font-size:26px;padding:14px 26px;border-radius:12px;font-weight:600}
.c{background:#4285f4}.f{background:#ff7139}.wn{background:#0078d6}
.cmd{font-family:${MONO};font-size:27px;background:#0b0f18;border:1px solid #2c3550;border-radius:12px;padding:18px 26px;display:inline-block;color:#9fe3b0}
.u{font-size:26px;color:#9db4ff;margin-top:30px}.n{position:absolute;left:110px;bottom:38px;font-size:17px;color:#7f8aa3;width:1060px}
</style></head><body><div class="w">
<h2>Try it</h2>
<div class="row"><div class="b c">Chrome Web Store</div><div class="b f">Firefox Add-ons</div><div class="b wn">Windows installer</div></div>
<div class="cmd">npm install -g @el-makina-ai/browserforge-mcp</div>
<div class="u">github.com/zoghlamimostafa/BrowserForge-MCP</div>
<div class="n">Recorded on the demo site that ships with the repo (scripts/demo/record-demo.mjs). A script plays the agent (and the person, where something needs approving); everything else is real. MIT licensed.</div>
</div></body></html>`;
}

/** A code editor look for the left half of the API demo: a file (or a terminal) with plain, escaped text. Lines starting with "$ " are shown as commands. */
export function codeHtml({ file, code, terminal, output }) {
  const block = (text) => esc(text).split('\n').map((l) => (l.startsWith('$ ') ? `<span class="cmd">${l}</span>` : l)).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;height:100%;background:#0d1117;color:#e6edf3;font-family:${FONT}}
.w{display:flex;flex-direction:column;height:720px;padding:22px 26px;gap:16px}
.box{border:1px solid #30363d;border-radius:10px;overflow:hidden;background:#010409;display:flex;flex-direction:column;min-height:0}
.tab{font-size:13px;color:#9da7b3;background:#161b22;border-bottom:1px solid #30363d;padding:8px 14px;font-family:${MONO}}
pre{margin:0;padding:14px 16px;font-family:${MONO};font-size:13px;line-height:1.55;white-space:pre-wrap;overflow:hidden}
.code{flex:${terminal ? '1.25' : '1'}}.term{flex:1}.term pre{color:#c9d1d9}.cmd{color:#7ee787}
</style></head><body><div class="w">
<div class="box code"><div class="tab">${esc(file)}</div><pre>${block(code)}</pre></div>
${terminal ? `<div class="box term"><div class="tab">${esc(terminal)}</div><pre>${block(output ?? '')}</pre></div>` : ''}
</div></body></html>`;
}
