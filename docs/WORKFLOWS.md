# Example workflows

All examples can be tried against the bundled demo site: `node tests/fixtures/demo-site/server.mjs` (serves `http://127.0.0.1:8099` with `/apply`, `/shop`, a mock REST + GraphQL API and a hostile `/evil` page).

## 1. Fill a job application (human submits)

1. User gives you details and says it is fine to store them. Agent calls `form_profile_save` with `consent:true`:
   `{ "name":"me", "consent":true, "data":{ "fullName":"…", "email":"…", "phone":"…", "country":"France", "cvPath":"/home/me/Documents/cv.pdf", "coverLetterTemplate":"Dear {{hiringManager}}, …" } }`
   Only values the user provided. Nothing is invented.
2. `browser_navigate` to the application page.
3. `form_discover { profile:"me" }` → fields, which profile key each maps to, and the **humanOnly** list (passwords, declarations, consent, salary, visa, protected characteristics).
4. `form_fill_from_profile { profile:"me" }` (default `dryRun:true`) → preview: `willFill`, `missingRequired`, `needsHuman`, `notMapped`, `cv`.
5. Ask the user about anything missing; then `form_fill_from_profile { profile:"me", dryRun:false, attachCv:true, overrides:{…} }`. Attaching the CV shows an approval prompt in the browser.
6. `form_prepare_cover_letter { profile:"me", values:{ company:"Acme", hiringManager:"…" } }` → text with any unresolved `{{placeholders}}` listed.
7. `form_validate` and `form_preview_submission` → show the user exactly what will be sent.
8. The user reviews. The agent clicks submit with `browser_click`; **the browser asks the human to approve** and only a human click lets it through.

## 2. Reverse-engineer a site's API (authorised sites only)

1. `network_configure_capture { captureBodies:true }` (grant the permission in the popup first), then browse with `browser_navigate` / `browser_click`.
2. `network_list_requests { hostname:"api.example.com", status:"2xx" }` — look at what was captured (secrets are `[REDACTED]`).
3. `api_analyze_traffic { hosts:["api.example.com"] }` → `analysisId`, endpoints with confidence and evidence.
4. `api_get_endpoint_details { analysisId, endpointId:"GET /api/v1/products" }` for parameters, schemas, pagination, errors.
5. `api_generate_openapi { analysisId, path:"api.json" }` → `~/.config/browserforge/exports/api.json`.
6. `api_generate_client { analysisId, language:"python", outputDir:"example-client", packageName:"example_api" }` → client + tests; syntax checks and the generated tests are run before success is reported.
7. Set `EXAMPLE_API_TOKEN` (or pass `token=`) at runtime; the generated code contains no credentials.

Working offline from a HAR: `network_import_har { path:"/path/session.har" }` → use the returned `captureId` in `api_analyze_traffic`.

## 3. A scripted workflow with approval

```json
{ "name": "checkout smoke test",
  "steps": [
    { "tool": "browser_navigate", "args": { "url": "http://127.0.0.1:8099/shop" } },
    { "tool": "browser_get_interactive_elements", "args": {} },
    { "tool": "browser_click", "args": { "selector": "#buy" }, "approval": "Place the demo order?" },
    { "tool": "network_list_requests", "args": { "method": "POST" } }
  ] }
```
`workflow_create` → `workflow_run` → poll `workflow_get_status`. The approval step blocks on a human in the extension popup; `workflow_pause` stops before the next step; a failed step skips the rest unless `continueOnError`. Steps may only call `browser_*`, `network_*`, `api_*`, `form_*` tools and are validated when the workflow is created. (Note: a `browser_click` on a consequential element prompts in the browser on its own, in addition to the step-level `approval`.)

## 4. Write a message in a chat box (human sends)

1. `browser_get_interactive_elements` → find the message box (`editable:true`, e.g. label "Message").
2. `browser_click { ref }` to focus it, then `browser_type { text:"Hi!\nSecond line" }` — one call, whole message; omit `ref` to type into the focused element. Nothing is sent.
3. Sending (`browser_click` on **Send**, `browser_press_key Enter`, or `browser_type … submit:true`) pops an approval prompt in the extension; the human decides. Shift+Enter inserts a line break without approval.

## 5. Stop everything

`browser_stop` from the agent, or the red **STOP** in the popup (stronger: only the popup can undo it).
