import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { createExecutionGuard } from './security/guard.mjs';

/** Trusted host configuration only. Never expose this file selector as a tool argument. */
export async function loadToolConfiguration(file, { toolset = 'technical' } = {}) {
  if (!file) {
    if (['coding', 'browser'].includes(toolset)) throw new Error('This toolset requires MICRO_DSH_TOOL_CONFIG');
    return { toolProviders: [], extraTools: [] };
  }
  if (!isAbsolute(file)) throw new Error('MICRO_DSH_TOOL_CONFIG must be an absolute host path');
  const text = await readFile(file, 'utf8');
  if (Buffer.byteLength(text) > 256_000) throw new Error('Tool configuration is too large');
  let config;
  try { config = JSON.parse(text); } catch { throw new Error('Invalid JSON tool configuration'); }
  if (!config || typeof config !== 'object' || Array.isArray(config) || typeof config.workspaceRoot !== 'string' || !isAbsolute(config.workspaceRoot)) throw new Error('An absolute workspaceRoot is required');
  if (Object.keys(config).some(key => !['workspaceRoot', 'review', 'mcp', 'browser'].includes(key))) throw new Error('Unknown tool configuration field');
  let guard = createExecutionGuard({ workspaceRoot: config.workspaceRoot });
  const providers = [];
  let browserRuntime;
  try {
    if (config.review) {
      if (Object.keys(config.review).some(key => !['base', 'head'].includes(key))) throw new Error('Review accepts only base and head commit IDs');
      const { createRepositoryReviewTools } = await import('./review/repository-tools.mjs');
      const review = createRepositoryReviewTools({ repoRoot: config.workspaceRoot, guard });
      await review.snapshot({ base: config.review.base, head: config.review.head });
      providers.push(review);
    }
    if (config.mcp) {
      const { createMcpHost } = await import('./mcp/host.mjs');
      providers.push(await createMcpHost(config.mcp));
    }
    if (config.browser) {
      const { configureBrowserProvider } = await import('./browser/configuration.mjs');
      const { createBrowserToolGuard } = await import('./browser/provider.mjs');
      const browser = await configureBrowserProvider(config.browser, { workspaceRoot: config.workspaceRoot });
      providers.push(browser); browserRuntime = browser.runtime; guard = createBrowserToolGuard(guard);
    }
    if (toolset === 'browser' && !browserRuntime) throw new Error('Browser toolset has no configured browser runtime');
    const extraTools = providers.flatMap(provider => provider.definitions());
    if (toolset === 'coding' && !extraTools.length) throw new Error('Coding configuration exposes no tools');
    return {
      toolProviders: providers, extraTools, executionGuard: guard, workspaceRoot: config.workspaceRoot, browserRuntime,
      // Includes destinations, local policy and fixed commit pair, not just schemas.
      // The digest is persisted to block replay under a changed host capability set.
      executionProfile: createHash('sha256').update(JSON.stringify({ config, toolset, extraTools, policy: guard.policyVersion })).digest('hex'),
    };
  } catch (cause) {
    await Promise.allSettled(providers.map(provider => provider.close?.()));
    throw cause;
  }
}
