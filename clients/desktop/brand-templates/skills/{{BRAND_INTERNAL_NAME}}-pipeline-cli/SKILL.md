---
name: {{BRAND_INTERNAL_NAME}}-pipeline-cli
description: Use when asked to run, resume, inspect, validate, or manage {{BRAND_DISPLAY_NAME}} pipelines, workspaces, or worktrees from the terminal with the `{{BRAND_CLI_NAME}}` CLI
---

# {{BRAND_DISPLAY_NAME}} CLI

Use this skill when the task is about invoking or interpreting the {{BRAND_DISPLAY_NAME}} CLI. This skill is the complete reference for the CLI's pipeline commands, execution behavior, output formats, and common failure cases.

When the task also requires creating or editing pipeline YAML, interpreting schema fields or expressions, or reasoning about action authoring and runtime behavior, read the sibling bundled [`{{BRAND_INTERNAL_NAME}}-pipeline-writing`](../{{BRAND_INTERNAL_NAME}}-pipeline-writing/SKILL.md) skill before proceeding. It ships with this skill and contains the self-contained schema, execution-model, and authoring guidance; do not rely on repository-only documentation.

Assume the CLI is available as a global `{{BRAND_CLI_NAME}}` executable.

## Quick Selection

- List workspaces: `{{BRAND_CLI_NAME}} workspace list`
- Get a workspace record: `{{BRAND_CLI_NAME}} workspace get <workspace-id>`
- Import a local repo as a workspace: `{{BRAND_CLI_NAME}} workspace create import <repo-path>`
- Clone and import a remote repo: `{{BRAND_CLI_NAME}} workspace create remote <remote-url> <destination-dir>`
- Create a new single-repo workspace: `{{BRAND_CLI_NAME}} workspace create new single-repo <name>`
- Create a new multi-repo workspace: `{{BRAND_CLI_NAME}} workspace create new multi-repo <name>`
- List worktrees in a workspace: `{{BRAND_CLI_NAME}} workspace worktrees <workspace-id> list`
- Create a worktree: `{{BRAND_CLI_NAME}} workspace worktrees <workspace-id> create [--branch <name>] [--base-branch <name>] [--repair] [--no-restore-claude-md]`
- Get a worktree record: `{{BRAND_CLI_NAME}} workspace worktrees <workspace-id> get <worktree-id>`
- Print a worktree path: `{{BRAND_CLI_NAME}} workspace worktrees <workspace-id> get-path <worktree-id>`
- Delete a worktree: `{{BRAND_CLI_NAME}} workspace worktrees <workspace-id> delete <worktree-id>`
- List pipeline executions for a worktree: `{{BRAND_CLI_NAME}} workspace worktrees <workspace-id> pipeline-executions <worktree-id> list [--limit <n>] [--offset <n>]`
- Run a pipeline once: `{{BRAND_CLI_NAME}} pipelines executions run <pipeline-input> [flags]`
- Resume a paused or interrupted execution: `{{BRAND_CLI_NAME}} pipelines executions resume <execution-id> [flags]`
- Cancel a paused or running execution: `{{BRAND_CLI_NAME}} pipelines executions cancel <execution-id> [--executions-dir <dir>]`
- List executions: `{{BRAND_CLI_NAME}} pipelines executions list [--executions-dir <dir>] [--limit <n>] [--offset <n>]`
- Inspect an execution: `{{BRAND_CLI_NAME}} pipelines executions summary <execution-id> [--executions-dir <dir>]`
- List bundled and user pipelines: `{{BRAND_CLI_NAME}} pipelines list`
- Validate a pipeline definition without running it: `{{BRAND_CLI_NAME}} pipelines validate <pipeline-input> [--inline]`
- Register a pipeline in the user store: `{{BRAND_CLI_NAME}} pipelines register <pipeline-input> [--inline]`
- Read a stored or bundled pipeline: `{{BRAND_CLI_NAME}} pipelines get <pipeline-id>`
- Get a stored or bundled pipeline path: `{{BRAND_CLI_NAME}} pipelines get-path <pipeline-id>`
- Update a stored user pipeline: `{{BRAND_CLI_NAME}} pipelines update <pipeline-id> <pipeline-input> [--inline]`
- Delete a stored user pipeline: `{{BRAND_CLI_NAME}} pipelines delete <pipeline-id>`

## Workspace And Worktree Commands

Workspace and worktree commands operate on the same persisted data root as the desktop app. Output is intentionally script-friendly:

- `workspace list` prints tab-delimited rows: `<workspace-id>\t<type>\t<name>\t<root-path>`
- `workspace get` and workspace creation commands print formatted JSON `WorkspaceCliRecord`
- `worktrees list` prints tab-delimited rows: `<worktree-id>\t<branch-name>\t<created-at>\t<path>`
- `worktrees get` and `worktrees create` print formatted JSON `WorktreeCliRecord`
- `worktrees get-path` prints only the absolute worktree path
- `worktrees delete` prints the deleted worktree ID

### `{{BRAND_CLI_NAME}} workspace worktrees <workspace-id> create`

Syntax:

```bash
{{BRAND_CLI_NAME}} workspace worktrees <workspace-id> create [options]
```

Flags:

- `--branch <name>`: branch name for the new worktree. Without this flag, {{BRAND_DISPLAY_NAME}} uses the generated worktree ID as the initial branch name.
- `--base-branch <name>`: start from a local branch, remote branch, or `origin/<name>`. The tracked base branch is persisted on the worktree.
- `--repair`: for source-backed multi-repo workspaces, repair required workspace-root files if the new root worktree is missing or has invalid `.gitignore`, `{{BRAND_CONFIG_FILE}}`, or `AGENTS.md` state.
- `--no-restore-claude-md`: only meaningful with `--repair`; skip copying `CLAUDE.md` from the source repo into the worktree during repair.

Behavior:

- Single-repo worktrees are created from the workspace repo.
- Source-backed multi-repo worktrees create the workspace root worktree first, then child repo worktrees under `repos/<repo-id>`.
- Without `--repair`, a source-backed multi-repo worktree that needs blocking root repair fails and rolls back with an error that says the root worktree requires repair.
- With `--repair`, the CLI repairs root files inline before creating child repo worktrees, then prints the normal `WorktreeCliRecord`.
- CLI worktree creation does not run desktop post-create setup scripts; use the app when you need the interactive setup flow.

Examples:

```bash
{{BRAND_CLI_NAME}} workspace worktrees app create --branch feature/search --base-branch main
{{BRAND_CLI_NAME}} workspace worktrees platform create --branch feature/search --base-branch main --repair
{{BRAND_CLI_NAME}} workspace worktrees platform create --repair --no-restore-claude-md
```

## Triggers and Event Context

Pipelines declare their trigger type(s) via the `on` field (`dispatch`, `plan_ready`, `task_ready`, or any combination). The CLI `run` command always uses the `dispatch` trigger. The `plan_ready` and `task_ready` triggers are initiated by the app or by higher-level integrations, not directly from `{{BRAND_CLI_NAME}} pipelines executions run`.

When a `plan_ready` execution runs, the plan is written to a shared file accessible via `{{BRAND_EXPRESSION_ROOT}}.event.plan_ready.plan_path`. When a `task_ready` execution runs, the task definition is available at `{{BRAND_EXPRESSION_ROOT}}.event.task_ready.task_path` and the pipeline receives a reserved plan output path at `{{BRAND_EXPRESSION_ROOT}}.event.task_ready.plan_path`. All executions expose `{{BRAND_EXPRESSION_ROOT}}.event_name` (`'dispatch'`, `'plan_ready'`, or `'task_ready'`).

## Working Rules

- `pipeline-input` can be a file path or inline YAML/JSON when `--inline` is set.
- The parser accepts both a raw pipeline object and a document wrapped in `pipeline:`.
- `validate`, `register`, and `update` normalize structure, but they do not resolve actions or verify that `project/...` actions exist.
- Bundled pipelines now include the default presets plus the workflow-mapping families under `resources/pipelines/index.json`.
- If a pipeline uses `project/...` actions, include `--repo-path <repo-root>` when running it.
- Keep the same `--executions-dir` across `run`, `resume`, `cancel`, and `summary` if you override it.
- `--stream` and `--silent` are mutually exclusive on `run` and `resume`.
- Explicit job keys and step IDs must match `[A-Za-z_][A-Za-z0-9_]*`.
- `working_directory` values must be relative and stay under the execution `cwd`.
- Dispatch inputs are declared under `on.dispatch.inputs`, and values are passed with repeatable `--input KEY=VALUE` flags, not `--env`.
- `plan_ready` inputs are declared under `on.plan_ready.inputs` and are collected in the app UI before the run starts.
- `task_ready` inputs are declared under `on.task_ready.inputs` and are collected by the higher-level caller that starts the run.
- CLI `--input` remains dispatch-only.
- Pipelines can have multiple simultaneous structured or formless checkpoints in `pending_pauses`. CLI `--input` changes pipeline inputs and does not answer checkpoints.
- Resume one checkpoint with `--job <physical-job-id> --step <step-id>` and repeatable `--answer KEY=VALUE`, or submit an atomic batch with `--pause-responses-json <json>`.
- Matrix executions are displayed as logical groups with ordered physical variants and their matrix values. Use the displayed physical ID whenever a command must identify one variant.
- The CLI can run, stream, summarize, resume, and cancel an entire matrix execution. Targeted matrix-variant retry/cancel controls are currently available in the desktop execution view, not as CLI subcommands.
- `run` and `resume` print a trailing `Report` section when the execution emits `{{BRAND_ENV_PREFIX}}_OUTPUT_REPORT` or `{{BRAND_ENV_PREFIX}}_OUTPUT_REPORT_JSON`.
- Child pipelines launched via `builtin/run-pipeline` share the same execution persistence model, but nested step output is still surfaced under the parent step stream.
- Pipelines can define `model_aliases` for agent steps. Supply run-time alias choices with `--model-alias-prefs-json` or `--model-alias-prefs-file`; raw `agent_model_*` IDs should be referenced through alias preferences or `model_aliases.defaults.agent_id`, not directly as `with.model`.
- Every `{{BRAND_CLI_NAME}} pipelines ...` command also supports `-h, --help`.
- CLI state defaults under `<brand-data-dir>`, where production runs use `~/{{BRAND_PROJECT_CONFIG_DIR}}` and dev-style runs (`tsx`, `{{BRAND_ENV_PREFIX}}_ENV=development`, or `NODE_ENV=development`) use `~/{{BRAND_PROJECT_CONFIG_DIR}}-dev`.

## `{{BRAND_CLI_NAME}} pipelines executions run`

Syntax:

```bash
{{BRAND_CLI_NAME}} pipelines executions run <pipeline-input> [options]
```

Use `run` only for fresh executions.

Flags:

- `--cwd <dir>`: working directory for step execution. Defaults to the current shell directory.
- `--repo-path <dir>`: repo root for resolving `project/...` actions.
- `--env <pair>`: repeatable `KEY=VALUE` environment overrides.
- `--input <pair>`: repeatable `KEY=VALUE` pipeline inputs. Keys must be declared under `on.dispatch.inputs`; it does not apply to `plan_ready` runs.
- `--executions-dir <dir>`: where execution state and logs are persisted.
- `--bundled-actions-dir <dir>`: override the bundled actions directory.
- `--execution-id <id>`: set the execution ID for a new run.
- `--silent`: suppress streamed per-job details and print only the execution header, final status line, and any final report section.
- `--stream`: print live job/step status updates and step stdout/stderr as the execution runs.
- `--inline`: treat `pipeline-input` as inline YAML/JSON.
- `--plugin-prefs-json <json>`: unsaved plugin collection preferences as JSON.
- `--plugin-prefs-file <path>`: path to plugin collection preferences JSON.
- `--save-plugin-defaults`: save plugin collection preferences as defaults for this file-backed or stored pipeline.
- `--model-alias-prefs-json <json>`: unsaved model alias preferences as JSON.
- `--model-alias-prefs-file <path>`: path to model alias preferences JSON.
- `--save-model-alias-defaults`: save model alias preferences as defaults for this file-backed or stored pipeline.

Behavior:

- `pipeline-input` is required.
- `--execution-id` matters only for new executions.
- The CLI prints an execution header line immediately when the run starts.
- By default, completed jobs are printed as they finish using the same detailed formatting as `{{BRAND_CLI_NAME}} pipelines executions summary`.
- `--stream` switches from buffered completed-job sections to live job/step status lines plus prefixed step stdout/stderr.
- If the execution pauses, paused jobs are printed before the final status line.
- If the execution has report outputs, the CLI prints the final status line and then a `Report` section containing report file paths plus readable text/JSON report contents.
- Use `--silent` to suppress job details while keeping the execution header, final status line, and any final report section.
- `--stream` cannot be combined with `--silent`.
- Pipeline-input validation is aggregated. A single startup error can include undeclared inputs, missing required inputs, invalid booleans/choices, and out-of-range numbers.
- `--plugin-prefs-json` and `--plugin-prefs-file` are mutually exclusive.
- `--model-alias-prefs-json` and `--model-alias-prefs-file` are mutually exclusive.
- `--save-plugin-defaults` and `--save-model-alias-defaults` require a stable pipeline preference locator. Inline pipelines cannot save defaults.
- Default execution-state location is `<brand-data-dir>/pipeline-executions`, which is typically `~/{{BRAND_PROJECT_CONFIG_DIR}}/pipeline-executions` in production and `~/{{BRAND_PROJECT_CONFIG_DIR}}-dev/pipeline-executions` in dev-style runs.

Model alias preference JSON:

```json
{
  "reviewer": {
    "mode": "inline",
    "base": "claude-sonnet-4-6",
    "instructions": "Review for regressions.",
    "plugin_collection_id": "review_tools"
  },
  "implementer": {
    "mode": "agent",
    "agent_id": "agent_model_code_reviewer"
  },
  "planner": {
    "mode": "reset"
  }
}
```

Preference rules:

- Keys are pipeline `model_aliases` ids.
- `mode: inline` supplies the true provider `base` model, optional instructions, and optional plugin collection.
- `mode: agent` points the alias at a local Agent model id. The app/runtime resolves that Agent to its base model, instructions, and plugin selections.
- `mode: reset` removes a saved local override and falls back to the YAML alias defaults. If the alias has no YAML defaults, the alias is still required before execution can run.
- If the alias supplies a plugin collection and the step also sets `with.plugin_collection_id`, the runtime uses the union.

Execution header line format:

```text
<execution-id> <pipeline-name>
```

Final status line format:

```text
<status>
```

When report outputs exist, the CLI then appends:

```text
Report
Report outputs:
  report_file=...
  report_json_file=...
```

Parsing notes:

- First line, first token: execution ID
- First line, remainder: pipeline name, which may contain spaces
- A standalone terminal-status line is always printed (`success`, `failure`, `paused`, or `cancelled`)
- Do not assume the last stdout line is the status; report sections may follow it

Exit codes:

- `0`: final status `success` or `paused`
- `1`: startup failure or final status `failure`
- `130`: cancelled, usually from `Ctrl+C`

Typical examples:

```bash
# Run a file-based pipeline
{{BRAND_CLI_NAME}} pipelines executions run deploy.yaml --cwd /path/to/project

# Run inline YAML
{{BRAND_CLI_NAME}} pipelines executions run 'name: Quick
on: dispatch
jobs:
  build:
    steps:
      - id: hi
        run: echo hello' --inline

# Run with environment overrides
{{BRAND_CLI_NAME}} pipelines executions run build.yaml --env NODE_ENV=production --env CI=true

# Run with declared pipeline inputs
{{BRAND_CLI_NAME}} pipelines executions run explain.yaml \
  --input topic="feature flags" \
  --input audience=engineers \
  --input max_words=80

# Run with model alias preferences
{{BRAND_CLI_NAME}} pipelines executions run review.yaml \
  --model-alias-prefs-json '{"reviewer":{"mode":"agent","agent_id":"agent_model_code_reviewer"}}'

# Save model alias defaults for a file-backed pipeline
{{BRAND_CLI_NAME}} pipelines executions run review.yaml \
  --model-alias-prefs-file ./review-models.json \
  --save-model-alias-defaults

# Run a report-emitting example and keep the final report section
{{BRAND_CLI_NAME}} pipelines executions run example-pipelines/reports-demo.yml --silent

# Stream live job/step updates plus stdout/stderr
{{BRAND_CLI_NAME}} pipelines executions run pipeline.yaml --stream

# Use project-local actions
{{BRAND_CLI_NAME}} pipelines executions run pipeline.yaml --repo-path /path/to/repo

# Keep only the execution header plus the final status/report footer
{{BRAND_CLI_NAME}} pipelines executions run pipeline.yaml --silent
```

## `{{BRAND_CLI_NAME}} pipelines executions resume`

Syntax:

```bash
{{BRAND_CLI_NAME}} pipelines executions resume <execution-id> [options]
```

Use `resume` for paused or interrupted executions.

Flags:

- `--cwd <dir>`: working directory for step execution. Defaults to the current shell directory.
- `--env <pair>`: repeatable `KEY=VALUE` environment overrides.
- `--input <pair>`: repeatable `KEY=VALUE` pipeline input overrides for pending work.
- `--repo-path <dir>`: repo root for resolving `project/...` actions.
- `--executions-dir <dir>`: where execution state and logs are persisted.
- `--bundled-actions-dir <dir>`: override the bundled actions directory.
- `--job <physical-job-id>`: select the job holding one pending checkpoint. A logical matrix ID is accepted only when it resolves to exactly one paused variant.
- `--step <step-id>`: narrow checkpoint selection to one step.
- `--answer <pair>`: repeatable `KEY=VALUE` answers for the selected structured checkpoint.
- `--pause-responses-json <json-array>`: atomically answer or resume several addressed checkpoints. Cannot be combined with `--job`, `--step`, or `--answer`.
- `--silent`: suppress streamed per-job details and print only the execution header, final status line, and any final report section.
- `--stream`: print live status updates and step output during resume.

Behavior:

- Stored pipeline inputs are reused unless overridden with `--input`.
- Completed work is not re-run. Resume continues from the next pending top-level step.
- Jobs that were already complete before resume are not reprinted, including when `--stream` is enabled.
- Resume-time `--input` flags affect pending work only. Previously completed work is not recomputed.
- Resume-time `--input` flags do not answer `builtin/request-input` checkpoint fields. Use `--job`, `--step`, and `--answer`, the JSON batch option, or the desktop Activity detail form.
- If a logical matrix job has more than one paused variant, `--job` must be the displayed physical variant ID so the checkpoint is unambiguous.
- If a pipeline wrote a bare `{{BRAND_ENV_PREFIX}}_PAUSE=true` without `{{BRAND_ENV_PREFIX}}_INPUT_REQUEST`, the pause is formless and CLI resume can continue it normally.
- `--stream` shows live status changes and step stdout/stderr for resumed work only.
- `--stream` cannot be combined with `--silent`.
- Paused executions exit `0` for the current invocation but remain incomplete until resumed again.
- If the resumed execution finishes with report outputs, the same trailing `Report` section is printed after the status line.

Example:

```bash
{{BRAND_CLI_NAME}} pipelines executions resume abc123-def456

# Resume one structured matrix checkpoint.
{{BRAND_CLI_NAME}} pipelines executions resume abc123-def456 \
  --job __matrix__review__0 \
  --step approval \
  --answer decision=approve

# Atomically resume two checkpoints. Omit answers for a formless pause.
{{BRAND_CLI_NAME}} pipelines executions resume abc123-def456 \
  --pause-responses-json '[{"job_id":"__matrix__review__0","step_id":"approval","answers":{"decision":"approve"}},{"job_id":"fixed_review","step_id":"pause"}]'
```

## `{{BRAND_CLI_NAME}} pipelines executions cancel`

Syntax:

```bash
{{BRAND_CLI_NAME}} pipelines executions cancel <execution-id> [--executions-dir <dir>]
```

Use `cancel` to terminate a paused execution immediately or request cancellation of a running execution.

Behavior:

- Paused executions are usually marked `cancelled` immediately and stdout prints `cancelled`.
- Running executions are cancelled via a persisted cancel request that the executor polls for.
- If cancellation has been requested but the execution still reports `running`, `pending`, or `paused`, the command still exits `0` and prints a stderr message explaining that termination should happen shortly.
- Exit `1` when the execution has already completed with `success` or `failure` before cancellation can take effect.

Example:

```bash
{{BRAND_CLI_NAME}} pipelines executions cancel abc123-def456
```

## `{{BRAND_CLI_NAME}} pipelines executions list`

Syntax:

```bash
{{BRAND_CLI_NAME}} pipelines executions list [--executions-dir <dir>] [--limit <n>] [--offset <n>]
```

Use `list` to page through persisted executions.

Behavior:

- Output is tab-delimited as `<execution-id>\t<status>\t<pipeline-name>`.
- Results are sorted by `started_at` descending.
- `--offset` skips that many newest executions before printing.
- `--limit` caps how many rows are printed after offset.

Example:

```bash
{{BRAND_CLI_NAME}} pipelines executions list
{{BRAND_CLI_NAME}} pipelines executions list --limit 20 --offset 40
```

## `{{BRAND_CLI_NAME}} pipelines executions summary`

Syntax:

```bash
{{BRAND_CLI_NAME}} pipelines executions summary <execution-id> [--executions-dir <dir>]
```

Use `summary` to read the persisted execution state and associated step logs.

Behavior:

- Exit `0` when the execution is found.
- Exit `1` when the execution cannot be found or read.
- The output is human-readable, not a stable machine format.
- Status symbols are `✔` for success, `✘` for failure, `⊘` for cancelled/skipped, and `…` for pending/running/paused.
- The header includes an `Inputs:` section when the execution persisted resolved pipeline inputs.
- The header includes a `Report outputs:` section when the execution persisted final report metadata.

Example:

```bash
{{BRAND_CLI_NAME}} pipelines executions summary abc123-def456
{{BRAND_CLI_NAME}} pipelines executions summary abc123-def456 --executions-dir {{BRAND_PROJECT_CONFIG_DIR}}/executions
```

Use the same `--executions-dir` that was used for `run` or `resume`.

## Matrix execution output

The CLI accepts the same GitHub-style `strategy.matrix` pipeline schema as the
desktop runtime. Pipeline YAML may use static axes, `include`, `exclude`,
`strategy.max_parallel`, `strategy.fail_fast`, and whole or field-level dynamic
matrices. Use `{{BRAND_CLI_NAME}} pipelines validate <pipeline-input>` to catch
schema errors before execution. Authored top-level `foreach` and
`max_parallel` fields are rejected; concurrency belongs under `strategy`.

Run the bundled repository example with streaming enabled:

```bash
{{BRAND_CLI_NAME}} pipelines executions run example-pipelines/matrix-demo.yml --stream
```

`run`, `resume`, and `summary` render one `Matrix:` heading for each logical
job and an indented row for every physical variant. Variant rows include the
physical job ID, serialized matrix values, status, step output, and logs. A
dynamic expansion error appears on the logical group and has no partial
variant rows. An empty matrix shows a zero-variant skipped group.

The execution-wide limit is 256 newly generated variants across all matrix
groups. `max_parallel` limits active variants within one group; other groups
and ordinary jobs can continue independently. Paused variants release their
slot. `fail_fast` cancellation is confined to sibling variants in that group.

Downstream YAML continues to name the logical job in `needs`. It can read the
matrix-index-ordered aggregate through `needs.<job>.outputs` and the lossless
variant array through `needs.<job>.children`. The generated physical IDs are
runtime locators for logs, pauses, and desktop controls; do not put them in
authored `needs` declarations.

When a matrix variant pauses, execution output adds a `Pending pauses:` entry
with its physical job ID, step, matrix values, title, and whether fields are
required. Select one with `--job` and `--step`, or submit multiple checkpoints
with `--pause-responses-json`. The batch is atomic: one stale or invalid entry
rejects all responses. The CLI does not currently expose targeted retry or
cancel commands for individual matrix variants; use the desktop execution
view for those operations.

## Retry output in CLI

When a job has `max_retries` configured, the streamed run output and `summary` output include retry information:

- **Retry summary line** appears after the job header: `Retries: <used>/<max> used`. This line only appears when `max_retries > 0` or the job actually retried.
- **Failed attempt sections** appear before the final attempt's steps, labeled `Failed Attempt 1`, `Failed Attempt 2`, etc. (1-indexed). Each shows the step results from that failed attempt.
- **Final attempt section** appears after all failed attempts, labeled `Final Attempt`.
- **Streamed run output** only prints a job once its final result is known. Intermediate failed attempts that will retry are not printed as standalone completed jobs.
- **Log files** are separated per attempt. The first attempt uses `<job-id>--<step-id>.log`; retries use `<job-id>--<step-id>--attempt<N>.log`, where `N` starts at `1` for the first retry.

Example inspect output for a job that failed once and succeeded on retry:

```text
─── Job: Build (build) ✔ success 12s ───
  Retries: 1/2 used
  Failed Attempt 1
    ✘ Compile (failure, 3s)
      Build failed due to network error
  Final Attempt
  ✔ Compile (success, 4s)
    Build complete!
```

The first line (`<execution-id> <pipeline-name>`) and standalone status line (`<status>`) are unchanged regardless of retries, although a trailing `Report` section may still follow the status line.

## Iteration output in CLI

When a job has `max_iterations` configured or a job restart actually occurred, the streamed run output and `summary` output include:

- `Iterations: <current>/<max>`

Interpretation:

- `max_iterations` is the max total pass count for the job
- omitting `max_iterations` means a normal one-pass job
- `max_iterations: 0` skips the job
- iteration output shows the current 1-based pass number
- `{{BRAND_ENV_PREFIX}}_JOB_RESTART` consumes the remaining pass budget
- retries count actual failure/retry attempts
- a job can use iterations without retries, retries without iterations, or both

## `{{BRAND_CLI_NAME}} pipelines list`

Syntax:

```bash
{{BRAND_CLI_NAME}} pipelines list
```

Use `list` to inspect the stored pipeline catalog without opening files directly.

Behavior:

- Output is tab-delimited as `<pipeline-id>\t<pipeline-name>\t<description>`.
- The result includes both bundled pipelines and user pipelines.
- Exit `0` on success and `1` on failure.

Example:

```bash
{{BRAND_CLI_NAME}} pipelines list
```

## Pipeline Store Commands

These commands operate on pipeline definitions or the standard user pipeline store.

Default user store path:

- `<brand-data-dir>/pipelines`
- In practice this is usually `~/{{BRAND_PROJECT_CONFIG_DIR}}/pipelines` in production and `~/{{BRAND_PROJECT_CONFIG_DIR}}-dev/pipelines` in dev-style runs

Command outputs:

- `{{BRAND_CLI_NAME}} pipelines list`
  Success stdout: tab-delimited `<pipeline-id>\t<pipeline-name>\t<description>`
- `{{BRAND_CLI_NAME}} pipelines validate <pipeline-input> [--inline]`
  Success stdout: `Pipeline is valid`
- `{{BRAND_CLI_NAME}} pipelines register <pipeline-input> [--inline]`
  Success stdout: `<pipeline-id> <absolute-path>`
  Parse the first token as the pipeline ID and the remainder as the stored path.
- `{{BRAND_CLI_NAME}} pipelines get <pipeline-id>`
  Success stdout: raw pipeline text
- `{{BRAND_CLI_NAME}} pipelines get-path <pipeline-id>`
  Success stdout: absolute file path
- `{{BRAND_CLI_NAME}} pipelines update <pipeline-id> <pipeline-input> [--inline]`
  Success stdout: `<pipeline-id>`
- `{{BRAND_CLI_NAME}} pipelines delete <pipeline-id>`
  Success stdout: `<pipeline-id>`

Store rules:

- `list`, `get`, and `get-path` work for both bundled and user pipelines.
- `update` and `delete` work only for user pipelines.
- `register` creates a new user pipeline ID and writes the pipeline into the user store.
- All of these commands exit `0` on success and `1` on failure.

Examples:

```bash
# Validate before running or registering
{{BRAND_CLI_NAME}} pipelines validate pipeline.yaml

# List bundled and user pipelines
{{BRAND_CLI_NAME}} pipelines list

# Register a pipeline so it appears in the UI
{{BRAND_CLI_NAME}} pipelines register pipeline.yaml

# Read it back
{{BRAND_CLI_NAME}} pipelines get my-pipeline-id
{{BRAND_CLI_NAME}} pipelines get-path my-pipeline-id

# Update it
{{BRAND_CLI_NAME}} pipelines update my-pipeline-id updated.yaml

# Delete it
{{BRAND_CLI_NAME}} pipelines delete my-pipeline-id
```

## Recommended Workflow

Use this order unless the user asks for something else:

1. If the pipeline definition changed, run `{{BRAND_CLI_NAME}} pipelines validate ...` first.
2. If the goal is execution, run `{{BRAND_CLI_NAME}} pipelines executions run ...`.
3. Capture the execution ID from the first token on the first stdout line.
4. If the run fails or the user wants details, run `{{BRAND_CLI_NAME}} pipelines executions summary <execution-id> ...`.
5. If the run pauses at `builtin/request-input`, use `--job`, `--step`, and repeatable `--answer`, submit an atomic `--pause-responses-json` batch, or tell the user to answer it in the desktop Activity detail modal. Do not use `--input` for checkpoint fields.
6. If the task is about the saved pipeline catalog, use `register`, `get`, `get-path`, `update`, or `delete` instead of editing store files directly.

## Common Failure Cases

- `--env` without `=` is invalid and fails immediately.
- `--input` without `=` is invalid and fails immediately.
- `project/...` actions fail at runtime without `--repo-path`.
- Missing actions are runtime failures unless the step sets `skip_on_missing_action: true`.
- `update` and `delete` fail for bundled pipeline IDs.
- `summary` fails if you point at the wrong execution directory.
- Validation errors for duplicate step IDs, invalid identifiers, bad dependencies, illegal `working_directory` values, undeclared inputs, missing required inputs, or invalid input values surface on stderr and exit `1`.
