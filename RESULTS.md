# Results and evidence limits

The figures below are separate runs. They are not interchangeable, and implementation checks are not Agent task success rates. Private raw traces are excluded from this public source package; the original records remain preserved by the author.

| Cohort | Result | Scope |
| --- | --- | --- |
| Desktop functional checks | 28 server checks and 11 Windows checks passed historically | Self-hosted fixture pages and a zero-cost model fixture; no third-party website benchmark |
| Bounded genuine model browser pilot | single 0/4, multi 0/4 | Failure retained. Some runs failed; others returned blocked explanations. This does not qualify browser task capability |
| Earlier AppWorld repaired run | single 7/8, multi 6/8 | Independent small development cohort; no general multi-Agent gain |
| Original mixed 100-task campaign | 151/200 cells obtained: AppWorld 96, ToolSandbox 40, τ 15 | Campaign partial; API 503/unknown-usage stopping condition retained, remaining cells not marked complete |
| Later independent mixed 100-task rerun, supplied by author | single 69/100, multi 81/100 | Author-reported summary only. Per-task logs and new-run latency/cost files were not supplied for independent verification |
| Jev routing at publication revision | No measured improvement | Added code and mock tests; live provider and performance evaluation pending |

## Engineering conclusions

- The desktop checks establish supported local navigation/takeover/recovery behaviors under their fixtures, not arbitrary website success.
- Run persistence, idempotent lookup, cancellation and SSE replay have targeted software checks. They do not establish browser-side exactly-once or a multi-host service SLA.
- The 69%/81% aggregate covers mixed API/tool and personal workflow tasks. It is not a result for 100 Electron website tasks.
- Earlier provider cache-hit and TTFT figures describe a separate request cohort. They are not attributed to a Jev change or to the later mixed-task run.

## Next measurements

For routing, hold tasks/model/tools fixed and compare rule routing, explicit LLM routing where needed, and Jev routing. Record decision P50/P95, fallback rate, misrouting, per-decision usage/cost and final task completion. Also measure Run submission/queue wait, SSE replay latency and restart reconciliation independently from model inference. No expected gain is filled in as a result.
