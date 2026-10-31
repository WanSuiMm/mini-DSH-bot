import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ToolRegistry } from '../../dist/tools/registry.js';
import { createExecutionGuard } from '../security/guard.mjs';
import { createRepositoryReviewTools } from './repository-tools.mjs';

/**
 * Create an MCP stdio server for one configured immutable local commit pair.
 * It exports only the local review tools; it has no shell, network or write tool.
 */
export async function createRepositoryReviewMcpServer({ repoRoot, workspaceRoot = repoRoot, base, head, guard } = {}) {
  if (typeof repoRoot !== 'string' || typeof workspaceRoot !== 'string' || !base || !head) {
    throw new TypeError('repoRoot, workspaceRoot, base, and head must be explicitly configured');
  }
  const executionGuard = guard ?? createExecutionGuard({ workspaceRoot });
  const reviewTools = createRepositoryReviewTools({ repoRoot: resolve(repoRoot), guard: executionGuard });
  const snapshot = await reviewTools.snapshot({ base, head });
  // Apply the same host policy and output redaction at the MCP server boundary
  // as at the native provider boundary.
  const registry = new ToolRegistry({ guard: executionGuard });
  reviewTools.register(registry);
  const allowedTools = reviewTools.definitions().map(definition => definition.name);
  const sessionId = `mcp-review-${randomUUID()}`;
  const server = new McpServer({ name: 'micro-dsh-local-repository-review', version: '0.1.0' }, { maxToolInputElements: 32 });

  server.registerTool('repository_review_diff', {
    title: 'Read fixed repository diff',
    description: 'Read the filtered local Git diff and changed head-side lines for the configured immutable base/head commit pair.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (_input, extra) => executeTool(registry, 'repository_review_diff', {}, extra, sessionId, allowedTools));

  server.registerTool('repository_review_file_at_head', {
    title: 'Read changed file at fixed head',
    description: 'Read a bounded range from a regular text file that changed and exists at the configured reviewed head commit.',
    inputSchema: {
      path: z.string().min(1).max(1024),
      startLine: z.number().int().min(1).optional(),
      maxLines: z.number().int().min(1).max(200).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, extra) => executeTool(registry, 'repository_review_file_at_head', input, extra, sessionId, allowedTools));

  return Object.freeze({ server, reviewTools, snapshot, close: () => server.close() });
}

export async function runRepositoryReviewMcpFromEnv(env = process.env) {
  const repoRoot = env.MICRO_DSH_REVIEW_ROOT;
  const base = env.MICRO_DSH_REVIEW_BASE;
  const head = env.MICRO_DSH_REVIEW_HEAD;
  if (!repoRoot || !base || !head) {
    throw new Error('Set MICRO_DSH_REVIEW_ROOT, MICRO_DSH_REVIEW_BASE, and MICRO_DSH_REVIEW_HEAD explicitly.');
  }
  const service = await createRepositoryReviewMcpServer({ repoRoot, workspaceRoot: repoRoot, base, head });
  const transport = new StdioServerTransport();
  transport.onerror = error => process.stderr.write(`review MCP transport error: ${error.message}\n`);
  await service.server.connect(transport);
  return service;
}

async function executeTool(registry, name, input, extra, sessionId, allowedTools) {
  const taskId = `mcp-${randomUUID()}`;
  const result = await registry.execute(name, input, {
    sessionId,
    agentId: 'mcp-review-client',
    taskId,
    runId: taskId,
    attempt: 1,
    allowedTools,
    contextRefs: [],
    signal: extra.signal,
    budget: {},
  });
  const payload = result.ok ? result.data : { error: result.error };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: !result.ok,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runRepositoryReviewMcpFromEnv().catch(error => {
    process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.message}\n`);
    process.exitCode = 1;
  });
}
