# Review context

## Scope

This repository contains the desktop browser, Agent Harness, HTTP worker and Go durable queue. It is an engineering portfolio implementation, not a new browser engine or an independently qualified Agent model. Reference code is scoped and attributed in `THIRD_PARTY_NOTICES.md`.

Start with `ARCHITECTURE.md`, then `RESULTS.md`. Read source symbols relevant to a question before opening tests. No large datasets, private credentials, browser profiles or production databases are included.

The author-provided project timeline is 2026.02–2026.05 for the main development and 2026.09–2026.10 for the Jev routing extension. These résumé dates are not inferred from or verified by repository commit history.

## Status

- Desktop, AgentLoop, DAG, Memory, MCP, authenticated service, queue and reconcile paths: implemented; historical functional checks are summarized in `RESULTS.md`.
- Jev integration: opt-in. The original publication revision recorded static checks only and no measured improvement. On 2026-10-31 the author later reported a 46% decrease in routing-decision time under the same configuration. This covers the routing stage, not end-to-end latency; sample count, absolute times, mean/P50/P95 and baseline routing category were not supplied. This is an author self-test report, not a Codex independent rerun.
- Mixed-task retest: the author later reported single 69/100 and multi 81/100 on a 100-question mixed cohort. It is separate from the original incomplete 151/200-cell campaign, is not 100 Electron website tasks, and was not independently rerun by Codex; see `RESULTS.md`.
- Long-duration operation, multi-host failover, arbitrary-step browser recovery and third-party website success: unqualified.

## Useful review questions

1. Do restart and same-key lookup preserve pending/unknown outcomes rather than reissuing side effects?
2. Does cancellation stop new dispatch while accounting for already-started work?
3. Can any untrusted page, tool result or route choice broaden the trusted host tool allowlist?
4. Are route decisions made once and persisted consistently with replay, budget and cancellation?
5. Which telemetry describes an API cohort rather than a whole browser task benchmark?

See `docs/JEV_AUTO_ROUTING.md` for the finite routing contract and fallback behavior. Read `tests/` for fixture-level assertions. Passing a fixture does not establish real-model routing quality.
