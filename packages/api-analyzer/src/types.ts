export type Basis = 'observed' | 'inferred' | 'hypothesis';
export type Confidence = 'high' | 'medium' | 'low';

/** Every non-trivial claim carries how we know it and which captured requests support it. */
export interface Claim {
  basis: Basis;
  confidence: Confidence;
  evidence: string[];
}

export interface JsonSchema {
  type?: string | string[];
  format?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  nullable?: boolean;
}

export interface ParamInfo extends Claim {
  name: string;
  type: string;
  required: boolean;
  /** Redacted example values actually seen. */
  examples: string[];
  distinctValues: number;
  occurrences: number;
}

export interface PathParamInfo extends Claim {
  name: string;
  type: 'integer' | 'string' | 'uuid';
  examples: string[];
}

export interface BodyInfo extends Claim {
  contentType: string;
  schema: JsonSchema;
  example?: unknown;
  samples: number;
}

export interface ResponseInfo extends Claim {
  status: number;
  contentType?: string;
  count: number;
  schema?: JsonSchema;
  example?: unknown;
}

export interface AuthInfo extends Claim {
  kind: 'bearer' | 'basic' | 'apiKeyHeader' | 'cookie' | 'none';
  /** Header name (apiKeyHeader) or cookie names; never a value. */
  name?: string;
  requiredBy: 'all-samples' | 'some-samples';
}

export interface PaginationInfo extends Claim {
  style: 'page' | 'offset' | 'cursor' | 'link-header' | 'unknown';
  requestParams: string[];
  responseFields: string[];
  pageSizeParam?: string;
}

export interface Endpoint extends Claim {
  id: string;
  method: string;
  scheme: string;
  host: string;
  pathTemplate: string;
  pathParams: PathParamInfo[];
  query: ParamInfo[];
  requestBody?: BodyInfo;
  responses: ResponseInfo[];
  auth: AuthInfo[];
  pagination?: PaginationInfo;
  graphql?: { operationName?: string; operationType?: string; variables: string[]; query?: string };
  version?: string;
  sampleCount: number;
  requestHeaders: string[];
  errors: { status: number; count: number; shape?: JsonSchema }[];
  notes: string[];
}

export interface AnalysisReport {
  analysisId?: string;
  captureId: string;
  generatedAt: string;
  stats: { requestsConsidered: number; requestsAnalyzed: number; skippedStatic: number; endpoints: number };
  hosts: { host: string; scheme: string; endpoints: number }[];
  securitySchemes: AuthInfo[];
  endpoints: Endpoint[];
  warnings: string[];
  disclaimer: string;
}

export interface AnalyzeOptions {
  captureId?: string;
  /** Keep only these hosts (exact or *.wildcard). */
  hosts?: string[];
  /** Also analyse HTML/JS/CSS/image requests. */
  includeStatic?: boolean;
  /** Endpoints with fewer samples are reported with low confidence (default 1: kept). */
  minSamples?: number;
  maxExampleChars?: number;
}
