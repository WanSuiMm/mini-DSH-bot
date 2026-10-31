# Jev auto routing

## Purpose and boundary

The service can make one optional upstream Choice decision for a run submitted with `mode: "auto"`. Jev chooses only between host-authored `single` and `multi` candidates. The selected mode then uses the existing `AgentLoop`, planner, and bounded `Supervisor`; this does not replace DAG scheduling or call Jev for every task step.

The service fixes the toolset and `allowedTools` before routing. Those names are included as bounded context so Jev can distinguish the available workflows. Jev cannot add tools, change scopes, create a planner, approve an action, or execute a tool. The existing planner still has to produce a valid task list, and the service still checks each worker allowlist against the host's available tools.

The deterministic fallback is `single`. The host also bypasses Jev when its route allowlist contains only `single`, fewer than two child slots are available, or the run budget cannot reserve enough tokens for the route decision and existing planner. A configured `autoModeRule` can select a host-provided candidate before any network request. Low confidence, invalid or unknown choices, transport errors, timeouts, and oversized responses use `single`. Cancellation stops the run before a fallback task or execution reservation is created.

## Enable at the host

Routing is off by default. The production host enables it only when `MICRO_DSH_JEV_ROUTING=1` and supplies `TYPESAFE_API_KEY` plus `MICRO_DSH_JEV_MODEL`. The host obtains the credential from its secret store or process environment; the service does not print it or place it in events. `MICRO_DSH_JEV_BASE_URL` defaults to `https://api.typesafe.ai/v1`, `MICRO_DSH_JEV_TIMEOUT_MS` defaults to 3000, and `MICRO_DSH_JEV_MIN_CONFIDENCE` defaults to 0.6. Select a model name supported by the TypeSafe account.

This entry is the TypeScript HTTP service. The existing desktop UI and Go facade keep their existing explicit execution modes; they do not automatically acquire an auto-routing switch from this change.

For a run, the calling application explicitly opts into auto mode:

```http
POST /v1/sessions/{sessionId}/runs
Authorization: Bearer <host-session-token>
Idempotency-Key: run-unique-key
Content-Type: application/json

{
  "prompt": "Research this request and compare the evidence.",
  "mode": "auto",
  "memoryStrategy": "none",
  "budget": {
    "maxTokens": 12000,
    "maxToolCalls": 8,
    "maxDurationMs": 120000,
    "maxActiveChildren": 2
  }
}
```

The request prompt, configured toolset, allowed tool names, and run limits are sent to TypeSafe only for an explicitly enabled `auto` run. Do not use auto mode for prompts that must remain inside the host without this external decision request.

## API and accounting

`JevChoiceRouter` uses the documented System One HTTP contract: one `POST https://api.typesafe.ai/v1/systemone` with a JSON body containing `model`, `state`, and a named `choice` question. The Choice options are generated from the host's finite candidate list. The response is validated for the expected answer ID, an allowed option, per-option probabilities, confidence, optional token usage, and bounded metadata before the service uses it. See TypeSafe's [Quick Start](https://docs.typesafe.ai/introduction/quickstart) and [System One API reference](https://docs.typesafe.ai/api/system-one).

The injected Fetch transport keeps the same deadline and cancellation signal active while reading the response body, and by default rejects bodies over 64 KiB. The service also bounds routing by the remaining run deadline. An expired run ends as `timed_out` without dispatching a fallback task; explicit cancellation has priority. The client makes one request and does not retry it. A stable per-run `Idempotency-Key` header is sent as a request marker; this integration does not claim provider-side exactly-once behavior.

The host writes a `run.mode_routed` receipt and copies the decision into `run.execution_reserved`. The completed run result also includes `resolvedMode` and `routeDecision`. The receipt includes the returned model, confidence, provider-reported input/output tokens when present, response request ID and credits when valid, plus a token-budget charge. Complete, partial and unknown provider usage are recorded separately. Missing input uses the serialized-request estimate; missing output reserves a fixed 256 estimated completion tokens, with known fields retained. A route is bypassed before dispatch if that reservation leaves insufficient worker budget. Missing usage stays unknown in the receipt. These estimates are not a guaranteed upper bound on provider billing.

On cancellation during routing, `run.mode_route_cancelled` records whether the transport was started and the estimated input-token reservation when applicable. It contains no fallback selection, and no task or execution reservation is written. A timeout or cancellation may leave provider-side billing unknown; no zero-charge inference is made.

## Verification status

Mock-only tests are in `tests/jev-choice-router.test.mjs` and the service integration cases are in `tests/service.test.mjs`. They cover the request contract, host-only choices, low-confidence and invalid-choice fallback, rule bypass, transport errors, response size, timeout and cancellation through a pending body, explicit opt-in, persisted routing, budget accounting, and idempotent replay.

This publication pass performs static type/syntax checks only; the new functional mock cases have not been executed because the designated test server was unavailable. No live TypeSafe request or performance comparison has been run. The integration does not establish a speedup or task-quality improvement. Use the normal project test entry in an authorized environment after review:

```powershell
node scripts/test.mjs
```
