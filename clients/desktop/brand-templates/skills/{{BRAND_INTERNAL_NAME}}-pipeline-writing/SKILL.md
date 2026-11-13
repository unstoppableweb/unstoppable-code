---
name: {{BRAND_INTERNAL_NAME}}-pipeline-writing
description: Teaches Claude how to write and edit {{BRAND_DISPLAY_NAME}} pipeline YAML files
---

# {{BRAND_DISPLAY_NAME}} Pipeline Writing

This skill covers how to write and edit {{BRAND_DISPLAY_NAME}} pipeline YAML files and action manifests.

{{BRAND_DISPLAY_NAME}} pipelines follow GitHub Actions conventions: a pipeline contains **jobs** arranged in a dependency graph, and each job contains sequential **steps** that either run inline scripts or invoke reusable **actions**.

Important runtime and authoring rules:

- jobs can use `max_iterations` for non-failure loops
- `{{BRAND_ENV_PREFIX}}_PAUSE`, `{{BRAND_ENV_PREFIX}}_INPUT_REQUEST`, `{{BRAND_ENV_PREFIX}}_JOB_RESTART`, `{{BRAND_ENV_PREFIX}}_OUTPUT_REPORT`, and `{{BRAND_ENV_PREFIX}}_OUTPUT_REPORT_JSON` are reserved executor outputs
- `{{BRAND_ENV_PREFIX}}_NOTIFICATION` is reserved for desktop OS notifications emitted by `builtin/notify`
- every step and action receives `{{BRAND_ENV_PREFIX}}_OUTPUT_DIR`, the required home for artifacts that must survive into later steps, retries, or resume
- actions can use `runs.using: pipeline` for nested child execution
- `plugin_collections` can define portable `skill`, `claude_plugin`, and `codex_plugin` defaults for `builtin/agent-prompt` and `builtin/agent-resume`
- `model_aliases` can define named model slots for `builtin/agent-prompt` and `builtin/agent-resume`; use aliases for Agent-backed pipeline models instead of raw `agent_model_*` values in `with.model`
- `log_format_hint: agent` is supported on action manifests and `uses` steps, but not on inline `run` steps
- `assets` declare folders of files a pipeline reads, and `local_state` lists per-runner paths that never travel with a share; declare assets on the entry pipeline, not on child pipelines
- inspect a bundled action's `action.yml` manifest when you need its exact inputs and outputs

## File Locations

### Pipelines

| Scope       | Location                                              | Description                                |
| ----------- | ----------------------------------------------------- | ------------------------------------------ |
| User (prod) | `~/{{BRAND_PROJECT_CONFIG_DIR}}/pipelines/*.yaml`     | User-created pipelines in production       |
| User (dev)  | `~/{{BRAND_PROJECT_CONFIG_DIR}}-dev/pipelines/*.yaml` | User-created pipelines in development mode |

Bundled pipelines are shipped read-only. Use `{{BRAND_CLI_NAME}} pipelines list` to discover them and `{{BRAND_CLI_NAME}} pipelines get <pipeline-id>` to read one.

### Actions

| Scope   | Location                                                        | Referenced as    |
| ------- | --------------------------------------------------------------- | ---------------- |
| Builtin | Shipped read-only with {{BRAND_DISPLAY_NAME}}                   | `builtin/<name>` |
| Project | `<repo>/{{BRAND_PROJECT_CONFIG_DIR}}/actions/<name>/action.yml` | `project/<name>` |

Each action lives in its own directory containing an `action.yml` manifest and its runtime files (scripts).

## Pipeline YAML Schema

Pipeline documents may either be a raw pipeline object or a document wrapped in a top-level `pipeline:` key. Stored pipelines are typically written in wrapped form.

```yaml
pipeline:
  name: My Pipeline # required — display name
  version: '3.0' # schema version
  description: What it does # optional
  icon: '🔧' # optional emoji
  readonly: false # optional — prevents editing in UI
  scope: directory # optional — global | directory | worktree; omitted means directory
  on: # required — trigger type(s)
    dispatch:
      inputs:
        topic:
          type: string
          required: true
        max_words:
          type: number
          min: 20
          max: 200
          default: 80
        generated_context_file:
          type: string
          required: false
          hint-hide-ui-option: true

  env: # optional — env vars available to all jobs
    APP_NAME: my-app

  model_aliases: # optional — named model slots for agent steps
    - id: reviewer
      name: Reviewer
      defaults:
        base: claude-sonnet-4-6
        instructions: Focus on correctness and regression risk.
    - id: local_reviewer
      name: Local reviewer Agent
      defaults:
        agent_id: agent_model_code_reviewer

  defaults: # optional — default settings for run steps
    run:
      shell: bash # bash | sh | pwsh | powershell | cmd | python | node | tsx
      # If shell is omitted, {{BRAND_DISPLAY_NAME}} defaults to bash on macOS/Linux and powershell on Windows.
      # For portable pipelines, prefer node or tsx steps when possible.
      working_directory: src # must be relative

  jobs: # required — map of job ID → job definition
    build: { ... }
    test: { ... }
```

### Pipeline fields

| Field                            | Type             | Required | Description                                                                                                                                                                               |
| -------------------------------- | ---------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                           | string           | yes      | Display name                                                                                                                                                                              |
| `version`                        | string           | no       | Schema version (currently `"3.0"`)                                                                                                                                                        |
| `description`                    | string           | no       | Human-readable description                                                                                                                                                                |
| `icon`                           | string           | no       | Emoji icon                                                                                                                                                                                |
| `readonly`                       | boolean          | no       | Prevents editing in the UI                                                                                                                                                                |
| `scope`                          | string or array  | no       | Execution scope(s): `global`, `directory`, or `worktree`. Omitted means `directory`. `chat-project` is not supported. A worktree execution can run directory-scoped pipelines.            |
| `on`                             | string or object | yes      | Trigger type(s): `'dispatch'`, `'plan_ready'`, `'task_ready'`, or object form. Trigger-scoped inputs live under `on.dispatch.inputs`, `on.plan_ready.inputs`, and `on.task_ready.inputs`. |
| `env`                            | map              | no       | Pipeline-level environment variables                                                                                                                                                      |
| `defaults.run.shell`             | ShellType        | no       | Default shell for `run` steps                                                                                                                                                             |
| `defaults.run.working_directory` | string           | no       | Default working directory                                                                                                                                                                 |
| `plugin_collections`             | array            | no       | Portable skill/plugin defaults that agent steps can opt into with `with.plugin_collection_id`                                                                                             |
| `model_aliases`                  | array            | no       | Named model slots that agent steps can use with `with.model`; supports inline `base`/`instructions`/`plugin_collection_id` or Agent-backed `agent_id` defaults                            |
| `assets`                         | array            | no       | Folders of files the pipeline reads at run time, read as `${{ assets.<id>.path }}`. See [Assets and local state](#assets-and-local-state)                                                 |
| `local_state`                    | array            | no       | Per-runner paths (databases, caches, checkouts) that must never travel with a share                                                                                                       |
| `sandbox.vcpus`                  | number           | no       | Cloud runs only: 1, 2, 4 or 8 vCPUs (2 GiB of memory each). Raises the run's default sandbox; desktop ignores it                                                                          |
| `jobs`                           | map              | yes      | Job definitions keyed by ID                                                                                                                                                               |

Set `hint-hide-ui-option: true` on a trigger input to hide it from UI input pickers when the input is optional or has a default.

### Plugin collections

Pipeline YAML may declare portable plugin defaults:

```yaml
plugin_collections:
  - id: review_tools
    name: Review tools
    description: Optional review-time helpers
    defaults:
      - type: skill
        source: { type: builtin, id: app }
        skill_name: {{BRAND_INTERNAL_NAME}}-config
        required: true
      - type: skill
        source: { type: github, repo: org/skills }
        skill_name: code-review
      - type: claude_plugin
        marketplace: { type: github, repo: org/claude-plugins }
        plugin_name: browser
      - type: codex_plugin
        marketplace:
          type: codex-builtin
          id: openai-curated
        plugin_name: codex-security
        required: true
```

Use the collection from an agent step:

```yaml
steps:
  - id: review
    uses: builtin/agent-prompt
    with:
      plugin_collection_id: review_tools
      permission_preset: dangerous_all
      prompt: Review this worktree.
```

Rules:

- YAML defaults may contain only `skill`, `claude_plugin`, and `codex_plugin` refs. Bundles are local-only extras and must not appear in pipeline YAML.
- `codex_plugin` is for Codex-native plugins reported by Codex-only marketplaces. Its `marketplace.type` must be `codex-builtin`, and `marketplace.id` is the Codex marketplace id, such as `openai-curated`.
- When a Codex agent step receives a `claude_plugin` default and the same marketplace/plugin name also has a paired Codex-native plugin, the pipeline runtime uses the Codex-native plugin instead of the Claude-compatible plugin.
- `required` defaults to `false`. Unmatched required defaults block execution before any job starts.
- Default keys must be unique inside a collection, and collection ids must be unique inside the pipeline.
- Local saved defaults may disable optional defaults and add local bundles, skills, or plugins. MCP server refs are ignored for this feature.
- This feature does not add MCP runtime behavior. If a selected local bundle contains MCP servers, those entries are filtered out before materialization; MCP-only bundles produce a warning.
- `builtin/agent-prompt` and `builtin/agent-resume` default to `permission_preset: none`, which disables Claude Code's built-in tool surface. Use `permission_preset: dangerous_all` when a plugin-collection step should behave like a normal chat session for Claude skill/plugin discovery.
- Resume and retry keep the plugin preference snapshot persisted with the execution. Rerun reuses the original first-run snapshot instead of reading current saved defaults again.

### Model aliases

Pipeline YAML may declare named model slots. Agent steps can then set `with.model` to the alias id instead of hard-coding a provider model or local Agent id.

```yaml
plugin_collections:
  - id: review_tools
    name: Review tools
    defaults:
      - type: skill
        source: { type: builtin, id: app }
        skill_name: {{BRAND_INTERNAL_NAME}}-config

model_aliases:
  - id: reviewer
    name: Reviewer
    description: Model used for code review steps
    defaults:
      base: claude-sonnet-4-6
      instructions: Review for correctness and regression risk.
      plugin_collection_id: review_tools
  - id: implementation_agent
    name: Implementation Agent
    defaults:
      agent_id: agent_model_code_reviewer
  - id: required_at_run_time
    name: Required run-time model

jobs:
  review:
    steps:
      - id: review
        uses: builtin/agent-prompt
        with:
          model: reviewer
          plugin_collection_id: extra_tools
          prompt: Review this worktree.
```

Rules:

- `model_aliases` is an array of named objects aligned with `plugin_collections`: each entry has `id`, `name`, optional `description`, and optional `defaults`.
- `defaults` has exactly one mode. Inline defaults use `base`, optional `instructions`, and optional `plugin_collection_id`. Agent-backed defaults use `agent_id: agent_model_*`.
- Omit `defaults` when the alias must be supplied by the app UI, automation setup, or CLI preferences before execution.
- `with.model` may be a provider model or a model alias id. Raw `agent_model_*` IDs are not resolved directly in pipeline steps; define a `model_aliases` entry with `defaults.agent_id` and use the alias id.
- If an alias contributes `plugin_collection_id` and the step also sets `with.plugin_collection_id`, the runtime unions both plugin collections.
- For builtin action processes, alias resolution rewrites `INPUT_MODEL` to the true provider/base model and appends alias or Agent instructions into `INPUT_SYSTEM_PROMPT`.
- Alias-backed action processes also receive `{{BRAND_ENV_PREFIX}}_PIPELINE_SELECTED_MODEL`, `{{BRAND_ENV_PREFIX}}_PIPELINE_RUNTIME_MODEL`, `{{BRAND_ENV_PREFIX}}_PIPELINE_MODEL_ALIAS`, and, when applicable, comma-separated `{{BRAND_ENV_PREFIX}}_PIPELINE_MODEL_ALIAS_PLUGIN_COLLECTION_IDS`.
- The app exposes model aliases as first-class run configuration, like plugin collections, so users can customize each alias before dispatch or automation setup.
- CLI runs can provide alias preferences with `--model-alias-prefs-json <json>` or `--model-alias-prefs-file <path>`. Use `--save-model-alias-defaults` to save those preferences for a file-backed pipeline.
- CLI preference entries are keyed by alias id and use `mode: inline`, `mode: agent`, or `mode: reset`. `reset` removes a saved override and falls back to YAML defaults.

### Assets and local state

Use `assets` for files a pipeline reads at run time, such as configs or prompts, and `local_state` for per-runner state that must stay on this machine:

```yaml
assets:
  - id: specialists
    path: ~/journeys/specialists
    description: Specialist configs
    required: true
    install: seed
local_state:
  - ~/journeys/state.db
  - ~/journeys/checkout

jobs:
  run:
    steps:
      - id: list
        run: ls "${{ assets.specialists.path }}"
      - id: remember
        run: date >> "${{ {{BRAND_EXPRESSION_ROOT}}.pipeline_data_dir }}/runs.log"
```

Rules:

- `id` starts with a lower-case letter and uses at most 32 lower-case letters, numbers, or underscores. Ids are unique in the pipeline.
- `path` is the folder on the author's machine: an absolute path, or one starting with `~`. It must be inside the home folder to be shared.
- `required` defaults to `true`. `install` defaults to `seed`, which adds only files the recipient doesn't have; `replace` overwrites them on every install.
- `local_state` entries are paths that must never be shared. An asset folder can't overlap a `local_state` entry.
- Declare assets on the entry pipeline, the one an automation or the user starts. Child pipelines started with `builtin/run-pipeline` read the root run's assets and data folder; a child's own `assets` are not resolved, and sharing blocks them.
- Assets travel only when the automation that runs the pipeline is shared, and only with a team or organization. Sharing the pipeline by itself is blocked while it declares `assets`.

What a run sees:

| Expression                                           | Environment variable                     | Value                                                               |
| ---------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------- |
| `${{ assets.<id>.path }}`                            | `{{BRAND_ENV_PREFIX}}_ASSET_<ID>`        | The asset's folder, or an empty string for a missing optional asset |
| `${{ {{BRAND_EXPRESSION_ROOT}}.pipeline_data_dir }}` | `{{BRAND_ENV_PREFIX}}_PIPELINE_DATA_DIR` | A folder the pipeline keeps across runs, for its own state          |
| (none)                                               | `{{BRAND_ENV_PREFIX}}_ASSETS_DIR`        | The folder installed assets live in, when the pipeline has any      |

`<ID>` is the asset id in upper case. Before the first step, an asset resolves to its installed copy when a share installed one, otherwise to its declared `path` when that folder exists. A missing required asset stops the run before any step and names the asset. A saved pipeline's data folder is `pipeline-data/<pipeline id>/state` in the app data folder (`~/{{BRAND_PROJECT_CONFIG_DIR}}/pipeline-data/` in production), and it is kept when the pipeline is deleted. Inline pipelines get no data folder. The CLI doesn't resolve assets or a data folder.

### Triggers (`on` field)

The `on` field declares which events can start the pipeline.

| Trigger      | Description                                                     |
| ------------ | --------------------------------------------------------------- |
| `dispatch`   | Manually triggered via the UI or API (default)                  |
| `plan_ready` | Triggered when an agent plan is ready to run through a pipeline |
| `task_ready` | Triggered when a task definition is ready to be planned         |

**String shorthand** — single trigger with no configuration:

```yaml
on: dispatch
on: plan_ready
on: task_ready
```

**Object form** — one or more triggers, with optional configuration:

```yaml
on:
  dispatch:
    inputs:
      topic:
        type: string
        required: true
  plan_ready:
    inputs:
      max_iterations:
        type: number
        default: 2
        min: 1
        max: 10
  task_ready:
    inputs:
      audience:
        type: choice
        options: [engineer, designer, pm]
        default: engineer
```

Dispatch inputs are declared under `on.dispatch.inputs`. Plan-ready inputs are declared under `on.plan_ready.inputs`. Task-ready inputs are declared under `on.task_ready.inputs`. Top-level `inputs` is no longer supported.

#### `plan_ready` trigger

When a Claude agent produces a plan and the user clicks "Pipeline" in the plan approval bar, {{BRAND_DISPLAY_NAME}} lists all pipelines with a `plan_ready` trigger. The selected pipeline receives the plan via `{{BRAND_EXPRESSION_ROOT}}.event` expressions (see below). If `on.plan_ready.inputs` is configured, the app prompts for those values before execution and exposes them through `${{ inputs.* }}` and `INPUT_*`.

#### `task_ready` trigger

`task_ready` pipelines are for turning a task definition into a plan. They receive:

- `{{BRAND_EXPRESSION_ROOT}}.event.task_ready.task_path`: the source task definition file
- `{{BRAND_EXPRESSION_ROOT}}.event.task_ready.plan_path`: a durable execution-scoped file path reserved for the generated plan

Unlike `plan_ready`, the reserved `task_ready.plan_path` file may not exist yet. Pipelines should write the generated plan there when they want downstream UI and follow-up flows to treat the run as plan-producing.

### Pipeline input definition

```yaml
on:
  dispatch:
    inputs:
      topic:
        description: Topic to explain
        type: string
        required: true
      audience:
        type: choice
        options: [beginners, engineers, executives]
        default: engineers
      max_words:
        type: number
        min: 20
        max: 200
        default: 80
  plan_ready:
    inputs:
      max_iterations:
        description: Maximum number of refine passes before stopping
        type: number
        default: 2
        min: 1
        max: 10
```

| Field         | Type                                            | Required    | Description                                                        |
| ------------- | ----------------------------------------------- | ----------- | ------------------------------------------------------------------ |
| `description` | string                                          | no          | Human-readable help text                                           |
| `type`        | `string \| number \| boolean \| choice \| json` | no          | Defaults to `string`; `json` preserves JSON-safe structured values |
| `required`    | boolean                                         | no          | Fails execution when omitted and no default exists                 |
| `default`     | scalar or JSON-safe value                       | no          | Default value used when the caller omits the input                 |
| `options`     | string[]                                        | choice only | Allowed values for `choice` inputs                                 |
| `min`         | number                                          | number only | Inclusive lower bound for numeric inputs                           |
| `max`         | number                                          | number only | Inclusive upper bound for numeric inputs                           |

Rules:

- Input names must match `/^[a-zA-Z_][a-zA-Z0-9_]*$/`.
- `choice` inputs must declare a non-empty `options` array.
- `min` / `max` are valid only on `number` inputs.
- `json` inputs accept JSON-safe plain objects, arrays, scalars, and `null`. Structured values are JSON-stringified when projected into `INPUT_*`, `env`, or `with`.
- Runtime validation is aggregated, so missing required inputs and invalid values are reported together.

### Job fields

```yaml
jobs:
  test:
    name: Run Tests
    needs: build # or needs: [build, lint]
    if: needs.build.result == 'success'
    timeout_minutes: 30
    continue_on_error: false
    env:
      NODE_ENV: test
    defaults:
      run:
        shell: bash
    outputs:
      coverage: ${{ steps.cov.outputs.percent }}
    steps:
      - ...
```

| Field               | Type                   | Required | Description                                                                                                                |
| ------------------- | ---------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `name`              | string                 | no       | Display name                                                                                                               |
| `needs`             | string or string[]     | no       | Job IDs that must complete first                                                                                           |
| `if`                | string                 | no       | Expression — skips job when false                                                                                          |
| `env`               | map                    | no       | Job-level environment variables                                                                                            |
| `defaults`          | object                 | no       | Default `run` settings for steps                                                                                           |
| `outputs`           | map                    | no       | Values exposed to downstream jobs (supports `${{ }}`)                                                                      |
| `timeout_minutes`   | number                 | no       | Max execution time (default: 360)                                                                                          |
| `continue_on_error` | boolean or expression  | no       | Downstream jobs treat this as successful even if it fails                                                                  |
| `max_retries`       | number                 | no       | Retry attempts after initial failure (0–50, default: 0)                                                                    |
| `max_iterations`    | number                 | no       | Max total passes for logical job loops; omit for a normal one-pass job, set `0` to skip, or set `1-50` to cap total passes |
| `strategy`          | matrix strategy object | no       | Expand this logical job into physical variants                                                                             |
| `steps`             | Step[]                 | yes      | Ordered list of steps                                                                                                      |

### Matrix jobs

Use `strategy.matrix` when a job must run independently for combinations of
one or more axes:

```yaml
jobs:
  process:
    strategy:
      matrix:
        os: [macos, windows]
        provider: [claude, codex]
        exclude:
          - os: windows
            provider: claude
        include:
          - os: linux
            provider: codex
            experimental: true
      max_parallel: 2
      fail_fast: false
    name: ${{ matrix.os }} / ${{ matrix.provider }}
    steps:
      - id: emit
        env:
          TARGET_JSON: ${{ toJson(matrix) }}
        run: echo "target=$TARGET_JSON" >> "${{BRAND_ENV_PREFIX}}_OUTPUT"
```

- Expansion order is Cartesian product in axis declaration order, partial-match `exclude`, then ordered `include`. An include entry decorates compatible base combinations or creates an additional variant when none are compatible. An include-only matrix creates one variant per entry. Duplicate combinations remain distinct and ordered; an empty axis, empty matrix, or fully excluded matrix produces a skipped group with zero variants.
- Matrix values may be any JSON-safe value. Axis names must match `[A-Za-z_][A-Za-z0-9_]*`. Authored job IDs cannot begin with the reserved `__matrix__` prefix. An execution may generate at most 256 matrix variants across all groups.
- Every variant exposes `matrix.<axis>`. Use `toJson()` for an object or array in a string; structured values are not implicitly JSON encoded.
- `max_parallel` is a static integer from 1 through 256. A paused variant releases its slot.
- `fail_fast` is a static boolean and defaults to `true`; it cancels only nonterminal variants of that matrix job.
- Job names, conditions, environment, `continue_on_error`, `max_iterations`, steps, and job outputs resolve per variant. For example, `continue_on_error: ${{ matrix.experimental == true }}` tolerates only marked variants.
- The whole matrix or individual axes/include/exclude lists may be complete expressions. Use `parseJson()` when a dependency output contains JSON text. Dynamic expansion validates atomically, so invalid JSON, wrong types, or the 256-variant cap create no partial variants.
- A downstream job waits for the complete logical group. `needs.<job>.outputs` merges outputs in variant order, while `needs.<job>.children` contains every ordered variant record.
- Variants share one checkout and execution output directory. Include stable matrix values or the physical job ID in artifact paths, or explicitly coordinate shared-file writes to avoid races.
- Multiple fixed jobs or matrix variants may request input simultaneously. Resume checkpoints individually or as an atomic batch.
- Do not author the removed top-level `foreach` or `max_parallel` fields. Put fan-out, concurrency, and fail-fast behavior under `strategy`.

Dynamic whole-matrix example:

```yaml
jobs:
  prepare:
    outputs:
      matrix: ${{ steps.emit.outputs.matrix }}
    steps:
      - id: emit
        run: echo 'matrix={"target":["one","two"]}' >> "${{BRAND_ENV_PREFIX}}_OUTPUT"

  process:
    needs: prepare
    strategy:
      matrix: ${{ parseJson(needs.prepare.outputs.matrix) }}
      max_parallel: 2
```

Static and dynamic fields can be mixed:

```yaml
strategy:
  matrix:
    os: [macos, windows]
    runtime: ${{ parseJson(needs.prepare.outputs.runtimes) }}
    include: ${{ parseJson(needs.prepare.outputs.extra_variants) }}
    exclude: ${{ parseJson(needs.prepare.outputs.excluded_variants) }}
```

Each dynamic field must be one complete expression. The whole matrix must
resolve to an object, axes to arrays, and `include`/`exclude` to arrays of
objects. A successful expansion is persisted once. Retrying materialized
variants reuses those values; only an explicit expansion retry reevaluates a
failed dynamic matrix.

The ordered `children` projection is lossless and is suitable for aggregation:

```yaml
jobs:
  summarize:
    needs: process
    env:
      MERGED_RESULT: ${{ needs.process.outputs.result }}
      VARIANTS_JSON: ${{ toJson(needs.process.children) }}
```

Each child record contains `job_id`, `matrix`, `status`, `result`,
`conclusion`, `outcome`, and `outputs`. Duplicate aggregate output keys use the
later matrix index. The desktop execution view can cancel an active physical
variant and can retry all, failed/cancelled, or selected variants—or retry a
failed expansion—once the relevant execution and group are terminal.

### Step fields

Each step must have exactly **one** of `run` (inline script) or `uses` (action reference).

| Field                    | Type      | Required | Description                                                                               |
| ------------------------ | --------- | -------- | ----------------------------------------------------------------------------------------- |
| `id`                     | string    | no       | Unique ID within the job (auto-generated if omitted)                                      |
| `name`                   | string    | no       | Display name                                                                              |
| `run`                    | string    | no       | Inline script to execute                                                                  |
| `uses`                   | string    | no       | Action reference: `builtin/<name>` or `project/<name>`                                    |
| `log_format_hint`        | string    | no       | `uses` steps only; currently only `agent` is supported                                    |
| `shell`                  | ShellType | no       | Shell for `run` steps: `bash`, `sh`, `pwsh`, `powershell`, `cmd`, `python`, `node`, `tsx` |
| `with`                   | map       | no       | Input parameters passed to the action                                                     |
| `env`                    | map       | no       | Step-level environment variables                                                          |
| `if`                     | string    | no       | Conditional expression                                                                    |
| `working_directory`      | string    | no       | Working directory (must be relative)                                                      |
| `timeout_minutes`        | number    | no       | Step timeout (default: 360)                                                               |
| `continue_on_error`      | boolean   | no       | Job continues even if this step fails                                                     |
| `skip_on_missing_action` | boolean   | no       | Silently skip if action doesn't exist                                                     |

### Validation rules

- **Job keys and step IDs** must match `/^[a-zA-Z_][a-zA-Z0-9_]*$/` (valid identifiers for expressions).
- **Working directories** must be relative paths.
- Each step must have exactly **one** of `run` or `uses`, not both.
- `log_format_hint` is only valid on `uses` steps, and the only supported value today is `agent`.
- Job dependencies (`needs`) must not form cycles.

## Action YAML Schema

An action is defined by an `action.yml` file in the action's directory.

```yaml
name: My Action # required — display name
description: What it does # optional
log_format_hint: agent # optional — currently only supported value
inputs:
  depth:
    description: How deep to scan
    required: false
    default: 2
outputs:
  file_count:
    description: Number of files found
runs:
  using: node # node | python | tsx | composite | pipeline
  main: index.js # entry point (not used for composite or pipeline)
```

### Supported runtimes

| Runtime         | `using` value | Entry point | Description                                                 |
| --------------- | ------------- | ----------- | ----------------------------------------------------------- |
| Node.js         | `node`        | `.js` file  | Runs with Node.js                                           |
| Python          | `python`      | `.py` file  | Runs with `python3`                                         |
| TypeScript      | `tsx`         | `.ts` file  | Runs directly via `tsx` and is useful for project actions   |
| Composite       | `composite`   | N/A         | Inline pipeline steps                                       |
| Nested Pipeline | `pipeline`    | N/A         | Executes a child pipeline via `builtin/run-pipeline`        |
| Host            | `host`        | N/A         | Performed by the desktop app; see [Host steps](#host-steps) |

### Composite actions

Composite actions contain nested steps instead of a script entry point:

```yaml
name: Multi-step Task
description: A composite action with multiple steps
inputs:
  target:
    description: Build target
    required: false
    default: 'all'
outputs:
  result:
    value: ${{ steps.final.outputs.data }}
runs:
  using: composite
  steps:
    - id: prepare
      run: echo "Preparing ${{ inputs.target }}"
    - id: final
      run: echo "data=done" >> "${{BRAND_ENV_PREFIX}}_OUTPUT"
```

### Pipeline runtime actions

`runs.using: pipeline` is supported for actions that execute child pipelines instead of a script entry point.

In practice, bundled nested execution is usually exposed through `builtin/run-pipeline`, whose key inputs are:

- `pipeline`: stored pipeline ID, bundled filename, or file path. To pick the child through `env`, define the ID as a literal in the pipeline or job `env` and write `pipeline: ${{ env.WORKER_PIPELINE }}`; a share then includes the child. A ref that reads an input, a step output, or a step-level `env` value is known only at run time, so a share can't include that child
- `pipeline_yaml`: inline child pipeline text
- `inputs`: JSON object of child pipeline inputs
- `cwd`: optional child working directory relative to the parent step cwd

Child pipelines inherit the parent execution's event data and paths. A child of a `plan_ready` pipeline receives the same writable plan path, and a child of a `task_ready` pipeline receives the same task and reserved plan paths. The child inherits the parent's `event_name` only when its own `on` declaration includes that trigger; otherwise its `event_name` is `dispatch`. For example, a dispatch-only child of a `plan_ready` pipeline sees `event_name: dispatch`, while a child declaring `on: [plan_ready]` sees `event_name: plan_ready`.

Nested execution target selection is a first-class **step property**, not a `with` input:

- missing `target` means `target: { scope: inherit }`
- `target.scope: directory` may use an absolute or relative `path`
- `target.scope: worktree` requires `workspace_id` and `worktree.id`; create worktrees first with `builtin/create-worktree`
- do not combine legacy `with.cwd` with `target.path`; use `target.path`

```yaml
- id: run_child_inherit
  uses: builtin/run-pipeline
  with:
    pipeline: child.yaml
    inputs: '{}'

- id: run_child_directory
  uses: builtin/run-pipeline
  target:
    scope: directory
    path: /tmp
  with:
    pipeline: child.yaml
    inputs: '{}'

- id: run_child_existing_worktree
  uses: builtin/run-pipeline
  target:
    scope: worktree
    workspace_id: ${{ inputs.workspace_id }}
    worktree:
      id: ${{ inputs.worktree_id }}
  with:
    pipeline: child.yaml
    inputs: '{}'

- id: create_review_worktree
  uses: builtin/create-worktree
  with:
    workspace_id: ${{ inputs.workspace_id }}
    branch: ${{ inputs.branch }}
    base_branch: main
    repair: true

- id: run_review
  uses: builtin/run-pipeline
  target:
    scope: worktree
    workspace_id: ${{ inputs.workspace_id }}
    worktree:
      id: ${{ steps.create_review_worktree.outputs.worktree_id }}
  with:
    pipeline: bundled-code-review
    inputs: '{}'
```

### Input/output mechanism

Actions receive inputs as **environment variables** named `INPUT_<NAME>` (uppercase, spaces become underscores).

Actions write outputs to the file at `${{BRAND_ENV_PREFIX}}_OUTPUT` as `key=value` lines. Actions can inject environment variables into subsequent steps by writing to `${{BRAND_ENV_PREFIX}}_ENV`.

#### Artifact lifetime contract

`{{BRAND_ENV_PREFIX}}_OUTPUT` is a temporary, executor-owned command file for the current step invocation. Use it only to append single-line output metadata. Do not treat its parent directory as artifact storage, derive persistent paths with `dirname({{BRAND_ENV_PREFIX}}_OUTPUT)`, or write files beside it.

`{{BRAND_ENV_PREFIX}}_OUTPUT_DIR` is the durable, execution-scoped artifact directory under the execution store. A file **must** live under this directory when its path is exposed as a step or job output, consumed by a later step or job, reused by a retry, or needed after pause/resume. Output values are persisted in execution state, but files referenced by those values are not copied automatically.

Temporary step files may be retained while an execution is paused as a best-effort executor behavior, but that is not a pipeline persistence contract. An app/process restart or operating-system temp cleanup can remove them. A resumed execution can therefore still show the producer step as successful while a downstream consumer receives a path to a missing temp file.

Every step and action receives `{{BRAND_ENV_PREFIX}}_OUTPUT_DIR`; treat its absence as an error instead of falling back to the parent of `{{BRAND_ENV_PREFIX}}_OUTPUT`. Create subdirectories as needed and choose collision-safe names when parallel steps or retry attempts can write artifacts in the same execution. Intentionally overwrite a stable durable path only when that is the desired retry behavior.

Because `${{BRAND_ENV_PREFIX}}_OUTPUT` is line-based, write multiline payloads to files under `${{BRAND_ENV_PREFIX}}_OUTPUT_DIR` and expose their paths as outputs:

```javascript
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const outputFile = process.env.{{BRAND_ENV_PREFIX}}_OUTPUT;
const outputDir = process.env.{{BRAND_ENV_PREFIX}}_OUTPUT_DIR;
if (!outputFile || !outputDir) throw new Error('Pipeline output paths are required');

mkdirSync(outputDir, { recursive: true });
const artifactFile = path.join(outputDir, 'security-review.json');
writeFileSync(artifactFile, JSON.stringify({ findings: [] }), 'utf8');
appendFileSync(outputFile, `review_file=${artifactFile}\n`, 'utf8');
```

`{{BRAND_ENV_PREFIX}}_PAUSE` is reserved executor control metadata: writing `{{BRAND_ENV_PREFIX}}_PAUSE=true` or `{{BRAND_ENV_PREFIX}}_PAUSE=1` pauses the current physical job after the step finishes. The step still completes as `success`, independent jobs continue, a paused matrix variant releases its concurrency slot, and the reserved key is not persisted as a normal step output.
`{{BRAND_ENV_PREFIX}}_INPUT_REQUEST` is reserved structured pause metadata. It must be a single-line JSON object with `fields`; use `builtin/request-input` instead of hand-writing it unless an action needs to generate fields dynamically.
`{{BRAND_ENV_PREFIX}}_JOB_RESTART` is reserved executor control metadata: writing `{{BRAND_ENV_PREFIX}}_JOB_RESTART=true` or `{{BRAND_ENV_PREFIX}}_JOB_RESTART=1` requests a non-failure restart of the current job from step 1, consuming the remaining `max_iterations` pass budget.
`{{BRAND_ENV_PREFIX}}_OUTPUT_REPORT` and `{{BRAND_ENV_PREFIX}}_OUTPUT_REPORT_JSON` are reserved execution-report metadata keys. Write a file under `${{BRAND_ENV_PREFIX}}_OUTPUT_DIR`, then write one of these keys to `${{BRAND_ENV_PREFIX}}_OUTPUT` with the file path. The executor promotes these paths to execution-level report metadata and surfaces them specially in the CLI and UI.
`{{BRAND_ENV_PREFIX}}_NOTIFICATION` is reserved desktop-notification metadata. Prefer `builtin/notify` instead of hand-writing it; the value must be a single-line JSON object with `title` and `body`.
If a child pipeline launched via `builtin/run-pipeline` emits one of the reserved report keys, the parent execution surfaces that child report metadata as its own final execution report.

### Inline Node steps

Inline `shell: node` steps are written to a temporary `.mjs` file, so author
them as ES modules. Use `import` from `node:*` builtins and avoid CommonJS
forms such as `require(...)`, `module.exports`, `__dirname`, and `__filename`.

Do not inject expression values directly into JavaScript string literals inside
`shell: node` scripts. On Windows, file-path outputs contain backslashes, and a
literal such as `` `${{ steps.build.outputs.artifact_file }}` `` can become
invalid JavaScript before the script runs. Use `toJson(...)` when a pipeline
expression needs to become JavaScript source, then read properties from the
serialized object:

```yaml
- id: read_artifact
  shell: node
  run: |
    import fs from 'node:fs';

    const buildOutputs = ${{ toJson(steps.build.outputs) }};
    const artifactPath = String(buildOutputs.artifact_file ?? '').trim();
    const content = fs.readFileSync(artifactPath, 'utf8');
```

For a single required scalar, `const value = ${{ toJson(steps.build.outputs.value) }};`
is valid. For optional outputs, prefer serializing the containing object and
using `?? ''`; `toJson(undefined)` interpolates to an empty string, which can
produce invalid JavaScript source.

```yaml
- id: build_fields
  shell: node
  env:
    OPTIONS_JSON: ${{ steps.draft.outputs.json_response }}
  run: |
    import { appendFileSync } from 'node:fs';

    const parsed = JSON.parse(process.env.OPTIONS_JSON || '{}');
    const fields = [
      {
        key: 'decision',
        label: 'Decision',
        type: 'choice',
        options: parsed.options ?? ['continue', 'revise'],
        required: true,
      },
    ];
    const outputFile = process.env.{{BRAND_ENV_PREFIX}}_OUTPUT;
    if (!outputFile) throw new Error('{{BRAND_ENV_PREFIX}}_OUTPUT is required');
    appendFileSync(outputFile, `fields=${JSON.stringify(fields)}\n`, 'utf8');
```

### Pausing for human input

Use `builtin/request-input` when a pipeline needs a human to review, choose, or
fill in values before downstream steps continue:

```yaml
- id: review_gate
  uses: builtin/request-input
  with:
    title: Review requirements
    message: Edit the answers below before continuing.
    fields: '[{"key":"scope","label":"Scope","type":"string","multiline":true,"required":true},{"key":"decision","label":"Decision","type":"choice","options":["continue","revise"],"required":true}]'
```

Builtin input contract:

| Input     | Required | Description                                                                                                     |
| --------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `title`   | no       | Short form heading.                                                                                             |
| `message` | no       | Human-facing instructions shown above the fields.                                                               |
| `fields`  | no       | Single-line JSON array of field objects. Use `[]` for a formless pause, but most checkpoints should set fields. |

The desktop app shows a form in the Activity detail modal. On resume, answers are
validated, stringified, and merged into the paused checkpoint step's outputs, so
downstream steps read them as `${{ steps.review_gate.outputs.<key> }}`. Boolean
and number answers are also step-output strings after resume (`"true"`, `"42"`).
`fields` may be generated by an earlier step, for example
`fields: ${{ steps.draft.outputs.fields }}`. When generating fields in an
inline `shell: node` step, use ES module imports as shown above.

Checkpoint answers are not pipeline inputs. Do not declare answer fields under
`on.dispatch.inputs` just so a paused checkpoint can receive them; use
`${{ steps.<request_step_id>.outputs.<field_key> }}` after resume.

Each field object must have a `key`, `label`, and `type`. Keys must match
`[A-Za-z_][A-Za-z0-9_]*` and become step output keys after resume. Supported
types are `string`, `boolean`, `number`, and `choice`. Optional properties are
`description`, `required`, `default`, `options` for choices, `min`/`max` for
numbers, and `multiline` for string text areas.

Validation rules:

- `choice` fields must provide a non-empty string `options` array.
- `default` must match the field type; choice defaults must be one of `options`.
- `min` and `max` must be finite numbers, and `min` cannot exceed `max`.
- Submitted answers cannot include unknown keys.
- Required fields reject missing or blank string answers.
- Boolean answers must be booleans, choices must be in `options`, and numeric
  answers must parse to finite numbers within any configured bounds.

Independent jobs and matrix variants may hold any number of simultaneous input
or formless checkpoints. A paused matrix variant releases its `max_parallel`
slot, allowing queued variants to reach their own checkpoints. The Activity
detail modal can submit one checkpoint or an atomic batch; unselected
checkpoints stay paused. A bare `{{BRAND_ENV_PREFIX}}_PAUSE=true` without
`{{BRAND_ENV_PREFIX}}_INPUT_REQUEST` creates an addressed formless checkpoint
with a simple resume control.

If an action genuinely needs to build the request itself, write
`{{BRAND_ENV_PREFIX}}_INPUT_REQUEST=<single-line-json>` and
`{{BRAND_ENV_PREFIX}}_PAUSE=true` to `{{BRAND_ENV_PREFIX}}_OUTPUT`. The JSON
must be an object shaped like `{ "title"?: string, "message"?: string,
"fields": PauseInputField[] }`. Prefer `builtin/request-input` for static forms
because it handles the reserved output shape.

If you just need to emit a final report, prefer `builtin/{{BRAND_REPORT_ACTION_ID}}` instead of hand-rolling the file write:

```yaml
- uses: builtin/{{BRAND_REPORT_ACTION_ID}}
  with:
    content: |
      # Summary
      All checks passed.
    format: text
```

Use `format: text` for markdown/plaintext reports and `format: json` for machine-readable report payloads.

```typescript
// Reading inputs in a Node/TSX action
const message = process.env.INPUT_MESSAGE || '';

// Writing outputs
import { appendFileSync } from 'fs';
appendFileSync(process.env.{{BRAND_ENV_PREFIX}}_OUTPUT!, 'result=success\n');
```

```python
# Reading inputs in a Python action
import os
message = os.environ.get("INPUT_MESSAGE", "")

# Writing outputs
with open(os.environ["{{BRAND_ENV_PREFIX}}_OUTPUT"], "a") as f:
    f.write("result=success\n")
```

## Expressions and Conditions

Expressions use `${{ }}` syntax for interpolation in string values, and bare syntax in `if` fields.

### Property access

```
steps.<step_id>.outputs.<key>     # Step output value
steps.<step_id>.outcome           # Actual result: success | failure | cancelled | skipped
steps.<step_id>.conclusion        # Effective result (after continue_on_error)
needs.<job_id>.outputs.<key>      # Upstream job output
needs.<job_id>.result             # Upstream job result
needs.<job_id>.children           # Ordered matrix variant projections
env.<VAR>                         # Environment variable
inputs.<name>                     # Pipeline input in pipeline/job/step expressions
inputs.<name>                     # Action input inside composite-action internals
job.is_retry                      # true if current attempt is a retry
job.retry_count                   # Current attempt number (0-based)
job.max_retries                   # max_retries from job definition
matrix.<axis>                     # Current matrix value for an authored axis
assets.<id>.path                  # Resolved folder of a declared asset ('' when an optional one is missing)
{{BRAND_EXPRESSION_ROOT}}.pipeline_data_dir          # The pipeline's own data folder, kept across runs
{{BRAND_EXPRESSION_ROOT}}.event_name                 # Trigger that started this execution ('dispatch', 'plan_ready', or 'task_ready')
{{BRAND_EXPRESSION_ROOT}}.event.plan_ready.plan_path # Path to shared plan file (writable by the pipeline)
{{BRAND_EXPRESSION_ROOT}}.event.task_ready.task_path # Path to the task definition file
{{BRAND_EXPRESSION_ROOT}}.event.task_ready.plan_path # Reserved writable plan path for generated plans
{{BRAND_EXPRESSION_ROOT}}.project_id                 # The run's project, or '' in a run with no project
{{BRAND_EXPRESSION_ROOT}}.task_id                    # The run's task (worktree), or '' in a run with no task
{{BRAND_EXPRESSION_ROOT}}.owner                      # The run's owner: personal or org:<uuid>
{{BRAND_EXPRESSION_ROOT}}.initiator.kind             # user, hook, portal, automation, app_advisor or agent
{{BRAND_EXPRESSION_ROOT}}.initiator.automation_id    # The automation that started the run (automation only)
{{BRAND_EXPRESSION_ROOT}}.initiator.chat_id          # The starting chat (agent, and app_advisor when known)
```

The desktop app records the owner and initiator when a run starts; resume, retry and rerun keep them. `{{BRAND_EXPRESSION_ROOT}}.initiator.automation_name` is text a person or agent wrote, so never interpolate it into a `run:` command line.

### Operators

`==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `||`, `!`, `()`

### Status functions

| Function      | Description                                       |
| ------------- | ------------------------------------------------- |
| `success()`   | True if all previous steps/dependencies succeeded |
| `failure()`   | True if any previous step/dependency failed       |
| `cancelled()` | True if execution was cancelled                   |
| `always()`    | Always true — step runs regardless                |

### Utility functions

| Function                     | Description                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `contains(haystack, needle)` | String/array containment check                                                  |
| `join(array, separator)`     | Join array elements                                                             |
| `parseJson(value)`           | Parse a JSON string so nested fields can be accessed with `.prop` and `[index]` |
| `toJson(value)`              | Serialize a value or object to a JSON string                                    |

## Environment Variable Cascading

Environment variables cascade from broad to narrow scope. Later layers override earlier ones:

```
process.env → execution env → pipeline.env → job.env → step.env
```

Resolved pipeline inputs are also exposed to spawned steps as `INPUT_<NAME>` environment variables. Action runtimes receive their own action inputs with the same naming convention, and action inputs override same-named pipeline input env vars inside the action process.

User-configured pipeline environment variables marked as secret are injected only at subprocess spawn time and are not persisted in execution state. Use secret environment variables for credentials such as HTTP `Authorization` values. Do not put tokens directly in YAML `with:` values.

## Error Handling

Error handling uses a two-level model:

- **outcome** — the actual result of execution (`success` or `failure`)
- **conclusion** — the effective result after applying `continue_on_error`

When `continue_on_error: true`, the outcome stays `failure` but the conclusion is promoted to `success`, allowing subsequent steps/jobs to proceed.

## Job Scheduling

Jobs are organized into **tiers** by topological sort of `needs`:

```
Tier 0: [setup]         — no dependencies, runs first
Tier 1: [build, lint]   — depend on setup, run in parallel
Tier 2: [deploy]        — depends on build and lint
```

All jobs in a tier run concurrently. A job is skipped if any dependency did not conclude as `success`.

## Builtin Actions

These actions ship with {{BRAND_DISPLAY_NAME}} and are referenced as `builtin/<name>`:

Inspect the specific `action.yml` file you plan to use for exact inputs, outputs, and log-format behavior. The current bundled catalog includes:

- Orchestration and execution: `agent-prompt`, `agent-resume`, `agent-loop`, `parallel-agents`, `create-worktree`, `run-pipeline`, `router`, `quality-gate`, `condenser`, `{{BRAND_REPORT_ACTION_ID}}`
- Projects and chats (host steps, desktop app only): `create-project-entry`, `create-bot-entry`, `send-agent-message`, `wait-for-agent-reply`, `move-to-group`
- Memory and coordination: `memory-read`, `memory-write`, `memory`, `comms-setup`
- Discovery and requirements: `discovery`, `context-discovery`, `historical-context`, `requirements-from-task`, `requirements-interactive`, `complexity-assessor`, `greenfield-detection`, `git-workspace-details`, `open-pr-details`
- Spec and planning: `spec-researcher`, `spec-gatherer`, `spec-quick`, `spec-writer`, `spec-critic`, `spec-validation`, `planner`, `plan-validation`, `plan-path-validation`, `plan-with-review`
- Implementation and QA: `coder`, `qa-reviewer`, `qa-fixer`, `request-input`, `phase-compaction`
- Outbound integrations: `http-request`, `notify`
- Example/reference actions: `hello-world-js`, `hello-world-py`, `hello-world-ts`

### Outbound integration actions

Use `builtin/http-request` for generic APIs. Put credentials in environment variables and reference the variable name from `auth_header_env`:

```yaml
- id: call_api
  uses: builtin/http-request
  with:
    url: https://api.example.com/v1/jobs
    method: POST
    content_type: application/json
    body: '{"status":"ready"}'
    auth_header_env: EXAMPLE_AUTH_HEADER
    expected_status: 200-299
```

Use `builtin/notify` for desktop notifications. Desktop notifications are shown by the desktop runtime and ignored by CLI runtimes.

```yaml
- id: desktop
  uses: builtin/notify
  with:
    title: Pipeline finished
    body: The pipeline completed successfully.
```

### Session-aware agent actions

Use these when a pipeline step needs to start or continue an SDK-backed agent session:

- `builtin/agent-prompt`
  - Runs a single Claude or Codex turn.
  - `model` can be a provider model or a `model_aliases` id. Agent-backed models must go through `model_aliases.defaults.agent_id`, not a raw `agent_model_*` value.
  - `thinking_effort` accepts `off`, `low`, `medium`, `high`, `xhigh`, or `max`.
  - Always outputs `session_id` alongside the transcript/text/JSON outputs.
  - Emits `proposed_plan_file` whenever it detects a proposed plan from Claude plan-mode tool output or Codex plan output.
  - `permission_preset: plan` enables Claude plan mode and applies the shared {{BRAND_DISPLAY_NAME}} Codex planning instructions.
  - Claude sessions are only resumable later if `persist_session: true`.
  - Codex threads are persisted automatically.
- `builtin/agent-resume`
  - Continues an existing session using `session_id` plus `prompt` or `prompt_file`.
  - `model` can be a provider model or a `model_aliases` id. When omitted, it attempts Claude first and then Codex.
  - `thinking_effort` accepts `off`, `low`, `medium`, `high`, `xhigh`, or `max`.
  - If the session is missing or expired, the step fails instead of returning a blank result.
  - Produces the same output shape as `agent-prompt`, including `session_id`.

Example:

```yaml
jobs:
  plan:
    steps:
      - id: draft
        uses: builtin/agent-prompt
        with:
          prompt: Draft an implementation plan for the current task.
          persist_session: true

      - id: revise
        uses: builtin/agent-resume
        with:
          session_id: ${{ steps.draft.outputs.session_id }}
          prompt: Revise the plan to include verification steps and risks.
```

### Host steps

Host steps (`using: host`) are performed by the desktop app: they create tasks, chats and worktrees, send messages and wait for replies, and move tasks between sidebar groups. The CLI refuses them with `failure_reason: needs_desktop`, except `builtin/create-worktree`, which runs its Node fallback on the CLI unless a desktop-only input is set (`existing_branch`, `base_task_id` or `base_worktree_id`, `group`, or `worktree_setup: run` or `run_and_wait`). Every host step has a `failure_reason` output, empty on success and a typed code otherwise (for example `not_found`, `validation_failed`, `owner_context_unavailable`, `advisor_access_disabled`, `target_not_ready`, `authorization_conflict` or `needs_desktop`), so `continue_on_error` steps can branch on it. Group problems never fail a step; they report `grouped: 'false'` and a `not_grouped_reason`.

| Action                         | What it does                                                                                         | Main inputs                                                                                                                                                                                                               | Main outputs                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `builtin/create-worktree`      | Creates a worktree in a code project                                                                 | `project_id` (or `workspace_id`), `branch`, `base_branch`, `existing_branch`, `base_task_id`, `worktree_setup` (`skip`, `run` or `run_and_wait`), `group`                                                                 | `task_id` (same as `worktree_id`), `path`, `branch_name`, `setup_state` |
| `builtin/create-project-entry` | Creates a task (a Work Entry with its first chat) in a cowork project                                | `project_id`, `title`, `group`                                                                                                                                                                                            | `task_id`, `chat_id`, `task_created`, `chat_created`                    |
| `builtin/create-bot-entry`     | Creates an Orchestrator task with its first, empty chat                                              | `bot_id` (`app_advisor`), `title`, `group`                                                                                                                                                                                | `task_id`, `chat_id`                                                    |
| `builtin/send-agent-message`   | Sends a message to a project or Orchestrator chat, creating the chat when no `chat_id` is given      | `project_id` or `bot_id`, `task_id`, `chat_id`, `text` or `text_file`, `mode` (`queue` or `steer`), `model`, `thinking_effort`, `plan_mode`, `approval_mode`, `plugins`, `literal_text`, `new_chat`, `replace_empty_chat` | `chat_id`, `message_id`, `state` (`sent`, `queued` or `steered`)        |
| `builtin/wait-for-agent-reply` | Waits for the turn that answers `message_id` (or the chat's latest turn) and exposes its final reply | `project_id` or `bot_id`, `task_id`, `chat_id`, `message_id`, `reply_timeout_minutes` (default 60, at most 720)                                                                                                           | `reply_state`, `reply_text` (capped at 8,000 characters), `reply_file`  |
| `builtin/move-to-group`        | Moves a worktree or Work Entry into a sidebar group, creating the group when missing                 | `project_id` or `bot_id`, `task_id`, `group` (or `group_id`; `none` removes it), `color`                                                                                                                                  | `group_id`, `group_name`, `grouped`, `not_grouped_reason`               |

Rules:

- Read each step's `action.yml` (GetBuiltinActionDefinition in the editor) for the full inputs and outputs before configuring it.
- Pass `literal_text: 'true'` with `text` when the message must be sent exactly as written; otherwise `${{ }}` expressions in it are evaluated.
- A run an agent started is agent-originated: `send-agent-message` can't change an existing chat's model, plan mode, plugins or approvals, and a chat it creates takes no plugins and only its agent's approvals.
- `create-worktree` with `worktree_setup: run_and_wait` waits for the project's setup scripts and reports `setup_state` (`succeeded`, `failed`, `timed_out`, …); `run` starts them and continues.

#### Runs with no project

A pipeline with `scope: global` can run with no project or task (an automation's **No project** destination, `target: { kind: 'global' }`). It runs in a scratch folder that is deleted with the execution, can't use project actions or project pipelines, and runs as its owner (`{{BRAND_EXPRESSION_ROOT}}.owner`). Its steps name every project, task and chat with explicit IDs, usually through `inputs`, since there is no current project to default to.

## Examples

### Minimal pipeline

```yaml
pipeline:
  name: Hello World
  version: '3.0'
  on: dispatch
  jobs:
    greet:
      name: Greet
      steps:
        - id: hello
          run: echo "Hello from {{BRAND_DISPLAY_NAME}}!"
```

### Chat automation as a global pipeline

This is the workflow an automation owns when it starts a chat in a cowork project each run: create a task, send the prompt, wait for the reply. The project is an input, so the steps hold no local IDs, and `replace_empty_chat` keeps the new task to one chat in runs an automation starts.

```yaml
name: Morning check
scope: global
on:
  dispatch:
    inputs:
      project_id:
        required: false
jobs:
  chat:
    steps:
      - id: entry
        uses: builtin/create-project-entry
        with:
          project_id: ${{ inputs.project_id }}
      - id: send
        uses: builtin/send-agent-message
        with:
          project_id: ${{ inputs.project_id }}
          task_id: ${{ steps.entry.outputs.task_id }}
          text: Organize my notes from today.
          literal_text: 'true'
          replace_empty_chat: 'true'
      - id: reply
        uses: builtin/wait-for-agent-reply
        with:
          project_id: ${{ inputs.project_id }}
          task_id: ${{ steps.entry.outputs.task_id }}
          chat_id: ${{ steps.send.outputs.chat_id }}
          message_id: ${{ steps.send.outputs.message_id }}
          reply_timeout_minutes: '720'
```

For a code project, `builtin/create-worktree` (with `project_id`) replaces `create-project-entry`; for the Orchestrator, `builtin/create-bot-entry` with `bot_id: app_advisor` does, and the send uses `bot_id`.

### Ticketing-system pipeline with builtin actions

```yaml
pipeline:
  name: Quick Edits
  version: '3.0'
  description: Fast iterations for simple changes
  icon: '⚡'
  on: dispatch

  jobs:
    discovery:
      name: Discovery
      steps:
        - id: discovery
          uses: builtin/discovery
        - id: requirements
          uses: builtin/requirements-from-task

    specification:
      name: Specification
      needs: discovery
      steps:
        - id: quick_spec
          uses: builtin/spec-quick
        - id: validation
          uses: builtin/spec-validation

    planning:
      name: Planning
      needs: specification
      steps:
        - id: planning
          uses: builtin/planner

    implementation:
      name: Implementation
      needs: planning
      steps:
        - id: coding
          uses: builtin/coder
```

### Conditional steps and QA retry loop

```yaml
pipeline:
  name: Auto
  version: '3.0'
  on: dispatch
  env:
    qa_max_iterations: 50

  jobs:
    specification:
      name: Specification
      steps:
        - id: complexity_assessment
          uses: builtin/complexity-assessor
        - id: research
          if: steps.complexity_assessment.outputs.complexity == 'complex'
          uses: builtin/spec-researcher
          continue_on_error: true
        - id: quick_spec
          if: steps.complexity_assessment.outputs.complexity == 'simple'
          uses: builtin/spec-quick
        - id: spec_writing
          if: steps.complexity_assessment.outputs.complexity != 'simple'
          uses: builtin/spec-writer
        - id: validation
          uses: builtin/spec-validation

    implementation:
      name: Implementation
      needs: specification
      steps:
        - id: coding
          uses: builtin/coder

    quality_assurance:
      name: Quality Assurance
      needs: implementation
      steps:
        - id: qa_review
          uses: builtin/qa-reviewer
          continue_on_error: true
        - id: qa_fix
          if: steps.qa_review.conclusion == 'failure'
          uses: builtin/qa-fixer
        - id: qa_review_retry
          if: steps.qa_fix.conclusion == 'success'
          uses: builtin/qa-reviewer
```

### Inline scripts with outputs

```yaml
pipeline:
  name: Build and Deploy
  version: '3.0'
  on: dispatch

  jobs:
    build:
      name: Build
      outputs:
        version: ${{ steps.version.outputs.tag }}
      steps:
        - id: version
          run: echo "tag=v1.2.3" >> "${{BRAND_ENV_PREFIX}}_OUTPUT"
        - id: compile
          run: |
            npm ci
            npm run build
          shell: bash
          env:
            NODE_ENV: production

    deploy:
      name: Deploy
      needs: build
      steps:
        - id: deploy
          run: echo "Deploying ${{ needs.build.outputs.version }}"
          if: needs.build.result == 'success'
```

### Project-local action

Create `<repo>/{{BRAND_PROJECT_CONFIG_DIR}}/actions/lint-check/action.yml`:

```yaml
name: Lint Check
description: Run project linter and report results
scope: directory # optional; omitted means all scopes. Use worktree for git/GitHub workspace actions.
inputs:
  fix:
    description: Whether to auto-fix issues
    required: false
    default: 'false'
outputs:
  issues_found:
    description: Number of lint issues found
runs:
  using: node
  main: index.js
```

Reference it in a pipeline:

```yaml
pipeline:
  name: Code Quality
  version: '3.0'
  on: dispatch
  jobs:
    lint:
      steps:
        - id: lint
          uses: project/lint-check
          with:
            fix: true
```

## Common Patterns

### Optional steps with continue_on_error

Use `continue_on_error: true` for steps that may fail without blocking the pipeline:

```yaml
- id: historical_context
  uses: builtin/historical-context
  continue_on_error: true
```

### Conditional branching on step outputs

Route the pipeline based on earlier step results:

```yaml
- id: assess
  uses: builtin/complexity-assessor
- id: quick_path
  if: steps.assess.outputs.complexity == 'simple'
  uses: builtin/spec-quick
- id: full_path
  if: steps.assess.outputs.complexity != 'simple'
  uses: builtin/spec-writer
```

### QA retry pattern

Review, fix if failed, then re-review:

```yaml
- id: review
  uses: builtin/qa-reviewer
  continue_on_error: true
- id: fix
  if: steps.review.conclusion == 'failure'
  uses: builtin/qa-fixer
- id: re_review
  if: steps.fix.conclusion == 'success'
  uses: builtin/qa-reviewer
```

### Automatic job retries

Use `max_retries` for jobs with flaky steps. The entire job re-runs from the beginning on failure. Steps can use `job.is_retry` to adjust behavior on retry:

```yaml
jobs:
  build:
    name: Build
    max_retries: 2
    steps:
      - id: setup
        if: '!job.is_retry'
        run: npm ci
      - id: quick_setup
        if: job.is_retry
        run: npm install --prefer-offline
      - id: compile
        run: npm run build
```

Retry semantics:

- `max_retries` counts extra attempts after the initial run (`max_retries: 2` = up to 3 total attempts)
- `retry_count` is 0-based (first run = 0, first retry = 1)
- Retries trigger when a job attempt ends in failure and retry budget remains
- Job-level `continue_on_error: true` does not suppress retries; it only promotes the final failed attempt to `conclusion: success` after retries are exhausted
- Step-level `continue_on_error: true` can prevent the job from failing, so those absorbed step failures do not trigger a job retry
- Each retry resets all steps and re-runs the full job
- Steps also receive `{{BRAND_ENV_PREFIX}}_JOB_IS_RETRY`, `{{BRAND_ENV_PREFIX}}_JOB_RETRY_COUNT`, and `{{BRAND_ENV_PREFIX}}_JOB_MAX_RETRIES` environment variables

### Passing data between jobs

Use job `outputs` to forward step outputs to downstream jobs:

```yaml
jobs:
  setup:
    outputs:
      config: ${{ steps.load.outputs.config_path }}
    steps:
      - id: load
        run: echo "config_path=./config.json" >> "${{BRAND_ENV_PREFIX}}_OUTPUT"

  build:
    needs: setup
    steps:
      - id: use_config
        run: echo "Using ${{ needs.setup.outputs.config }}"
```

### Plan-ready pipeline

A pipeline triggered by an agent plan. The plan is written to a shared file that the pipeline can read and modify:

```yaml
pipeline:
  name: Implement Plan
  version: '3.0'
  description: Execute an agent-generated plan
  icon: '📋'
  on: plan_ready

  jobs:
    review:
      name: Review Plan
      steps:
        - id: show_plan
          run: |
            echo "Plan file: ${{ {{BRAND_EXPRESSION_ROOT}}.event.plan_ready.plan_path }}"
            cat "${{ {{BRAND_EXPRESSION_ROOT}}.event.plan_ready.plan_path }}"
        - id: refine_plan
          run: |
            # The plan file is writable — pipelines can modify it
            echo "## Additional Notes" >> "${{ {{BRAND_EXPRESSION_ROOT}}.event.plan_ready.plan_path }}"
        - id: implement
          uses: builtin/coder
```

A pipeline can support both triggers:

```yaml
pipeline:
  name: Flexible Pipeline
  version: '3.0'
  on:
    dispatch:
      inputs:
        task:
          type: string
          required: true
    plan_ready: {}

  jobs:
    work:
      name: Do Work
      steps:
        - id: from_dispatch
          if: {{BRAND_EXPRESSION_ROOT}}.event_name == 'dispatch'
          run: echo "Manual trigger with input ${{ inputs.task }}"
        - id: from_plan
          if: {{BRAND_EXPRESSION_ROOT}}.event_name == 'plan_ready'
          run: cat "${{ {{BRAND_EXPRESSION_ROOT}}.event.plan_ready.plan_path }}"
```

### Task-ready planning pipeline

Use `task_ready` when the pipeline should read a task definition and publish a fresh plan to the reserved plan slot:

```yaml
pipeline:
  name: Create Task Implementation Plan
  version: '3.0'
  on: task_ready

  jobs:
    plan:
      steps:
        - id: draft_plan
          uses: builtin/agent-prompt
          with:
            model: gpt-6-sol
            thinking_effort: xhigh
            permission_preset: plan
            prompt_file: ${{ {{BRAND_EXPRESSION_ROOT}}.event.task_ready.task_path }}

        - id: publish_plan
          run: |
            cp \
              "${{ steps.draft_plan.outputs.proposed_plan_file }}" \
              "${{ {{BRAND_EXPRESSION_ROOT}}.event.task_ready.plan_path }}"
```
