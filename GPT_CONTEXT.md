# Review context

## Scope

This repository contains the desktop browser, Agent Harness, HTTP worker and Go durable queue. It is an engineering portfolio implementation, not a new browser engine or an independently qualified Agent model. Reference code is scoped and attributed in `THIRD_PARTY_NOTICES.md`.

Start with `ARCHITECTURE.md`, then `RESULTS.md`. Read source symbols relevant to a question before opening tests. No large datasets, private credentials, browser profiles or production databases are included.

## Status

- Desktop, AgentLoop, DAG, Memory, MCP, authenticated service, queue and reconcile paths: implemented; historical functional checks are summarized in `RESULTS.md`.
- Jev integration: newly implemented, opt-in; publication revision static checks are recorded separately. Real endpoint behavior, decision quality, latency and cost are unmeasured.
- Mixed 100-task success rates: author-reported aggregate, not independently verified against per-task traces.
- Long-duration operation, multi-host failover, arbitrary-step browser recovery and third-party website success: unqualified.

## Useful review questions

1. Do restart and same-key lookup preserve pending/unknown outcomes rather than reissuing side effects?
2. Does cancellation stop new dispatch while accounting for already-started work?
3. Can any untrusted page, tool result or route choice broaden the trusted host tool allowlist?
4. Are route decisions made once and persisted consistently with replay, budget and cancellation?
5. Which telemetry describes an API cohort rather than a whole browser task benchmark?

See `docs/JEV_AUTO_ROUTING.md` for the finite routing contract and fallback behavior. Read `tests/` for fixture-level assertions. Passing a fixture does not establish real-model routing quality.
