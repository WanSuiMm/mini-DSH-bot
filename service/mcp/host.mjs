import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import process from 'node:process';

const MCP_NAME_PREFIX = 'mcp_';
const SAFE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,19}$/;
const SAFE_ALIAS = /^[A-Za-z][A-Za-z0-9_-]{0,37}$/;
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_TOOL_DESCRIPTION_CHARS = 512;
const MAX_SCHEMA_DESCRIPTION_CHARS = 512;
const MAX_SCHEMA_STRING_CHARS = 2048;
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_NODES = 4096;
const SCHEMA_ANNOTATION_FIELDS = new Set(['$comment', 'comment', 'default', 'deprecated', 'examples', 'externalDocs', 'readOnly', 'writeOnly']);
const MAX_TOOL_PAGES = 32;
const MAX_REMOTE_TOOLS = 512;
const MAX_INPUT_BYTES = 128 * 1024;
const MAX_INPUT_DEPTH = 40;
const MAX_INPUT_NODES = 10_000;
const POLICY_EFFECTS = new Set(['read', 'write', 'delete', 'git', 'command', 'network', 'opaque']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Connect to administrator-configured MCP servers and expose only the named
 * tools in their local manifests. Server annotations are retained only by the
 * SDK and are never used to grant policy or read-only status.
 */
export async function createMcpHost({
  servers,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResultBytes = DEFAULT_MAX_RESULT_BYTES,
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
  maxSchemaBytes = DEFAULT_MAX_SCHEMA_BYTES,
} = {}) {
  const normalized = normalizeManifest(servers);
  const limits = {
    timeoutMs: boundedInteger(timeoutMs, 1, MAX_TIMEOUT_MS, 'timeoutMs'),
    maxResultBytes: boundedInteger(maxResultBytes, 1, MAX_RESULT_BYTES, 'maxResultBytes'),
    maxMessageBytes: boundedInteger(maxMessageBytes, 1, MAX_MESSAGE_BYTES, 'maxMessageBytes'),
    maxSchemaBytes: boundedInteger(maxSchemaBytes, 1, MAX_SCHEMA_BYTES, 'maxSchemaBytes'),
  };
  const clients = [];
  const tools = [];
  const names = new Set();
  let closed = false;
  const activeCalls = new Set();
  const registeredRegistries = new WeakSet();

  try {
    for (const serverConfig of normalized) {
      // An empty local allowlist starts no process and makes no network request.
      if (serverConfig.tools.length === 0) continue;

      const { client } = await connectServer(serverConfig, limits);
      clients.push(client);

      const remoteTools = await listAllTools(client, limits.timeoutMs);
      const byRemoteName = new Map();
      for (const tool of remoteTools) {
        if (!tool || typeof tool.name !== 'string' || tool.name.length < 1 || tool.name.length > 256) {
          throw new Error('Invalid remote tool list');
        }
        if (byRemoteName.has(tool.name)) throw new Error('Duplicate remote tool name');
        byRemoteName.set(tool.name, tool);
      }

      for (const exposure of serverConfig.tools) {
        const remote = byRemoteName.get(exposure.name);
        if (!remote) throw new Error('Configured tool is not available');
        const localName = `${MCP_NAME_PREFIX}${serverConfig.id}__${exposure.alias}`;
        if (localName.length > 64 || names.has(localName)) throw new Error('MCP tool name collision');
        names.add(localName);

        const description = formatDescription(serverConfig.id, remote.description);
        const { schema, validate } = prepareInputSchema(remote.inputSchema, limits.maxSchemaBytes);
        const registeredPolicy = Object.freeze({
          ...exposure.policy,
          source: 'mcp',
          serverId: serverConfig.id,
        });
        const tool = {
          name: localName,
          description,
          schema,
          validate,
          client,
          serverId: serverConfig.id,
          remoteName: exposure.name,
          readOnly: exposure.readOnly === true && exposure.policy.effect === 'read',
          policy: registeredPolicy,
          timeoutMs: serverConfig.timeoutMs ?? limits.timeoutMs,
          maxResultBytes: limits.maxResultBytes,
        };
        tools.push(tool);
      }
    }
  } catch {
    await Promise.allSettled(clients.map(client => client.close()));
    throw new Error('MCP host initialization failed; check the local server manifest and connection configuration.');
  }

  return {
    definitions() {
      return tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: cloneJson(tool.schema),
      }));
    },

    register(registry) {
      if (closed) throw new Error('MCP host is closed');
      if (!registry || typeof registry.register !== 'function') {
        throw new TypeError('A compatible tool registry is required');
      }
      if (registeredRegistries.has(registry)) throw new Error('MCP tools are already registered with this registry');

      if (typeof registry.has === 'function') {
        for (const tool of tools) {
          if (registry.has(tool.name)) throw new Error(`Tool name is already registered: ${tool.name}`);
        }
      }
      for (const tool of tools) {
        registry.register(tool.name, (input, context) => invokeTool(tool, input, context), {
          readOnly: tool.readOnly,
          policy: tool.policy,
        });
      }
      registeredRegistries.add(registry);
      return registry;
    },

    async close() {
      if (closed) return;
      closed = true;
      for (const controller of activeCalls) controller.abort(new Error('MCP host closed'));
      activeCalls.clear();
      await Promise.allSettled(clients.map(client => client.close()));
    },
  };

  async function invokeTool(tool, input, context) {
    if (closed) return failure('MCP_HOST_CLOSED', 'MCP host is closed.');
    if (context?.signal?.aborted) return failure('CANCELLED', 'MCP tool call was cancelled.');
    if (!isBoundedJson(input, MAX_INPUT_BYTES, MAX_INPUT_DEPTH, MAX_INPUT_NODES)) {
      return failure('MCP_INVALID_ARGUMENTS', 'Arguments must be bounded JSON data.');
    }
    let valid = false;
    try { valid = tool.validate(input) === true; } catch { valid = false; }
    if (!valid) return failure('MCP_INVALID_ARGUMENTS', 'Arguments do not match the configured MCP tool schema.');

    const controller = new AbortController();
    activeCalls.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('MCP tool call timed out'));
    }, tool.timeoutMs);
    timer.unref?.();

    const signal = combineSignals(context?.signal, controller.signal);
    try {
      const result = await tool.client.callTool(
        { name: tool.remoteName, arguments: input },
        undefined,
        {
          signal,
          timeout: tool.timeoutMs + 100,
          maxTotalTimeout: tool.timeoutMs + 100,
        },
      );
      return makeToolResult(tool, result);
    } catch {
      if (timedOut) return failure('MCP_TIMEOUT', 'MCP tool call exceeded its time limit.');
      if (context?.signal?.aborted || closed) return failure('CANCELLED', 'MCP tool call was cancelled.');
      return failure('MCP_CALL_FAILED', 'MCP tool call failed.');
    } finally {
      clearTimeout(timer);
      activeCalls.delete(controller);
    }
  }
}

async function connectServer(server, limits) {
  const client = new Client({ name: 'micro-dsh', version: '0.1.0' });
  let transport;
  try {
    if (server.transport === 'stdio') {
      const env = buildStdioEnvironment(server.env);
      transport = new StdioClientTransport({
        command: server.command,
        args: server.args,
        cwd: server.cwd,
        env,
        stderr: 'ignore',
        maxBufferSize: limits.maxMessageBytes,
      });
    } else {
      transport = new StreamableHTTPClientTransport(new URL(server.url), {
        fetch: createBoundedNoRedirectFetch(limits.maxMessageBytes),
        requestInit: {
          headers: buildHttpHeaders(server.headers),
          redirect: 'error',
        },
        redirectPolicy: 'same-origin',
        reconnectionOptions: {
          maxReconnectionDelay: 500,
          initialReconnectionDelay: 100,
          reconnectionDelayGrowFactor: 1.2,
          maxRetries: 1,
        },
      });
    }

    const deadline = makeDeadline(limits.timeoutMs);
    try {
      await client.connect(transport, deadline.requestOptions());
    } finally {
      deadline.close();
    }
    return { client };
  } catch {
    try { await client.close(); } catch { /* SDK cleanup can fail after failed startup. */ }
    if (transport && client.transport !== transport) {
      try { await transport.close(); } catch { /* No server diagnostics cross this boundary. */ }
    }
    throw new Error('MCP server connection failed.');
  }
}

async function listAllTools(client, timeoutMs) {
  const deadline = makeDeadline(timeoutMs);
  const tools = [];
  const cursors = new Set();
  let cursor;
  try {
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const params = cursor === undefined ? undefined : { cursor };
      const response = await client.listTools(params, deadline.requestOptions());
      if (!response || !Array.isArray(response.tools)) throw new Error('Invalid remote tool list');
      tools.push(...response.tools);
      if (tools.length > MAX_REMOTE_TOOLS) throw new Error('Remote tool list exceeds its limit');
      const next = response.nextCursor;
      if (next === undefined) return tools;
      if (typeof next !== 'string' || next.length < 1 || next.length > 512 || cursors.has(next)) {
        throw new Error('Invalid remote pagination cursor');
      }
      cursors.add(next);
      cursor = next;
    }
    throw new Error('Remote tool pagination exceeded its limit');
  } finally {
    deadline.close();
  }
}

function normalizeManifest(servers) {
  if (!Array.isArray(servers)) throw new TypeError('servers must be an array of administrator-configured MCP servers');
  if (servers.length > 32) throw new TypeError('Too many MCP servers are configured');
  const ids = new Set();
  const names = new Set();
  return servers.map(server => {
    if (!isPlainObject(server) || typeof server.id !== 'string' || !SAFE_ID.test(server.id) || ids.has(server.id)) {
      throw new TypeError('Each MCP server needs a unique safe id');
    }
    ids.add(server.id);
    if (server.transport !== 'stdio' && server.transport !== 'http') {
      throw new TypeError(`MCP server '${server.id}' has an unsupported transport`);
    }
    const timeoutMs = server.timeoutMs === undefined
      ? undefined
      : boundedInteger(server.timeoutMs, 1, MAX_TIMEOUT_MS, 'server.timeoutMs');
    const tools = server.tools === undefined ? [] : server.tools;
    if (!Array.isArray(tools) || tools.length > 256) throw new TypeError('Each MCP tools allowlist must be a bounded array');
    const normalizedTools = tools.map(exposure => {
      if (!isPlainObject(exposure) || typeof exposure.name !== 'string' || exposure.name.length < 1 || exposure.name.length > 256) {
        throw new TypeError('Each exposed MCP tool needs its exact remote name');
      }
      if (typeof exposure.alias !== 'string' || !SAFE_ALIAS.test(exposure.alias)) {
        throw new TypeError('Each exposed MCP tool needs a safe local alias');
      }
      const localName = `${MCP_NAME_PREFIX}${server.id}__${exposure.alias}`;
      if (localName.length > 64 || names.has(localName)) throw new TypeError('MCP tool name collision');
      names.add(localName);
      const policy = normalizePolicy(exposure.policy);
      if (exposure.readOnly !== undefined && typeof exposure.readOnly !== 'boolean') {
        throw new TypeError('readOnly must be a trusted boolean setting');
      }
      return {
        name: exposure.name,
        alias: exposure.alias,
        policy,
        readOnly: exposure.readOnly === true,
      };
    });
    const normalizedServer = {
      id: server.id,
      transport: server.transport,
      tools: normalizedTools,
      timeoutMs,
    };
    if (server.transport === 'stdio') {
      if (typeof server.command !== 'string' || server.command.length < 1 || server.command.length > 1024 || /[\0\r\n]/.test(server.command)) {
        throw new TypeError(`MCP stdio server '${server.id}' needs a fixed executable command`);
      }
      if (!Array.isArray(server.args) || server.args.length > 128 || server.args.some(arg => typeof arg !== 'string' || arg.length > 2048 || /[\0]/.test(arg))) {
        throw new TypeError(`MCP stdio server '${server.id}' needs a bounded fixed argument list`);
      }
      if (typeof server.cwd !== 'string' || !isAbsolutePath(server.cwd)) {
        throw new TypeError(`MCP stdio server '${server.id}' needs an absolute administrator-configured working directory`);
      }
      normalizedServer.command = server.command;
      normalizedServer.args = [...server.args];
      normalizedServer.cwd = server.cwd;
      normalizedServer.env = normalizeEnvReferences(server.env);
    } else {
      normalizedServer.url = normalizeHttpUrl(server.url, server.id);
      normalizedServer.headers = normalizeEnvReferences(server.headers, { headers: true });
    }
    return normalizedServer;
  });
}

function normalizePolicy(value) {
  if (!isPlainObject(value) || !POLICY_EFFECTS.has(value.effect)) {
    throw new TypeError('Each exposed MCP tool requires an explicit policy effect');
  }
  const allowed = new Set(['effect', 'pathFields', 'commandField', 'argvField', 'cwdField']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new TypeError('MCP policy contains unsupported fields');
  const policy = { effect: value.effect };
  if (value.pathFields !== undefined) {
    if (!Array.isArray(value.pathFields) || value.pathFields.length > 32 || value.pathFields.some(field => typeof field !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(field))) {
      throw new TypeError('MCP policy pathFields must be bounded safe field names');
    }
    policy.pathFields = [...new Set(value.pathFields)];
  }
  for (const field of ['commandField', 'argvField', 'cwdField']) {
    if (value[field] !== undefined) {
      if (typeof value[field] !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value[field])) {
        throw new TypeError(`MCP policy ${field} must be a safe field name`);
      }
      policy[field] = value[field];
    }
  }
  return Object.freeze(policy);
}

function normalizeEnvReferences(value, { headers = false } = {}) {
  if (value === undefined) return Object.freeze({});
  if (!isPlainObject(value) || Object.keys(value).length > 32) throw new TypeError('MCP environment references must be a bounded object');
  const result = Object.create(null);
  for (const [key, reference] of Object.entries(value)) {
    if (headers) {
      if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(key) || /^(host|connection|content-length|transfer-encoding|mcp-session-id|mcp-protocol-version)$/i.test(key)) {
        throw new TypeError('MCP HTTP header name is not allowed');
      }
    } else if (!SAFE_ENV_NAME.test(key)) {
      throw new TypeError('MCP environment variable name is invalid');
    }
    if (!isPlainObject(reference) || Object.keys(reference).length !== 1 || typeof reference.fromEnv !== 'string' || !SAFE_ENV_NAME.test(reference.fromEnv)) {
      throw new TypeError('MCP secrets must be referenced by environment variable name');
    }
    result[key] = Object.freeze({ fromEnv: reference.fromEnv });
  }
  return Object.freeze(result);
}

function normalizeHttpUrl(value, serverId) {
  if (typeof value !== 'string' || value.length > 2048) throw new TypeError(`MCP HTTP server '${serverId}' needs an exact configured URL`);
  let url;
  try { url = new URL(value); } catch { throw new TypeError(`MCP HTTP server '${serverId}' has an invalid URL`); }
  if (url.username || url.password || url.hash || url.search) {
    throw new TypeError(`MCP HTTP server '${serverId}' URL must not embed credentials, query tokens, or fragments`);
  }
  const localHttp = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !localHttp) {
    throw new TypeError(`MCP HTTP server '${serverId}' must use HTTPS; plain HTTP is limited to loopback tests`);
  }
  return url.toString();
}

function buildStdioEnvironment(references) {
  const env = Object.create(null);
  // The SDK merges these overrides over its default inherited environment.
  // Empty values explicitly remove that implicit inheritance.
  for (const name of DEFAULT_INHERITED_ENV_VARS) env[name] = '';
  const safeInherited = process.platform === 'win32'
    ? ['PATH', 'SYSTEMROOT', 'TEMP', 'TMP']
    : ['PATH', 'TMPDIR'];
  for (const name of safeInherited) {
    const value = readEnvironmentVariable(name);
    if (value !== undefined) env[name] = value;
  }
  for (const [name, reference] of Object.entries(references)) {
    const value = readEnvironmentVariable(reference.fromEnv);
    if (value === undefined || value.length === 0) {
      throw new Error('A configured MCP environment reference is not set');
    }
    env[name] = value;
  }
  return env;
}

function buildHttpHeaders(references) {
  const headers = Object.create(null);
  for (const [name, reference] of Object.entries(references)) {
    const value = readEnvironmentVariable(reference.fromEnv);
    if (value === undefined || value.length === 0 || /[\r\n]/.test(value)) {
      throw new Error('A configured MCP HTTP header reference is not set');
    }
    headers[name] = value;
  }
  return headers;
}

function readEnvironmentVariable(name) {
  if (Object.hasOwn(process.env, name)) return process.env[name];
  if (process.platform !== 'win32') return undefined;
  const matching = Object.keys(process.env).find(key => key.toUpperCase() === name.toUpperCase());
  return matching === undefined ? undefined : process.env[matching];
}

function prepareInputSchema(remoteSchema, maxSchemaBytes) {
  const source = remoteSchema === undefined
    ? { type: 'object', properties: {}, additionalProperties: false }
    : remoteSchema;
  if (!isPlainObject(source)) throw new Error('MCP tool input schema must be a JSON object');
  const serialized = safeStringify(source);
  if (Buffer.byteLength(serialized, 'utf8') > maxSchemaBytes) throw new Error('MCP tool schema exceeds its size limit');
  const schema = sanitizeSchema(source);
  const draft = schema.$schema;
  let Validator = Ajv;
  if (draft !== undefined) {
    if (typeof draft !== 'string') throw new Error('Unsupported MCP schema dialect');
    if (draft.includes('draft/2020-12')) Validator = Ajv2020;
    else if (!draft.includes('draft-07')) throw new Error('Unsupported MCP schema dialect');
  }
  const ajv = new Validator({
    strict: false,
    strictSchema: true,
    allErrors: false,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    validateFormats: false,
    addUsedSchema: false,
    ownProperties: true,
    messages: false,
  });
  const validate = ajv.compile(schema);
  return { schema, validate };
}

function sanitizeSchema(source) {
  let nodes = 0;
  function visit(value, depth, key = '') {
    nodes += 1;
    if (nodes > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH) throw new Error('MCP tool schema exceeds structural limits');
    if (typeof value === 'string') {
      if (key === '$ref' && !value.startsWith('#/')) throw new Error('External MCP schema references are disabled');
      if (key === '$schema' && !(value.includes('draft-07') || value.includes('draft/2020-12'))) throw new Error('Unsupported MCP schema dialect');
      if ((key === 'description' || key === 'title') && value.length > MAX_SCHEMA_DESCRIPTION_CHARS) {
        return `[untrusted MCP schema ${key}] ${value.slice(0, MAX_SCHEMA_DESCRIPTION_CHARS)}`;
      }
      if (key === 'description' || key === 'title') return `[untrusted MCP schema ${key}] ${value}`;
      if (value.length > MAX_SCHEMA_STRING_CHARS) throw new Error('MCP tool schema text exceeds its limit');
      if (key === 'pattern') assertSafePattern(value);
      return value;
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('MCP tool schema contains a non-finite number');
      return value;
    }
    if (Array.isArray(value)) {
      if (value.length > 512) throw new Error('MCP tool schema array exceeds its limit');
      return value.map(item => visit(item, depth + 1, key));
    }
    if (!isPlainObject(value)) throw new Error('MCP tool schema must contain only JSON data');
    const result = Object.create(null);
    for (const [childKey, child] of Object.entries(value)) {
      // Annotation values are not needed to validate input and may contain
      // prompt-like text or suggested defaults from an untrusted server.
      if (SCHEMA_ANNOTATION_FIELDS.has(childKey)) continue;
      if (childKey === '__proto__') throw new Error('Unsafe schema property name');
      if (childKey === '$dynamicRef' || childKey === '$recursiveRef' || childKey === '$id' || childKey === '$anchor') {
        throw new Error('Unsupported MCP schema reference feature');
      }
      if (childKey === 'patternProperties') {
        if (!isPlainObject(child)) throw new Error('MCP schema patternProperties must be an object');
        for (const pattern of Object.keys(child)) assertSafePattern(pattern);
      }
      result[childKey] = visit(child, depth + 1, childKey);
    }
    return result;
  }
  return visit(source, 0);
}

function assertSafePattern(pattern) {
  if (pattern.length > 128 || /\\[1-9]|\\k</.test(pattern) || /\(\?[=!<]/.test(pattern)) {
    throw new Error('MCP schema regular expression exceeds its safe subset');
  }
  // Avoid nested/repeated quantifiers from untrusted servers. This is a
  // conservative filter; bounded input size is also enforced per call.
  if (/\([^)]*[+*{][^)]*\)[+*{]/.test(pattern) || /(?:\*|\+|\?|\{\d+(?:,\d*)?\})\s*(?:\*|\+|\?|\{)/.test(pattern)) {
    throw new Error('MCP schema regular expression exceeds its safe subset');
  }
  try { new RegExp(pattern); } catch { throw new Error('MCP schema contains an invalid regular expression'); }
}

function makeToolResult(tool, result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.content)) {
    return failure('MCP_INVALID_RESULT', 'MCP server returned an invalid tool result.');
  }
  let data;
  try {
    data = {
      isError: result.isError === true,
      content: result.content,
      ...(Object.hasOwn(result, 'structuredContent') ? { structuredContent: result.structuredContent } : {}),
    };
    const serialized = safeStringify(data);
    if (Buffer.byteLength(serialized, 'utf8') > tool.maxResultBytes) {
      return failure('MCP_RESULT_TOO_LARGE', 'MCP tool result exceeded its size limit.');
    }
    data = JSON.parse(serialized);
  } catch {
    return failure('MCP_INVALID_RESULT', 'MCP server returned data that could not be safely bounded.');
  }
  const evidence = [makeEvidence(tool, data)];
  if (data.isError) {
    return {
      ok: false,
      error: {
        code: 'MCP_TOOL_ERROR',
        message: extractText(data.content) || 'MCP server reported a tool error.',
        details: { content: data.content, ...(Object.hasOwn(data, 'structuredContent') ? { structuredContent: data.structuredContent } : {}) },
      },
      evidence,
    };
  }
  return { ok: true, data, evidence };
}

function makeEvidence(tool, data) {
  const summary = extractText(data.content).slice(0, 240);
  return {
    id: `mcp:${tool.serverId}:${tool.remoteName}`,
    kind: 'tool_output',
    summary: summary || `MCP tool '${tool.name}' returned a result.`,
    metadata: {
      source: 'mcp',
      serverId: tool.serverId,
      toolName: tool.remoteName,
      isError: data.isError,
    },
  };
}

function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter(item => item && item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text.slice(0, 512))
    .join('\n')
    .slice(0, 512);
}

function formatDescription(serverId, remoteDescription) {
  const prefix = `MCP server ${serverId}; server-supplied description (untrusted): `;
  const description = typeof remoteDescription === 'string' ? remoteDescription : 'No description supplied.';
  return `${prefix}${description.slice(0, MAX_TOOL_DESCRIPTION_CHARS)}`.slice(0, 768);
}

function createBoundedNoRedirectFetch(maxBytes) {
  return async (input, init = {}) => {
    const response = await fetch(input, { ...init, redirect: 'error' });
    if (!response.body) return response;
    const reader = response.body.getReader();
    let bytes = 0;
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          bytes += value.byteLength;
          if (bytes > maxBytes) {
            await reader.cancel();
            controller.error(new Error('MCP HTTP response exceeded its byte limit'));
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function makeDeadline(timeoutMs) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(new Error('MCP startup timed out')), timeoutMs);
  timer.unref?.();
  return {
    requestOptions() {
      const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt));
      return { signal: controller.signal, timeout: remaining, maxTotalTimeout: remaining };
    },
    close() { clearTimeout(timer); },
  };
}

function combineSignals(...signals) {
  const present = signals.filter(signal => signal && typeof signal.aborted === 'boolean');
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(present);
  const controller = new AbortController();
  const abort = signal => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  for (const signal of present) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    signal.addEventListener('abort', () => abort(signal), { once: true });
  }
  return controller.signal;
}

function isBoundedJson(value, maxBytes, maxDepth, maxNodes) {
  try {
    const text = safeStringify(value);
    if (Buffer.byteLength(text, 'utf8') > maxBytes) return false;
    let nodes = 0;
    function visit(item, depth) {
      nodes += 1;
      if (nodes > maxNodes || depth > maxDepth) return false;
      if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
      if (typeof item === 'number') return Number.isFinite(item);
      if (Array.isArray(item)) return item.every(child => visit(child, depth + 1));
      if (!isPlainObject(item)) return false;
      return Object.values(item).every(child => visit(child, depth + 1));
    }
    return visit(value, 0);
  } catch {
    return false;
  }
}

function cloneJson(value) {
  return JSON.parse(safeStringify(value));
}

function safeStringify(value) {
  return JSON.stringify(value, (_key, current) => {
    if (typeof current === 'bigint' || typeof current === 'function' || typeof current === 'symbol') {
      throw new TypeError('Only JSON values are accepted');
    }
    return current;
  });
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isAbsolutePath(value) {
  if (process.platform === 'win32') return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
  return value.startsWith('/');
}

function boundedInteger(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

function failure(code, message) {
  return { ok: false, error: { code, message }, evidence: [] };
}
