import 'dart:async';

import 'package:computer_connect_core/computer_connect_core.dart';
import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/device_link/desktop/ipc.dart';
import 'package:mobile/device_link/projects/clones.dart';
import 'package:mobile/device_link/protocol.dart';
import 'package:mobile/device_link/rust_core/failures.dart';
import 'package:mobile/device_link/worktrees/models.dart';
import 'package:mobile/device_link/worktrees/writes.dart';

import '../controller.dart';
import 'rust_home.dart';
import 'view_revisions.dart';

/// The exception the Dart creator, archiver or reader threw for [failure].
/// "Other" errors were casts and timeouts, which every caller words itself.
Object writeFailure(WriteFailure failure) => switch (failure.kind) {
  WriteFailureKind.link => DeviceLinkException(failure.message),
  WriteFailureKind.refused => DesktopIpcRefusal(
    failure.message,
    code: failure.code,
  ),
  WriteFailureKind.notSent => DesktopIpcNotSent(failure.message),
  WriteFailureKind.other => StateError(
    'The computer sent an unexpected reply.',
  ),
};

/// One creation attempt as the core reports it.
final class _RustAttempt implements DeviceWorktreeAttempt {
  _RustAttempt(this.id, this.projectId, this.onChanged);
  final int id;
  @override
  final String projectId;
  final VoidCallback? onChanged;
  @override
  String? worktreeId;
  String? name;
  bool ready = false;
  @override
  bool canRetry = true;

  void update(AttemptView view) {
    final answered =
        view.worktreeId != worktreeId ||
        view.name != name ||
        view.ready != ready;
    worktreeId = view.worktreeId;
    name = view.name;
    ready = view.ready;
    canRetry = view.canRetry;
    // Dart's attempt notified when the computer answered its create.
    if (answered) onChanged?.call();
  }
}

/// One computer's worktree creation on the core's [WorktreesService] (P8).
/// The core sends each create at most once and keeps the attempts; this
/// model mirrors them for the new task screen.
final class RustWorktreeCreation implements DeviceWorktreeCreation {
  RustWorktreeCreation(this.service) {
    _views = service.watch().listen(
      _apply,
      onError: _revisions.ended,
      onDone: _revisions.ended,
      cancelOnError: true,
    );
  }
  final WorktreesService service;
  StreamSubscription<WorktreesView>? _views;
  final _revisions = ViewRevisions();
  final _attempts = <int, _RustAttempt>{};
  bool _disposed = false;

  void _apply(WorktreesView view) {
    if (_disposed || view.revision <= _revisions.current) return;
    for (final attempt in view.attempts) {
      _attempts[attempt.id]?.update(attempt);
    }
    _revisions.reached(view.revision);
  }

  @override
  DeviceWorktreeAttempt attempt(
    String projectId, {
    String? baseBranch,
    VoidCallback? onChanged,
  }) {
    final id = service.begin(projectId: projectId, baseBranch: baseBranch);
    return _attempts[id] = _RustAttempt(id, projectId, onChanged);
  }

  @override
  Future<DeviceCreatedWorktree> create(DeviceWorktreeAttempt attempt) async {
    if (attempt is! _RustAttempt) {
      throw ArgumentError.value(attempt, 'attempt', 'Not from this creator');
    }
    if (_disposed) throw StateError('Writes disposed.');
    final WorktreesSettled settled;
    try {
      settled = await service.settled(
        ticket: service.request(
          intent: WorktreesIntent.create(attempt: attempt.id),
        ),
      );
    } on CoreFailure catch (error) {
      throw rustFailure(error);
    }
    await _revisions.wait(settled.revision);
    if (settled.attempt case final view?) attempt.update(view);
    if (settled.failure case final failure?) throw writeFailure(failure);
    final created = settled.created!;
    return DeviceCreatedWorktree(created.projectId, created.id, created.name);
  }

  @override
  void release(DeviceWorktreeAttempt attempt) {
    if (attempt is! _RustAttempt || _attempts.remove(attempt.id) == null) {
      return;
    }
    if (!_disposed) {
      service.send(intent: WorktreesIntent.release(attempt: attempt.id));
    }
  }

  /// The core follows its own connection.
  @override
  void setConnected(bool value) {}

  @override
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    _revisions.fail(StateError('Writes disposed.'));
    await _views?.cancel();
    service.send(intent: const WorktreesIntent.close());
  }
}

/// One computer's worktree archive on the core's [WorktreesService] (P8).
final class RustWorktreeArchive extends ChangeNotifier
    implements DeviceWorktreeArchive {
  RustWorktreeArchive(this.service) {
    _views = service.watch().listen(
      _apply,
      onError: _revisions.ended,
      onDone: _revisions.ended,
      cancelOnError: true,
    );
  }
  final WorktreesService service;
  StreamSubscription<WorktreesView>? _views;
  final _revisions = ViewRevisions();
  var _archiving = const <String>{};
  bool _disposed = false;

  void _apply(WorktreesView view) {
    if (_disposed || view.revision <= _revisions.current) return;
    final archiving = view.archiving.toSet();
    final changed = !setEquals(archiving, _archiving);
    _archiving = archiving;
    _revisions.reached(view.revision);
    if (changed) notifyListeners();
  }

  @override
  bool isArchiving(DeviceWorktree worktree) =>
      _archiving.contains(worktree.key);

  @override
  Future<void> archive(DeviceWorktree worktree) async {
    if (_disposed) throw StateError('Writes disposed.');
    final WorktreesSettled settled;
    try {
      settled = await service.settled(
        ticket: service.request(
          intent: WorktreesIntent.archive(
            projectId: worktree.projectId,
            worktreeId: worktree.id,
          ),
        ),
      );
    } on CoreFailure catch (error) {
      throw rustFailure(error);
    }
    await _revisions.wait(settled.revision);
    if (settled.failure case final failure?) throw writeFailure(failure);
  }

  @override
  void dispose() {
    _disposed = true;
    _revisions.fail(StateError('Writes disposed.'));
    unawaited(_views?.cancel());
    super.dispose();
  }
}

/// One computer's project clones on the core's [ProjectsService] (P8). The
/// core sends each clone once and reads lost answers back; this model
/// mirrors the rows and runs the two-step add with the host's own context
/// check between them.
final class RustProjectClones implements DeviceProjectClones {
  RustProjectClones(this.service, {required this.onChanged}) {
    _views = service.watch().listen(
      _apply,
      onError: _revisions.ended,
      onDone: _revisions.ended,
      cancelOnError: true,
    );
  }
  final ProjectsService service;
  final VoidCallback onChanged;
  StreamSubscription<ClonesView>? _views;
  final _revisions = ViewRevisions();
  ClonesView? _view;
  bool _disposed = false;

  void _apply(ClonesView view) {
    if (_disposed || view.revision <= _revisions.current) return;
    _view = view;
    _revisions.reached(view.revision);
    onChanged();
  }

  Future<ProjectsOutcome> _settle(ProjectsIntent intent) async {
    if (_disposed) throw StateError('Writes disposed.');
    final ProjectsSettled settled;
    try {
      settled = await service.settled(ticket: service.request(intent: intent));
    } on CoreFailure catch (error) {
      throw rustFailure(error);
    }
    await _revisions.wait(settled.revision);
    return settled.outcome;
  }

  @override
  List<CloneRowView> get clones => _view?.rows ?? const [];
  @override
  CloneRowView? get unconfirmed => _view?.unconfirmed;

  @override
  Future<String?> add(
    String remoteUrl, {
    required bool Function() stillAllowed,
  }) async {
    switch (await _settle(const ProjectsIntent.discover())) {
      case ProjectsOutcome_Refused(:final message):
        return message;
      case ProjectsOutcome_Discovered(:final discovery):
        final committed = await _settle(
          ProjectsIntent.commit(
            discovery: discovery,
            url: remoteUrl,
            allowed: !_disposed && stillAllowed(),
          ),
        );
        return switch (committed) {
          ProjectsOutcome_Refused(:final message) => message,
          _ => null,
        };
      default:
        throw StateError('The computer did not answer the folder lookup.');
    }
  }

  @override
  Future<bool> acknowledgeUnknown(String jobId) async {
    if (_disposed) return false;
    return switch (await _settle(ProjectsIntent.acknowledge(jobId: jobId))) {
      ProjectsOutcome_Acknowledged(:final accepted) => accepted,
      _ => false,
    };
  }

  void _send(ProjectsIntent intent) {
    if (!_disposed) service.send(intent: intent);
  }

  @override
  void dismiss(String jobId) => _send(ProjectsIntent.dismiss(jobId: jobId));
  @override
  void readBack() => _send(const ProjectsIntent.readBack());
  @override
  void retireListed(Set<String> projectIds) =>
      _send(ProjectsIntent.retire(projectIds: projectIds.toList()));

  /// The core follows its own connection.
  @override
  void setConnected(bool value) {}

  @override
  void dispose() {
    if (_disposed) return;
    _send(const ProjectsIntent.close());
    _disposed = true;
    _revisions.fail(StateError('Writes disposed.'));
    unawaited(_views?.cancel());
  }
}

Future<HomeOutcome> _settleHome(HomeService service, HomeIntent intent) async {
  try {
    return (await service.settled(
      ticket: service.request(intent: intent),
    )).outcome;
  } on CoreFailure catch (error) {
    throw rustFailure(error);
  }
}

/// `personal` or `organization:<id>`, as Home keys its records.
String homeContextId(String? organizationId) =>
    organizationId == null ? 'personal' : 'organization:$organizationId';

/// Home's composer drafts of one computer in the core's encrypted store
/// (P8). Read once when opened; the composer reads them synchronously from
/// here, and every change goes to the core, which writes it 500 ms after
/// the last one.
final class RustHomeDrafts implements ChatDraftPort {
  RustHomeDrafts._(this.service, this._drafts);
  final HomeService service;
  final Map<String, String> _drafts;

  static Future<RustHomeDrafts> open(HomeService service) async {
    final outcome = await _settleHome(service, const HomeIntent.drafts());
    return RustHomeDrafts._(service, {
      if (outcome case HomeOutcome_Drafts(:final drafts))
        for (final draft in drafts) draft.context: draft.text,
    });
  }

  static String? _context(DraftTarget target) =>
      target is ComputerHomeDraftTarget ? target.contextId : null;

  @override
  String draftFor(DraftTarget target) => _drafts[_context(target)] ?? '';

  @override
  void setDraft(DraftTarget target, String text) {
    final context = _context(target);
    if (context == null || (_drafts[context] ?? '') == text) return;
    if (text.isEmpty) {
      _drafts.remove(context);
    } else {
      _drafts[context] = text;
    }
    service.send(
      intent: HomeIntent.setDraft(context: context, text: text),
    );
  }

  @override
  void moveDraft(DraftTarget from, DraftTarget to) {
    if (from == to) return;
    final text = draftFor(from);
    if (text.isEmpty) return;
    setDraft(from, '');
    setDraft(to, text);
  }

  @override
  Future<bool> flush() async {
    try {
      return switch (await _settleHome(
        service,
        const HomeIntent.flushDrafts(),
      )) {
        HomeOutcome_Saved(:final stored) => stored,
        _ => false,
      };
    } on Object {
      return false;
    }
  }
}

/// [ComputerConnectController]'s writes for computer [computerId] on the
/// core (P8). [home] is the computer's Home service, shared with its
/// choices and drafts.
ComputerConnectWrites Function(VoidCallback) rustComputerWrites(
  AccountService account,
  String computerId,
  RustHome home,
) => (onChanged) {
  final worktrees = account.worktrees(computerId: computerId);
  // New tasks create their worktrees on the same service.
  home.service.bindWorktrees(worktrees: worktrees);
  return (
    worktrees: RustWorktreeCreation(worktrees),
    archive: RustWorktreeArchive(worktrees),
    clones: RustProjectClones(
      account.projects(computerId: computerId),
      onChanged: onChanged,
    ),
    homeFlows: home,
  );
};
