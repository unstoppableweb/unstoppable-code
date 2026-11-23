/// Shared with Remote Control. Computer Connect uses the Rust port in
/// cc-domain::pipelines::presentation (status words, guards, groups, dot
/// tiers) with its words in cc-app copy::pipelines; the shared widgets
/// still draw with these helpers for both apps. Keep both in step until
/// cleanup C5.
library;

import 'package:flutter/material.dart';
import 'package:mobile/data/models/computer_activity/pipeline_run.dart';
import 'package:mobile/ui/core/status_colors.dart';

import 'pipeline_run_status.dart';

export 'pipeline_run_status.dart';

/// Pure presentation helpers for pipeline runs, kept out of the widgets so
/// the status vocabulary and the action guards are unit-testable.
///
/// The guards are a direct port of `packages/ui-shared/src/lib/
/// execution-actions.ts`; keep them in step with that file.

/// Run and step statuses share one color vocabulary, matching desktop:
/// running is the active accent, paused is the attention color, a failure is
/// always red and a success always green.
Color pipelineRunStatusColor(String status, StatusColors colors) =>
    switch (normalizePipelineRunStatus(status)) {
      'running' || 'restarting' => colors.active,
      'paused' => colors.warning,
      'success' => colors.success,
      'failure' => colors.failed,
      'pending' || 'queued' || 'skipped' => colors.quaternary,
      _ => colors.neutral,
    };

String pipelineRunStatusLabel(String status) =>
    switch (normalizePipelineRunStatus(status)) {
      'running' => 'Running',
      'restarting' => 'Restarting',
      'paused' => 'Paused',
      'success' => 'Succeeded',
      'failure' => 'Failed',
      'cancelled' => 'Canceled',
      'pending' || 'queued' => 'Queued',
      'skipped' => 'Skipped',
      '' => 'Unknown',
      _ => status,
    };

/// An absent trigger falls back to manual, matching the renderer.
IconData pipelineTriggerIcon(String? trigger) => switch (trigger) {
  'hook' => Icons.bolt_outlined,
  'chat' => Icons.chat_bubble_outline,
  'plan' => Icons.map_outlined,
  _ => Icons.play_arrow_outlined,
};

String pipelineTriggerLabel(String? trigger) => switch (trigger) {
  'hook' => 'Started by a hook',
  'chat' => 'Started from a chat',
  'plan' => 'Started from a plan',
  _ => 'Started manually',
};

bool canCancelPipelineRun(RemotePipelineRun run) =>
    isPipelineRunActive(run.status);

/// A paused root run, unless the desktop is waiting for input: the phone
/// cannot answer an input checkpoint, and a resume without answers would not
/// release it. This matches the desktop row, which only offers Resume from
/// the preview when no input is requested.
bool canResumePipelineRun(RemotePipelineRun run) =>
    run.isRoot &&
    normalizePipelineRunStatus(run.status) == 'paused' &&
    !run.pendingPauses.any((pause) => pause.kind == 'input');

bool canRetryPipelineRun(RemotePipelineRun run) =>
    run.isRoot &&
    switch (normalizePipelineRunStatus(run.status)) {
      'failure' || 'cancelled' => true,
      _ => false,
    };

/// `42s`, `3m 7s`, `1h 2m` — the coarsest two units, so the value stays
/// readable in a row. Empty when there is no start time to measure from.
String formatPipelineRunDuration(DateTime? startedAt, DateTime? until) {
  if (startedAt == null || until == null) return '';
  final elapsed = until.difference(startedAt);
  if (elapsed.isNegative) return '';
  final hours = elapsed.inHours;
  final minutes = elapsed.inMinutes % 60;
  final seconds = elapsed.inSeconds % 60;
  if (hours > 0) return '${hours}h ${minutes}m';
  if (minutes > 0) return '${minutes}m ${seconds}s';
  return '${seconds}s';
}

/// One step row, carrying the PHYSICAL job id its log request needs — a
/// matrix variant's own id, never its logical parent's.
class PipelineRunStepEntry {
  const PipelineRunStepEntry({required this.jobId, required this.step});

  final String jobId;
  final RemotePipelineRunStep step;
}

/// One expandable group in the run tree: a job, or a matrix variant nested
/// one level under it.
class PipelineRunGroup {
  const PipelineRunGroup({
    required this.jobId,
    required this.name,
    required this.status,
    required this.depth,
    required this.isVariant,
    required this.steps,
  });

  final String jobId;
  final String name;
  final String status;

  /// 0 for a job, 1 for a matrix variant. One level is the ceiling the
  /// portal wire supports.
  final int depth;
  final bool isVariant;
  final List<PipelineRunStepEntry> steps;
}

/// Flattens the run tree into ordered groups: each job, followed by its
/// matrix variants.
List<PipelineRunGroup> buildPipelineRunGroups(
  List<RemotePipelineRunJob> jobs,
) => [
  for (final job in jobs) ...[
    PipelineRunGroup(
      jobId: job.jobId,
      name: job.name,
      status: job.status,
      depth: 0,
      isVariant: false,
      steps: [
        for (final step in job.steps)
          PipelineRunStepEntry(jobId: job.jobId, step: step),
      ],
    ),
    for (final variant in job.variants)
      PipelineRunGroup(
        jobId: variant.jobId,
        name: variant.name,
        status: variant.status,
        depth: 1,
        isVariant: true,
        steps: [
          for (final step in variant.steps)
            PipelineRunStepEntry(jobId: variant.jobId, step: step),
        ],
      ),
  ],
];

/// The desktop progress-dot vocabulary (`DagJobStatus` in
/// `packages/ui-shared/src/components/DagProgressBar.tsx`).
enum PipelineRunDotStatus {
  pending,
  running,
  success,
  failure,
  paused,
  cancelled,
  skipped,
}

PipelineRunDotStatus pipelineRunDotStatus(String status) =>
    switch (normalizePipelineRunStatus(status)) {
      'running' || 'restarting' => PipelineRunDotStatus.running,
      'success' => PipelineRunDotStatus.success,
      'failure' => PipelineRunDotStatus.failure,
      'paused' => PipelineRunDotStatus.paused,
      'cancelled' => PipelineRunDotStatus.cancelled,
      'skipped' => PipelineRunDotStatus.skipped,
      _ => PipelineRunDotStatus.pending,
    };

/// One progress dot: a logical job. A matrix job is one dot carrying its
/// group status, exactly as on the desktop.
class PipelineRunDot {
  const PipelineRunDot({
    required this.jobId,
    required this.name,
    required this.status,
  });

  final String jobId;
  final String name;
  final PipelineRunDotStatus status;
}

/// Lays a run's jobs out in dependency tiers, the grouping the desktop's
/// progress dots use: jobs that can run in parallel share a group, and a job
/// that needs another starts a later one. A port of the portal's
/// `buildTiers` (`packages/ui-app/src/code/activity/sections/
/// PipelineRunsSection.tsx`) over `computeDagTiers`
/// (`packages/ui-shared/src/lib/dag-tiers.ts`); keep them in step.
///
/// When no job carries `needs` (an older desktop) every job is one group,
/// since claiming they all run in parallel would be a guess.
List<List<PipelineRunDot>> buildPipelineRunDotTiers(
  List<RemotePipelineRunJob> jobs,
) {
  if (jobs.isEmpty) return const [];
  final byId = {for (final job in jobs) job.jobId: job};
  PipelineRunDot dotFor(RemotePipelineRunJob job) => PipelineRunDot(
    jobId: job.jobId,
    name: job.name,
    status: pipelineRunDotStatus(job.status),
  );
  if (jobs.every((job) => job.needs == null)) {
    return [
      [for (final job in byId.values) dotFor(job)],
    ];
  }
  // Dependencies on jobs absent from this run (e.g. one that never
  // expanded) are dropped, or the missing id would read as a depth-0 node
  // and inflate every dependent's tier.
  final needs = {
    for (final job in byId.values)
      job.jobId: [
        for (final id in job.needs ?? const <String>[])
          if (byId.containsKey(id) && id != job.jobId) id,
      ],
  };
  // Insertion-ordered, like the JS `Map`: recursion records a dependency's
  // level before its dependent's, which fixes the order within a tier.
  final levels = <String, int>{};
  int levelOf(String jobId, Set<String> visiting) {
    final cached = levels[jobId];
    if (cached != null) return cached;
    final deps = needs[jobId] ?? const <String>[];
    // A cycle falls back to the first tier rather than recursing forever.
    if (visiting.contains(jobId) || deps.isEmpty) return levels[jobId] = 0;
    visiting.add(jobId);
    var level = 0;
    for (final dep in deps) {
      final depLevel = levelOf(dep, visiting) + 1;
      if (depLevel > level) level = depLevel;
    }
    return levels[jobId] = level;
  }

  for (final jobId in byId.keys) {
    levelOf(jobId, <String>{});
  }
  final tiers = <List<PipelineRunDot>>[];
  levels.forEach((jobId, level) {
    while (tiers.length <= level) {
      tiers.add([]);
    }
    tiers[level].add(dotFor(byId[jobId]!));
  });
  return [
    for (final tier in tiers)
      if (tier.isNotEmpty) tier,
  ];
}
