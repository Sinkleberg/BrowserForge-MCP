import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { analyzeRequests } from '@browserforge/api-analyzer';
import { TARGET_LANGUAGES, buildIr, generateClient, generateOpenApi, writeClient } from '@browserforge/client-generator';
import { LIVE_CAPTURE, type RequestFilter } from '@browserforge/network-inspector';
import { BrowserForgeError, LIMITS, isSensitiveHeader, resolveSafePath, safeSegment } from '@browserforge/shared';
import type { ServerContext } from '../context.js';
import { registerTool, untrusted } from './helpers.js';

const analysisId = z.string().max(40).describe('Id returned by api_analyze_traffic');
const filterShape = {
  hostname: z.string().max(253).optional(),
  urlPattern: z.string().max(500).optional(),
  method: z.union([z.string().max(16), z.array(z.string().max(16)).max(10)]).optional(),
  status: z.union([z.number().int(), z.string().max(20), z.array(z.union([z.number().int(), z.string().max(20)])).max(20)]).optional(),
  contentType: z.string().max(100).optional(),
  tabId: z.number().int().optional(),
};

/** Raw credential values present in a capture; used only to prove generated output does not contain them. */
function capturedSecrets(ctx: ServerContext, captureId: string): string[] {
  const out = new Set<string>();
  const add = (v: string | undefined) => { if (v && v.length >= 6) out.add(v); };
  for (const r of ctx.store.getCapture(captureId).requests) {
    for (const h of [...r.requestHeaders, ...r.responseHeaders]) {
      if (!isSensitiveHeader(h.name)) continue;
      add(h.value);
      add(h.value.replace(/^(Bearer|Basic|Token)\s+/i, ''));
      if (/cookie/i.test(h.name)) for (const part of h.value.split(/;\s*/)) add(part.split('=').slice(1).join('='));
      if (/set-cookie/i.test(h.name)) add(h.value.split(';')[0]!.split('=').slice(1).join('='));
    }
    try { for (const [k, v] of new URL(r.url).searchParams) if (/token|key|secret|sig|auth|session/i.test(k)) add(v); } catch { /* ignore */ }
  }
  return [...out];
}

function resolveOut(ctx: ServerContext, p: string): string {
  const abs = path.isAbsolute(p) ? p : path.join(ctx.config.writeRoots[0]!, p);
  return resolveSafePath(abs, ctx.config.writeRoots);
}

export function registerApiTools(server: McpServer, ctx: ServerContext): void {
  registerTool(server, ctx, {
    name: 'api_analyze_traffic', title: 'Analyze traffic', readOnly: true,
    description:
      'Reverse-engineer the HTTP API from a capture: groups requests into endpoints, infers parameters, JSON schemas, pagination, auth scheme (no secrets), versioning, GraphQL operations and error patterns. ' +
      'Every item says whether it was observed, inferred or is a hypothesis, with confidence and evidence request ids. Use only on sites the user is authorized to inspect.',
    input: z.object({
      captureId: z.string().max(100).optional().describe(`Capture to analyse (default "${LIVE_CAPTURE}")`),
      ...filterShape,
      hosts: z.array(z.string().max(253)).max(20).optional().describe('Only analyse these hosts (supports *.wildcards)'),
      includeStatic: z.boolean().optional().describe('Also analyse HTML/JS/CSS/image requests'),
      minSamples: z.number().int().min(1).max(100).optional(),
      detail: z.enum(['summary', 'full']).optional().describe('summary (default) lists endpoints compactly; full returns the whole report'),
    }),
    run: async ({ captureId, hosts, includeStatic, minSamples, detail, ...filter }) => {
      const cap = ctx.store.getCapture(captureId);
      const reqs = ctx.store.queryAll(cap.id, filter as RequestFilter);
      const report = analyzeRequests(reqs, { captureId: cap.id, hosts, includeStatic, minSamples });
      const id = ctx.analyses.put(report);
      report.analysisId = id;
      if (detail === 'full') return untrusted('api_analysis', report);
      return untrusted('api_analysis', {
        analysisId: id, stats: report.stats, hosts: report.hosts, securitySchemes: report.securitySchemes.map((s) => ({ kind: s.kind, name: s.name, confidence: s.confidence })),
        endpoints: report.endpoints.map((e) => ({ id: e.id, host: e.host, samples: e.sampleCount, confidence: e.confidence, auth: e.auth.map((a) => a.kind), pagination: e.pagination?.style, statuses: e.responses.map((r) => r.status) })),
        warnings: report.warnings, disclaimer: report.disclaimer,
        next: 'Use api_get_endpoint_details for one endpoint, api_generate_openapi / api_generate_client to produce artifacts.',
      });
    },
  });

  registerTool(server, ctx, {
    name: 'api_list_endpoints', title: 'List endpoints', readOnly: true,
    description: 'List endpoints of an analysis with optional filters and pagination.',
    input: z.object({ analysisId, host: z.string().max(253).optional(), method: z.string().max(16).optional(), search: z.string().max(200).optional(), minConfidence: z.enum(['low', 'medium', 'high']).optional(), cursor: z.string().max(10).optional(), limit: z.number().int().min(1).max(LIMITS.maxPageSize).optional() }),
    run: async ({ analysisId, host, method, search, minConfidence, cursor, limit }) => {
      const rank = { low: 0, medium: 1, high: 2 } as const;
      const report = ctx.analyses.get(analysisId);
      const list = report.endpoints.filter((e) => (!host || e.host === host) && (!method || e.method === method.toUpperCase()) && (!search || e.id.toLowerCase().includes(search.toLowerCase())) && (!minConfidence || rank[e.confidence] >= rank[minConfidence]));
      const off = cursor ? Number.parseInt(cursor, 10) : 0;
      const n = limit ?? LIMITS.defaultPageSize;
      if (!Number.isFinite(off) || off < 0) throw new BrowserForgeError('INVALID_ARGUMENTS', 'Invalid cursor');
      return untrusted('api_analysis', { total: list.length, nextCursor: off + n < list.length ? String(off + n) : undefined, endpoints: list.slice(off, off + n).map((e) => ({ id: e.id, host: e.host, method: e.method, path: e.pathTemplate, samples: e.sampleCount, confidence: e.confidence, basis: e.basis })) });
    },
  });

  registerTool(server, ctx, {
    name: 'api_get_endpoint_details', title: 'Endpoint details', readOnly: true,
    description: 'Full documentation for one endpoint: parameters, schemas, example (redacted) payloads, auth, pagination, errors, evidence.',
    input: z.object({ analysisId, endpointId: z.string().max(300).describe('Endpoint id such as "GET /api/v1/products/{productId}"') }),
    run: async ({ analysisId, endpointId }) => {
      const e = ctx.analyses.get(analysisId).endpoints.find((x) => x.id === endpointId);
      if (!e) throw new BrowserForgeError('NOT_FOUND', `No endpoint '${endpointId}' in this analysis`);
      return untrusted('api_analysis', e);
    },
  });

  registerTool(server, ctx, {
    name: 'api_generate_openapi', title: 'Generate OpenAPI', readOnly: false,
    description: 'Create an OpenAPI 3.1 document from an analysis (REST operations only; confidence and evidence are annotated; no credentials). Writes to an allowed export directory when "path" is given, else returns it inline.',
    input: z.object({ analysisId, host: z.string().max(253).optional(), title: z.string().max(120).optional(), path: z.string().max(1000).optional().describe('Output .json file inside an allowed export directory') }),
    run: async ({ analysisId, host, title, path: outPath }) => {
      const doc = generateOpenApi(ctx.analyses.get(analysisId), { host, title });
      const text = JSON.stringify(doc, null, 2);
      if (outPath) {
        const real = resolveOut(ctx, outPath);
        fs.mkdirSync(path.dirname(real), { recursive: true, mode: 0o700 });
        fs.writeFileSync(real, text, { mode: 0o600 });
        return { written: real, operations: Object.values(doc.paths as object).reduce((n: number, p) => n + Object.keys(p as object).length, 0), skipped: doc['x-browserforge-skipped'] };
      }
      if (text.length > 300_000) throw new BrowserForgeError('LIMIT_EXCEEDED', 'OpenAPI document too large to return inline; pass "path"');
      return { openapi: doc };
    },
  });

  registerTool(server, ctx, {
    name: 'api_generate_client', title: 'Generate API client', readOnly: false,
    description:
      'Generate a client library (python, typescript, javascript or php) from an analysis, with models, auth configuration via environment variables/parameters, retries, timeouts, pagination helpers, README, example and unit tests. ' +
      'The output is scanned so it cannot contain captured credentials, written only inside an allowed export directory, and syntax checks plus the generated tests are run before success is reported.',
    input: z.object({
      analysisId, language: z.enum(TARGET_LANGUAGES as [string, ...string[]]),
      outputDir: z.string().min(1).max(1000).describe('Directory inside an allowed export root (relative paths resolve there)'),
      packageName: z.string().max(60).optional(), host: z.string().max(253).optional(), title: z.string().max(120).optional(),
      overwrite: z.boolean().optional().describe('Allow replacing existing files that were not created by BrowserForge'),
      runChecks: z.boolean().optional().describe('Run syntax checks and generated tests (default true)'),
      includeTests: z.boolean().optional(),
    }),
    run: async ({ analysisId, language, outputDir, packageName, host, title, overwrite, runChecks, includeTests }) => {
      const report = ctx.analyses.get(analysisId);
      const ir = buildIr(report, { host, title });
      const gen = generateClient(ir, language as (typeof TARGET_LANGUAGES)[number], { packageName: safeSegment(packageName ?? 'api_client').replace(/[.-]/g, '_'), tests: includeTests });
      const res = await writeClient(gen, {
        outDir: resolveOut(ctx, outputDir), allowedRoots: ctx.config.writeRoots, overwrite, validate: runChecks !== false,
        forbiddenStrings: (() => { try { return capturedSecrets(ctx, report.captureId); } catch { return []; } })(),
      });
      const out = { success: res.success, language, outputDir: res.outDir, operations: ir.ops.length, files: res.files, checks: res.checks, notSupported: ir.skipped };
      if (!res.success) throw new BrowserForgeError('GENERATION_FAILED', `Generated client failed validation: ${res.checks.filter((c) => c.status === 'failed').map((c) => `${c.name}: ${c.output.slice(0, 400)}`).join(' | ')}`, { details: { outputDir: res.outDir } });
      return out;
    },
  });
}
