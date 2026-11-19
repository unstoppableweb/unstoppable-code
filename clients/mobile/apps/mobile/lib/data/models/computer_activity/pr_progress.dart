/// Mobile mirrors of the portal PR progress feeds carried on the `pr_status`
/// entity: `RemoteControlPrCreationProgress` and `RemoteControlMergePrProgress` in
/// `packages/protocol/src/remote-control/shell/index.ts`.
///
/// Parsing is deliberately lenient. A desktop host newer than this client can
/// emit phases we do not know; an unknown step phase is dropped and an unknown
/// overall phase makes the whole feed unrenderable (null) rather than throwing.
library;

int? _intOrNull(Object? value) => value is int ? value : null;

String? _stringOrNull(Object? value) =>
    value is String && value.isNotEmpty ? value : null;

/// One step of either feed, as consumed by the phase-status derivation.
abstract interface class RemoteProgressStep {
  String get wirePhase;
  String? get error;
}

enum RemotePrCreationPhase {
  gatheringChanges('gathering_changes'),
  summarizing('summarizing'),
  pushing('pushing'),
  creatingPr('creating_pr'),
  skipped('skipped'),
  done('done'),
  error('error');

  const RemotePrCreationPhase(this.wireValue);
  final String wireValue;

  static RemotePrCreationPhase? fromWire(Object? value) {
    for (final phase in RemotePrCreationPhase.values) {
      if (phase.wireValue == value) return phase;
    }
    return null;
  }
}

enum RemoteMergePrPhase {
  queued('queued'),
  checkingMergeability('checking_mergeability'),
  waitingMergeability('waiting_mergeability'),
  merging('merging'),
  refreshingPrStatus('refreshing_pr_status'),
  done('done'),
  error('error');

  const RemoteMergePrPhase(this.wireValue);
  final String wireValue;

  static RemoteMergePrPhase? fromWire(Object? value) {
    for (final phase in RemoteMergePrPhase.values) {
      if (phase.wireValue == value) return phase;
    }
    return null;
  }
}

class RemotePrCreationStep implements RemoteProgressStep {
  const RemotePrCreationStep({required this.phase, this.repoName, this.error});

  final RemotePrCreationPhase phase;
  final String? repoName;
  @override
  final String? error;

  @override
  String get wirePhase => phase.wireValue;
}

class RemoteMergePrStep implements RemoteProgressStep {
  const RemoteMergePrStep({
    required this.phase,
    this.repoId,
    this.repoName,
    this.queuePosition,
    this.queueLength,
    this.retryDelayMs,
    this.error,
  });

  final RemoteMergePrPhase phase;
  final String? repoId;
  final String? repoName;
  final int? queuePosition;
  final int? queueLength;
  final int? retryDelayMs;
  @override
  final String? error;

  @override
  String get wirePhase => phase.wireValue;

  bool _sameAs(RemoteMergePrStep other) =>
      phase == other.phase &&
      repoId == other.repoId &&
      repoName == other.repoName &&
      queuePosition == other.queuePosition &&
      queueLength == other.queueLength &&
      retryDelayMs == other.retryDelayMs &&
      error == other.error;
}

class RemotePrCreationProgress {
  const RemotePrCreationProgress({
    required this.steps,
    required this.currentPhase,
  });

  final List<RemotePrCreationStep> steps;
  final RemotePrCreationPhase currentPhase;

  static RemotePrCreationProgress? fromJson(Object? raw) {
    if (raw is! Map<String, dynamic>) return null;
    final currentPhase = RemotePrCreationPhase.fromWire(raw['currentPhase']);
    if (currentPhase == null) return null;
    final rawSteps = raw['steps'];
    final steps = <RemotePrCreationStep>[];
    if (rawSteps is List) {
      for (final row in rawSteps.whereType<Map<String, dynamic>>()) {
        final phase = RemotePrCreationPhase.fromWire(row['phase']);
        if (phase == null) continue;
        steps.add(
          RemotePrCreationStep(
            phase: phase,
            repoName: _stringOrNull(row['repoName']),
            error: _stringOrNull(row['error']),
          ),
        );
      }
    }
    return RemotePrCreationProgress(steps: steps, currentPhase: currentPhase);
  }
}

class RemoteMergePrProgress {
  const RemoteMergePrProgress({
    required this.steps,
    required this.currentPhase,
    this.generation,
  });

  final List<RemoteMergePrStep> steps;
  final RemoteMergePrPhase currentPhase;
  final int? generation;

  /// Whether this feed is an earlier read than [live].
  ///
  /// The desktop only appends steps during one merge, but a worktree snapshot
  /// reads the feed before its slower sections finish and can arrive after a
  /// newer delta. A lower generation belongs to an older merge. Within one
  /// generation, a strict step prefix or a pre-terminal phase after settlement
  /// is a stale read. The prefix rule also supports older hosts.
  bool isEarlierReadOf(RemoteMergePrProgress live) {
    if (generation != null && live.generation != null) {
      if (generation! < live.generation!) return true;
      if (generation! > live.generation!) return false;
    }
    if (live.currentPhase == RemoteMergePrPhase.done ||
        live.currentPhase == RemoteMergePrPhase.error) {
      if (currentPhase != RemoteMergePrPhase.done &&
          currentPhase != RemoteMergePrPhase.error) {
        // Older hosts omit the marker. Their empty initial feed is the only
        // unambiguous sign of a new attempt after a settled merge.
        if (generation == null && live.generation == null && steps.isEmpty) {
          return false;
        }
        return true;
      }
    }
    if (steps.length >= live.steps.length) return false;
    for (var i = 0; i < steps.length; i++) {
      if (!steps[i]._sameAs(live.steps[i])) return false;
    }
    return true;
  }

  static RemoteMergePrProgress? fromJson(Object? raw) {
    if (raw is! Map<String, dynamic>) return null;
    final currentPhase = RemoteMergePrPhase.fromWire(raw['currentPhase']);
    if (currentPhase == null) return null;
    final rawSteps = raw['steps'];
    final steps = <RemoteMergePrStep>[];
    if (rawSteps is List) {
      for (final row in rawSteps.whereType<Map<String, dynamic>>()) {
        final phase = RemoteMergePrPhase.fromWire(row['phase']);
        if (phase == null) continue;
        steps.add(
          RemoteMergePrStep(
            phase: phase,
            repoId: _stringOrNull(row['repoId']),
            repoName: _stringOrNull(row['repoName']),
            queuePosition: _intOrNull(row['queuePosition']),
            queueLength: _intOrNull(row['queueLength']),
            retryDelayMs: _intOrNull(row['retryDelayMs']),
            error: _stringOrNull(row['error']),
          ),
        );
      }
    }
    return RemoteMergePrProgress(
      steps: steps,
      currentPhase: currentPhase,
      generation: _intOrNull(raw['generation']),
    );
  }
}

/// Both feeds for one worktree. Either may be absent: a host emits creation
/// progress, merge progress, or neither.
class RemotePrProgressState {
  const RemotePrProgressState({
    this.creation,
    this.merge,
    this.clearCreation = false,
    this.clearMerge = false,
  });

  final RemotePrCreationProgress? creation;
  final RemoteMergePrProgress? merge;
  final bool clearCreation;
  final bool clearMerge;

  bool get isEmpty =>
      creation == null && merge == null && !clearCreation && !clearMerge;
}
