import { definePlugin, PluginError, tool, z } from '@browserforge/plugin-sdk';

async function get(api, path, allowMissing = false) {
  const response = await api.fetch(`https://api.github.com/${path}`);
  if (response.status === 403 || response.status === 429) {
    throw new PluginError('LIMIT_EXCEEDED', `GitHub refused the request (HTTP ${response.status}); its public API may be rate limited. Wait before retrying; this plugin does not use tokens.`, { retryable: true });
  }
  if (allowMissing && response.status === 404) return null;
  if (response.status === 404) throw new PluginError('NOT_FOUND', 'Public GitHub repository not found');
  if (response.status !== 200) throw new PluginError('INTERNAL', `GitHub returned HTTP ${response.status}`, { retryable: response.status >= 500 });
  try { return JSON.parse(response.body); } catch { throw new PluginError('INTERNAL', 'GitHub returned invalid JSON'); }
}

const count = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new PluginError('INTERNAL', 'GitHub returned an invalid count');
  return value;
};

export default definePlugin({
  tools: [tool({
    name: 'ghstats_repo',
    description: 'Read stars, forks, open issues (excluding pull requests) and the latest published release of a public GitHub repository. Sends its owner/name to GitHub without a token.',
    input: z.object({
      owner: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),
      repo: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/).refine((s) => s !== '.' && s !== '..'),
    }),
    readOnly: true,
    run: async ({ owner, repo }, api) => {
      const repository = `${owner}/${repo}`;
      const resource = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      // Sequential calls stop immediately on a refusal, rather than spending more rate-limit budget.
      const stats = await get(api, resource);
      const issues = await get(api, `search/issues?q=${encodeURIComponent(`repo:${repository} is:issue is:open`)}&per_page=1`);
      if (issues.incomplete_results !== false) throw new PluginError('INTERNAL', 'GitHub returned incomplete issue search results; retry later', { retryable: true });
      const release = await get(api, `${resource}/releases/latest`, true);
      if (release && typeof release.tag_name !== 'string') throw new PluginError('INTERNAL', 'GitHub returned an invalid release');
      return api.untrusted('github', {
        repository, stars: count(stats.stargazers_count), forks: count(stats.forks_count), openIssues: count(issues.total_count),
        latestRelease: release ? { tag: release.tag_name.slice(0, 200), name: typeof release.name === 'string' ? release.name.slice(0, 200) : null, publishedAt: typeof release.published_at === 'string' ? release.published_at.slice(0, 50) : null } : null,
      });
    },
  })],
});
