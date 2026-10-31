# Read-only local PR review

The review tools inspect one caller-selected local Git commit range. The caller supplies an absolute repository root plus full base and head commit SHAs. The model receives no repository-root or revision argument, and cannot broaden the snapshot after it starts.

The native tool provider exports `repository_review_diff` and `repository_review_file_at_head`. The first returns a bounded diff and the added lines that exist at the reviewed head. The second reads a bounded line range from a regular text file that changed in that range and exists at the selected head. Both operations read Git objects through fixed `git` argument arrays with `shell: false`, timeouts, and output limits. They do not check out commits or read arbitrary paths.

## Safety boundaries

- Protected paths such as `.env`, `.ssh`, private keys, credentials, and Git metadata are filtered before patch contents are collected. Symlinks, submodules, binary files, deleted files, unsafe paths, and files rejected by the workspace guard are omitted.
- Git execution uses a minimal environment without inherited model or credential variables. System and global Git configuration are disabled. Filesystem monitors, credential helpers, external diff drivers, and pagers are disabled; text conversion and external diffs are explicitly off. No PR source, tests, hooks, or shell commands are executed.
- MCP runs over the official SDK stdio transport. The standalone server requires `MICRO_DSH_REVIEW_ROOT`, `MICRO_DSH_REVIEW_BASE`, and `MICRO_DSH_REVIEW_HEAD`. It exposes the same two read-only tools and no filesystem write, network, shell, or GitHub mutation tool.
- A report is accepted only when it names the fixed full SHAs, uses a supported severity, points to an added line in the head commit, quotes an exact substring from that line, and includes bounded limitations. Empty findings are valid. These checks prevent invented file/line/SHA anchors; they cannot prove that the model's interpretation of the code is correct.
- This is host-side read-only enforcement. It is not an OS sandbox or a guarantee against unrelated software already running on the host.

## Optional model-backed CLI

The CLI makes no model request for `--help` or unless `--execute` is present. It requires an explicit repo root, full base/head SHAs, and a new output directory whose parent already exists. The output path is checked before the model call and created without overwrite after the report passes validation.

```powershell
node scripts/review.mjs --help
node scripts/review.mjs --execute `
  --repo-root D:\path\to\repository `
  --base <full-base-sha> `
  --head <full-head-sha> `
  --output D:\path\to\new-review-directory `
  --model-url http://127.0.0.1:8000/v1 `
  --model local-review-model
```

`MICRO_DSH_MODEL_URL` and `MICRO_DSH_MODEL` can supply the model endpoint and identifier. `MODEL_API_KEY`, when needed, is read only from the environment and is never written into the report. The CLI limits the run to 12 tool calls, 16,384 estimated/cumulative tokens, a two-minute task deadline, a 32,768-token request context, and 1,024 output tokens per request. A truncated final response fails without writing a report.

The offline review tests create a temporary local Git repository with real commits and use synthetic fixtures where needed. They make no model or network calls and do not contact GitHub. The tests exercise fixed SHA snapshots, protected-file filtering, bounded file reads, changed-line report validation, path traversal denial, and guard rejection of symlink paths. Creating an actual junction/symlink may be unavailable in restricted Windows sandboxes; the injected-guard denial case still runs there.

```powershell
node scripts/build.mjs
node --test tests/review.test.mjs
```
