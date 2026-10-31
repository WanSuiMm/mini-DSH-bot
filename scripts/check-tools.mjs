import { loadToolConfiguration } from '../service/tool-configuration.mjs';

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/check-tools.mjs --config ABSOLUTE_HOST_CONFIG.json. Performs local repository/MCP connection checks only; no model, training, PR publication or repository mutation.');
} else {
  const index = process.argv.indexOf('--config');
  const file = index >= 0 ? process.argv[index + 1] : process.env.MICRO_DSH_TOOL_CONFIG;
  if (!file) throw new Error('Provide --config or MICRO_DSH_TOOL_CONFIG');
  const tools = await loadToolConfiguration(file, { toolset: 'coding' });
  try {
    console.log(JSON.stringify({ status: 'connected', policyVersion: tools.executionGuard.policyVersion,
      tools: tools.extraTools.map(tool => ({ name: tool.name })), modelCalls: 0, repositoryWrites: 0 }));
  } finally { await Promise.allSettled(tools.toolProviders.map(provider => provider.close?.())); }
}
