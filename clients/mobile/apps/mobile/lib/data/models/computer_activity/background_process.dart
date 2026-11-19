/// Mobile projection of the portal `background_process` entity
/// (`RemoteControlBackgroundProcessEntity` in `packages/protocol/src/remote-control/shell/index.ts`):
/// one agent background task of a worktree chat (CAN-5253).
///
/// Rows reach the device two ways, the worktree `/state` slices and
/// `background_process` state deltas, and both use the same payload shape, so
/// one parser serves both.
library;

/// What kind of work the process runs. [unknown] stands for a kind a newer
/// desktop sends that this build does not know.
enum RemoteBackgroundProcessKind {
  agent('agent'),
  bash('bash'),
  task('task'),
  workflow('workflow'),
  unknown('unknown');

  const RemoteBackgroundProcessKind(this.wire);

  final String wire;

  static RemoteBackgroundProcessKind fromWire(Object? wire) {
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    return unknown;
  }
}

/// The process lifecycle. [unknown] stands for a status a newer desktop
/// sends that this build does not know.
enum RemoteBackgroundProcessStatus {
  queued('queued'),
  running('running'),
  completed('completed'),
  failed('failed'),
  stopped('stopped'),
  unknown('unknown');

  const RemoteBackgroundProcessStatus(this.wire);

  final String wire;

  static RemoteBackgroundProcessStatus fromWire(Object? wire) {
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    return unknown;
  }
}

class RemoteBackgroundProcess {
  const RemoteBackgroundProcess({
    required this.localId,
    required this.workspaceLocalId,
    required this.worktreeLocalId,
    required this.chatId,
    required this.toolUseId,
    required this.kind,
    required this.description,
    required this.status,
    required this.canStop,
    this.taskId,
    this.startedAt,
    this.updatedAt,
    this.summary,
    this.lastDescription,
  });

  /// The row, or null when it names no process, worktree or chat. Unknown
  /// kinds and statuses parse as `unknown`; other missing fields fall back.
  /// [localId] is the entity envelope id, which wins over the payload's.
  static RemoteBackgroundProcess? fromJson(Object? value, {String? localId}) {
    if (value is! Map<String, dynamic>) return null;
    final id = localId ?? _nonEmpty(value['localId']);
    final workspaceLocalId = _nonEmpty(value['workspaceLocalId']);
    final worktreeLocalId = _nonEmpty(value['worktreeLocalId']);
    final chatId = _nonEmpty(value['chatId']);
    if (id == null ||
        workspaceLocalId == null ||
        worktreeLocalId == null ||
        chatId == null) {
      return null;
    }
    return RemoteBackgroundProcess(
      localId: id,
      workspaceLocalId: workspaceLocalId,
      worktreeLocalId: worktreeLocalId,
      chatId: chatId,
      toolUseId: _string(value['toolUseId']),
      taskId: _nonEmpty(value['taskId']),
      kind: RemoteBackgroundProcessKind.fromWire(value['kind']),
      description: _string(value['description']),
      status: RemoteBackgroundProcessStatus.fromWire(value['status']),
      startedAt: _intOrNull(value['startedAt']),
      updatedAt: _intOrNull(value['updatedAt']),
      summary: _nonEmpty(value['summary']),
      lastDescription: _nonEmpty(value['lastDescription']),
      canStop: value['canStop'] == true,
    );
  }

  final String localId;
  final String workspaceLocalId;
  final String worktreeLocalId;
  final String chatId;

  /// The tool call that started the process.
  final String toolUseId;

  /// The provider's task id, when it has one.
  final String? taskId;
  final RemoteBackgroundProcessKind kind;
  final String description;
  final RemoteBackgroundProcessStatus status;

  /// Epoch milliseconds; null when the row left them out.
  final int? startedAt;
  final int? updatedAt;

  /// The final summary of a finished process.
  final String? summary;

  /// The latest progress line of a running process.
  final String? lastDescription;

  /// Whether the desktop offers Stop for this process.
  final bool canStop;

  /// The wire shape [fromJson] reads, for the held worktree slices.
  Map<String, dynamic> toJson() => {
    'localId': localId,
    'workspaceLocalId': workspaceLocalId,
    'worktreeLocalId': worktreeLocalId,
    'chatId': chatId,
    'toolUseId': toolUseId,
    'taskId': ?taskId,
    'kind': kind.wire,
    'description': description,
    'status': status.wire,
    'startedAt': ?startedAt,
    'updatedAt': ?updatedAt,
    'summary': ?summary,
    'lastDescription': ?lastDescription,
    'canStop': canStop,
  };
}

String? _nonEmpty(Object? value) =>
    value is String && value.isNotEmpty ? value : null;

String _string(Object? value) => value is String ? value : '';

int? _intOrNull(Object? value) =>
    value is num && value.isFinite ? value.toInt() : null;
