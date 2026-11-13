import 'dart:async';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/chats/overview_repository.dart';
import 'package:mobile/device_link/chats/recents.dart';
import 'package:mobile/device_link/chats/home_options.dart';
import 'package:mobile/ui/core/activity/worktree_activity_context.dart';
import 'package:mobile/device_link/worktrees/archive.dart';
import 'package:mobile/device_link/projects/clone_repository.dart';
import 'package:mobile/device_link/worktrees/creation.dart';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:mobile/device_link/desktop/relay.dart';
import 'package:mobile/device_link/worktrees/repository.dart';
import 'package:mobile/device_link/protocol.dart';
import '../chats_view_model.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/device_link/worktrees/context_scope.dart';

// An interrupted open needs a next step while ownership is being re-read.
const deviceScopeRefreshingMessage =
    'Projects are refreshing. Try opening this task again when they finish.';

/// Account discovery and overview lifetime belong only to Computer connect.
class ComputerConnectController extends ChangeNotifier {
  ComputerConnectController(
    this.chats, {
    this.connectComputer,
    this.createTimer = Timer.new,
  }) {
    chats.connection.addListener(_connectionChanged);
    _events = chats.chats.ipc.events.listen(_event);
    _connectionChanged();
  }
  final DeviceChatsViewModel chats;
  final Timer Function(Duration, void Function()) createTimer;
  final Future<void> Function(DesktopRelayPeer, DesktopTokenProvider)?
  connectComputer;
  late final DeviceWorktreesRepository worktrees = DeviceWorktreesRepository(
    chats.chats.ipc,
    onChanged: () {
      // The repository publishes only after re-reading inventory and owners.
      // Slow chat summaries must not keep the roster in its loading state.
      _scopePending = false;
      clones.retireListed({
        for (final project in worktrees.projects) project.id,
      });
      _notify();
    },
  );
  late final homeOptions = DeviceChatHomeOptionsService(chats.chats.ipc);
  late final overviewChats = DeviceChatOverviewRepository(
    chats.chats.ipc,
    onChanged: _notify,
  );

  /// The drawer's Recents for this computer, read beside the overview.
  late final recents = DeviceRecentChatsRepository(
    chats.chats.ipc,
    onChanged: _notify,
  );
  late final worktreeCreator = DeviceWorktreeCreator(chats.chats.ipc)
    ..setConnected(chats.online);
  late final _archiver = DeviceWorktreeArchiver(chats.chats.ipc);
  late final clones = DeviceProjectCloneRepository(
    chats.chats.ipc,
    onChanged: _notify,
    onCreated: _cloneCreated,
  )..setConnected(chats.online);

  /// A clone created a project while an inventory read was in flight.
  bool _refreshAgain = false;
  final _archiving = <String>{};
  List<DesktopRelayPeer> computers = [];
  bool discovering = false, loading = false;
  String? error;
  DesktopTokenProvider? _tokens;
  bool _disposed = false, _online = false, _overview = true;
  bool _scopePending = false;
  bool get scopePending => _scopePending;
  bool _active = true;
  bool get active => !_disposed && _active;

  /// Navigation only. Other computers keep their sessions, caches and drafts.
  void setActive(bool value) {
    if (_active == value) return;
    _active = value;
    _notify();
  }

  /// Actions need current ownership even while the overview shows cached rows.
  DeviceContextScope scopeFor(WorkspaceContext? context) => _scopePending
      ? DeviceContextScope(
          context ?? const WorkspaceContext.personal(),
          const [],
          const [],
        )
      : overviewScopeFor(context);

  DeviceContextScope overviewScopeFor(WorkspaceContext? context) =>
      DeviceContextScope(
        context ?? const WorkspaceContext.personal(),
        active ? worktrees.projects : const [],
        active ? worktrees.worktrees : const [],
      );

  int _refreshGeneration = 0;
  int _generation = 0;
  StreamSubscription<Map<String, dynamic>>? _events;
  Timer? _refresh;
  final _pendingScopes = <String>{};
  bool _readingScope = false;
  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> findComputers(String origin, String key) async {
    if (discovering || chats.online) return;
    try {
      final credentials = DesktopRelayCredentials.parse(
        jsonEncode({
          'apiUrl': origin.trim(),
          'apiKey': key.trim(),
          'peerDeviceId': 'AAAAAAAAAAAAAAAAAAAAAA',
        }),
      );
      await discoverWith((id) => fetchDesktopRelayToken(credentials, id));
    } catch (cause) {
      error = _describe(cause);
      _notify();
    }
  }

  Future<void> discoverWith(DesktopTokenProvider tokens) async {
    if (discovering || chats.online) return;
    final generation = ++_generation;
    discovering = true;
    computers = [];
    error = null;
    _notify();
    DesktopRelay? relay;
    try {
      final identity = await chats.connection.repository.identity();
      relay = await chats.connection.repository.hub.relay(tokens);
      if (_disposed || generation != _generation) return;
      computers =
          relay.peers.values
              .where((p) => p.acceptsControl && p.id != identity.deviceId)
              .toList()
            ..sort((a, b) => a.name.compareTo(b.name));
      _tokens = tokens;
    } catch (cause) {
      if (generation == _generation) error = _describe(cause);
    } finally {
      if (generation == _generation) {
        discovering = false;
        _notify();
      }
    }
  }

  Future<void> connect(DesktopRelayPeer computer) async {
    final tokens = _tokens;
    if (tokens == null ||
        discovering ||
        chats.connection.busy ||
        !computers.contains(computer)) {
      return;
    }
    computers = [];
    if (connectComputer case final connect?) {
      await connect(computer, tokens);
      return;
    }
    await chats.connection.connectWith(
      peerDeviceId: computer.id,
      fetchToken: tokens,
    );
    _notify();
  }

  void _connectionChanged() {
    final online = chats.online;
    // An explicit disconnect can follow suspension without changing `online`.
    if (!online && !chats.connection.reconnecting) {
      worktrees.invalidate();
      overviewChats.invalidate();
      recents.invalidate();
    }
    worktreeCreator.setConnected(online);
    clones.setConnected(online);
    if (_online != online) {
      _online = online;
      _refreshGeneration++;
      loading = false;
      _scopePending = true;
      if (online && _overview) {
        unawaited(watchOverview());
      } else {
        if (online || chats.connection.reconnecting) {
          worktrees.pause();
          overviewChats.pause();
          recents.pause();
        } else {
          worktrees.invalidate();
          overviewChats.invalidate();
          recents.invalidate();
        }
        _pendingScopes.clear();
        loading = false;
        _refresh?.cancel();
      }
    }
    _notify();
  }

  void _event(Map<String, dynamic> message) {
    if (!chats.online || message['name'] != 'ipc.push') return;
    final push = message['payload'];
    if (push is! Map) return;
    // Desktop sends each build transition once, so track them while a chat
    // is open too; going offline clears the set.
    if (push['channel'] == 'code-graph:build-status-changed' &&
        push['args'] is List &&
        (push['args'] as List).isNotEmpty &&
        worktrees.applyCodeGraphStatus((push['args'] as List).first)) {
      _notify();
    }
    if (push['channel'] == 'org-projects:ownership-changed') {
      // Retire old evidence and re-read immediately. Streaming activity must
      // not postpone ownership behind the shared summary debounce.
      _refreshGeneration++;
      loading = false;
      _scopePending = true;
      worktrees.invalidateInventory();
      overviewChats.invalidate();
      // A failed re-read must not keep filtering Recents by the old owner.
      recents.invalidate();
      _pendingScopes.clear();
      _refresh?.cancel();
      _notify();
      if (_overview) unawaited(refresh());
      return;
    }
    if (!_overview) return;
    if (push['channel'] == 'chat:state-changed' &&
        push['args'] is List &&
        (push['args'] as List).isNotEmpty) {
      final event = (push['args'] as List).first;
      if (event is Map &&
          (event['changes'] as List? ?? []).whereType<Map>().any(
            (change) =>
                const {
                  'runtime.patched',
                  'tab.created',
                  'tab.upserted',
                  'tab.removed',
                }.contains(change['type']) ||
                (change['type'] == 'tab.metadata_patched' &&
                    change['patch'] is Map &&
                    (change['patch'] as Map).containsKey('unread')),
          )) {
        _pendingScopes.add('${event['projectId']}/${event['worktreeId']}');
        unawaited(_readScopes());
      }
    }
    if ([
      'worktrees:file-changed',
      'workspace:worktrees-updated',
      'chat:state-changed',
      // Snapshot invalidation is Portal-scoped. Lifecycle pushes also arrive
      // without Portal, so observe them directly for execution indicators.
      'desktop:session-snapshot-stale',
      'script:started',
      'script:complete',
      'hook:started',
      'hook:complete',
      'terminal:spawned',
      'terminal:exit',
      'terminal:running-changed',
      'pipelines:execution-event',
      'pipelines:queue-event',
    ].contains(push['channel'])) {
      // Bulk inventory waits for a quiet period; tab/read changes refresh
      // their own scope immediately instead of waiting behind this debounce.
      // No polling remains active while the app is suspended/disconnected.
      _refresh?.cancel();
      _refresh = createTimer(
        const Duration(seconds: 2),
        () => unawaited(refresh()),
      );
    }
  }

  Future<void> _readScopes() async {
    if (_readingScope) return;
    _readingScope = true;
    try {
      while (!_disposed &&
          _overview &&
          chats.online &&
          _pendingScopes.isNotEmpty) {
        final key = _pendingScopes.first;
        _pendingScopes.remove(key);
        final worktree = worktrees.worktrees
            .where((w) => w.key == key)
            .firstOrNull;
        final chat = overviewChats.target(key);
        if (worktree != null || chat != null) {
          final generation = _refreshGeneration;
          if (worktree != null) {
            await worktrees.load(worktree);
          } else if (chat != null) {
            await overviewChats.load(chat);
          }
          _notify();
          // A full refresh can replace this row while its scope read is in
          // flight. Replay against the replacement so an older snapshot
          // cannot restore an unread flag after a newer read notification.
          if (loading ||
              generation != _refreshGeneration ||
              (worktree != null && !worktrees.worktrees.contains(worktree))) {
            _pendingScopes.add(key);
            if (loading) break;
          }
        }
      }
    } finally {
      _readingScope = false;
    }
  }

  /// Explicit search retry acknowledges prior open errors before reloading.
  Future<void> retrySearch() {
    if (!active) return Future.value();
    chats.error = null;
    return refresh();
  }

  Future<void> refresh() async {
    if (!chats.online || loading) return;
    final generation = ++_refreshGeneration;
    loading = true;
    error = null;
    _notify();
    unawaited(clones.readBack());
    unawaited(recents.refresh());
    try {
      await Future.wait([worktrees.refresh(), chats.chats.refreshCatalog()]);
      if (generation == _refreshGeneration) {
        final coworkProjects = {
          for (final project in worktrees.projects)
            if (project.type == 'cowork') project.id,
        };
        await overviewChats.refresh(
          chats.chats.catalog.where(
            (chat) => coworkProjects.contains(chat.projectId),
          ),
        );
      }
      if (generation == _refreshGeneration) {
        _scopePending = false;
      }
    } catch (cause) {
      if (generation == _refreshGeneration) error = _describe(cause);
    } finally {
      if (generation == _refreshGeneration) {
        loading = false;
        _notify();
        if (_refreshAgain) {
          _refreshAgain = false;
          unawaited(refresh());
        } else {
          unawaited(_readScopes());
        }
      }
    }
  }

  /// Re-reads ownership too: the new project's owner comes from the session
  /// snapshot, which the computer may still have cached.
  void _cloneCreated() {
    if (!chats.online) return;
    unawaited(() async {
      try {
        await chats.chats.ipc.invoke('desktop:session-snapshot-invalidate');
      } on DeviceLinkException {
        // Older hosts may refuse it; their snapshot pushes refresh instead.
      }
      // A read already in flight may predate the project; read once more.
      if (loading) {
        _refreshAgain = true;
      } else {
        await refresh();
      }
    }());
  }

  bool canArchiveWorktree(DeviceWorktree worktree) =>
      chats.online &&
      !_scopePending &&
      worktrees.codeProjectIds.contains(worktree.projectId);
  bool isArchivingWorktree(DeviceWorktree worktree) =>
      _archiving.contains(worktree.key);

  /// Keeps the row archiving until a re-read drops it, so it does not flash
  /// back between the archive reply and the overview refresh.
  Future<void> archiveWorktree(DeviceWorktree worktree) async {
    if (!canArchiveWorktree(worktree) || !_archiving.add(worktree.key)) return;
    _notify();
    try {
      await _archiver.archive(worktree.projectId, worktree.id);
      try {
        await worktrees.refresh();
      } catch (_) {
        // Lifecycle pushes schedule another re-read.
      }
    } finally {
      _archiving.remove(worktree.key);
      _notify();
    }
  }

  WorktreeActivityContext? activityContext(DeviceChatRef ref) {
    final project = worktrees.projects
        .where((p) => p.id == ref.projectId)
        .firstOrNull;
    chats.activity.setWorkspaceKind(
      ref.projectId,
      project?.type ?? 'single-repo',
    );
    return worktrees.codeProjectIds.contains(ref.projectId)
        ? WorktreeActivityContext(
            workspaceLocalId: ref.projectId,
            localId: ref.worktreeId,
          )
        : null;
  }

  void enterChat() {
    _overview = false;
    _pendingScopes.clear();
    _refresh?.cancel();
  }

  Future<void> watchOverview() async {
    _overview = true;
    if (!chats.online) return;
    try {
      await chats.chats.ipc.invoke('chat:set-state-scopes', [
        {'kind': 'all'},
      ]);
      if (_disposed || !_overview) return;
      await refresh();
    } catch (cause) {
      if (_disposed || !_overview) return;
      error = _describe(cause);
      _notify();
    }
  }

  Future<void> restoreOverview(int selectionGeneration) async {
    if (_disposed || chats.chats.selectionGeneration != selectionGeneration) {
      return;
    }
    await chats.leaveChat(expectedGeneration: selectionGeneration);
    if (_disposed ||
        chats.chats.selectionGeneration != selectionGeneration + 1) {
      return;
    }
    await watchOverview();
  }

  Future<void> disconnect() async {
    _generation++;
    _tokens = null;
    computers = [];
    discovering = false;
    await chats.connection.disconnectAndClear();
    _notify();
  }

  String _describe(Object cause) => cause is DeviceLinkException
      ? cause.message
      : 'Could not read your computer. Try again.';
  @override
  void dispose() {
    _disposed = true;
    _generation++;
    _refreshGeneration++;
    _refresh?.cancel();
    worktrees.invalidate();
    overviewChats.invalidate();
    recents.invalidate();
    unawaited(worktreeCreator.dispose());
    clones.dispose();
    chats.connection.removeListener(_connectionChanged);
    unawaited(_events?.cancel());
    super.dispose();
  }
}
