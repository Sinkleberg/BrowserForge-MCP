# Release checklist

- [ ] `npm ci && npm run build`
- [ ] `npm run typecheck` and `npm run lint` clean (lint includes `web-ext lint` on the Firefox build)
- [ ] `npm test` (unit + security + integration) green
- [ ] `npm run test:e2e` green on Firefox **and** Chromium (needs `geckodriver`, Playwright Chromium)
- [ ] Manual smoke on **branded Chrome** (Load unpacked) and **release Firefox** (temporary add-on): connect, `browser_navigate`, form fill, approval prompt, STOP, body-capture permission grants from the popup
- [ ] Idle test: leave both browsers connected ≥ 30 min; tools still work
- [ ] `claude mcp list` / `codex mcp list` show the server; one real tool call from each
- [ ] `npm run package`; inspect `artifacts/*.zip`: no `e2e-config.json`, `manifest.json` has no `web_accessible_resources`, permissions as in `docs/SECURITY.md`
- [ ] Firefox: submit the unlisted build to AMO for signing (`web-ext sign`) if a permanent install is required
- [ ] Grep the tree and the zips for secrets: `rg -n "eyJ|sk-|Bearer [A-Za-z0-9]" --glob '!tests/**'`
- [ ] Update version in the root `package.json`, `apps/*/package.json`, `SERVER_VERSION` in `apps/mcp-server/src/context.ts`, `EXT_VERSION` in `apps/firefox-extension/src/background.ts`
- [ ] Re-read `docs/LIMITATIONS.md` and `docs/SECURITY.md` for anything that changed
- [ ] Tag the release; attach both zips
