import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildScenarioMetrics } from './results.mjs';
import {
  formatGateSummary,
  judgeGate,
  readGateConfig,
  validateGateConfig,
} from './retained-worktrees-gate.mjs';
import { retainedEventWork } from './retained-worktrees.mjs';
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
  });
});
