# Desktop performance suite

The canonical usage, workload, metric, comparison, profiling, artifact, and
retention documentation is in
[`docs/desktop-app-performance.md`](../../../../docs/desktop-app-performance.md#automated-benchmarking-and-regression-suite).

Quick commands:

```bash
pnpm run perf:desktop:smoke
pnpm run perf:desktop --profile counters
pnpm run build && node --import tsx apps/desktop-app/tests/performance/run.mjs --release-like --profile baseline --scenarios stress-transcript
pnpm run perf:desktop:capture-field-load --data-dir <app data directory> --app-pid <main pid>
pnpm run perf:desktop:chat-storage-field-load --profile smoke
pnpm run perf:desktop:chat-storage-field-load --profile field
pnpm run perf:desktop --profile baseline --scenarios startup-settle
pnpm run perf:desktop --profile baseline --scenarios startup-settle --live-startup-background --diagnose
pnpm run perf:desktop --profile baseline --scenarios startup-realistic --diagnose
pnpm run perf:desktop --profile baseline --scenarios power-user-idle --diagnose
pnpm run perf:desktop --profile baseline --scenarios power-user-active --diagnose
pnpm run perf:desktop --profile baseline --scenarios startup-settle --startup-worktrees 74 --startup-workspaces 42
pnpm run perf:desktop --profile baseline --scenarios loaded-ui,large-transcripts
pnpm run perf:desktop --profile baseline --scenarios cowork-default-50,cowork-default-100,cowork-default-500
pnpm run perf:desktop --profile baseline --scenarios loaded-ui,math-transcripts
pnpm run perf:desktop --profile baseline --scenarios chat-search-indexing
pnpm run perf:desktop --profile baseline --scenarios plugin-picker
pnpm run perf:desktop --profile baseline --scenarios menu-surfaces
pnpm run perf:desktop --profile baseline --scenarios browser-panels
pnpm run perf:desktop --profile baseline --scenarios inner-panels-collapse
pnpm run perf:desktop --profile smoke --scenarios plan-open
pnpm run perf:desktop --profile baseline --scenarios plan-open
pnpm run perf:desktop --profile baseline --scenarios pipeline-history --pipeline-history-executions 424 --pipeline-history-bytes 62000000
pnpm run perf:desktop --profile baseline --scenarios worktree-concurrency,large-transcript-concurrency
pnpm run perf:desktop --profile baseline --scenarios code-graph-concurrency --code-graph-worktrees 9 --code-graph-files 3000
pnpm run perf:desktop --profile baseline --scenarios code-graph-background-concurrency --code-graph-worktrees 9 --code-graph-files 3000
pnpm run perf:desktop --profile baseline --scenarios chats,pipelines,scripts
pnpm run perf:desktop --profile baseline --scenarios mixed-provider-agent-concurrency --diagnose
pnpm run perf:desktop --profile baseline --scenarios worktree-concurrency
pnpm run perf:desktop --profile baseline --scenarios chats --diagnose
pnpm run perf:desktop --profile baseline --scenarios multi-chat-streaming,multi-chat-streaming-sequential
pnpm run perf:desktop --profile smoke --scenarios background-streaming,chat-switch-catch-up
pnpm run perf:desktop --profile counters --scenarios background-streaming,chat-switch-catch-up
pnpm run perf:desktop --profile baseline --scenarios transcript-active-turn-tools
pnpm run perf:desktop --profile baseline --scenarios code-graph-new-worktree,code-graph-small-edit
pnpm run perf:desktop --profile baseline --scenarios startup-settle --startup-trace
pnpm run perf:desktop:compare before.json after.json
pnpm run perf:desktop:sampler-overhead --assert
pnpm run build:core-daemon && pnpm run perf:desktop:daemon-idle-shutdown --stop signal
pnpm run perf:desktop:antigravity-launch --executable <private copy of the official CLI> --baseline-root /path/to/unchanged
pnpm run perf:desktop --profile baseline --scenarios browser-actions --browser-actions-iterations 50
pnpm run build && node --import tsx apps/desktop-app/tests/performance/run.mjs --release-like --profile baseline --scenarios browser-actions --browser-actions-iterations 50
pnpm run perf:desktop --profile baseline --scenarios browser-agent-actions
pnpm run perf:desktop:compare:interleaved --release-like --baseline-root /path/to/unchanged --candidate-root . --profile baseline --scenarios code-review-registry-cleanup
pnpm run perf:desktop:compare:interleaved --release-like --baseline-root /path/to/unchanged --candidate-root . --profile baseline --scenarios owned-automations-list
pnpm run perf:desktop --profile smoke --scenarios w5-store-startup,w5-store-reload,w5-store-writes --w5-store daemon-record-port
pnpm run perf:desktop:compare:interleaved --baseline-root . --candidate-root . --profile baseline --scenarios w5-store-startup,w5-store-reload,w5-store-writes --w5-store-arms in-process,daemon-record-port
```

`--w5-store` launches the E2E build with the `in-process` or the
`daemon-record-port` W5 store. The interleaved driver's
`--w5-store-arms <baseline>,<candidate>` sets one arm per side and launches
the candidate build on both sides. The arm is recorded as `treatment`, and
the `w5` counters land in `scenarios[].work.w5`. Without daemon-owned storage
rows, the daemon arm refuses W5 writes as counted typed failures. See
[W5 store arms](../../../../docs/desktop-app-performance.md#w5-store-arms-can-5532).

Timestamped smoke outputs and their matching `-diagnostics/` directories are
retained as run pairs. After each smoke run the suite keeps only the newest two
pairs under the output directory and removes every older JSON/directory pair
together. Baseline, stress, explicitly named, and unrelated artifacts are not
part of this pruning rule.

`--diagnose` also replays a failed workload and retains any CPU profiles and
Electron trace captured before the repeated failure.

`mixed-provider-agent-concurrency` is a correctness gate as well as a benchmark:
it fails when a Codex child thread/message is missing or routed to the wrong
parent chat. It is part of the default suite so pooled provider routing remains
covered by every full performance run.

Runs are headless by default. Agents must not pass `--headed` unless the user
explicitly requests a headed run in the current request. Results and
diagnostics default to the ignored `.performance/desktop/` directory. Do not
treat E2E-relative results as production startup or release measurements. The
canonical pnpm entry point also applies the local concurrency and
memory-pressure safeguards documented in the runbook; blocked guards use the
documented polling schedule unless `--no-guard-wait` is passed as a script
argument, and CI bypasses those safeguards.

`startup-realistic` is an opt-in diagnostic scenario. It concentrates many
worktrees into several independent repositories, seeds cold shadow Code Graph
maintenance, and restores selected startup procedures normally suppressed by
the E2E build. An in-memory startup ledger makes the run fail if plugin refresh,
curated MCP refresh, updater, automation, resource-monitor, GitHub polling, or
Code Graph startup paths were not activated. Its timings remain E2E-relative
and require confirmation in a matched release-like build.

The `browser-panels` baseline seeds 270 unopened historical Chromium
partitions, exercises two create/navigate/close cycles, records per-panel close
latency, and samples renderer/resource/partition-handle state immediately after
close and again after a two-second plateau. On macOS, partition-handle counters
come from `lsof`; other platforms report those counters as unavailable while
retaining the cross-platform process and resource-monitor checks.

The opt-in `browser-actions` scenario starts an isolated loopback Browser Lab,
opens one Browser panel, and uses `window.api.browser.automation` (the App
Advisor renderer's automation IPC) for pointer-menu click, form-input fill,
and Enter/Tab presses. After three warmup cycles outside the sampled window,
baseline runs 50
fixed cycles; `--browser-actions-iterations` overrides that count. Its result
retains every action latency sample and p50/p95/max, the normal IPC/timer/frame
and foreground key-to-paint monitoring, and aggregate working-set samples with
first-to-last-tenth growth. The same driver supports E2E-relative and
`--release-like` production-bundle launches; only matched release-like runs
support a production performance conclusion.

The opt-in `browser-agent-actions` scenario measures the host-side browser
page model that agents' snapshots, inspect, waits, and actions read. On the
isolated Browser Lab's `heavy` and `controls` pages it measures six groups:

- through `window.api.browser.inputSnapshot`, the snapshot agents get: an
  uncached snapshot (an agent action boundary before each read, so the
  model is rebuilt) and a cached one (a priming read immediately before
  each measured read);
- through the E2E-only `__CANOPY_E2E_BROWSER_PAGE_MODEL__` build hook, which
  reports stage timings and cannot change routing: uncached builds, cached
  builds, and builds with the optional accessibility and listener stages.

After three warmups, baseline samples 30 reads or builds per group;
`--browser-agent-actions-iterations` overrides that count. The result keeps
every sample with p50/p95/max, the model's own timings where the hook
supplies them (extraction, assembly, the style supplement, and the optional
stages), the last coverage and counts, foreground typing probes, and
working-set samples. It also reports the budgets, which apply to a build
and to the snapshot made from it: uncached p95 at or below 300 ms on
`heavy` and 60 ms on `controls`, and cached p95 below 10 ms. The budgets
are E2E-relative. A production bundle has no hook, so a `--release-like`
run measures the two snapshot groups and reports `buildHook: 'unavailable'`.

The opt-in `inner-panels-collapse` scenario restores the deterministic nested
nine-panel layout used by the durable Electron coverage, performs three
warmups, and measures 20 collapse and expand cycles at baseline. The canonical
monitor records renderer responsiveness, CPU, and process memory alongside the
per-cycle duration distribution.

The opt-in `plan-open` scenario seeds one large tracked plan (40 sections, 24
comment threads, and ready sequence, logic, and data model diagrams at
baseline) beside two small plans and a hidden one. Each of its 10 baseline
iterations opens the plan from the activity plan list into its Plan panel
until the last heading of the document renders, switches to the ready logic
diagram, and closes the panel. `planOpenSurface()` reads which surface is
under test (the Plan panel, or the retired full-window takeover on an
unmigrated tree) once per open; only the diagram-tab switch and the close step
differ across the two, so the same driver bytes measure either build (task
names stay stable, so `perf:desktop:compare` compares like for like).

The `chat-search-indexing` baseline uses a 65 MB searchable chat body, verifies
the lazy initial scan, appends one message through the real partial-persistence
IPC, waits for exact FTS freshness, and overlaps both indexing phases with a
foreground composer probe. It records load/persist/freshness timing plus index,
WAL, responsiveness, IPC, CPU, and memory metrics.

The opt-in `power-user-idle` and `power-user-active` scenarios share the same
measured desktop footprint, including restored mixed-panel layouts and Cowork
transcript/pipeline state. The idle variant observes background work and probes
otherwise-idle input/navigation. The active variant additionally overlaps the
profile's supported chat and pipeline concurrency with sustained composer input
and restored-panel navigation. Use them as a matched pair; neither runs in the
default suite because their fixtures are intentionally large. At baseline the
175 chat files comprise 45 source-worktree containers, 17 visible Cowork
entries, and 113 retained/non-visible containers, including the App Advisor
transcript. Retained files still carry their apportioned tabs/messages but do
not create synthetic sidebar rows. Both variants also seed the stored
performance pipeline during their shared preparation so their persisted
footprints differ only in the active variant's in-memory mock registrations.

The `plugin-picker` baseline seeds 850 marketplace plugins, 100 custom skills,
and 50 enabled MCP servers. It incrementally searches and selects six plugins,
one skill, and one MCP server, clears the search and toggles one more row with
the full catalog on screen, then saves through the real chat IPC path and
verifies the persisted tab selections. Compare `keyboardDispatchMs` rather than
`textCommitMs`, and read row counts from `data-row-count` on
`[data-testid="unified-table"]` — the picker windows its table body, so
`tbody tr` no longer equals the filtered total.

The three opt-in `cowork-default-50`, `cowork-default-100`, and
`cowork-default-500` scenarios use fixed Work Entry counts. Every entry has
normal, long, and rich pipeline chat transcripts plus a persisted pipeline
execution. They navigate distant entry rows, switch all three chats, and run a
composer typing probe at each stop. Use all three together for list-scaling
changes; profile selection controls transcript density, not entry count.

The opt-in `background-streaming` and `chat-switch-catch-up` scenarios
reproduce the foreground-first streaming lab cases described in
[the canonical runbook](../../../../docs/desktop-app-performance.md#automated-benchmarking-and-regression-suite).
Select them explicitly with `--scenarios background-streaming,chat-switch-catch-up`
(together or separately); neither is part of the default suite, so a plain
`pnpm run perf:desktop` run skips both. Measure both at `smoke` for a quick
check; use `baseline` for an accepted/rejected comparison. Their `.work.ipc.*`
counters carry byte estimates only under the `counters` profile
(`--profile counters`); every other profile reports message counts alone.
`chat-switch-catch-up` reports its transcript-page invokes under every
profile, and under `counters` the estimated bytes of all main-to-renderer
sends during the switch. That estimate is a proxy: it does not isolate the
transcript page responses.

## Required optimization workflow

The performance runner is only one acceptance gate. Electron UI automation is
the user-behavior gate and must be established before production code changes:

1. Run and save a matched baseline for the affected scenario.
2. Identify the user interactions the optimization could put at risk.
3. Add or update the relevant Electron specs, rebuild the E2E app, and prove
   those specs pass against the unchanged production implementation.
4. Make one attributable production change.
5. Rebuild and rerun the same Electron specs, then collect and compare the
   candidate benchmark.

Do not accept a faster change when the relevant UI automation fails. Likewise,
green UI automation does not establish a performance improvement. Acceptance
requires both green UI coverage and the suite's applicable performance
requirements. If an exploratory workload already exceeds an absolute ceiling,
require repeated matched results showing a material improvement without a new
responsiveness, CPU, or memory regression, and continue reporting the remaining
ceiling failure as unresolved.

See the
[required change sequence](../../../../docs/desktop-app-performance.md#required-change-sequence)
for the complete methodology and release-like measurement requirements.

The worktree workload includes a sustained composer probe on the final created
worktree: one key every 500 ms from Git setup through automatic setup
completion. This complements the short probes in every created worktree and
exposes intermittent stalls that a burst can miss.

## Implementation map

| File                   | Responsibility                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `run.mjs`              | suite orchestration, metadata, output naming, exit status, replay trigger                                  |
| `profiles.mjs`         | profiles, workload overrides, CLI parsing, responsiveness ceilings                                         |
| `scenarios.mjs`        | deterministic fixtures and startup/loaded UI/chat/pipeline/worktree workflows                              |
| `monitor.mjs`          | renderer, IPC, per-process, and work-counter sampling and summaries                                        |
| `responsiveness.mjs`   | absolute unresponsive verdict                                                                              |
| `quit-latency.mjs`     | bounded `app.quit()`-to-exit timing for `startup-settle`                                                   |
| `results.mjs`          | flat comparison-metric generation and result normalization                                                 |
| `scaling-ratios.mjs`   | the P0 section C scaling ratios, their bounds, and their advisory reports                                  |
| `comparison.mjs`       | compatibility, the single-sample flat rule, the repeated-sample comparison, and exact work-counter changes |
| `verdicts.mjs`         | rank-sum test, Holm correction, effect floors, three-way verdicts, and the geometric-mean headline         |
| `work-ratchet.mjs`     | work-counter registry, ceilings, qualification, and the local ratchet verdict                              |
| `compare.mjs`          | comparison CLI, the interleaved baseline/candidate driver, and focused regression replay                   |
| `diagnostics.mjs`      | V8 CPU-profile and Electron trace capture                                                                  |
| `inspector-client.mjs` | loopback Electron main-process inspector client                                                            |
| `hotspots.mjs`         | source-map resolution and Markdown/JSON hot-path reports                                                   |
| `mock-server.mjs`      | deterministic E2E service lifecycle                                                                        |
| `daemon-*.mjs`         | daemon Files treatment admission, start/attach and Files populations, arm preparation, raw summaries       |
| `w5-store-*.mjs`       | W5 store arms: arm parsing, launch env and treatment; the startup, reload and write scenarios              |

`work-metrics.json` (the counter registry) and `work-ceilings.json` (the
per-platform ceilings) are checked-in inputs to `work-ratchet.mjs`; see
[work counters and the local ratchet](../../../../docs/desktop-app-performance.md#work-counters-and-the-local-ratchet).

Keep this README concise and update the canonical runbook whenever the CLI,
result schema, thresholds, scenarios, artifacts, or diagnostic workflow
changes.

`stress-transcript` is part of the default suite. It seeds canonical Default
cowork history with 25 turns × 647 entries, 12,000 tool exchanges, 75 mid-turn
answers, and 26 KB Markdown final reports. Smoke preserves that shape. Cold
opening, scrolling/lazy expansion, warm switching, and typing are separate
measured tasks; legacy migration remains in `large-transcripts`. See the
oversized-turn section of `docs/desktop-app-performance.md` for matched commands.
