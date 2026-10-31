# MCP Host

`service/mcp/host.mjs` uses the official TypeScript SDK, pinned to `@modelcontextprotocol/sdk` **1.32.1**, with Ajv **8.20.0** and Zod **3.25.76** in the dependency lock. It supports stdio and Streamable HTTP. See the [official SDK client documentation](https://ts.sdk.modelcontextprotocol.io/client).

## Capability registration

The host connects only to administrator-configured servers. Each server has an explicit local tool allowlist. An empty allowlist launches no process and makes no HTTP connection. `tools/list` is bounded and paginated; only configured tool names become model-visible functions.

Local names use `mcp_<server-id>__<alias>` and remain within 64 characters. IDs and aliases start with a letter and contain only letters, digits, underscores or dashes. This avoids dots that are incompatible with the configured [DeepSeek function-name contract](https://api-docs.deepseek.com/api/create-chat-completion/). Remote names remain unchanged when the host calls `tools/call`.

Server-supplied descriptions and schema descriptions are labeled untrusted and bounded. Server annotations never grant permissions or concurrency. A tool is parallel-safe only when the local manifest explicitly sets both `readOnly: true` and `policy.effect: read`.

## Trusted JSON configuration

`MICRO_DSH_TOOL_CONFIG` points to an absolute host configuration file. Replace the example root and commit placeholders with a real local Git worktree and complete immutable commit SHAs. No credential values belong in this file.

```json
{
  "workspaceRoot": "D:/code/review-worktree",
  "review": {"base": "<full-base-SHA>", "head": "<full-head-SHA>"},
  "mcp": {
    "timeoutMs": 15000,
    "maxResultBytes": 262144,
    "servers": [{
      "id": "repo",
      "transport": "stdio",
      "command": "C:/Program Files/nodejs/node.exe",
      "args": ["/absolute/path/to/mini-DSH-bot/service/review/mcp-server.mjs"],
      "cwd": "/absolute/path/to/mini-DSH-bot",
      "env": {
        "MICRO_DSH_REVIEW_ROOT": {"fromEnv": "MICRO_DSH_REVIEW_ROOT"},
        "MICRO_DSH_REVIEW_BASE": {"fromEnv": "MICRO_DSH_REVIEW_BASE"},
        "MICRO_DSH_REVIEW_HEAD": {"fromEnv": "MICRO_DSH_REVIEW_HEAD"}
      },
      "tools": [{
        "name": "repository_review_diff",
        "alias": "diff",
        "readOnly": true,
        "policy": {"effect": "read"}
      }, {
        "name": "repository_review_file_at_head",
        "alias": "file",
        "readOnly": true,
        "policy": {"effect": "read"}
      }]
    }]
  }
}
```

The standalone repository server validates its own fixed root and commit pair. The native `review` provider and this MCP server should receive the same pair when used in one review. File-at-head tools read fixed Git blobs and check paths internally; they do not accept a model-selected root or revision.

An HTTP server entry instead uses:

```json
{
  "id": "documentation",
  "transport": "http",
  "url": "https://your-approved-mcp-host.example/mcp",
  "headers": {"Authorization": {"fromEnv": "APPROVED_MCP_AUTH_HEADER"}},
  "tools": [{"name": "search", "alias": "search", "readOnly": true, "policy": {"effect": "read"}}]
}
```

HTTP requires an exact administrator-selected HTTPS endpoint; plain HTTP is limited to loopback. Redirects are rejected. The referenced authorization environment variable contains the complete header value; it is not sent to the model or printed. Embedded URL credentials/query tokens and forbidden transport headers are rejected. There is no automatic OAuth enrollment or credential forwarding from incoming users.

## Execution and lifecycle

`createMcpHost({servers, timeoutMs, maxResultBytes, maxMessageBytes, maxSchemaBytes})` returns `definitions()`, `register(registry)` and `close()`. The service uses a guarded registry; callers using the library directly must also install the execution guard.

- Tool arguments must satisfy the returned JSON Schema before the remote handler is called. Input depth/size, schema depth/size, tool-list pages/count and result size are bounded.
- JSON Schema draft-07 and 2020-12 are supported within the host's bounded subset. External references and unsafe/unbounded schema patterns are rejected; unsupported schemas fail closed at connection time.
- Native and MCP capabilities share `ToolRegistry` policy evaluation, worker allowlists, cancellation and redacted event auditing. Write/delete/opaque/network effects return `TOOL_APPROVAL_REQUIRED` without remote dispatch.
- Timeouts and cancellation reach SDK requests. Closing the host cancels active calls and closes transports/stdio children. Transport errors do not echo raw server stderr or credential-bearing connection details.
- Stdio child environments are minimal; additional values require explicit environment-variable references. Server process launch itself is a trusted administrator action, outside the per-tool guard. The host does not sandbox arbitrary server startup code.

The host can withhold a tool call; it cannot guarantee that a remote implementation honors the locally declared effect or undo side effects after dispatch. Do not treat a `readOnlyHint` or a protocol test as an OS isolation guarantee.

## Checks

From the project root:

```powershell
node scripts/build.mjs
node scripts/check-tools.mjs --config D:/code/private/micro-dsh-tools.json
node --test tests/mcp.test.mjs tests/security.test.mjs tests/review.test.mjs tests/coding-service.test.mjs
```

The tests use official SDK subprocess and loopback HTTP servers, real temporary Git repositories, synthetic model fixtures and policy probes. They do not train a model, publish PR comments or connect to an external MCP account. Real Flash integration is separately recorded in CODING_GUARD_MCP_RESULTS_20261019.md（历史材料未随源码分发；见[结果汇总](../RESULTS.md)）.
