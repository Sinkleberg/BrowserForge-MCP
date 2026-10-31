# Building plugins for BrowserForge

BrowserForge can be extended two ways:

| | **Skill** | **Plugin** |
|---|---|---|
| What it is | A folder of instructions (and optional ready-made workflows) | An ES module that adds MCP tools |
| Needs code | No | Yes (JavaScript or TypeScript) |
| Can touch your files / run programs | No | Only what its manifest declares and you approved |
| Safe to share around | Yes: it is text the agent reads | Install only from authors you trust |
| Guide | [SKILLS.md](SKILLS.md) | this page |

Rule of thumb: if a few steps with the existing tools do the job, write a **skill**. If you need your own logic (parse a file, render a PDF, keep a log), write a **plugin**. A package can also be a skill pack (`"kind": "skill"`).

The reference plugin is [`plugins/rendercv`](../plugins/rendercv) (tailor a CV, render it, log applications) with its companion skill [`skills/job-apply`](../skills/job-apply). The smallest plugin is [`examples/plugins/hello`](../examples/plugins/hello).

## Quick start

```bash
browserforge plugin new my-tool          # creates ./browserforge-plugin-my-tool
cd browserforge-plugin-my-tool && npm install && npm test
browserforge plugin validate .           # checks the manifest and the tools like the server would
browserforge plugin add .                # shows what it asks for; you answer yes or no
# restart `browserforge serve`, then ask your agent to use mytool_hello
```

> **SDK status.** `@browserforge/plugin-sdk` lives in this repository (`packages/plugin-sdk`) and is not on npm yet. Until it is published, build your plugin inside a checkout of this repo (a folder under `plugins/` is a workspace package) or `npm link` the SDK. Everything else on this page already works.

## A plugin in 20 lines

`package.json`:

```json
{
  "name": "browserforge-plugin-hello",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "keywords": ["browserforge-plugin"],
  "browserforge": {
    "id": "hello",
    "toolPrefix": "hello",
    "description": "Greets people and keeps notes.",
    "permissions": { "files": { "read": ["data"], "write": ["data"] } }
  },
  "dependencies": { "@browserforge/plugin-sdk": "*" }
}
```

`index.js`:

```js
import { definePlugin, tool, z } from '@browserforge/plugin-sdk';

export default definePlugin({
  tools: [
    tool({
      name: 'hello_greet',
      description: 'Say hello to someone.',
      input: z.object({ name: z.string().min(1).max(60) }),
      readOnly: true,
      run: async ({ name }, api) => ({ greeting: `Hello, ${name}!` }),
    }),
  ],
});
```

## The manifest (`browserforge` in package.json, or `browserforge-plugin.json`)

| Field | Meaning |
|---|---|
| `id` | Lowercase letters, digits, dashes; 2 to 31 characters; starts with a letter. Unique per user. |
| `kind` | `"plugin"` (default) or `"skill"` (a package that only carries skills). |
| `toolPrefix` | Every tool must be named `<toolPrefix>_something`. This keeps plugins from shadowing core tools or each other. Lowercase letters and digits, 2 to 16. |
| `description` | One sentence, shown at install time. |
| `instructions` | Up to 500 characters of guidance for the agent. Appended **below** the core safety rules, which always win. |
| `main` | Entry file (defaults to package.json `main`, then `index.js`). |
| `settings` | Things the user configures: `{ "cvDir": { "type": "path", "description": "...", "required": true, "default": ... } }`. Types: `path`, `string`, `number`, `boolean`. |
| `permissions` | See below. Whatever is not listed is refused at run time. |

Unknown fields are rejected, so typos do not silently weaken a permission.

## Permissions

```json
"permissions": {
  "browser": true,
  "files": { "read": ["setting:cvDir", "uploads/cv"], "write": ["setting:cvDir/tailored", "data"] },
  "exec": ["setting:rendercv"]
}
```

* **`files`** are named folders, never raw paths: `uploads` (BrowserForge's upload folder, the only place `browser_fill_form` reads files from), `exports`, `data` (your plugin's own private folder), or `setting:<key>` (a folder the user configured). Each may be narrowed with a sub-folder (`setting:cvDir/tailored`). Read and write are separate: write does not imply read.
* **`exec`** lists programs: a command name (`python3`) or `setting:<key>` (a program path the user configured). They are run without a shell, with a minimal environment (no inherited API keys), a time limit and an output cap.
* **`browser`** lets the plugin call BrowserForge's browser actions. Consequential ones (submit, send, upload, password) still stop for the human in the extension.

At install the user is shown these in plain words and must approve them. If a later version asks for different permissions, the plugin is **switched off** until the user approves again (`browserforge plugin update <id>`).

## The `api` your tools receive

```ts
api.settings                         // the user's settings (defaults filled in)
api.files.read(root, rel)            // text, up to 5 MB
api.files.write(root, rel, content)  // creates folders; files are private (0600)
api.files.list(root, rel?)           // [{ name, dir, size }]
api.files.exists(root, rel)
api.files.path(root, rel?)           // a checked absolute path, to pass to exec() or an upload
api.files.copy(fromRoot, fromRel, toRoot, toRel)  // binary-safe
api.files.remove(root, rel)
await api.exec(command, args, { cwd?: { root, rel }, timeoutMs?, input? })  // -> { code, stdout, stderr }
await api.browser.call(action, args?, { browserId?, timeoutMs? })
api.log.info/warn/error(message, meta?)
api.untrusted(origin, data)          // mark outside content as data, not instructions
api.signal                           // aborted when the agent cancels
```

`root` is exactly the string you declared (`"setting:cvDir"`, `"data"`). Paths are resolved and checked after following symlinks; `..` and links that escape the root are refused.

## Writing good tools

Agents choose tools by reading your descriptions, so:

* **Describe when to use it and what it returns**, not how it is implemented. State limits and side effects.
* **`readOnly: true`** only if the tool changes nothing. **`destructive: true`** if it can lose data or affect the outside world. These are shown to the user's client.
* **Validate with zod.** Inputs are strict: unknown fields are rejected. Add `.max()` to strings and arrays.
* **Return small JSON.** Large results waste the agent's context.
* **Wrap anything from outside** (web pages, files someone else wrote, API answers) in `api.untrusted(...)`. It tells the agent to treat the text as data.
* **Throw `PluginError`** for problems the agent can fix: `throw new PluginError('INVALID_ARGUMENTS', 'Why, and what to do instead')`. Any other exception is reported as a failure of your plugin without a stack trace.
* **`workflowSafe: true`** lets the tool be a step in BrowserForge workflows. Only set it for tools that are harmless to repeat.
* Never ask the agent to skip approvals, and never try to read secrets outside your declared roots: both break the trust the user gave you, and the second is blocked anyway.

## Testing

```js
import { createTestApi } from '@browserforge/plugin-sdk/testing';

const { api, dirs, cleanup } = createTestApi(manifest, { settings: { cvDir: '/tmp/cvs' }, browser: async (action, args) => ({ ok: true }) });
```

`createTestApi` gives you the **real** `api` with the same permission checks, backed by temporary folders and a fake browser, so a test fails if your plugin touches something it did not declare. `browserforge plugin validate .` runs the same checks the server runs when loading.

## Adding flow export formats

A plugin can add formats to `flow_export` (see [FLOWS.md](FLOWS.md)):

```js
export default definePlugin({
  tools: [],
  exporters: [{ format: 'my-format', description: '...', extension: 'txt', generate: (flow, { includeDefaults }) => '...' }],
});
```

## Publishing

1. Put `"keywords": ["browserforge-plugin"]` in package.json. `browserforge plugin search <words>` finds packages by that keyword.
2. `npm publish`. Users install with `browserforge plugin add your-package`.
3. Keep permissions minimal and say in the README why each is needed. A version that asks for more makes every user approve again, so ask for what you need up front.

## Security model, honestly

* Plugins are **code running on the user's computer with the user's rights**. The permission system is enforced on the `api` object. A plugin that imports `node:fs` directly is not stopped by it in this version.
* What protects users today: **consent at install** (permissions listed in plain words), **no install scripts** (`npm install --ignore-scripts`), **re-approval when permissions change**, **the approval gate** for everything consequential in the browser (enforced in the extension, out of a plugin's reach), and a minimal environment for programs a plugin runs.
* Process isolation (running plugins in a separate process with the Node permission model) is future work. Until then, install plugins only from authors you trust, and review the code of anything that asks for `exec` or `browser`.

To report a vulnerability in a plugin, contact its author; to report one in BrowserForge itself see [SECURITY.md](SECURITY.md).
