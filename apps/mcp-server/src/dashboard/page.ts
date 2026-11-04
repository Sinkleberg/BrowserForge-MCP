/**
 * The read-only dashboard page: three static files kept as strings so the single-file release bundle needs no asset copying.
 * They contain no data. The page asks /dashboard/data with the dashboard token it finds in the URL fragment (`#t=...`), which the browser
 * never sends to a server. The Content-Security-Policy (see app.ts) allows only these two files, so nothing inline can run, and every piece
 * of text from a plugin, skill or flow is put on the page with textContent, never as HTML.
 */

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>BrowserForge dashboard</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/dashboard/app.css">
</head>
<body>
<header>
  <h1>BrowserForge <span>dashboard</span></h1>
  <div id="live" class="live" role="status">connecting…</div>
</header>
<nav id="tabs" aria-label="Sections"></nav>
<main id="view"><p class="muted">Loading…</p></main>
<footer>Read-only. Local to this computer. To change something, use the commands shown on each page.</footer>
<script src="/dashboard/app.js"></script>
</body>
</html>
`;

export const DASHBOARD_CSS = String.raw`
:root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --fg:#1b1f24; --muted:#667085; --line:#e3e6eb; --accent:#2f6fed; --ok:#12805c; --warn:#b54708; --bad:#b42318; }
@media (prefers-color-scheme: dark) { :root { --bg:#12151a; --card:#1b2028; --fg:#e8ebf0; --muted:#98a2b3; --line:#2a313c; --accent:#7aa2ff; --ok:#4ade80; --warn:#fbbf24; --bad:#f87171; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
header { display:flex; align-items:center; justify-content:space-between; padding:14px 24px; border-bottom:1px solid var(--line); background:var(--card); }
h1 { font-size:18px; margin:0; } h1 span { color:var(--muted); font-weight:400; }
h2 { font-size:16px; margin:0 0 10px; } h3 { font-size:14px; margin:14px 0 6px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
.live { font-size:13px; color:var(--muted); } .live.ok::before, .live.err::before { content:""; display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; background:var(--ok); } .live.err::before { background:var(--bad); }
nav { display:flex; gap:4px; padding:8px 24px 0; border-bottom:1px solid var(--line); background:var(--card); overflow-x:auto; }
nav button { border:0; background:none; color:var(--muted); font:inherit; padding:8px 14px; cursor:pointer; border-bottom:2px solid transparent; white-space:nowrap; }
nav button[aria-selected="true"] { color:var(--fg); border-bottom-color:var(--accent); font-weight:600; }
nav button:focus-visible, .copy:focus-visible, input:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
main { max-width:1100px; margin:0 auto; padding:20px 24px 40px; }
footer { text-align:center; color:var(--muted); font-size:12px; padding:16px; }
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(230px,1fr)); gap:12px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin-bottom:12px; }
.grid .card { margin-bottom:0; }
.stat { font-size:26px; font-weight:650; line-height:1.2; } .label { color:var(--muted); font-size:13px; }
.muted { color:var(--muted); } .small { font-size:13px; }
.badge { display:inline-block; font-size:12px; padding:1px 8px; border-radius:99px; border:1px solid var(--line); margin-left:6px; vertical-align:middle; }
.badge.ok { color:var(--ok); border-color:var(--ok); } .badge.warn { color:var(--warn); border-color:var(--warn); } .badge.bad { color:var(--bad); border-color:var(--bad); }
table { width:100%; border-collapse:collapse; font-size:14px; } th, td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--line); vertical-align:top; } th { color:var(--muted); font-weight:500; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
code, .cmd { font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
.cmd { display:flex; align-items:center; gap:8px; background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:6px 10px; margin:6px 0; overflow-x:auto; }
.cmd code { flex:1; white-space:pre; } .copy { border:1px solid var(--line); background:var(--card); color:var(--fg); border-radius:6px; padding:2px 8px; font-size:12px; cursor:pointer; }
ul.plain { margin:4px 0 0; padding-left:18px; } li { margin:2px 0; }
input[type=search] { width:100%; max-width:380px; padding:7px 10px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--fg); font:inherit; margin-bottom:10px; }
.empty { padding:18px; text-align:center; color:var(--muted); }
`;

export const DASHBOARD_JS = String.raw`
(function () {
  'use strict';
  var KEY = 'bf-dashboard-token';
  // The token arrives in the address (#t=...). Keep it for this tab only and take it out of the address bar and the history.
  var m = /[#&]t=([^&]+)/.exec(location.hash);
  if (m) { sessionStorage.setItem(KEY, decodeURIComponent(m[1])); history.replaceState(null, '', location.pathname); }
  var token = sessionStorage.getItem(KEY);

  var TABS = [['overview', 'Overview'], ['mcp', 'MCP'], ['plugins', 'Plugins'], ['skills', 'Skills'], ['flows', 'Flows'], ['models', 'Local models']];
  var current = 'overview';
  var data = null;
  var filter = '';

  // Every piece of text goes through textContent / text nodes. Nothing from a plugin, skill or flow is ever treated as HTML.
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === 'class') el.className = props[k];
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), props[k]);
      else el.setAttribute(k, props[k]);
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  function badge(text, kind) { return h('span', { class: 'badge ' + (kind || '') }, text); }
  function cmd(text) {
    var b = h('button', { class: 'copy', type: 'button', 'aria-label': 'Copy command' }, 'Copy');
    b.addEventListener('click', function () {
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1200); });
    });
    return h('div', { class: 'cmd' }, h('code', null, text), b);
  }
  function stat(value, label, extra) { return h('div', { class: 'card' }, h('div', { class: 'stat' }, value), h('div', { class: 'label' }, label), extra || null); }
  function empty(text) { return h('div', { class: 'card empty' }, text); }
  function table(head, rows) {
    return h('table', null, h('thead', null, h('tr', null, head.map(function (t) { return h('th', null, t); }))), h('tbody', null, rows.map(function (r) { return h('tr', null, r.map(function (c) { return h('td', null, c); })); })));
  }
  function ago(iso) {
    var s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 60) return s + ' s ago';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }
  function uptime(sec) {
    if (sec < 120) return sec + ' s';
    if (sec < 7200) return Math.round(sec / 60) + ' min';
    return Math.round(sec / 3600) + ' h';
  }

  function overview(d) {
    var up = d.browsers.filter(function (b) { return b.connected; });
    var loaded = d.plugins.filter(function (p) { return p.state === 'loaded'; }).length;
    var problems = d.plugins.length - loaded;
    var ro = d.tools.filter(function (t) { return t.readOnly; }).length;
    return h('div', null,
      h('div', { class: 'grid' },
        stat('v' + d.server.version, 'Server · up ' + uptime(d.server.uptimeSec) + ' · ' + d.server.bind),
        stat(up.length, up.length === 1 ? 'Browser connected' : 'Browsers connected', up.length ? null : h('div', { class: 'small muted' }, 'Open the extension popup and press Connect.')),
        stat(d.transports.mcpSessions, 'MCP sessions' + (d.transports.stdio ? ' (stdio on)' : '')),
        stat(d.tools.length, 'Tools · ' + ro + ' read-only'),
        stat(loaded, 'Plugins loaded', problems ? h('div', { class: 'small' }, badge(problems + ' skipped or off', 'warn')) : null),
        stat(d.skills.length, 'Skills'),
        stat(d.flows.total, 'Recorded flows'),
        stat(d.sites, 'Sites with saved notes')),
      d.policy.allowReveal ? h('div', { class: 'card' }, badge('allow-reveal is on', 'warn'), ' Tools can return unredacted secrets when asked. Restart the server without --allow-reveal to turn this off.') : null,
      h('h3', null, 'Connected browsers'),
      d.browsers.length ? table(['Browser', 'Version', 'Extension', 'State', 'Last seen'], d.browsers.map(function (b) {
        return [b.kind, b.version, b.extensionVersion, badge(b.connected ? 'connected' : 'disconnected', b.connected ? 'ok' : 'bad'), ago(b.lastSeen)];
      })) : empty('No browser has connected yet.'));
  }

  function mcp(d) {
    var q = filter.toLowerCase();
    var tools = d.tools.filter(function (t) { return !q || t.name.indexOf(q) >= 0 || t.description.toLowerCase().indexOf(q) >= 0; });
    var groups = {};
    tools.forEach(function (t) { (groups[t.group] = groups[t.group] || []).push(t); });
    var search = h('input', { type: 'search', placeholder: 'Filter ' + d.tools.length + ' tools…', 'aria-label': 'Filter tools', value: filter });
    search.addEventListener('input', function () { filter = search.value; render(true); });
    return h('div', null,
      h('div', { class: 'card' }, h('h2', null, 'Connect an agent'),
        h('div', { class: 'small muted' }, 'This computer, port ' + d.server.bind.split(':')[1] + '. ', d.transports.mcpSessions, ' MCP session(s) open now.'),
        cmd('browserforge print-config claude'), cmd('browserforge print-config codex')),
      search,
      Object.keys(groups).length ? Object.keys(groups).map(function (g) {
        return h('div', { class: 'card' }, h('h2', null, g, badge(groups[g].length + ' tools')),
          table(['Tool', 'What it does', ''], groups[g].map(function (t) { return [h('code', null, t.name), t.description, t.readOnly ? badge('read-only', 'ok') : badge('acts', 'warn')]; })));
      }) : empty('No tool matches.'));
  }

  function plugins(d) {
    return h('div', null,
      d.plugins.length ? d.plugins.map(function (p) {
        var kind = p.state === 'loaded' ? 'ok' : p.state === 'skipped' ? 'bad' : 'warn';
        return h('div', { class: 'card' },
          h('h2', null, p.id, p.version ? ' ' + p.version : '', badge(p.state, kind)),
          p.description ? h('div', null, p.description) : null,
          p.reason ? h('div', { class: 'small' }, 'Why it is off: ', p.reason) : null,
          p.permissions.length ? [h('h3', null, 'It may'), h('ul', { class: 'plain' }, p.permissions.map(function (x) { return h('li', null, x); }))] : null,
          p.tools.length ? [h('h3', null, 'Tools'), h('div', null, p.tools.map(function (t) { return [h('code', null, t), ' ']; }))] : null);
      }) : empty('No plugin is installed.'),
      h('h3', null, 'Manage (in a terminal)'),
      cmd('browserforge plugin list'), cmd('browserforge plugin search <words>'), cmd('browserforge plugin add <name or folder>'), cmd('browserforge plugin disable <id>'));
  }

  function skills(d) {
    return h('div', null,
      d.skills.length ? d.skills.map(function (s) {
        return h('div', { class: 'card' },
          h('h2', null, s.name, badge(s.source)),
          h('div', null, s.description),
          s.requiresTools.length || s.requiresPlugins.length ? h('div', { class: 'small muted' }, 'Needs: ', s.requiresTools.concat(s.requiresPlugins).join(', ')) : null,
          s.workflows.length ? [h('h3', null, 'Workflows'), table(['Name', 'Inputs', 'Steps'], s.workflows.map(function (w) { return [h('code', null, w.name), w.inputs.join(', ') || '–', w.steps]; }))] : null);
      }) : empty('No skill is installed.'),
      h('h3', null, 'Manage (in a terminal)'),
      cmd('browserforge skill list'), cmd('browserforge skill add <folder>'), cmd('browserforge skill new <name>'));
  }

  function flows(d) {
    return h('div', null,
      h('div', { class: 'card' }, h('div', { class: 'stat' }, d.flows.total), h('div', { class: 'label' }, 'recorded flows · newest 20 below')),
      d.flows.recent.length ? table(['Site', 'Name', 'Steps', 'Params', 'Needs approval', 'Outcome', 'Replays', 'Recorded'], d.flows.recent.map(function (f) {
        var out = f.outcome ? badge(f.outcome, f.outcome === 'success' ? 'ok' : 'bad') : '–';
        return [f.site, f.taskName || f.name, f.steps, f.params, f.consequential, out, f.runs ? f.runs.ok + '/' + f.runs.count : '–', ago(f.createdAt)];
      })) : empty('Nothing recorded yet.'),
      h('h3', null, 'Use a flow (in a terminal)'),
      cmd('browserforge flow list'), cmd('browserforge flow export <id> --format playwright-ts --out task.ts'));
  }

  function models(d) {
    var s = d.localModels.status, t = d.localModels.traces;
    function line(name, x) { return h('tr', null, h('td', null, name), h('td', null, h('code', null, x.model)), h('td', null, badge(x.reachable ? 'reachable' : 'not reachable', x.reachable ? 'ok' : 'warn')), h('td', null, badge(x.modelPulled ? 'model present' : 'model missing', x.modelPulled ? 'ok' : 'warn'))); }
    var by = Object.keys(t.byDecider || {});
    return h('div', null,
      h('div', { class: 'card' }, h('h2', null, 'Deciders', badge('mode: ' + d.localModels.mode)),
        h('table', null, h('tbody', null, line('Qwen (Ollama)', s.qwen), line('Laya (Ollaya)', s.laya))),
        h('div', { class: 'small muted' }, 'Local models pick routine steps; your agent checks the result and gives feedback.')),
      h('div', { class: 'grid' }, stat(t.steps, 'Steps recorded'), stat(t.runs, 'Runs'), stat(t.labelledGood, 'Labelled good'), stat(t.labelledBad, 'Labelled bad')),
      h('h3', null, 'By who decided'),
      by.length ? table(['Decider', 'Steps', 'OK', 'In good runs', 'In bad runs'], by.map(function (k) { var x = t.byDecider[k]; return [k, x.steps, x.ok, x.inGoodRuns, x.inBadRuns]; })) : empty('No decisions recorded yet.'),
      h('div', { class: 'small muted' }, t.recording ? 'Recording is on.' : 'Recording is off (--no-traces).'));
  }

  var VIEWS = { overview: overview, mcp: mcp, plugins: plugins, skills: skills, flows: flows, models: models };

  function drawTabs() {
    var nav = document.getElementById('tabs');
    nav.replaceChildren.apply(nav, TABS.map(function (t) {
      return h('button', { type: 'button', 'aria-selected': String(t[0] === current), onclick: function () { current = t[0]; drawTabs(); render(); } }, t[1]);
    }));
  }
  function setLive(ok, text) { var el = document.getElementById('live'); el.className = 'live ' + (ok ? 'ok' : 'err'); el.textContent = text; }

  function render(fromInput) {
    if (!data) return;
    var active = document.activeElement;
    // Do not rebuild the page under someone who is typing in the filter, except for their own keystrokes.
    if (!fromInput && active && active.tagName === 'INPUT') return;
    var view = document.getElementById('view');
    view.replaceChildren(VIEWS[current](data));
    if (fromInput) { var i = view.querySelector('input'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
  }

  function refresh() {
    if (!token) { setLive(false, 'no access token'); document.getElementById('view').replaceChildren(h('div', { class: 'card' }, h('h2', null, 'Open this page from the command line'), h('p', null, 'The dashboard needs its own token, which the command below puts in the address for you.'), cmd('browserforge dashboard'))); return; }
    fetch('/dashboard/data', { headers: { authorization: 'Bearer ' + token }, cache: 'no-store' })
      .then(function (r) {
        if (r.status === 401) { sessionStorage.removeItem(KEY); token = null; throw new Error('token rejected'); }
        if (!r.ok) throw new Error('server answered ' + r.status);
        return r.json();
      })
      .then(function (d) { data = d; setLive(true, 'live · updated ' + new Date().toLocaleTimeString()); render(); })
      .catch(function (e) { setLive(false, e.message); if (!token) refresh(); });
  }

  drawTabs();
  refresh();
  setInterval(function () { if (token && !document.hidden) refresh(); }, 5000);
})();
`;
