# Contributing to BrowserForge MCP

Thank you for helping. BrowserForge is built to be extended by everyone: you do not need to touch the core to add something useful.

## Ways to contribute

| You want to... | Do this |
|---|---|
| Share a way of working (a recipe for an agent) | Write a **skill**: a folder with a `SKILL.md`. No code. See [docs/SKILLS.md](docs/SKILLS.md). |
| Add tools (a new integration, a file format, your own logic) | Write a **plugin**. See [docs/PLUGINS.md](docs/PLUGINS.md). Publish it on npm with the `browserforge-plugin` keyword, or open a pull request to list it. |
| Add an export format for recorded flows | An **exporter**: [docs/FLOWS.md](docs/FLOWS.md). |
| Fix a bug or improve the core | A pull request, as below. |
| Report a bug or an idea | An issue (templates are provided). For security problems, read [docs/SECURITY.md](docs/SECURITY.md) first and report privately. |

## Set up

You need Node 22 or newer, and Firefox and/or Chrome for the end-to-end tests.

```bash
git clone https://github.com/zoghlamimostafa/BrowserForge-MCP.git && cd BrowserForge-MCP
npm ci
npm run build
npm run typecheck && npm run lint
npm test                 # unit + security + integration (no browser needed)
npm run test:e2e         # real Firefox and Chromium (and local models if Ollama is running)
```

Layout: `packages/*` are libraries, `apps/mcp-server` is the MCP server, `apps/firefox-extension` is the browser extension (built for Firefox and Chrome), `plugins/*` are reference plugins, `skills/*` reference skills, `examples/*` minimal examples. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how they fit together.

## Pull requests

* **Small and focused.** One change per pull request, with a description of the problem it solves.
* **Tests.** New behaviour comes with tests; a bug fix comes with a test that fails without the fix. Anything that touches approvals, file access or permissions needs a test for the case that must be refused.
* **Checks pass:** `npm run build && npm run typecheck && npm run lint && npm test`. CI runs the same.
* **Docs.** If a user would notice the change, update the README or the relevant page in `docs/`, and `docs/LIMITATIONS.md` if something is not covered.
* **No personal data.** Never commit real names, emails, CVs, tokens or captured traffic. Use obviously fake data in tests and examples.
* Match the code around yours: naming, comment density, the existing helpers (look before you add a new one).

## Ground rules for changes

These are what users rely on, so changes that weaken them will not be merged:

1. **The human approves consequential actions**, and that gate lives in the extension, out of reach of agents, pages and plugins.
2. **Page content is untrusted data.** Anything that comes from a web page is marked as such for the agent.
3. **Secrets are redacted** by default and never written to logs, flows or traces.
4. **Everything stays on this machine** unless the user explicitly sends it elsewhere. Local models must be on loopback.
5. **Least privilege for extensions.** Plugins declare what they need; skills cannot run code.

## Writing a plugin or skill for others

Keep permissions minimal and explain each one in your README. Say what your plugin sends where. Name your tools with your prefix. Test with `createTestApi`. Publish with the `browserforge-plugin` keyword so `browserforge plugin search` finds it. Maintainers may link good plugins from the README; listing is not an endorsement or a security review.

## Code of conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing you agree your contribution is licensed under the project's [MIT license](LICENSE).
