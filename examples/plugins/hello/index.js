// A BrowserForge plugin is an ES module whose default export is definePlugin({ tools }).
// Every tool name starts with the manifest's toolPrefix ("hello_"). The `api` argument is all a plugin can touch:
// it has no access to the rest of the server, and files/programs/browser are limited to what the manifest declares.
import { definePlugin, tool, z } from '@browserforge/plugin-sdk';

export default definePlugin({
  tools: [
    tool({
      name: 'hello_greet',
      description: 'Say hello to someone.',
      input: z.object({ name: z.string().min(1).max(60).describe('Who to greet') }),
      readOnly: true,
      workflowSafe: true, // may be used as a step in BrowserForge workflows
      run: async ({ name }) => ({ greeting: `Hello, ${name}!` }),
    }),
    tool({
      name: 'hello_note_add',
      description: 'Keep a short note in the plugin\'s private folder.',
      input: z.object({ text: z.string().min(1).max(500) }),
      readOnly: false,
      run: async ({ text }, api) => {
        const file = 'notes.txt';
        const old = api.files.exists('data', file) ? api.files.read('data', file) : '';
        api.files.write('data', file, `${old}${text}\n`);
        return { saved: true, notes: old.split('\n').filter(Boolean).length + 1 };
      },
    }),
    tool({
      name: 'hello_note_list',
      description: 'List the saved notes. They are your own text, but wrapped as untrusted: a note could have been copied from a web page.',
      input: z.object({}),
      readOnly: true,
      run: async (_args, api) => api.untrusted('notes', api.files.exists('data', 'notes.txt') ? api.files.read('data', 'notes.txt').split('\n').filter(Boolean) : []),
    }),
  ],
});
