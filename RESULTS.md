# Results and evidence limits

The figures below are separate runs. They are not interchangeable, and implementation checks are not Agent task success rates. Private raw traces are excluded from this public source package; the original records remain preserved by the author.

| Cohort | Result | Scope |
| --- | --- | --- |
| Desktop functional checks | 28 server checks and 11 Windows checks passed historically | Self-hosted fixture pages and a zero-cost model fixture; no third-party website benchmark |
| Bounded genuine model browser pilot | single 0/4, multi 0/4 | Failure retained. Some runs failed; others returned blocked explanations. This does not qualify browser task capability |
| Earlier AppWorld repaired run | single 7/8, multi 6/8 | Independent small development cohort; no general multi-Agent gain |
| Original mixed 100-task campaign | 151/200 cells obtained: AppWorld 96, ToolSandbox 40, τ 15 | Campaign partial; API 503/unknown-usage stopping condition retained, remaining cells not marked complete |
| Author's subsequent mixed-task retest (100 questions) | single 69/100, multi 81/100 | A separate later batch reported by the author; not part of the original incomplete 151/200-cell campaign and not 100 Electron website tasks. This records the author's result, not a Codex independent rerun; per-task logs are not included in this public package |
| Jev routing, original publication revision | No measured improvement | This was the status at the original publication revision: static checks only, with no performance measurement recorded then |
| Jev routing, later author self-test (confirmed 2026-10-31) | 46% lower routing-decision time under the same configuration | Author-reported routing-stage result only; it does not establish end-to-end latency improvement. Sample count, absolute times, mean/P50/P95, and baseline routing category were not supplied. This documentation records the author report; it is not a Codex independent rerun |

## Engineering conclusions

- The desktop checks establish supported local navigation/takeover/recovery behaviors under their fixtures, not arbitrary website success.
- Run persistence, idempotent lookup, cancellation and SSE replay have targeted software checks. They do not establish browser-side exactly-once or a multi-host service SLA.
- The 69%/81% aggregate is from the author's subsequent 100-question mixed API/tool and personal workflow retest. It is separate from the original partial 151/200-cell campaign and is not a result for 100 Electron website tasks.
- Earlier provider cache-hit and TTFT figures describe a separate request cohort. They are not attributed to a Jev change or to the later mixed-task run.

## Next measurements

For routing, hold tasks/model/tools fixed and compare rule routing, explicit LLM routing where needed, and Jev routing. Record decision P50/P95, fallback rate, misrouting, per-decision usage/cost and final task completion. Also measure Run submission/queue wait, SSE replay latency and restart reconciliation independently from model inference. No expected gain is filled in as a result.
