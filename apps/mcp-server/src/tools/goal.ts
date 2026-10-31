import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SiteStore } from '@browserforge/knowledge';
import type { ServerContext } from '../context.js';
import { makeDecider } from '../decider.js';
import { runGoal } from '../goal-runner.js';
import { registerTool, untrusted } from './helpers.js';

export function registerGoalTools(server: McpServer, ctx: ServerContext): void {
  const browserId = z.string().max(100).optional().describe('Browser to use when several are connected (see system_status)');
  registerTool(server, ctx, {
    name: 'browser_run_goal', title: 'Run a goal with the local model', readOnly: false, destructive: true,
    description:
      'Fast path for routine navigation, supervised by you: local models on this machine pick one step at a time (click / type / select / scroll / wait), up to maxSteps, then hand back. ' +
      'By default Qwen (via Ollama) decides; with --decider cascade, Laya (tiny decision model via Ollaya) decides first and Qwen takes over when Laya is unsure, unavailable, wrong, or says DONE/BLOCKED. When the deciding model is unsure the run stops and hands back to you. Each step reports which model decided (source), its confidence and any escalation. ' +
      'It can only act on rows that are on the page and only type values you pass in `inputs` (values are never shown to the model or stored). It cannot navigate to other sites. ' +
      'Every step goes through the normal approval gate (or YOLO), so consequential clicks still wait for the human. It stops on done, blocked, low confidence, no progress, a denied approval or maxSteps, and returns the step trace plus the final page table so you can continue. ' +
      'Verify the outcome yourself, then call browser_goal_feedback so the run can teach future runs.',
    input: z.object({
      browserId,
      tabId: z.number().int().nonnegative().optional(),
      goal: z.string().min(3).max(500),
      inputs: z.record(z.string().min(1).max(60), z.string().max(500)).refine((o) => Object.keys(o).length <= 20, 'At most 20 inputs').optional().describe('label -> value, e.g. {"first name":"Ada","birth month":"July"}'),
      maxSteps: z.number().int().min(1).max(25).optional().describe('Default 8'),
      minConfidence: z.number().min(0).max(1).optional().describe('Stop and hand back below this (default 0.7)'),
    }),
    run: async (a, x) => {
      const result = await runGoal(
        {
          call: (action, args, o) => ctx.hub.call(action, args, { browserId: a.browserId, timeoutMs: o.timeoutMs, signal: x.signal }),
          decide: makeDecider(ctx.config.decider),
          traces: ctx.knowledge.traces,
          docs: ctx.knowledge.docs,
          signal: x.signal,
        },
        { goal: a.goal, inputs: a.inputs ?? {}, maxSteps: a.maxSteps ?? 8, minConfidence: a.minConfidence ?? ctx.config.decider.minConfidence, tabId: a.tabId },
      );
      const host = SiteStore.hostOf(result.final.url);
      if (host && result.stopReason === 'done' && result.verification.verdict !== 'unknown') ctx.knowledge.sites.outcome(host, result.verification.verdict);
      return untrusted('goal_run', result);
    },
  });
  registerTool(server, ctx, {
    name: 'browser_goal_feedback', title: 'Label a goal run', readOnly: false,
    description: 'Mark a browser_run_goal run (by runId) as good or bad after you verified the result. Good runs become examples for future runs and fine-tuning data; bad runs are never reused.',
    input: z.object({ runId: z.string().min(1).max(40), outcome: z.enum(['good', 'bad']), note: z.string().max(300).optional() }),
    run: async ({ runId, outcome, note }) => ({ labelled: ctx.knowledge.traces.label(runId, outcome, note), runId, outcome }),
  });
}
