import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildScenarioMetrics } from './results.mjs';
import {
  developBaselineRecord,
  formatGateSummary,
  formatMatchedSummary,
  judgeGate,
  judgeMatched,
  matchedDriverArgs,
  MATCHED_SIGNALS,
  readGateConfig,
  validateGateConfig,
} from './retained-worktrees-gate.mjs';
import { retainedEventWork, retainedIdleRates } from './retained-worktrees.mjs';
import {
  readWorkRatchetInputs,
  workRatchetFingerprint,
} from './work-ratchet.mjs';

// CAN-6969: the retained-worktrees-idle gate. Counts come from the
// scenario's phases through the real metric builder and are judged by the
// real work-counter ratchet; CPU is reported, and fails only when the gate is
// switched on and the runner calibrated as no slower than its norm.

const SCENARIO = 'retained-worktrees-idle';
const KEY = `${SCENARIO}.work.retained`;

function phases({ staleReads = 0, focusReads = 0, idleCpu = 4 } = {}) {
  return {
    idle: {
      seconds: 10,
      mainCpuPercentOfCore: idleCpu,
      metadataReadsPerSecond: 0,
      metadataCapturesPerSecond: 0,
      configReadsPerSecond: 0,
      w5PerSecond: { 'read.worktrees.list': 0.1 },
    },
    // W5 reads live in the W5 rates, as in real runs; `metadata` holds only
    // config and recovery keys.
    stale: {
      seconds: 10,
      mainCpuPercentOfCore: idleCpu * 3,
      w5PerSecond: { 'read.manifest.project': staleReads * 2 },
      events: {
        key: 'send.desktop:session-snapshot-stale.main.messages',
        count: 20,
        perEvent: {
          metadataReads: staleReads,
          configReads: 0,
          metadata: { 'config.read': 0 },
          ipc: {
            'invoke.desktop:session-snapshot': 1,
            'invoke.worktree:recovery-list': 0,
            'invoke.preferences:load': 0,
          },
        },
      },
    },
    focus: {
      seconds: 10,
      mainCpuPercentOfCore: idleCpu * 2,
      w5PerSecond: { 'read.index.workspaces': focusReads },
      events: {
        key: 'window.focus',
        count: 10,
        perEvent: {
          metadataReads: focusReads,
          configReads: 0,
          metadata: {},
        },
      },
    },
  };
}

function run(counters, { profile = 'counters', status = 'ok' } = {}) {
  const work = retainedEventWork(counters);
  const scenario = {
    name: SCENARIO,
    status,
    durationMs: 1000,
    tasks: [],
    counters,
    work: work ? { retained: work } : {},
  };
  return {
    profile,
    benchmarkKind: 'e2e-relative',
    config: { retainedWorktrees: profile === 'counters' ? 30 : 110 },
    environment: {
      platform: 'darwin',
      architecture: 'arm64',
      electronVersion: '42.3.0',
      viewport: { width: 1400, height: 900 },
      windowVisible: false,
    },
    scenarios: [scenario],
    metrics: buildScenarioMetrics(scenario),
  };
}

/** The real registry, with ceilings for this scenario and chosen statuses. */
function inputsFor(result, { ceilings = {}, statuses = {} } = {}) {
  const real = readWorkRatchetInputs();
  const metrics = { ...real.registry.metrics };
  for (const [suffix, status] of Object.entries(statuses))
    metrics[`${KEY}.${suffix}`] = { ...metrics[`${KEY}.${suffix}`], status };
  return {
    registry: { ...real.registry, metrics },
    ceilings: {
      version: 1,
      profile: 'counters',
      platforms: {
        'darwin-arm64': {
          ...workRatchetFingerprint(result),
          scenarios: {
            [SCENARIO]: Object.fromEntries(
              Object.entries(ceilings).map(([suffix, value]) => [
                `work.retained.${suffix}`,
                value,
              ]),
            ),
          },
        },
      },
    },
  };
}

const config = () => readGateConfig();

/** Step 0's stale signal counts (CAN-6970) in every phase, plus a chat phase. */
function withStaleSignal(counters, { recoveryReads = 1 } = {}) {
  const perEvent = (builds) => ({
    snapshotBuilds: builds,
    stale: {
      'request.worktree-runtime-status': 2,
      'request.structural.workspace-metadata': 1,
      broadcast: 1,
      'snapshot.build': builds,
      'chat-activity.turn-start': 0.5,
    },
  });
  return {
    ...counters,
    idle: {
      ...counters.idle,
      snapshotBuildsPerSecond: 0.1,
      stalePerSecond: {
        'request.worktree-runtime-status': 0.2,
        broadcast: 0.1,
        'snapshot.build': 0.1,
      },
    },
    stale: {
      ...counters.stale,
      events: {
        ...counters.stale.events,
        perEvent: { ...counters.stale.events.perEvent, ...perEvent(1) },
      },
    },
    focus: {
      ...counters.focus,
      events: {
        ...counters.focus.events,
        perEvent: {
          ...counters.focus.events.perEvent,
          ...perEvent(0),
          metadata: { 'recovery.list': recoveryReads },
        },
      },
    },
    chat: {
      seconds: 10,
      mainCpuPercentOfCore: 6,
      w5PerSecond: {},
      events: {
        key: 'eventsApplied',
        count: 40,
        perEvent: { metadataReads: 0, configReads: 0, ...perEvent(0.25) },
      },
    },
  };
}

/** The values of a source table's quoted keys, such as 'request.org-project'. */
function tableValues(path, prefix) {
  const text = readFileSync(new URL(path, import.meta.url), 'utf8');
  return [
    ...new Set(
      [
        ...text.matchAll(
          new RegExp(`'(${prefix.replace('.', '\\.')}[^']+)'`, 'g'),
        ),
      ].map((match) => match[1]),
    ),
  ];
}

describe('retained-worktrees gate (CAN-6969)', () => {
  it('the checked-in config is report-only for CPU and judges three runs of each', () => {
    const gate = config();
    assert.equal(gate.cpuGate, 'report');
    assert.equal(gate.countRuns, 3);
    assert.equal(gate.cpuRuns, 3);
    assert.throws(() => validateGateConfig({ ...gate, cpuGate: 'warn' }));
  });

  it('turns each phase into per-event counts, and a phase with no events into nothing', () => {
    assert.deepEqual(retainedEventWork(phases({ staleReads: 3 })), {
      'idle.metadataReads': 0,
      'idle.metadataCaptures': 0,
      'idle.configReads': 0,
      'stale.perEvent.metadataReads': 3,
      'stale.perEvent.configReads': 0,
      'stale.perEvent.ipc.invoke.desktop:session-snapshot': 1,
      'stale.perEvent.ipc.invoke.worktree:recovery-list': 0,
      'stale.perEvent.ipc.invoke.preferences:load': 0,
      'focus.perEvent.metadataReads': 0,
      'focus.perEvent.configReads': 0,
      'focus.perEvent.recoveryListReads': 0,
    });
    const silent = phases();
    delete silent.stale.events.perEvent;
    assert.equal(retainedEventWork(silent), null);
    // Every counter it emits is registered, as advisory until PR 2.
    const { registry } = readWorkRatchetInputs();
    for (const suffix of Object.keys(retainedEventWork(phases())))
      assert.equal(registry.metrics[`${KEY}.${suffix}`]?.status, 'advisory');
  });

  it('report-only counts never fail, even over a ceiling, and show median, min and max', () => {
    const counts = [1, 1, 1].map((reads) => run(phases({ staleReads: reads })));
    const report = judgeGate({
      counts,
      config: config(),
      inputs: inputsFor(counts[0], {
        ceilings: { 'stale.perEvent.metadataReads': 0 },
      }),
    });
    assert.equal(report.passed, true);
    const row = report.counts.rows.find(
      (entry) => entry.key === `${KEY}.stale.perEvent.metadataReads`,
    );
    assert.deepEqual(
      { status: row.status, median: row.median, min: row.min, max: row.max },
      { status: 'advisory', median: 1, min: 1, max: 1 },
    );
    assert.equal(row.outcome, 'exceeded');
  });

  it('a gating count over its ceiling fails, on the median of the runs', () => {
    const over = [0, 2, 2].map((reads) => run(phases({ staleReads: reads })));
    const gating = { 'stale.perEvent.metadataReads': 'gating' };
    const failed = judgeGate({
      counts: over,
      config: config(),
      inputs: inputsFor(over[0], {
        ceilings: { 'stale.perEvent.metadataReads': 0 },
        statuses: gating,
      }),
    });
    assert.equal(failed.passed, false);
    assert.ok(
      failed.failures.some((line) =>
        line.startsWith(`${KEY}.stale.perEvent.metadataReads: exceeded`),
      ),
    );
    const steady = [0, 0, 0].map((reads) => run(phases({ staleReads: reads })));
    assert.equal(
      judgeGate({
        counts: steady,
        config: config(),
        inputs: inputsFor(steady[0], {
          ceilings: { 'stale.perEvent.metadataReads': 0 },
          statuses: gating,
        }),
      }).passed,
      true,
    );
  });

  it('a count that varies between runs is flagged, and cannot gate', () => {
    const varying = [0, 0, 1].map((reads) =>
      run(phases({ focusReads: reads })),
    );
    const advisory = judgeGate({
      counts: varying,
      config: config(),
      inputs: inputsFor(varying[0]),
    });
    assert.equal(advisory.passed, true);
    assert.match(
      formatGateSummary(advisory),
      /`focus\.perEvent\.metadataReads` \| advisory \| 0 \| 0 \| 1 \| - \| nondeterministic \|/,
    );
    const gating = judgeGate({
      counts: varying,
      config: config(),
      inputs: inputsFor(varying[0], {
        ceilings: { 'focus.perEvent.metadataReads': 1 },
        statuses: { 'focus.perEvent.metadataReads': 'gating' },
      }),
    });
    assert.equal(gating.passed, false);
    assert.ok(
      gating.failures.some((line) => line.includes('nondeterministic')),
    );
  });

  it('a broken run is an error, not a clean zero', () => {
    const counts = [
      run(phases()),
      run(phases()),
      run(phases(), { status: 'error' }),
    ];
    const report = judgeGate({
      counts,
      config: config(),
      inputs: inputsFor(counts[0]),
    });
    assert.equal(report.passed, false);
    assert.match(report.errors.join('\n'), /counts run 3: .* failed/);
    const short = judgeGate({
      counts: counts.slice(0, 2),
      config: config(),
      inputs: inputsFor(counts[0]),
    });
    assert.match(short.errors.join('\n'), /2 run\(s\), expected 3/);
    // A run whose phases saw no events emits no retained counts, wherever
    // it falls in the order.
    const silent = phases();
    delete silent.focus.events.perEvent;
    for (const position of [0, 1, 2]) {
      const mixed = [run(phases()), run(phases()), run(phases())];
      mixed[position] = run(silent);
      const report = judgeGate({
        counts: mixed,
        config: config(),
        inputs: inputsFor(mixed[(position + 1) % 3]),
      });
      assert.equal(report.passed, false);
      assert.match(
        report.errors.join('\n'),
        new RegExp(`counts run ${position + 1}: .* emitted no retained counts`),
      );
    }
    // A launch that wrote no result reads as null and did not run.
    const missing = judgeGate({
      counts: [run(phases()), run(phases()), null],
      config: config(),
      inputs: inputsFor(counts[0]),
    });
    assert.match(missing.errors.join('\n'), /counts run 3: .* did not run/);
  });

  it('CPU is reported; it fails only when switched on and the runner calibrated as no slower than its norm', () => {
    const counts = [0, 0, 0].map(() => run(phases()));
    const cpu = [12, 14, 13].map((idleCpu) =>
      run(phases({ idleCpu }), { profile: 'baseline' }),
    );
    const inputs = inputsFor(counts[0]);
    const judge = (overrides, calibration) =>
      judgeGate({
        counts,
        cpu,
        calibration,
        config: { ...config(), ...overrides },
        inputs,
      });
    const norm = { calibration: { normMs: 100, slowMarginPercent: 25 } };

    const reported = judge({ ...norm }, { medianMs: 100 });
    assert.equal(reported.cpu.outcome, 'over');
    assert.deepEqual(
      {
        median: reported.cpu.phases.idle.median,
        min: reported.cpu.phases.idle.min,
        max: reported.cpu.phases.idle.max,
      },
      { median: 13, min: 12, max: 14 },
    );
    assert.equal(reported.passed, true, 'report mode never fails on CPU');

    assert.equal(
      judge({ ...norm, cpuGate: 'fail' }, { medianMs: 100 }).passed,
      false,
    );
    const slow = judge({ ...norm, cpuGate: 'fail' }, { medianMs: 140 });
    assert.equal(slow.cpu.calibrationState, 'slow');
    assert.equal(slow.cpu.outcome, 'inconclusive');
    assert.equal(
      slow.passed,
      true,
      'a slow runner is inconclusive, never a failure',
    );
    assert.equal(
      judge({ cpuGate: 'fail' }, { medianMs: 100 }).cpu.calibrationState,
      'no-norm',
    );
  });

  it('a CPU run that failed or wrote nothing fails the gate, while unmeasured CPU does not', () => {
    const counts = [0, 0, 0].map(() => run(phases()));
    const inputs = inputsFor(counts[0]);
    const judge = (cpu) => judgeGate({ counts, cpu, config: config(), inputs });
    const missing = judge([null, null, null]);
    assert.equal(missing.passed, false);
    assert.match(missing.errors.join('\n'), /cpu run 1: .* did not run/);
    const crashed = judge([
      run(phases(), { profile: 'baseline' }),
      run(phases(), { profile: 'baseline' }),
      run(phases(), { profile: 'baseline', status: 'error' }),
    ]);
    assert.equal(crashed.passed, false);
    assert.match(crashed.errors.join('\n'), /cpu run 3: .* failed/);
    // Runs that timed out as unresponsive, with no phase measured.
    const timedOut = judge(
      [1, 2, 3].map(() => {
        const result = run(phases(), {
          profile: 'baseline',
          status: 'unresponsive',
        });
        result.scenarios[0].counters = {};
        return result;
      }),
    );
    assert.equal(timedOut.passed, false);
    assert.match(
      timedOut.errors.join('\n'),
      /cpu run 1: .* \(unresponsive\) measured no CPU for idle, stale, focus/,
    );
    assert.equal(judge([]).passed, true, 'a PR run measures no CPU');
  });

  it('maps the stale signal counts into each phase, with idle rates as totals and a missing source as nothing', () => {
    const work = retainedEventWork(withStaleSignal(phases()));
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(work).filter(
          ([key]) => key.includes('.stale.') || key.endsWith('snapshotBuilds'),
        ),
      ),
      {
        'idle.snapshotBuilds': 1,
        'idle.stale.broadcast': 1,
        'idle.stale.requests': 2,
        'idle.stale.request.worktree-runtime-status': 2,
        'stale.perEvent.snapshotBuilds': 1,
        'stale.perEvent.stale.broadcast': 1,
        'stale.perEvent.stale.requests': 3,
        'stale.perEvent.stale.request.worktree-runtime-status': 2,
        'stale.perEvent.stale.request.structural.workspace-metadata': 1,
        'stale.perEvent.stale.chat-activity.turn-start': 0.5,
        'focus.perEvent.snapshotBuilds': 0,
        'focus.perEvent.stale.broadcast': 1,
        'focus.perEvent.stale.requests': 3,
        'focus.perEvent.stale.request.worktree-runtime-status': 2,
        'focus.perEvent.stale.request.structural.workspace-metadata': 1,
        'focus.perEvent.stale.chat-activity.turn-start': 0.5,
        'chat.perEvent.snapshotBuilds': 0.25,
        'chat.perEvent.stale.broadcast': 1,
        'chat.perEvent.stale.requests': 3,
        'chat.perEvent.stale.request.worktree-runtime-status': 2,
        'chat.perEvent.stale.request.structural.workspace-metadata': 1,
        'chat.perEvent.stale.chat-activity.turn-start': 0.5,
      },
    );
    assert.equal(work['focus.perEvent.recoveryListReads'], 1);
    assert.equal(work['chat.perEvent.metadataReads'], 0);
    // Snapshot builds are reported once, never again as a stale source.
    assert.ok(
      !Object.keys(work).some((key) => key.endsWith('.snapshot.build')),
    );
    // Every counter registered for the stale signal is emitted, as advisory.
    const { registry } = readWorkRatchetInputs();
    const registered = Object.keys(registry.metrics)
      .filter((key) => key.startsWith(`${KEY}.`))
      .map((key) => key.slice(KEY.length + 1));
    for (const suffix of registered) {
      assert.ok(suffix in work, `${suffix} is registered but not emitted`);
      assert.equal(registry.metrics[`${KEY}.${suffix}`].status, 'advisory');
    }
    // The per-source counts are reported, never judged.
    assert.equal(
      registry.metrics[
        `${KEY}.stale.perEvent.stale.request.worktree-runtime-status`
      ],
      undefined,
    );

    // A build without the stale source emits none of its counts.
    const legacy = withStaleSignal(phases());
    legacy.idle.stalePerSecond = null;
    legacy.idle.snapshotBuildsPerSecond = null;
    legacy.stale.events.perEvent.stale = null;
    legacy.stale.events.perEvent.snapshotBuilds = null;
    const without = retainedEventWork(legacy);
    assert.ok(!('idle.snapshotBuilds' in without));
    assert.ok(!('idle.stale.requests' in without));
    assert.ok(!('stale.perEvent.snapshotBuilds' in without));
    assert.ok(!('stale.perEvent.stale.broadcast' in without));
    // A run with no chat phase, such as a release-like build, drops only
    // the chat counts.
    const noChat = withStaleSignal(phases());
    noChat.chat = null;
    const partial = retainedEventWork(noChat);
    assert.ok(!Object.keys(partial).some((key) => key.startsWith('chat.')));
    assert.equal(partial['stale.perEvent.stale.requests'], 3);
  });

  it('counts every stale request source the app records, and none of the others, as a request', () => {
    const sources = tableValues(
      '../../src/main/services/desktop-session-snapshot-invalidation.ts',
      'request.',
    );
    const reasons = tableValues(
      '../../src/main/agents/session-manager.ts',
      'chat-activity.',
    );
    assert.ok(sources.length >= 20, `found ${sources.length} request sources`);
    assert.ok(reasons.length >= 3, `found ${reasons.length} activity reasons`);
    const counters = withStaleSignal(phases());
    counters.stale.events.perEvent.stale = Object.fromEntries(
      [...sources, ...reasons, 'broadcast'].map((key) => [key, 1]),
    );
    const work = retainedEventWork(counters);
    assert.equal(work['stale.perEvent.stale.requests'], sources.length);
    for (const key of [...sources, ...reasons])
      assert.equal(work[`stale.perEvent.stale.${key}`], 1);
  });

  it('warns, never fails, when recovery list reads per focus pass 1 (CAN-6934)', () => {
    const gate = config();
    assert.deepEqual(
      gate.flags.map(({ metric, above }) => ({ metric, above })),
      [{ metric: 'focus.perEvent.recoveryListReads', above: 1 }],
    );
    assert.match(gate.flags[0].reason, /CAN-6934/);
    const { registry } = readWorkRatchetInputs();
    for (const flag of gate.flags)
      assert.equal(
        registry.metrics[`${KEY}.${flag.metric}`]?.status,
        'advisory',
      );
    assert.throws(() =>
      validateGateConfig({ ...gate, flags: [{ metric: 'x', above: 1 }] }),
    );

    const judge = (reads) => {
      const counts = reads.map((value) =>
        run(withStaleSignal(phases(), { recoveryReads: value })),
      );
      return judgeGate({ counts, config: gate, inputs: inputsFor(counts[0]) });
    };
    const flag = (report) => report.flags[0];
    assert.equal(flag(judge([1, 1, 1])).outcome, 'ok');
    const over = judge([1.01, 1.01, 1.01]);
    assert.deepEqual(
      { outcome: flag(over).outcome, median: flag(over).median },
      { outcome: 'flagged', median: 1.01 },
    );
    assert.equal(over.passed, true, 'a watched count warns, never fails');
    const summary = formatGateSummary(over);
    assert.match(
      summary,
      /- Warning: focus\.perEvent\.recoveryListReads is 1\.01, above 1: .*CAN-6934/,
    );
    assert.match(
      summary,
      /`focus\.perEvent\.recoveryListReads` \| 1\.01 \| 1 \| flagged \|/,
    );
    // A nightly run names the flagged value and the commits it covers, and
    // still passes.
    const nightlyCounts = [1.5, 1.5, 1.5].map((value) =>
      run(withStaleSignal(phases(), { recoveryReads: value })),
    );
    const nightly = judgeGate({
      counts: nightlyCounts,
      config: gate,
      inputs: inputsFor(nightlyCounts[0]),
      commitRange: '1111111aaaa..2222222bbbb',
    });
    assert.equal(nightly.passed, true);
    assert.match(
      formatGateSummary(nightly),
      /- Warning: focus\.perEvent\.recoveryListReads is 1\.5, above 1: .*CAN-6934\. Commits in this run's window: 1111111aaaa\.\.2222222bbbb\./,
    );
    // The median decides: one run over the line is not a flag.
    assert.equal(flag(judge([1, 1, 3])).outcome, 'ok');
    // A run without the metadata source has no count, which is not a pass.
    const legacy = [1, 2, 3].map(() => {
      const counters = withStaleSignal(phases());
      counters.focus.events.perEvent.metadata = null;
      return run(counters);
    });
    const missing = judgeGate({
      counts: legacy,
      config: gate,
      inputs: inputsFor(legacy[0]),
    });
    assert.deepEqual(
      { outcome: flag(missing).outcome, median: flag(missing).median },
      { outcome: 'missing', median: null },
    );
  });

  it('a PR event that skips the gate gets a neutral not-run check, and only ci:run plus a gate path starts it', () => {
    const workflow = readFileSync(
      new URL(
        '../../../../.github/workflows/desktop-perf-retained-worktrees.yml',
        import.meta.url,
      ),
      'utf8',
    );
    const job = (id) => {
      const start = workflow.indexOf(`\n  ${id}:\n`);
      assert.ok(start >= 0, `${id} job exists`);
      const rest = workflow.slice(start + 1);
      const next = rest.slice(1).search(/\n {2}[a-z-]+:\n/);
      return next < 0 ? rest : rest.slice(0, next + 1);
    };
    const changes = job('changes');
    const gate = job('gate');
    // The change check runs on every PR event, so it can say why the gate
    // didn't run, and it alone may write checks.
    assert.match(
      changes,
      /if: \$\{\{ github\.event_name == 'pull_request' \}\}\n/,
    );
    assert.match(changes, /checks: write/);
    assert.doesNotMatch(gate, /checks: write/);
    assert.match(changes, /conclusion=neutral/);
    assert.match(changes, /not_run='Retained worktrees gate \(not run\)'/);
    // In either order: a not-run check is retired once the gate runs on
    // that head, and updated rather than duplicated by a later skip.
    assert.match(
      changes,
      /if \[\[ "\$REQUESTED" == true && "\$GATE_PATHS" == true \]\]; then\n\s+for id in \$existing; do\n\s+gh api -X PATCH "repos\/\$REPO\/check-runs\/\$id" \\\n\s+-f conclusion=skipped/,
    );
    assert.match(
      changes,
      /if \[\[ -n "\$existing" \]\]; then\n\s+for id in \$existing; do\n\s+gh api -X PATCH/,
    );
    // An event running alongside a requested run, such as another label
    // added with ci:run, writes nothing, before it could post a check.
    assert.match(
      changes,
      /HAS_CI_RUN: \$\{\{ contains\(github\.event\.pull_request\.labels\.\*\.name, 'ci:run'\) \}\}/,
    );
    const covered = changes.indexOf(
      'if [[ "$HAS_CI_RUN" == true && "$GATE_PATHS" == true ]]; then',
    );
    assert.ok(covered > 0, 'a covered head writes no not-run check');
    assert.ok(
      covered < changes.indexOf('gh api -X POST "repos/$REPO/check-runs"'),
      'the covered-head exit comes before any post',
    );
    // The gate still needs both ci:run and a changed gate path on a PR.
    assert.match(
      gate,
      /needs\.changes\.outputs\.requested == 'true' && needs\.changes\.outputs\.gate == 'true'\)\) \}\}/,
    );
    assert.match(
      changes,
      /REQUESTED: \$\{\{ \(github\.event\.action == 'labeled' && github\.event\.label\.name == 'ci:run'\) \|\| \(github\.event\.action != 'labeled' && contains\(github\.event\.pull_request\.labels\.\*\.name, 'ci:run'\)\) \}\}/,
    );
    // The nightly and dispatch runs are unchanged.
    assert.match(workflow, /schedule:\n {4}- cron: '23 3 \* \* \*'/);
    assert.match(workflow, /workflow_dispatch:/);
    // A flagged nightly names its merge window without failing the run.
    assert.match(
      gate,
      /--commit-range "\$\{LAST_GREEN:0:11\}\.\.\$\{HEAD_SHA:0:11\}"/,
    );
    assert.match(
      gate,
      /name: Name the merge window\n {8}if: \$\{\{ !cancelled\(\) && github\.event_name == 'schedule' && \(failure\(\) \|\| steps\.judge\.outputs\.flagged == 'true'\) \}\}/,
    );
  });

  it('the summary names the sources behind each event', () => {
    const counts = [2, 2, 2].map((reads) => run(phases({ staleReads: reads })));
    const summary = formatGateSummary(
      judgeGate({ counts, config: config(), inputs: inputsFor(counts[0]) }),
    );
    assert.match(summary, /#### stale per signal/);
    assert.match(summary, /`read\.manifest\.project` \| 2 \| 2 \| 2 \|/);
    assert.match(
      summary,
      /`invoke\.desktop:session-snapshot` \| 1 \| 1 \| 1 \|/,
    );
    assert.match(summary, /#### idle W5 per second/);
    assert.match(summary, /Not measured in this run\./);

    // The stale signal by the source that asked, per event and while idle,
    // and the per-source counts reported outside the judged table.
    const signalled = [1, 2, 3].map(() => run(withStaleSignal(phases())));
    const detailed = formatGateSummary(
      judgeGate({
        counts: signalled,
        config: config(),
        inputs: inputsFor(signalled[0]),
      }),
    );
    assert.match(
      detailed,
      /`stale\.request\.worktree-runtime-status` \| 2 \| 2 \| 2 \|/,
    );
    assert.match(detailed, /#### chat per provider event/);
    assert.match(detailed, /#### idle stale signal per second/);
    assert.match(
      detailed,
      /\d+ more counts, such as the stale signal by source, are reported, never judged/,
    );
    assert.doesNotMatch(
      detailed,
      /\| `stale\.perEvent\.stale\.request\.worktree-runtime-status` \| unregistered/,
    );
  });
});

// CAN-7148: the blocking matched run for workspace-state changes. One
// interleaved before/after run at the 170 tier, judged on three idle signals;
// only a significant REGRESSED signal fails, and only when no accepted
// regression with a named approver and a dated follow-up covers it.

// Main's count of worktree list writes, on every store (CAN-5532 counters).
const LIST_WRITE = 'replace.worktrees';

function idle({ cpu = 4, reads = 1, captures = 0.5, listCommits = 0 } = {}) {
  return {
    seconds: 60,
    mainCpuPercentOfCore: cpu,
    metadataReadsPerSecond: reads,
    metadataCapturesPerSecond: captures,
    metadataPerSecond: { 'config.read': 0.1 },
    w5PerSecond: listCommits ? { [LIST_WRITE]: listCommits } : {},
  };
}

function side(
  phases,
  {
    runId = 'run-1',
    profile = 'stress',
    worktrees = 170,
    commit = 'a'.repeat(40),
    dirty = false,
    statuses = [],
  } = {},
) {
  return {
    profile,
    config: { retainedWorktrees: worktrees },
    source: { commit: 'd'.repeat(40), measuredBuild: { commit, dirty } },
    environment: {
      platform: 'darwin',
      architecture: 'arm64',
      cpuModel: 'Apple M2',
    },
    repeat: { count: phases.length, interleaved: { runId } },
    scenarios: phases.map((phase, sample) => ({
      name: SCENARIO,
      status: statuses[sample] ?? 'ok',
      sample,
      counters: { idle: phase },
    })),
  };
}

const cpus = (values) => values.map((cpu) => idle({ cpu }));
const STEADY = [4, 4.2, 3.9, 4.1, 4];
const HOT = [6, 6.2, 5.9, 6.1, 6];

// Blocking unless an override says otherwise, so the documented rollback
// (live matched.gate "report") leaves these behaviour checks unchanged.
function matchedConfig(overrides = {}) {
  const gate = config();
  return {
    ...gate,
    matched: { ...gate.matched, gate: 'block', ...overrides },
  };
}

const accepted = (overrides = {}) => ({
  pr: 9850,
  signals: ['mainCpuIdlePercent'],
  approver: 'Mike',
  approvedOn: '2026-11-17',
  followUp: { ticket: 'CAN-7200', due: '2026-12-15' },
  reason: 'Counting W5 reads in packaged builds costs idle CPU until CAN-7200.',
  ...overrides,
});

describe('retained-worktrees matched gate (CAN-7148)', () => {
  it('judges at the 170 tier on exactly the three idle signals, with samples enough to ever reach significance', () => {
    const { matched } = config();
    // "report" is the documented rollback; both are supported live modes.
    assert.ok(['block', 'report'].includes(matched.gate), matched.gate);
    assert.equal(matched.profile, 'stress');
    assert.equal(matched.retainedWorktrees, 170);
    assert.deepEqual(
      matched.signals.map((signal) => signal.id),
      Object.keys(MATCHED_SIGNALS),
    );
    assert.deepEqual(Object.keys(MATCHED_SIGNALS), [
      'mainCpuIdlePercent',
      'w5MetadataReadsAndCapturesPerSecond',
      'worktreeListCommitsPerMinute',
    ]);
    assert.deepEqual(matchedDriverArgs(config()), [
      '--profile',
      'stress',
      '--scenarios',
      SCENARIO,
      '--repeat',
      String(matched.repeat),
      '--warmup',
      String(matched.warmup),
      '--order',
      'abba',
    ]);
    const invalid = (overrides) =>
      assert.throws(() => validateGateConfig(matchedConfig(overrides)));
    // Four samples per side can never pass a Holm step over three signals.
    invalid({ repeat: 4 });
    invalid({ gate: 'warn' });
    invalid({ signals: matched.signals.slice(1) });
    invalid({
      signals: matched.signals.map((signal, index) =>
        index === 0 ? { ...signal, minEffectAbsolute: 0 } : signal,
      ),
    });
    const gate = config();
    delete gate.matched;
    assert.throws(() => validateGateConfig(gate), /matched section/);
  });

  it('reads the signals from the idle phase: CPU, reads plus captures, and list commits per minute', () => {
    const phase = idle({
      cpu: 7.5,
      reads: 2.25,
      captures: 0.5,
      listCommits: 0.05,
    });
    assert.equal(MATCHED_SIGNALS.mainCpuIdlePercent(phase), 7.5);
    assert.equal(
      MATCHED_SIGNALS.w5MetadataReadsAndCapturesPerSecond(phase),
      2.75,
    );
    assert.equal(MATCHED_SIGNALS.worktreeListCommitsPerMinute(phase), 3);
    assert.equal(MATCHED_SIGNALS.worktreeListCommitsPerMinute(idle()), 0);

    // From main's counter snapshots, as the scenario reads them: two list
    // writes and a host commit label in one idle minute.
    const sample = (at, cpu, w5) => ({
      at,
      cpu: { user: cpu, system: 0 },
      w5,
      ipc: {},
      metadata: {},
    });
    const rates = retainedIdleRates(
      sample(0, 0, { 'replace.worktrees': 1, 'read.index.view': 0 }),
      sample(60_000, 3_000_000, {
        'replace.worktrees': 3,
        'host.commit.w5.worktree_list.write': 5,
        'read.index.view': 120,
        'readView.captured': 30,
      }),
    );
    assert.equal(MATCHED_SIGNALS.mainCpuIdlePercent(rates), 5);
    assert.equal(
      MATCHED_SIGNALS.w5MetadataReadsAndCapturesPerSecond(rates),
      2.5,
    );
    assert.equal(MATCHED_SIGNALS.worktreeListCommitsPerMinute(rates), 2);
  });

  it('identical and noisy runs are inconclusive and pass; a credible regression in any signal fails', () => {
    const judge = (baseline, candidate, overrides) =>
      judgeMatched({
        baseline: side(baseline),
        candidate: side(candidate),
        config: matchedConfig(overrides),
        pr: 1,
      });
    const same = judge(cpus(STEADY), cpus(STEADY));
    assert.equal(same.passed, true);
    assert.equal(same.verdict, 'inconclusive');
    const noisy = judge(cpus(STEADY), cpus([3.8, 6, 4.2, 7, 4]));
    assert.equal(noisy.passed, true, 'an overlapping shift is inconclusive');
    const small = judge(cpus(STEADY), cpus(STEADY.map((cpu) => cpu + 0.5)));
    assert.equal(small.passed, true);
    assert.equal(small.signals[0].reason, 'below-effect-floor');
    const better = judge(cpus(HOT), cpus(STEADY));
    assert.equal(better.passed, true);
    assert.equal(better.signals[0].verdict, 'improved');

    const hot = judge(cpus(STEADY), cpus(HOT));
    assert.equal(hot.passed, false);
    assert.deepEqual(hot.failures, ['mainCpuIdlePercent']);
    const summary = formatMatchedSummary(hot);
    assert.match(summary, /## Retained-worktrees matched gate: FAIL/);
    assert.match(
      summary,
      /- Failed: Main CPU at idle REGRESSED \(p50 4 -> 6 % of one core\)\. To merge anyway, add an accepted regression for PR #1/,
    );
    const reads = judge(
      [1, 1, 1, 1, 1].map((value) => idle({ reads: value })),
      [3, 3, 3, 3, 3].map((value) => idle({ reads: value })),
    );
    assert.deepEqual(reads.failures, ['w5MetadataReadsAndCapturesPerSecond']);
    const commits = judge(
      cpus(STEADY),
      STEADY.map((cpu) => idle({ cpu, listCommits: 0.05 })),
    );
    assert.deepEqual(commits.failures, ['worktreeListCommitsPerMinute']);
    // gate 'report' is the rollback: it judges and never fails.
    const reported = judge(cpus(STEADY), cpus(HOT), { gate: 'report' });
    assert.equal(reported.passed, true);
    assert.match(formatMatchedSummary(reported), /pass \(report only\)/);
    assert.match(
      formatMatchedSummary(reported),
      /- Reported: Main CPU at idle REGRESSED/,
    );
  });

  it('a regression passes only with an accepted regression for this PR and signal, with a named approver and a dated follow-up', () => {
    const judge = (entries, pr = 9850) =>
      judgeMatched({
        baseline: side(cpus(STEADY)),
        candidate: side(cpus(HOT)),
        config: matchedConfig({ acceptedRegressions: entries }),
        pr,
      });
    const ok = judge([accepted()]);
    assert.equal(ok.passed, true);
    assert.deepEqual(ok.accepted, ['mainCpuIdlePercent']);
    assert.match(
      formatMatchedSummary(ok),
      /- Accepted: Main CPU at idle REGRESSED .* accepted for PR #9850 by Mike on 2026-11-17; follow-up CAN-7200 due 2026-12-15\./,
    );
    assert.equal(judge([accepted()], 9851).passed, false, 'another PR');
    assert.equal(judge([accepted()], null).passed, false, 'no PR');
    assert.equal(
      judge([accepted({ signals: ['worktreeListCommitsPerMinute'] })]).passed,
      false,
      'another signal',
    );
    for (const broken of [
      accepted({ approver: '' }),
      accepted({ approver: 'TBD' }),
      accepted({ approver: '<name>' }),
      accepted({ followUp: undefined }),
      accepted({ followUp: { ticket: 'CAN-7200' } }),
      accepted({ followUp: { due: '2026-12-15' } }),
      accepted({ followUp: { ticket: 'later', due: '2026-12-15' } }),
      accepted({ followUp: { ticket: 'CAN-7200', due: '2026-11-01' } }),
      accepted({ followUp: { ticket: 'CAN-7200', due: '2026-02-30' } }),
      accepted({ approvedOn: '17/11/2026' }),
      accepted({ signals: [] }),
      accepted({ signals: ['mainCpu'] }),
      accepted({ pr: undefined }),
      accepted({ reason: '' }),
    ])
      assert.throws(
        () =>
          validateGateConfig(matchedConfig({ acceptedRegressions: [broken] })),
        undefined,
        JSON.stringify(broken),
      );
  });

  it('a broken or mismatched run is an error that a blocking gate never passes', () => {
    const judge = (baseline, candidate) =>
      judgeMatched({ baseline, candidate, config: matchedConfig(), pr: 1 });
    const good = () => side(cpus(STEADY));
    const failsWith = (report, pattern) => {
      assert.equal(report.passed, false);
      assert.match(report.errors.join('\n'), pattern);
    };
    failsWith(judge(null, good()), /baseline: no result/);
    // Under the report-only rollback a broken run is still reported, not failed.
    const reportOnly = judgeMatched({
      baseline: null,
      candidate: good(),
      config: matchedConfig({ gate: 'report' }),
      pr: 1,
    });
    assert.equal(reportOnly.passed, true);
    assert.match(
      formatMatchedSummary(reportOnly),
      /gate: pass \(report only\)[\s\S]*- Error: baseline: no result/,
    );
    failsWith(
      judge(good(), side(cpus(STEADY), { profile: 'baseline' })),
      /profile baseline, expected stress/,
    );
    failsWith(
      judge(good(), side(cpus(STEADY), { worktrees: 110 })),
      /110 retained worktrees, expected 170/,
    );
    failsWith(
      judge(good(), side(cpus(STEADY.slice(0, 4)))),
      /4 sample\(s\) .* expected at least 5/,
    );
    failsWith(
      judge(good(), side(cpus(STEADY), { runId: 'run-2' })),
      /not the two sides of one interleaved run/,
    );
    const crashed = side(cpus(STEADY));
    crashed.scenarios[2] = {
      ...crashed.scenarios[2],
      status: 'error',
      error: 'boom',
    };
    failsWith(judge(good(), crashed), /candidate sample 3: .* failed: boom/);
    const uncounted = side(cpus(STEADY));
    uncounted.scenarios[0].counters.idle.metadataPerSecond = null;
    failsWith(
      judge(uncounted, good()),
      /baseline sample 1: no idle work counters/,
    );
    const unmeasured = side(cpus(STEADY));
    unmeasured.scenarios[1].counters.idle.mainCpuPercentOfCore = null;
    failsWith(
      judge(good(), unmeasured),
      /candidate sample 2: measured no mainCpuIdlePercent/,
    );
    // An unresponsive sample still measured its idle window: kept, noted.
    const slow = judge(
      good(),
      side(cpus(STEADY), { statuses: ['unresponsive'] }),
    );
    assert.equal(slow.passed, true);
    assert.deepEqual(slow.notes, ['candidate sample 1: unresponsive']);
  });

  it('records the develop baseline only from a clean A/A run of one commit', () => {
    const run = (candidate = side(cpus(STEADY))) => {
      const sides = { baseline: side(cpus(STEADY)), candidate };
      return {
        sides,
        report: judgeMatched({ ...sides, config: matchedConfig() }),
      };
    };
    const { sides, report } = run();
    const record = developBaselineRecord(report, sides);
    assert.equal(record.commit, 'a'.repeat(40));
    assert.equal(record.samplesPerSide, 5);
    assert.equal(record.signals.mainCpuIdlePercent.candidate.p50, 4);
    assert.doesNotThrow(() =>
      validateGateConfig(matchedConfig({ baseline: record })),
    );
    // The run's own date and a host note survive a later recording.
    const finished = side(cpus(STEADY));
    finished.completedAt = '2026-11-17T23:10:00.000Z';
    const later = run(finished);
    const noted = developBaselineRecord(later.report, later.sides, {
      note: 'computer A, not a quiet host',
    });
    assert.equal(noted.measuredOn, '2026-11-17');
    assert.equal(noted.note, 'computer A, not a quiet host');
    assert.match(
      formatMatchedSummary(
        judgeMatched({
          ...later.sides,
          config: matchedConfig({ baseline: noted }),
        }),
      ),
      /Develop baseline: a{11} on 2026-11-17 \(darwin-arm64 Apple M2; computer A, not a quiet host\)/,
    );
    const other = run(side(cpus(STEADY), { commit: 'b'.repeat(40) }));
    assert.throws(
      () => developBaselineRecord(other.report, other.sides),
      /same checkout/,
    );
    const dirty = run(side(cpus(STEADY), { dirty: true }));
    assert.throws(
      () => developBaselineRecord(dirty.report, dirty.sides),
      /same checkout/,
    );
    const flagged = run(side(cpus(HOT)));
    assert.throws(
      () => developBaselineRecord(flagged.report, flagged.sides),
      /review the floors/,
    );
    assert.throws(() =>
      validateGateConfig(
        matchedConfig({ baseline: { ...record, commit: 'develop' } }),
      ),
    );
  });

  it('records the develop baseline from one clean side of a matched run, and refuses a dirty side, a wrong tier or a run with errors', () => {
    const develop = 'a'.repeat(40);
    const merge = 'b'.repeat(40);
    const run = (baseline, candidate = side(cpus(HOT), { commit: merge })) => {
      const sides = { baseline, candidate };
      return {
        sides,
        report: judgeMatched({ ...sides, config: matchedConfig() }),
      };
    };
    const record = (attempt, options = {}) =>
      developBaselineRecord(attempt.report, attempt.sides, {
        side: 'baseline',
        run: '44187923537',
        note: 'hosted macOS runner',
        ...options,
      });
    const finished = (result) => {
      result.completedAt = '2026-11-17T23:14:51.307Z';
      return result;
    };
    const clean = run(finished(side(cpus(STEADY), { commit: develop })));
    // The other side is a different commit and may even have regressed.
    assert.deepEqual(clean.report.failures, ['mainCpuIdlePercent']);
    const recorded = record(clean);
    assert.deepEqual(
      {
        commit: recorded.commit,
        side: recorded.side,
        pairedCommit: recorded.pairedCommit,
        run: recorded.run,
        measuredOn: recorded.measuredOn,
        samplesPerSide: recorded.samplesPerSide,
        cpu: recorded.signals.mainCpuIdlePercent,
      },
      {
        commit: develop,
        side: 'baseline',
        pairedCommit: merge,
        run: '44187923537',
        measuredOn: '2026-11-17',
        samplesPerSide: 5,
        cpu: {
          baseline: { p50: 4, p75: 4.1, max: 4.2 },
          candidate: { p50: 6, p75: 6.1, max: 6.2 },
        },
      },
    );
    assert.match(
      formatMatchedSummary(
        judgeMatched({
          ...clean.sides,
          config: matchedConfig({ baseline: recorded }),
        }),
      ),
      /Develop baseline: a{11} on 2026-11-17 \(darwin-arm64 Apple M2; hosted macOS runner\), the baseline side of run 44187923537 against b{11}, 5 samples per side, regressed; main CPU at idle p50 4%\./,
    );
    assert.throws(
      () =>
        validateGateConfig(
          matchedConfig({ baseline: { ...recorded, run: '' } }),
        ),
      /needs run/,
    );
    assert.throws(
      () =>
        validateGateConfig(
          matchedConfig({ baseline: { ...recorded, note: undefined } }),
        ),
      /needs a note/,
    );
    // CI's job summary links the run; the config keeps only its id.
    assert.match(
      formatMatchedSummary(
        judgeMatched({
          ...clean.sides,
          config: matchedConfig({ baseline: recorded }),
        }),
        { repositoryUrl: 'https://example.test/owner/repo' },
      ),
      /the baseline side of \[run 44187923537\]\(https:\/\/example\.test\/owner\/repo\/actions\/runs\/44187923537\) against b{11}/,
    );
    const url = 'https://example.test/owner/repo/actions/runs/44187923537';
    assert.throws(
      () =>
        validateGateConfig(
          matchedConfig({ baseline: { ...recorded, run: url } }),
        ),
      /needs run, the run's numeric id/,
    );
    assert.throws(
      () =>
        validateGateConfig(
          matchedConfig({ baseline: { ...recorded, run: 44187923537 } }),
        ),
      /needs run, the run's numeric id as a string/,
    );
    assert.throws(() => record(clean, { run: url }), /--side needs --run/);
    assert.throws(() => record(clean, { run: '0' }), /--side needs --run/);
    assert.throws(() => record(clean, { run: null }), /--side needs --run/);
    assert.throws(() => record(clean, { note: ' ' }), /--side needs --note/);
    assert.throws(() => record(clean, { side: 'develop' }), /--side must be/);
    assert.throws(
      () => record(run(side(cpus(STEADY), { commit: develop }))),
      /baseline side has no completedAt date/,
    );

    assert.throws(
      () => record(run(finished(side(cpus(STEADY), { dirty: true })))),
      /baseline side did not measure one clean commit/,
    );
    // A clean checkout whose launched bundle was built dirty is not clean.
    const rebuilt = finished(side(cpus(STEADY)));
    rebuilt.source.bundleIdentity = {
      status: 'mismatch',
      reasons: ['dirty-build'],
    };
    assert.throws(
      () => record(run(rebuilt)),
      /baseline side did not measure one clean commit/,
    );
    // Both sides on one commit is still an A/A run: REGRESSED is refused.
    assert.throws(
      () => record(run(finished(side(cpus(STEADY))), side(cpus(HOT)))),
      /Identical builds came out REGRESSED in mainCpuIdlePercent/,
    );
    assert.throws(
      () => record(run(side(cpus(STEADY), { worktrees: 110 }))),
      /Not a clean run: .*110 retained worktrees, expected 170/,
    );
    assert.throws(
      () => record(run(side(cpus(STEADY), { profile: 'baseline' }))),
      /Not a clean run: .*profile baseline, expected stress/,
    );
    assert.throws(
      () => record(run(side(cpus(STEADY.slice(0, 4))))),
      /Not a clean run: .*4 sample\(s\)/,
    );
    // An error anywhere in the run refuses it, even on the other side.
    const crashed = side(cpus(STEADY), { commit: merge });
    crashed.scenarios[1] = { ...crashed.scenarios[1], status: 'error' };
    assert.throws(
      () => record(run(side(cpus(STEADY)), crashed)),
      /Not a clean run: candidate sample 2/,
    );
  });
});
