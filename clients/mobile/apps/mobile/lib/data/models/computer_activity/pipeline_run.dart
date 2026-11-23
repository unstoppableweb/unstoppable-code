/// Mobile projection of the portal `pipeline_run` entity
/// (`RemoteControlPipelineRun` in `packages/protocol/src/remote-control/shell/index.ts`).
///
/// Rows reach the device two ways — the worktree `/state` slices and
/// `portal.pipeline.event` upserts — and both use the same payload shape, so
/// one parser serves both.
///
/// Shared with Remote Control. Computer Connect parses and merges runs in
/// the Rust port, cc-domain::pipelines::run (`fromJson`, `mergeWith`,
/// `comparePipelineRunRecency`), and maps the core's runs into these types;
/// keep both in step until cleanup C5.
library;

/// Coarse step counters across every job in a run.
class RemotePipelineRunProgress {
  const RemotePipelineRunProgress({
    required this.completedSteps,
    required this.totalSteps,
  });

  final int completedSteps;
  final int totalSteps;
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
}
