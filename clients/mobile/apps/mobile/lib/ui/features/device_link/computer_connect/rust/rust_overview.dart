import 'dart:async';

import 'package:computer_connect_core/computer_connect_core.dart';
import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/computer_activity/pr_merge_queue.dart';
import 'package:mobile/data/models/remote_overview_sections.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/chats/recent_chat.dart';
import 'package:mobile/device_link/protocol.dart';
import 'package:mobile/device_link/rust_core/failures.dart';
import 'package:mobile/device_link/worktrees/models.dart';

import '../../chats_view_model.dart';
import '../overview_model.dart';
import 'same_name.dart';

/// One computer's overview over the Rust core's [OverviewService]. The core
/// reads the roster, ownership, Cowork states, Recents and the catalog,
/// computes rows, scopes and attention, and claims the desktop interest;
/// this model maps the latest [OverviewView] to [ComputerOverviewModel] and
/// forwards intents. Without a [service] (no computer selected) it shows
/// nothing.
final class RustComputerOverview extends ChangeNotifier
    implements ComputerOverviewModel {
  RustComputerOverview({required this.service, required this.chats}) {
    _views = service?.watch().listen(_apply);
  }

  final OverviewService? service;

  /// The chats feature keeps the catalog list it creates chats against;
  /// each catalog the core reads is handed to it.
  final DeviceChatsViewModel chats;
  StreamSubscription<OverviewView>? _views;
  OverviewView? _view;
  bool _disposed = false;
  @override
  VoidCallback? onRefreshStarted;

  var _catalog = const <DeviceChatRef>[];
  var _projects = const <DeviceProject>[];
  var _worktrees = const <DeviceWorktree>[];
  var _codeProjectIds = const <String>{};
  var _rows = const <String, RemoteWorktree>{};
  var _building = const <String>{};
  var _scopes = const <String?, ContextScopeView>{};
  var _cowork = const <String, Map<String, CoworkChatView>>{};
  var _recents = const <String?, List<DeviceRecentChat>>{};
  var _notificationSpaces = const <String, String>{};

  void _apply(OverviewView view) {
    final previous = _view;
    if (_disposed || (previous != null && view.revision <= previous.revision)) {
      return;
    }
    _view = view;
    _projects = [for (final p in view.projects) _project(p)];
    final byId = {for (final p in view.projects) p.id: p.name};
    _worktrees = [
      for (final w in view.worktrees) _worktree(w, byId[w.projectId]),
    ];
    _codeProjectIds = view.codeProjectIds.toSet();
    _rows = {for (final w in view.worktrees) w.key: _row(w.row)};
    _building = {
      for (final w in view.worktrees)
        if (w.codeGraphBuilding) w.key,
    };
    _scopes = {for (final s in view.scopes) s.owner.organizationId: s};
    _cowork = {
      for (final s in view.cowork)
        s.scopeKey: {for (final c in s.chats) c.chatId: c},
    };
    _recents = {
      for (final r in view.recents)
        r.owner.organizationId: [for (final c in r.chats) _recent(c)],
    };
    _notificationSpaces = {
      for (final n in view.notificationSpaces) n.chatId: n.spaceId,
    };
    if (previous == null || view.catalogRevision != previous.catalogRevision) {
      if (view.catalogRevision > 0) {
        _catalog = [for (final c in view.catalog) _chat(c)];
        chats.chats.applyCatalog((
          chats: _catalog,
          workspaces: [
            for (final w in view.catalogWorkspaces)
              DeviceChatWorkspace(w.id, w.name),
          ],
        ));
      }
    }
    final started = view.refreshes - (previous?.refreshes ?? 0);
    notifyListeners();
    for (var i = 0; i < started; i++) {
      onRefreshStarted?.call();
    }
  }

  static DeviceProject _project(ProjectView p) => DeviceProject(
    id: p.id,
    name: p.name,
    type: p.kind,
    color: p.color,
    temporary: p.temporary,
    alwaysShow: p.alwaysShow,
    ownerContext: switch (p.owner) {
      null => null,
      OwnerView(organizationId: null) => const WorkspaceContext.personal(),
      OwnerView(organizationId: final String id) =>
        WorkspaceContext.organization(id),
    },
    order: _order(p.order),
  );

  /// Saved positions are JavaScript numbers: integral ones are Dart ints.
  static num? _order(double? order) =>
      order != null && order == order.truncateToDouble() && order.abs() < 1e15
      ? order.toInt()
      : order;

  static DeviceChatRef _chat(ChatRefView c) => DeviceChatRef(
    projectId: c.projectId,
    worktreeId: c.worktreeId,
    id: c.id,
    title: c.title,
  );

  static String _status(WorktreeStatus status) => switch (status) {
    WorktreeStatus.loading => 'Loading',
    WorktreeStatus.unavailable => 'Unavailable',
    WorktreeStatus.needsInput => 'Needs input',
    WorktreeStatus.working => 'Working',
    WorktreeStatus.failed => 'Failed',
    WorktreeStatus.done => 'Done',
    WorktreeStatus.idle => 'Idle',
  };

  static void _applyChats(DeviceWorktree worktree, WorktreeChatsView chats) {
    worktree
      ..chatReadSequence = chats.sequence
      ..chats = [for (final c in chats.chats) _chat(c)]
      ..activeChatId = chats.activeChatId
      ..status = _status(chats.status)
      ..unread = chats.unread
      ..pendingQuestion = chats.pendingQuestion
      ..pendingApproval = chats.pendingApproval
      ..isStreaming = chats.isStreaming;
    worktree.workingChats
      ..clear()
      ..addAll(chats.workingChats);
  }

  DeviceWorktree _worktree(WorktreeView w, String? projectName) {
    final worktree = DeviceWorktree(
      projectId: w.projectId,
      projectName: w.projectName,
      id: w.id,
      name: w.name,
      savedStatus: w.savedStatus,
      pipelineStatus: w.pipelineStatus,
      order: _order(w.order),
      hidden: w.hidden,
    );
    _applyChats(worktree, w.chats);
    worktree.inventoryInstance = w.instance.toInt();
    return worktree;
  }

  static RemoteWorktree _row(WorktreeRowView r) => RemoteWorktree(
    localId: r.localId,
    workspaceLocalId: r.workspaceLocalId,
    branch: r.branch,
    label: r.label,
    order: _order(r.order),
    status: r.status,
    busy: r.busy,
    isStreaming: r.isStreaming,
    backgroundTasks: r.backgroundTasks?.toInt(),
    hasUnread: r.hasUnread,
    hidden: r.hidden,
    awaitingApproval: r.awaitingApproval,
    pipelineStatus: RemoteWorktreePipelineStatus.fromWire(r.pipelineStatus),
    scriptStatus: r.scriptStatus,
    hookStatus: r.hookStatus,
    terminalStatus: r.terminalStatus,
    setupPhase: RemoteWorktreeSetupPhase.fromWire(r.setupPhase),
    lastActivityAt: r.lastActivityAt,
    createdAt: r.createdAt,
    insertions: r.insertions?.toInt(),
    deletions: r.deletions?.toInt(),
    prStatuses: [
      for (final p in r.prStatuses)
        RemoteWorktreePr(
          repoId: p.repoId,
          prNumber: p.prNumber?.toInt(),
          state: p.state,
          url: p.url,
          title: p.title,
          baseRefName: p.baseRefName,
          checkStatus: p.checkStatus,
          reviewStatus: p.reviewStatus,
          hasConflicts: p.hasConflicts,
          mergeReady: p.mergeReady,
          commentCount: p.commentCount?.toInt(),
          unresolvedReviewThreadCount: p.unresolvedReviewThreadCount?.toInt(),
          mergeQueue: switch (p.mergeQueue) {
            null => null,
            final q => RemotePrMergeQueue(
              inQueue: q.inQueue,
              position: q.position?.toInt(),
              phase: RemotePrMergeQueuePhase.fromWire(q.phase),
            ),
          },
        ),
    ],
    mergingPr: r.mergingPr,
    mergePrPhase: r.mergePrPhase,
    notificationSpaceId: r.notificationSpaceId,
  );

  static DeviceRecentChat _recent(RecentChatView c) => DeviceRecentChat(
    ref: _chat(c.chat),
    worktreeName: c.worktreeName,
    activityAt: switch (c.activityAtMs) {
      null => null,
      final ms => DateTime.fromMillisecondsSinceEpoch(ms.toInt(), isUtc: true),
    },
    attention: sameName(DeviceRecentAttention.values, c.attention),
  );

  @override
  bool get loading => _view?.loading ?? false;

  bool get _matchesSession =>
      _view?.session == chats.connection.connectedSession;

  @override
  bool get scopePending => !_matchesSession || (_view?.scopePending ?? false);
  @override
  String? get error => _matchesSession ? _view?.error : null;
  @override
  bool get hasInventory => _view?.hasInventory ?? false;
  @override
  List<DeviceProject> get projects => _projects;
  @override
  List<DeviceWorktree> get worktrees => _worktrees;
  @override
  Set<String> get codeProjectIds => _codeProjectIds;
  @override
  bool codeGraphBuilding(DeviceWorktree worktree) =>
      _building.contains(worktree.key);
  @override
  RemoteWorktree row(DeviceWorktree worktree) =>
      _rows[worktree.key] ??
      RemoteWorktree(
        localId: worktree.id,
        workspaceLocalId: worktree.projectId,
        branch: worktree.name,
      );
  @override
  DeviceOverviewScope scope(WorkspaceContext context) => _RustScope(
    _scopes[context.organizationId],
    _rows,
    projects: _projects,
    worktrees: _worktrees,
    hasUnknownOwners: _view?.hasUnknownOwners ?? false,
  );
  @override
  List<DeviceChatRef> get catalog => chats.chats.catalog;
  @override
  List<DeviceChatRef>? get currentCatalog =>
      _matchesSession && _view?.catalogCurrent == true ? _catalog : null;
  @override
  List<DeviceChatWorkspace> get catalogWorkspaces => chats.chats.workspaces;
  @override
  bool chatUnread(DeviceChatRef chat) =>
      _cowork['${chat.projectId}/${chat.worktreeId}']?[chat.id]?.unread ??
      false;
  @override
  bool chatWorking(DeviceChatRef chat) =>
      _cowork['${chat.projectId}/${chat.worktreeId}']?[chat.id]?.working ??
      false;
  @override
  bool get hasRecents => _view?.hasRecents ?? false;
  @override
  List<DeviceRecentChat> recents(WorkspaceContext context) =>
      _recents[context.organizationId] ?? const [];
  @override
  String? workEntryNotificationSpaceId(String chatId) =>
      _notificationSpaces[chatId];

  Future<void> _intent(
    Future<OverviewView> Function(OverviewService service) intent,
  ) async {
    final service = this.service;
    if (service == null || _disposed) return;
    try {
      _apply(await intent(service));
    } on CoreFailure catch (error) {
      debugPrint('Computer overview intent failed: ${error.code}');
    }
  }

  @override
  Future<void> refresh() => _intent((s) => s.refresh());
  @override
  Future<void> refreshSoon() => _intent((s) => s.refreshSoon());
  @override
  Future<void> reloadWorktrees() => _intent((s) => s.reloadWorktrees());
  @override
  Future<void> watch() => _intent((s) => s.watchOverview());
  @override
  void enterChat() => unawaited(_intent((s) => s.enterChat()));

  @override
  Future<WorktreeRead> loadWorktree(DeviceWorktree worktree) async {
    final service = this.service;
    if (service == null || _disposed) return WorktreeRead.unavailable;
    final WorktreeLoad outcome;
    try {
      outcome = await service.loadWorktree(
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        savedStatus: worktree.savedStatus,
        instance: worktree.inventoryInstance ?? 0,
      );
    } on CoreFailure catch (error) {
      debugPrint('Computer overview read failed: ${error.code}');
      return WorktreeRead.unavailable;
    }
    switch (outcome) {
      case WorktreeLoad_Loaded(:final field0):
        _applyChats(worktree, field0);
        return WorktreeRead.loaded;
      case WorktreeLoad_Unavailable():
        worktree.status = 'Unavailable';
        return WorktreeRead.unavailable;
      case WorktreeLoad_Stale():
        return WorktreeRead.stale;
      case WorktreeLoad_SessionLost():
        return WorktreeRead.sessionLost;
    }
  }

  /// One catalog read for the chats feature (`readDeviceChatCatalog`).
  Future<DeviceChatCatalog> readCatalog() async {
    final service = this.service;
    if (service == null) {
      throw const DeviceLinkException(connectFirstMessage);
    }
    final CatalogView view;
    try {
      view = await service.readCatalog();
    } on CoreFailure catch (error) {
      throw rustFailure(error);
    }
    return (
      chats: [for (final c in view.chats) _chat(c)],
      workspaces: [
        for (final w in view.workspaces) DeviceChatWorkspace(w.id, w.name),
      ],
    );
  }

  @override
  void dispose() {
    _disposed = true;
    unawaited(_views?.cancel());
    final service = this.service;
    if (service != null) {
      unawaited(service.close().then((_) {}, onError: (Object _) {}));
    }
    super.dispose();
  }
}

/// A context's slice as the core computed it. A context the core listed no
/// scope for owns nothing on this computer.
final class _RustScope implements DeviceOverviewScope {
  _RustScope(
    ContextScopeView? scope,
    this._rows, {
    required List<DeviceProject> projects,
    required List<DeviceWorktree> worktrees,
    required this.hasUnknownOwners,
  }) : _scope = scope {
    final projectIds = scope?.projectIds.toSet() ?? const {};
    this.projects = List.unmodifiable(
      projects.where((p) => projectIds.contains(p.id)),
    );
    final all = _allKeys = scope?.allWorktreeKeys.toSet() ?? const {};
    final visible = _visibleKeys = scope?.worktreeKeys.toSet() ?? const {};
    allWorktrees = List.unmodifiable(
      worktrees.where((w) => all.contains(w.key)),
    );
    this.worktrees = List.unmodifiable(
      worktrees.where((w) => visible.contains(w.key)),
    );
    _coworkIds = scope?.coworkProjectIds.toSet() ?? const {};
  }
  final ContextScopeView? _scope;
  final Map<String, RemoteWorktree> _rows;
  late final Set<String> _allKeys, _visibleKeys, _coworkIds;
  @override
  late final List<DeviceProject> projects;
  @override
  late final List<DeviceWorktree> worktrees;
  @override
  late final List<DeviceWorktree> allWorktrees;
  @override
  final bool hasUnknownOwners;

  @override
  late final AttentionSectionsData attention = () {
    List<AttentionEntry> entries(List<AttentionEntryView> rows) => [
      for (final e in rows)
        if (_rows[e.worktreeKey] case final row?)
          AttentionEntry(worktree: row, workspaceName: e.workspaceName),
    ];
    final a = _scope?.attention;
    return AttentionSectionsData(
      awaitingApproval: entries(a?.awaitingApproval ?? const []),
      unreadChats: entries(a?.unreadChats ?? const []),
      inProgress: entries(a?.inProgress ?? const []),
      pipelinesRunning: entries(a?.pipelinesRunning ?? const []),
      pipelinesFinished: entries(a?.pipelinesFinished ?? const []),
    );
  }();

  @override
  bool includesWorktree(DeviceWorktree worktree) =>
      _allKeys.contains(worktree.key);

  @override
  bool includesChat(DeviceChatRef chat) =>
      _coworkIds.contains(chat.projectId) ||
      _visibleKeys.contains('${chat.projectId}/${chat.worktreeId}');

  @override
  List<DeviceChatRef> chats(Iterable<DeviceChatRef> catalog) =>
      List.unmodifiable(catalog.where(includesChat));
}
