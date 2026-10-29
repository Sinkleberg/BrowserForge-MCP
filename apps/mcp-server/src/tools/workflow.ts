import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BrowserForgeError } from '@browserforge/shared';
import type { ServerContext } from '../context.js';
import { registerTool } from './helpers.js';

export const WORKFLOW_TOOL_PREFIXES = ['browser_', 'network_', 'api_', 'form_'];

const StepSchema = z.object({
  tool: z.string().min(1).max(64).describe('Name of a browser_*, network_*, api_* or form_* tool'),
  args: z.record(z.string(), z.unknown()).default({}),
  label: z.string().max(100).optional(),
  approval: z.string().max(500).optional().describe('If set, the human must approve this step in the browser extension before it runs'),
  continueOnError: z.boolean().optional(),
});

export function registerWorkflowTools(server: McpServer, ctx: ServerContext): void {
  registerTool(server, ctx, {
    name: 'workflow_create', title: 'Create workflow', readOnly: false,
    description: 'Define a sequence of tool calls (max 100 steps). Steps may require human approval. Nothing runs until workflow_run.',
    input: z.object({ name: z.string().min(1).max(100), steps: z.array(StepSchema).min(1).max(100) }),
    run: async ({ name, steps }) => {
      const wf = ctx.workflows.create(name, steps);
      return { workflowId: wf.id, steps: wf.steps.length };
    },
  });
  registerTool(server, ctx, {
    name: 'workflow_run', title: 'Run workflow', readOnly: false, destructive: true,
    description: 'Start a created workflow in the background; poll with workflow_get_status. Approval steps wait for the human in the browser extension.',
    input: z.object({ workflowId: z.string().max(40) }),
    run: async ({ workflowId }) => summary(ctx.workflows.run(workflowId)),
  });
  registerTool(server, ctx, {
    name: 'workflow_pause', title: 'Pause workflow', readOnly: false,
    description: 'Pause before the next step starts (a running step finishes first).',
    input: z.object({ workflowId: z.string().max(40) }),
    run: async ({ workflowId }) => summary(ctx.workflows.pause(workflowId)),
  });
  registerTool(server, ctx, {
    name: 'workflow_resume', title: 'Resume workflow', readOnly: false,
    description: 'Resume a paused workflow. Cannot bypass approval steps.',
    input: z.object({ workflowId: z.string().max(40) }),
    run: async ({ workflowId }) => summary(ctx.workflows.resume(workflowId)),
  });
  registerTool(server, ctx, {
    name: 'workflow_get_status', title: 'Workflow status', readOnly: true,
    description: 'Status, per-step state and truncated results of a workflow.',
    input: z.object({ workflowId: z.string().max(40) }),
    run: async ({ workflowId }) => ctx.workflows.get(workflowId),
  });
}

function summary(s: ReturnType<ServerContext['workflows']['get']>) {
  return { workflowId: s.id, status: s.status, currentStep: s.currentStep, steps: s.steps.length };
}

export function validateWorkflowStep(ctx: ServerContext, spec: { tool: string; args: Record<string, unknown> }): void {
  if (!WORKFLOW_TOOL_PREFIXES.some((p) => spec.tool.startsWith(p))) throw new BrowserForgeError('INVALID_ARGUMENTS', `Tool '${spec.tool}' cannot be used in workflows`);
  const entry = ctx.tools.get(spec.tool);
  if (!entry) throw new BrowserForgeError('INVALID_ARGUMENTS', `Unknown tool '${spec.tool}'`);
  const parsed = entry.input.safeParse(spec.args);
  if (!parsed.success) throw new BrowserForgeError('INVALID_ARGUMENTS', `Invalid args for ${spec.tool}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
}
