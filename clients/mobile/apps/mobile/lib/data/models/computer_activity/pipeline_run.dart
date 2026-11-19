/// Mobile projection of the portal `pipeline_run` entity
/// (`RemoteControlPipelineRun` in `packages/protocol/src/remote-control/shell/index.ts`).
///
/// Rows reach the device two ways — the worktree `/state` slices and
/// `portal.pipeline.event` upserts — and both use the same payload shape, so
/// one parser serves both.
library;

/// Coarse step counters across every job in a run.
class RemotePipelineRunProgress {
  const RemotePipelineRunProgress({
    required this.completedSteps,
    required this.totalSteps,
  });

  final int completedSteps;
  final int totalSteps;

  static RemotePipelineRunProgress? fromJson(Object? value) {
    if (value is! Map<String, dynamic>) return null;
    final completed = _intOrNull(value['completedSteps']);
    final total = _intOrNull(value['totalSteps']);
    if (completed == null || total == null) return null;
    return RemotePipelineRunProgress(
      completedSteps: completed,
      totalSteps: total,
    );
  }
}

/// One step inside a job or matrix variant.
class RemotePipelineRunStep {
  const RemotePipelineRunStep({
    required this.stepId,
    required this.name,
    required this.status,
    this.attempt,
    this.iteration,
    this.recovery,
    this.outputTail,
  });

  final String stepId;
  final String name;
  final String status;
  final int? attempt;
  final int? iteration;
  final int? recovery;

  /// Bounded tail of this step's combined stdout/stderr (<= 2 KB on the
  /// wire). A larger read is requested with `portal.pipeline.log_request`,
  /// which replaces this value in the next event.
  final String? outputTail;

  static RemotePipelineRunStep? fromJson(Object? value) {
    if (value is! Map<String, dynamic>) return null;
    final stepId = _stringOrNull(value['stepId']);
    if (stepId == null || stepId.isEmpty) return null;
    return RemotePipelineRunStep(
      stepId: stepId,
      name: _string(value['name'], fallback: stepId),
      status: _string(value['status']),
      attempt: _intOrNull(value['attempt']),
      iteration: _intOrNull(value['iteration']),
      recovery: _intOrNull(value['recovery']),
      outputTail: _stringOrNull(value['outputTail']),
    );
  }

  RemotePipelineRunStep withOutputTail(String? tail) => RemotePipelineRunStep(
    stepId: stepId,
    name: name,
    status: status,
    attempt: attempt,
    iteration: iteration,
    recovery: recovery,
    outputTail: tail,
  );
}

/// One physical job materialized from a matrix job.
class RemotePipelineRunVariant {
  const RemotePipelineRunVariant({
    required this.jobId,
    required this.name,
    required this.status,
    this.matrix = const {},
    this.steps = const [],
  });

  final String jobId;
  final String name;
  final String status;
  final Map<String, dynamic> matrix;
  final List<RemotePipelineRunStep> steps;

  static RemotePipelineRunVariant? fromJson(Object? value) {
    if (value is! Map<String, dynamic>) return null;
    final jobId = _stringOrNull(value['jobId']);
    if (jobId == null || jobId.isEmpty) return null;
    final matrix = value['matrix'];
    return RemotePipelineRunVariant(
      jobId: jobId,
      name: _string(value['name'], fallback: jobId),
      status: _string(value['status']),
      matrix: matrix is Map<String, dynamic> ? matrix : const {},
      steps: _steps(value['steps']),
    );
  }
}

/// One job in the run's execution tree.
class RemotePipelineRunJob {
  const RemotePipelineRunJob({
    required this.jobId,
    required this.name,
    required this.status,
    this.needs,
    this.steps = const [],
    this.variants = const [],
    this.expansion,
    this.expansionError,
  });

  final String jobId;
  final String name;
  final String status;

  /// Jobs this one depends on. Null means the desktop sent no `needs` (an
  /// older host), which is not the same as a job with no dependencies: the
  /// current desktop always emits the field, empty when there are none.
  final List<String>? needs;
  final List<RemotePipelineRunStep> steps;
  final List<RemotePipelineRunVariant> variants;

  /// `pending` | `expanded` | `failure` for a matrix job, else null.
  final String? expansion;
  final String? expansionError;

  static RemotePipelineRunJob? fromJson(Object? value) {
    if (value is! Map<String, dynamic>) return null;
    final jobId = _stringOrNull(value['jobId']);
    if (jobId == null || jobId.isEmpty) return null;
    final needs = value['needs'];
    final variants = value['variants'];
    return RemotePipelineRunJob(
      jobId: jobId,
      name: _string(value['name'], fallback: jobId),
      status: _string(value['status']),
      needs: needs is List
          ? needs.whereType<String>().toList(growable: false)
          : null,
      steps: _steps(value['steps']),
      variants: variants is List
          ? [
              for (final row in variants)
                ?RemotePipelineRunVariant.fromJson(row),
            ]
          : const [],
      expansion: _stringOrNull(value['expansion']),
      expansionError: _stringOrNull(value['expansionError']),
    );
  }
}

/// Why a run paused or failed, without desktop-only diagnostics.
class RemotePipelineRunStatusReason {
  const RemotePipelineRunStatusReason({
    required this.id,
    required this.kind,
    required this.code,
    this.provider,
    this.resetsAt,
  });

  final String id;
  final String kind;
  final String code;
  final String? provider;
  final String? resetsAt;

  static RemotePipelineRunStatusReason? fromJson(Object? value) {
    if (value is! Map<String, dynamic>) return null;
    final id = _stringOrNull(value['id']);
    if (id == null || id.isEmpty) return null;
    return RemotePipelineRunStatusReason(
      id: id,
      kind: _string(value['kind']),
      code: _string(value['code']),
      provider: _stringOrNull(value['provider']),
      resetsAt: _stringOrNull(value['resetsAt']),
    );
  }
}

/// A checkpoint the desktop is waiting on, parsed for display only — mobile
/// is read-only and never answers one.
class RemotePipelinePauseCheckpoint {
  const RemotePipelinePauseCheckpoint({
    required this.id,
    required this.kind,
    required this.jobId,
    required this.stepId,
    this.title,
    this.message,
    this.fieldLabels = const [],
  });

  final String id;
  final String kind;
  final String jobId;
  final String stepId;
  final String? title;
  final String? message;

  /// Labels of the inputs the desktop is asking for, so the phone can say
  /// what is being waited on without rendering an unusable form.
  final List<String> fieldLabels;

  static RemotePipelinePauseCheckpoint? fromJson(Object? value) {
    if (value is! Map<String, dynamic>) return null;
    final id = _stringOrNull(value['id']);
    if (id == null || id.isEmpty) return null;
    final request = value['request'];
    final fields = request is Map<String, dynamic> ? request['fields'] : null;
    return RemotePipelinePauseCheckpoint(
      id: id,
      kind: _string(value['kind']),
      jobId: _string(value['jobId']),
      stepId: _string(value['stepId']),
      title: request is Map<String, dynamic>
          ? _stringOrNull(request['title'])
          : null,
      message: request is Map<String, dynamic>
          ? _stringOrNull(request['message'])
          : null,
      fieldLabels: fields is List
          ? [
              for (final field in fields.whereType<Map<String, dynamic>>())
                _string(field['label'], fallback: _string(field['key'])),
            ]
          : const [],
    );
  }
}

/// One chat turn a desktop attributes a run to: the agent started, resumed
/// or retried it from that turn (`launched`), or the chat was watching it
/// and carried it into that turn (`watching`).
class RemotePipelineRunChatTurn {
  const RemotePipelineRunChatTurn({
    required this.chatId,
    required this.userMessageId,
    required this.relation,
  });

  final String chatId;

  /// The user message that opened the turn; matches the transcript's turn key.
  final String userMessageId;

  /// `launched` | `watching`.
  final String relation;

  static RemotePipelineRunChatTurn? fromJson(Object? value) {
    if (value is! Map<String, dynamic>) return null;
    final chatId = _stringOrNull(value['chatId']);
    final userMessageId = _stringOrNull(value['userMessageId']);
    final relation = _stringOrNull(value['relation']);
    if (chatId == null ||
        chatId.isEmpty ||
        userMessageId == null ||
        userMessageId.isEmpty ||
        (relation != 'launched' && relation != 'watching')) {
      return null;
    }
    return RemotePipelineRunChatTurn(
      chatId: chatId,
      userMessageId: userMessageId,
      relation: relation!,
    );
  }

  @override
  bool operator ==(Object other) =>
      other is RemotePipelineRunChatTurn &&
      other.chatId == chatId &&
      other.userMessageId == userMessageId &&
      other.relation == relation;

  @override
  int get hashCode => Object.hash(chatId, userMessageId, relation);
}

/// Which saved outputs a chat follow-up can review (CAN-3719). The desktop
/// keeps the paths; the phone only learns whether each one exists.
class RemotePipelineRunChatFollowUp {
  const RemotePipelineRunChatFollowUp({
    required this.planAvailable,
    required this.reportAvailable,
  });

  final bool planAvailable;
  final bool reportAvailable;

  bool get hasOutput => planAvailable || reportAvailable;

  static RemotePipelineRunChatFollowUp? fromJson(Object? value) {
    if (value is! Map<String, dynamic>) return null;
    return RemotePipelineRunChatFollowUp(
      planAvailable: value['planAvailable'] == true,
      reportAvailable: value['reportAvailable'] == true,
    );
  }
}

/// [incoming] raw `pipelineRuns` rows, each row that leaves `chatTurns` out
/// keeping the links its [held] row carries. A desktop omits the field when
/// it cannot attribute chats to a run, which means "keep"; an explicit list,
/// even an empty one, replaces them, as in [RemotePipelineRun.mergeWith].
/// Rows only [held] has stay dropped: a settled read is authoritative for
/// which runs exist. Returns [incoming] itself when nothing is kept.
Object? keepHeldPipelineRunChatTurns(Object? incoming, Object? held) {
  if (incoming is! List || held is! List) return incoming;
  final links = <Object, List<dynamic>>{
    for (final row in held)
      if (row case {'localId': final Object id, 'chatTurns': final List turns})
        id: turns,
  };
  bool keeps(Object? row) =>
      row is Map<String, dynamic> &&
      row['chatTurns'] is! List &&
      links.containsKey(row['localId']);
  if (!incoming.any(keeps)) return incoming;
  return [
    for (final row in incoming)
      if (row is Map<String, dynamic> && keeps(row))
        {...row, 'chatTurns': links[row['localId']]}
      else
        row,
  ];
}

/// A control the phone can send for a run, sent by its [Enum.name]. Each is
/// fire-and-forget: the desktop acknowledges the command, and the run's new
/// state arrives as a `portal.pipeline.event` upsert.
enum RemotePipelineRunAction { cancel, resume, retry }

/// One pipeline execution.
class RemotePipelineRun {
  const RemotePipelineRun({
    required this.localId,
    required this.pipelineName,
    required this.status,
    this.pipelineId,
    this.workspaceLocalId,
    this.worktreeLocalId,
    this.startedAt,
    this.finishedAt,
    this.parentExecutionId,
    this.triggerSource,
    this.hidden = false,
    this.truncated = false,
    this.outputTail,
    this.progress,
    this.statusReasons = const [],
    this.pendingPauses = const [],
    this.jobs,
    this.chatTurns,
    this.chatFollowUp,
  });

  /// Execution id; the key every pipeline command and event is scoped by.
  final String localId;
  final String? pipelineId;
  final String pipelineName;
  final String? workspaceLocalId;
  final String? worktreeLocalId;

  /// `pending` | `running` | `paused` | `success` | `failure` | `cancelled`.
  final String status;
  final String? startedAt;
  final String? finishedAt;
  final String? parentExecutionId;

  /// `hook` | `chat` | `plan` | `manual`; absent falls back to manual.
  final String? triggerSource;

  /// Child runs the desktop groups away from its activity list.
  final bool hidden;

  /// True when the desktop dropped detail fields to fit one live event.
  final bool truncated;

  /// Bounded tail of the run's combined output; the only content available
  /// when a desktop sends no [jobs].
  final String? outputTail;

  final RemotePipelineRunProgress? progress;
  final List<RemotePipelineRunStatusReason> statusReasons;
  final List<RemotePipelinePauseCheckpoint> pendingPauses;

  /// The execution tree. **Null means this desktop sent no detail**; an
  /// empty list means the run genuinely has no jobs yet.
  final List<RemotePipelineRunJob>? jobs;

  /// The chat turns the desktop attributes this run to. **Null means this
  /// update did not say** (an older desktop, or a partial event); an empty
  /// list means the run is linked to no turn.
  final List<RemotePipelineRunChatTurn>? chatTurns;

  /// Saved outputs a chat follow-up can review. **Null means unknown** (an
  /// older desktop, or an update that did not say).
  final RemotePipelineRunChatFollowUp? chatFollowUp;

  /// Root runs are the only ones desktop offers run controls for.
  bool get isRoot => parentExecutionId == null;

  bool get hasDetail => jobs != null;

  static RemotePipelineRun? fromJson(Map<String, dynamic> json) {
    final localId =
        _stringOrNull(json['localId']) ?? _stringOrNull(json['runId']);
    if (localId == null || localId.isEmpty) return null;
    final jobs = json['jobs'];
    final reasons = json['statusReasons'];
    final pauses = json['pendingPauses'];
    final chatTurns = json['chatTurns'];
    return RemotePipelineRun(
      localId: localId,
      pipelineId: _stringOrNull(json['pipelineId']),
      pipelineName: _string(
        json['pipelineName'],
        fallback: _string(json['name'], fallback: localId),
      ),
      workspaceLocalId: _stringOrNull(json['workspaceLocalId']),
      worktreeLocalId: _stringOrNull(json['worktreeLocalId']),
      status: _string(json['status']),
      startedAt: _stringOrNull(json['startedAt']),
      finishedAt: _stringOrNull(json['finishedAt']),
      parentExecutionId: _stringOrNull(json['parentExecutionId']),
      triggerSource: _stringOrNull(json['triggerSource']),
      hidden: json['hidden'] == true,
      truncated: json['truncated'] == true,
      outputTail: _stringOrNull(json['outputTail']),
      progress: RemotePipelineRunProgress.fromJson(json['progress']),
      statusReasons: reasons is List
          ? [
              for (final row in reasons)
                ?RemotePipelineRunStatusReason.fromJson(row),
            ]
          : const [],
      pendingPauses: pauses is List
          ? [
              for (final row in pauses)
                ?RemotePipelinePauseCheckpoint.fromJson(row),
            ]
          : const [],
      jobs: jobs is List
          ? [for (final row in jobs) ?RemotePipelineRunJob.fromJson(row)]
          : null,
      chatTurns: chatTurns is List
          ? List.unmodifiable({
              for (final row in chatTurns)
                ?RemotePipelineRunChatTurn.fromJson(row),
            })
          : null,
      chatFollowUp: RemotePipelineRunChatFollowUp.fromJson(
        json['chatFollowUp'],
      ),
    );
  }

  /// Folds [incoming] onto this row.
  ///
  /// Two rules carry the weight:
  ///
  /// - **Detail is never lost.** An event with `truncated: true` dropped its
  ///   detail to fit the transfer budget, and an older desktop may never send
  ///   `jobs` at all. Either way, dropping back to "no detail" would flap the
  ///   screen between the tree and the unavailable-details fallback, so
  ///   [jobs] is only ever replaced by a non-null value, and a step keeps the
  ///   output tail it already has when an update omits one for the same
  ///   attempt and iteration (live events carry tails only for the steps
  ///   streaming in that window). The same applies
  ///   to a held pending pause: the desktop deliberately re-attaches a
  ///   `too_large` stub (id/kind/jobId/stepId only, no `request`) when a
  ///   checkpoint's real detail did not fit the truncated event, and that
  ///   stub must not clobber a richer checkpoint already held for the same
  ///   id — see [_mergePendingPauses].
  /// - **Reasons and pauses clear on a settled update.** A resumed run must
  ///   stop showing the pause it just cleared, so a non-truncated update is
  ///   authoritative for them even when empty.
  /// - **Chat links change only when an update carries them.** An update
  ///   without `chatTurns` keeps the held links; an explicit list, even an
  ///   empty one, replaces them. Follow-up availability works the same way.
  RemotePipelineRun mergeWith(RemotePipelineRun incoming) {
    return RemotePipelineRun(
      localId: incoming.localId,
      pipelineId: incoming.pipelineId ?? pipelineId,
      pipelineName: incoming.pipelineName == incoming.localId
          ? pipelineName
          : incoming.pipelineName,
      workspaceLocalId: incoming.workspaceLocalId ?? workspaceLocalId,
      worktreeLocalId: incoming.worktreeLocalId ?? worktreeLocalId,
      status: incoming.status.isEmpty ? status : incoming.status,
      startedAt: incoming.startedAt ?? startedAt,
      finishedAt:
          incoming.finishedAt ??
          (incoming.status == 'pending' || incoming.status == 'running'
              ? null
              : finishedAt),
      parentExecutionId: incoming.parentExecutionId ?? parentExecutionId,
      triggerSource: incoming.triggerSource ?? triggerSource,
      hidden: incoming.hidden,
      truncated: incoming.truncated,
      outputTail: incoming.outputTail ?? outputTail,
      progress: incoming.progress ?? progress,
      statusReasons: incoming.truncated && incoming.statusReasons.isEmpty
          ? statusReasons
          : incoming.statusReasons,
      pendingPauses: _mergePendingPauses(pendingPauses, incoming),
      jobs: incoming.jobs == null ? jobs : _mergeJobs(jobs, incoming.jobs!),
      chatTurns: incoming.chatTurns ?? chatTurns,
      chatFollowUp: incoming.chatFollowUp ?? chatFollowUp,
    );
  }
}

/// Merges held pending pauses with [incoming]'s.
///
/// A settled (non-truncated) update is fully authoritative, matching the
/// "reasons and pauses clear on a settled update" rule. A truncated update
/// is merged by checkpoint id instead of replacing wholesale: the desktop's
/// `too_large` stub carries only `id`/`kind`/`jobId`/`stepId`, so a held
/// checkpoint that already carries a `title`/`message`/`fieldLabels` wins
/// over an incoming entry with the same id that carries none.
List<RemotePipelinePauseCheckpoint> _mergePendingPauses(
  List<RemotePipelinePauseCheckpoint> held,
  RemotePipelineRun incoming,
) {
  if (!incoming.truncated) return incoming.pendingPauses;
  if (incoming.pendingPauses.isEmpty) return held;
  final heldById = {for (final pause in held) pause.id: pause};
  return [
    for (final pause in incoming.pendingPauses)
      if (heldById[pause.id] case final existing?
          when !_hasPauseDetail(pause) && _hasPauseDetail(existing))
        existing
      else
        pause,
  ];
}

bool _hasPauseDetail(RemotePipelinePauseCheckpoint pause) =>
    pause.title != null ||
    pause.message != null ||
    pause.fieldLabels.isNotEmpty;

List<RemotePipelineRunJob> _mergeJobs(
  List<RemotePipelineRunJob>? existing,
  List<RemotePipelineRunJob> incoming,
) {
  if (existing == null || existing.isEmpty) return incoming;
  final previous = {for (final job in existing) job.jobId: job};
  return [
    for (final job in incoming)
      if (previous[job.jobId] case final before?)
        RemotePipelineRunJob(
          jobId: job.jobId,
          name: job.name,
          status: job.status,
          needs: job.needs,
          steps: _mergeSteps(before.steps, job.steps),
          variants: _mergeVariants(before.variants, job.variants),
          expansion: job.expansion,
          expansionError: job.expansionError,
        )
      else
        job,
  ];
}

List<RemotePipelineRunVariant> _mergeVariants(
  List<RemotePipelineRunVariant> existing,
  List<RemotePipelineRunVariant> incoming,
) {
  if (existing.isEmpty) return incoming;
  final previous = {for (final variant in existing) variant.jobId: variant};
  return [
    for (final variant in incoming)
      if (previous[variant.jobId] case final before?)
        RemotePipelineRunVariant(
          jobId: variant.jobId,
          name: variant.name,
          status: variant.status,
          matrix: variant.matrix,
          steps: _mergeSteps(before.steps, variant.steps),
        )
      else
        variant,
  ];
}

List<RemotePipelineRunStep> _mergeSteps(
  List<RemotePipelineRunStep> existing,
  List<RemotePipelineRunStep> incoming,
) {
  if (existing.isEmpty) return incoming;
  final previous = {for (final step in existing) step.stepId: step};
  return [
    for (final step in incoming)
      if (previous[step.stepId] case final before?
          when step.outputTail == null &&
              step.attempt == before.attempt &&
              step.iteration == before.iteration &&
              step.recovery == before.recovery &&
              before.outputTail != null)
        step.withOutputTail(before.outputTail)
      else
        step,
  ];
}

List<RemotePipelineRunStep> _steps(Object? value) => value is List
    ? [for (final row in value) ?RemotePipelineRunStep.fromJson(row)]
    : const [];

String? _stringOrNull(Object? value) => value is String ? value : null;

int? _intOrNull(Object? value) => value is num ? value.toInt() : null;

String _string(Object? value, {String fallback = ''}) =>
    value is String ? value : fallback;

/// Shared newest-first ordering for both remote execution projections.
int comparePipelineRunRecency(RemotePipelineRun a, RemotePipelineRun b) {
  final left = DateTime.tryParse(b.startedAt ?? ''),
      right = DateTime.tryParse(a.startedAt ?? '');
  if (left == null && right == null) return 0;
  if (left == null) return -1;
  if (right == null) return 1;
  return left.compareTo(right);
}
