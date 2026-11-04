// How is BrowserForge doing? One line of real numbers from public APIs, appended to artifacts/metrics.csv (git-ignored) so days can be compared.
//   npm run metrics                       (optional: --chrome-users N, read by hand from the Chrome Web Store developer dashboard)
//   GITHUB_TOKEN=...  raises GitHub's rate limit; not needed for a few runs a day.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'zoghlamimostafa/BrowserForge-MCP';
const OWNER = REPO.split('/')[0];
const NPM = '@el-makina-ai/browserforge-mcp';
const AMO = 'browserforge';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function get(url, headers = {}) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'browserforge-metrics', ...headers }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return await r.json();
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
const gh = (p) => get(`https://api.github.com/${p}`, { accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) });

const [repo, contributors, releases, npm, amo] = await Promise.all([
  gh(`repos/${REPO}`),
  gh(`repos/${REPO}/contributors?anon=1&per_page=100`),
  gh(`repos/${REPO}/releases?per_page=100`),
  get(`https://api.npmjs.org/downloads/point/last-week/${NPM}`),
  get(`https://addons.mozilla.org/api/v5/addons/addon/${AMO}/`),
]);
if (repo.error) {
  console.error(`GitHub: ${repo.error} (rate limited? set GITHUB_TOKEN)`);
  process.exit(1);
}

// Open issues from the API include pull requests; outside contributors are everyone but the owner and bots.
const outside = Array.isArray(contributors) ? contributors.filter((c) => (c.login ?? c.name) !== OWNER && !/\[bot\]$/.test(c.login ?? '')).length : NaN;
const downloads = Array.isArray(releases) ? releases.flatMap((r) => r.assets ?? []).reduce((n, a) => n + (a.download_count ?? 0), 0) : NaN;
const winExe = Array.isArray(releases) ? releases.flatMap((r) => r.assets ?? []).filter((a) => /\.exe$/.test(a.name)).reduce((n, a) => n + a.download_count, 0) : NaN;
const row = {
  date: new Date().toISOString().slice(0, 10),
  stars: repo.stargazers_count,
  forks: repo.forks_count,
  watchers: repo.subscribers_count,
  open_issues_and_prs: repo.open_issues_count,
  outside_contributors: outside,
  release_downloads: downloads,
  windows_installer_downloads: winExe,
  npm_last_week: typeof npm.downloads === 'number' ? npm.downloads : '',
  firefox_daily_users: typeof amo.average_daily_users === 'number' ? amo.average_daily_users : '',
  chrome_users: arg('chrome-users') ?? '',
};

const note = (v, why) => (v === '' ? `n/a (${why})` : v);
console.log(
  `${row.date}  ⭐ ${row.stars}  forks ${row.forks}  watchers ${row.watchers}  open issues+PRs ${row.open_issues_and_prs}  outside contributors ${row.outside_contributors}\n` +
  `            release downloads ${row.release_downloads} (Windows installer ${row.windows_installer_downloads})  ` +
  `npm last 7 days ${note(row.npm_last_week, npm.error ?? 'no data yet')}  Firefox daily users ${note(row.firefox_daily_users, amo.error ?? 'unknown')}  ` +
  `Chrome users ${note(row.chrome_users, 'pass --chrome-users N')}`,
);

const csv = path.join(ROOT, 'artifacts', 'metrics.csv');
fs.mkdirSync(path.dirname(csv), { recursive: true });
const cols = Object.keys(row);
if (!fs.existsSync(csv)) fs.writeFileSync(csv, cols.join(',') + '\n');
fs.appendFileSync(csv, cols.map((k) => row[k]).join(',') + '\n');
console.log(`appended to ${path.relative(ROOT, csv)}`);
