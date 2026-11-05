# Public GitHub stats

`ghstats_repo({ owner: "demo-org", repo: "example" })` reads stars, forks, the number of open issues **excluding pull requests**, and the latest published release of a public repository. No token or account is needed. A repository without a release returns `latestRelease: null`. GitHub's latest-release endpoint excludes drafts and prereleases.

Build BrowserForge in this checkout, then install the example:

```sh
npm ci && npm run build
node apps/mcp-server/dist/cli.js plugin add ./examples/plugins/github-stats
```

Approve the displayed `https://api.github.com` network origin, restart the server, and find `ghstats_repo` and its permissions in the dashboard. It requests no files, programs or browser access. The SDK helper allows only GET/HEAD to that exact HTTPS origin, refuses redirects and credentials, and limits each response to 1 MB and 10 seconds by default. As with all plugins, those restrictions apply to the API, not arbitrary JavaScript; install code only from trusted authors.

The owner/repository name is sent to GitHub. Each call makes three sequential requests: repository metadata, an `is:issue is:open` search (because repository `open_issues_count` includes pull requests), and the latest release. Search has its own lower rate limit and can lag recent changes. HTTP403/429 stops the call with a clear error; wait before retrying. There are no automatic retries, tokens, private-repository access or live API calls in the tests. API answers are returned as untrusted data.

Tests: `npm test -- --project unit tests/unit/github-stats-plugin.test.ts` (or run the full `npm test` suite). Installation, consent changes and dashboard discovery also have integration coverage.
