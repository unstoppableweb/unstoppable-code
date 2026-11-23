import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:computer_connect_core/computer_connect_core.dart' as core;
import 'package:mobile/data/models/computer_activity/activity.dart';
import 'package:mobile/data/models/computer_activity/pr.dart';
import 'package:mobile/data/models/computer_activity/pr_check.dart';
import 'package:mobile/data/models/computer_activity/pr_merge_queue.dart';
import 'package:mobile/data/models/computer_activity/pr_progress.dart';
import 'package:mobile/data/models/computer_activity/pr_status.dart';
import 'package:mobile/device_link/chats/dto.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/chats/state.dart';
import 'package:mobile/device_link/protocol.dart';
import 'package:mobile/device_link/rust_core/failures.dart';
import 'package:mobile/device_link/rust_core/value_codec.dart';
import 'package:mobile/device_link/worktree_ref.dart';
import 'package:mobile/ui/core/file_viewer/file_viewer_source.dart';
import 'package:mobile/ui/core/files/changed_files_grouping.dart';
import 'package:mobile/ui/core/files/changed_files_load_status.dart';

import '../activity_model.dart';
import '../files_model.dart';
import '../pipelines_model.dart';
import 'rust_chats.dart';
import 'same_name.dart';

core.ChatRefView _ref(DeviceChatRef ref) => core.ChatRefView(
  projectId: ref.projectId,
  worktreeId: ref.worktreeId,
  id: ref.id,
  title: ref.title,
);

/// [intent]'s outcome; a core failure as the Dart transport throws it.
Future<core.ActivitySettled> _settle(
  core.ActivityService service,
  core.ActivityIntent intent,
) async {
  try {
    return await service.settled(ticket: service.request(intent: intent));
  } on core.CoreFailure catch (error) {
    throw rustFailure(error);
  }
}

/// The core's PR rows in the shared activity types the drawer draws.
RemotePrRepo _repo(core.PrRepoView r) => RemotePrRepo(
  repoId: r.repoId,
  repoName: r.repoName,
  pr: switch (r.pr) {
    final pr? => _pr(pr),
    null => null,
  },
  baseBranch: r.baseBranch,
  headBranch: r.headBranch,
  published: r.published,
  canCreate: r.canCreate,
  canMerge: r.canMerge,
  mergeWarning: r.mergeWarning,
  createBlockedReason: r.createBlockedReason,
  mergeBlockedReason: r.mergeBlockedReason,
);

RemoteWorktreePr _pr(core.PrView p) => RemoteWorktreePr(
  repoId: p.repoId,
  prNumber: p.number,
  url: p.url,
  state: p.state,
  title: p.title,
  baseRefName: p.baseRefName,
  checkStatus: p.checkStatus,
  checks: [
    for (final c in p.checks)
      RemotePrCheck(
        name: c.name,
        status: c.status,
        executionState: c.executionState,
        detailsUri: switch (c.detailsUrl) {
          final url? => Uri.parse(url),
          null => null,
        },
      ),
  ],
  reviewStatus: p.reviewStatus,
  mergeReady: p.mergeReady,
  hasConflicts: p.hasConflicts,
  commentCount: p.commentCount,
  unresolvedReviewThreadCount: p.unresolvedReviewThreadCount,
  mergeQueue: switch (p.mergeQueue) {
    final q? => RemotePrMergeQueue(
      inQueue: q.inQueue,
      position: q.position,
      phase: switch (q.phase) {
        final phase? => sameName(RemotePrMergeQueuePhase.values, phase),
        null => null,
      },
    ),
    null => null,
  },
);

RemotePrProgressState? _progress(core.PrProgressView? p) => switch (p) {
  null => null,
  final p => RemotePrProgressState(
    creation: switch (p.creation) {
      final c? => RemotePrCreationProgress(
        currentPhase: sameName(RemotePrCreationPhase.values, c.current),
        steps: [
          for (final s in c.steps)
            RemotePrCreationStep(
              phase: sameName(RemotePrCreationPhase.values, s.phase),
              repoName: s.repoName,
              error: s.error,
            ),
        ],
      ),
      null => null,
    },
    merge: switch (p.merge) {
      final m? => RemoteMergePrProgress(
        currentPhase: sameName(RemoteMergePrPhase.values, m.current),
        steps: [
          for (final s in m.steps)
            RemoteMergePrStep(
              phase: sameName(RemoteMergePrPhase.values, s.phase),
              repoId: s.repoId,
              repoName: s.repoName,
              queuePosition: s.queuePosition,
              queueLength: s.queueLength,
              retryDelayMs: s.retryDelayMs,
              error: s.error,
            ),
        ],
      ),
      null => null,
    },
  ),
};

RemoteScriptDescriptor _script(core.ScriptView s) => RemoteScriptDescriptor(
  scriptKey: s.key,
  scriptName: s.scriptName,
  name: s.name,
  target: s.target,
);

/// The core's activity view in the shared types the drawer draws, mapped
/// once per view. [previous] keeps the PR rows' identity while they are
/// unchanged (the PR card resets its own copy when they change).
DeviceActivityView _view(
  core.ActivityView v,
  ({core.ActivityView core, DeviceActivityView view})? previous,
) {
  final changed = [
    for (final f in v.changedFiles)
      RemoteChangedFile(
        filePath: f.path,
        status: f.status,
        committed: f.committed,
        repoId: f.repoId,
        repoName: f.repoName,
        insertions: f.insertions,
        deletions: f.deletions,
      ),
  ];
  return DeviceActivityView(
    activity: RemoteWorktreeActivity(
      summary: switch (v.summary) {
        final s? => RemoteWorktreeSummary(
          title: s.title,
          description: s.description,
          generatedAt: s.generatedAt,
        ),
        null => null,
      },
      plans: [
        for (final p in v.plans)
          RemoteActivityPlan(title: p.title, status: p.status),
      ],
      todoLists: [
        for (final l in v.todoLists)
          RemoteChatTodoList(
            chatId: l.chatId,
            items: [
              for (final i in l.items)
                RemoteTodoItem(id: i.id, content: i.content, status: i.status),
            ],
          ),
      ],
      scriptDescriptors: [for (final s in v.scripts) _script(s)],
      scriptRuns: [
        for (final r in v.scriptRuns)
          RemoteScriptRun(
            script: _script(r.script),
            status: r.status,
            startedAt: r.startedAt,
          ),
      ],
      hookDescriptors: [
        for (final h in v.hooks)
          RemoteHookDescriptor(
            name: h.name,
            hookKey: h.hookKey,
            triggerName: h.triggerName,
            paused: h.paused,
            runDisabled: h.runDisabled,
            runDisabledReason: h.runDisabledReason,
          ),
      ],
      hookRuns: [
        for (final r in v.hookRuns)
          RemoteActivityRun(name: r.name, status: r.status),
      ],
      changedFiles: changed,
    ),
    filesStatus: switch (v.filesStatus) {
      core.FilesStatus_Loading() => ChangedFilesLoadStatus.loading,
      core.FilesStatus_Loaded() => ChangedFilesLoadStatus.loaded,
      core.FilesStatus_Failed(:final message) => ChangedFilesLoadStatus.failed(
        message,
      ),
    },
    errors: v.errors,
    insertions: v.insertions,
    deletions: v.deletions,
    prRepos: previous != null && previous.core.prs == v.prs
        ? previous.view.prRepos
        : switch (v.prs) {
            final prs? => List.unmodifiable(prs.map(_repo)),
            null => null,
          },
    prBusy: v.prBusy,
    prProgress: _progress(v.prProgress),
    prError: v.prError,
    hookError: v.hookError,
    todoUnavailableReason: v.todoUnavailable,
    fileSections: [
      for (final s in v.fileSections)
        ChangedFilesSection(
          committed: s.committed,
          summary: ChangedFilesSummary(
            fileCount: s.fileCount,
            insertions: s.insertions,
            deletions: s.deletions,
          ),
          groups: [
            for (final g in s.groups)
              ChangedFileDirectoryGroup(
                repoId: g.repoId,
                repoName: g.repoName,
                directory: g.directory,
                files: [
                  for (final f in g.files)
                    ChangedFileEntry(file: changed[f.index], fileName: f.name),
                ],
              ),
          ],
        ),
    ],
  );
}

/// One computer's worktree activity on the core's [core.ActivityService]
/// (P6). The core owns the reads, hooks, todos (it follows the chat read
/// path's selection), pull requests and diffs; this model maps each view
/// it streams into the shared activity types once. Pipelines are
/// [pipelines].
final class RustComputerActivity implements ComputerActivity {
  RustComputerActivity(this.service, {required this.pipelines});

  final core.ActivityService service;
  @override
  final ComputerPipelines pipelines;
  @override
  late final RustComputerFileDiffs diffs = RustComputerFileDiffs(service);
  final _updates = StreamController<void>.broadcast();
  final _views =
      <String, ({core.ActivityView core, DeviceActivityView view})>{};
  final _counts = <String, int>{};
  final _watches = <int, StreamSubscription<core.ActivityView>>{};
  final _kinds = <String, String>{};
  int _tokens = 0;
  bool _disposed = false;

  @override
  Stream<void> get updates => _updates.stream;

  /// The core's last view of [ref]'s worktree (the comparison reads it).
  core.ActivityView? coreView(DeviceChatRef ref) => _views[ref.key]?.core;

  @override
  DeviceActivityView view(DeviceChatRef ref) =>
      _views[ref.key]?.view ??
      const DeviceActivityView(
        activity: RemoteWorktreeActivity(),
        filesStatus: ChangedFilesLoadStatus.loading,
      );

  void _apply(DeviceChatRef ref, core.ActivityView v) {
    if (_disposed) return;
    _views[ref.key] = (core: v, view: _view(v, _views[ref.key]));
    _updates.add(null);
  }

  Future<core.ActivitySettled> _request(core.ActivityIntent intent) =>
      _settle(service, intent);

  @override
  void Function() watch(DeviceChatRef ref) {
    final token = ++_tokens;
    // Dart watched the pipelines before its load started, so a load the
    // caller asks for right after joins this one (as `_reads` did).
    final releasePipelines = pipelines.watch(ref);
    service.send(
      intent: core.ActivityIntent.watch(chat: _ref(ref), token: token),
    );
    _counts[ref.key] = (_counts[ref.key] ?? 0) + 1;
    _watches[token] = service
        .watch(chat: _ref(ref), token: token)
        .listen((view) => _apply(ref, view));
    var released = false;
    return () {
      if (released) return;
      released = true;
      releasePipelines();
      unawaited(_watches.remove(token)?.cancel());
      // A later watch gets the core's view of the worktree at once.
      final count = _counts[ref.key] ?? 0;
      if (count > 1) {
        _counts[ref.key] = count - 1;
      } else {
        _counts.remove(ref.key);
        _views.remove(ref.key);
      }
      if (!_disposed) {
        service.send(intent: core.ActivityIntent.release(token: token));
      }
    };
  }

  @override
  Future<void> load(DeviceChatRef ref) =>
      _request(core.ActivityIntent.load(chat: _ref(ref)));

  @override
  Future<void> setHookPaused(DeviceChatRef ref, String hookKey, bool paused) =>
      _request(
        core.ActivityIntent.setHookPaused(
          chat: _ref(ref),
          hookKey: hookKey,
          paused: paused,
        ),
      );

  @override
  Future<Map<String, dynamic>> runPrAction(
    DeviceChatRef ref,
    RemotePrAction action, {
    String? repoId,
    RemotePrActionIdentity? identity,
    bool confirmUnresolvedComments = false,
  }) async {
    final settled = await _request(
      core.ActivityIntent.runPr(
        chat: _ref(ref),
        action: sameName(core.PrActionKind.values, action),
        repoId: repoId,
        identity: switch (identity) {
          final i? => core.PrIdentityView(
            baseBranch: i.baseBranch,
            headBranch: i.headBranch,
            prNumber: i.prNumber,
          ),
          null => null,
        },
        confirmUnresolvedComments: confirmUnresolvedComments,
      ),
    );
    if (settled.failure case final failure?) {
      throw failure.link
          ? DeviceLinkException(failure.message)
          : Exception(failure.message);
    }
    if (settled.discarded) return remotePrActionDiscardedResult;
    final result = switch (settled.resultJson) {
      final json? => deviceChatDto(decodeRustValue(jsonDecode(json))),
      null => null,
    };
    return deviceLinkObject(result);
  }

  /// The core follows the chat read path's selection itself.

  @override
  void setWorkspaceKind(String id, String kind) => _kinds[id] = kind;
  @override
  String? workspaceKind(String id) => _kinds[id];

  @override
  Future<void> setConnected(bool connected) async {
    pipelines.setConnected(connected);
    await _request(core.ActivityIntent.setConnected(connected: connected));
  }

  @override
  Future<void> dispose() async {
    _disposed = true;
    service.send(intent: const core.ActivityIntent.close());
    for (final watch in _watches.values) {
      await watch.cancel();
    }
    _watches.clear();
    diffs._dispose();
    await pipelines.dispose();
    await _updates.close();
  }
}

/// Changed-file diffs on the core: it reads, caches and classifies each
/// diff; the screen draws the lines it sends.
final class RustComputerFileDiffs implements ComputerFileDiffs {
  RustComputerFileDiffs(this.service);
  final core.ActivityService service;
  final _updates = StreamController<ComputerFileDiffKey>.broadcast();
  final _views = <ComputerFileDiffKey, core.FileDiffView>{};
  final _counts = <ComputerFileDiffKey, int>{};
  final _watches = <int, StreamSubscription<core.FileDiffView>>{};
  int _tokens = 0;
  bool _disposed = false;

  static const _loading = core.FileDiffView(
    phase: core.DiffPhase.loading(),
    lines: [],
    truncated: false,
    lineLengthTruncated: false,
  );

  @override
  Stream<ComputerFileDiffKey> get updates => _updates.stream;

  @override
  ComputerFileDiffKey key(DeviceWorktreeRef ref, RemoteChangedFile file) => (
    projectId: ref.projectId,
    worktreeId: ref.worktreeId,
    repoId: file.repoId,
    path: file.filePath,
    committed: file.committed,
  );

  core.DiffTargetView _target(DeviceWorktreeRef ref, RemoteChangedFile file) =>
      core.DiffTargetView(
        projectId: ref.projectId,
        worktreeId: ref.worktreeId,
        repoId: file.repoId,
        path: file.filePath,
        committed: file.committed,
        insertions: file.insertions,
        deletions: file.deletions,
      );

  @override
  core.FileDiffView view(DeviceWorktreeRef ref, RemoteChangedFile file) =>
      _views[key(ref, file)] ?? _loading;

  @override
  void Function() watch(DeviceWorktreeRef ref, RemoteChangedFile file) {
    if (_disposed) return () {};
    final token = ++_tokens, target = key(ref, file);
    service.send(
      intent: core.ActivityIntent.watchDiff(
        target: _target(ref, file),
        token: token,
      ),
    );
    _counts[target] = (_counts[target] ?? 0) + 1;
    _watches[token] = service
        .watchDiff(file: _target(ref, file), token: token)
        .listen((view) {
          if (_disposed) return;
          _views[target] = view;
          _updates.add(target);
        });
    var released = false;
    return () {
      if (released) return;
      released = true;
      unawaited(_watches.remove(token)?.cancel());
      // A later watch gets the core's view of the diff at once.
      final count = _counts[target] ?? 0;
      if (count > 1) {
        _counts[target] = count - 1;
      } else {
        _counts.remove(target);
        _views.remove(target);
      }
      if (!_disposed) {
        service.send(intent: core.ActivityIntent.releaseDiff(token: token));
      }
    };
  }

  @override
  Future<void> refresh(DeviceWorktreeRef ref, RemoteChangedFile file) =>
      _settle(
        service,
        core.ActivityIntent.refreshDiff(target: _target(ref, file)),
      );

  void _dispose() {
    _disposed = true;
    for (final watch in _watches.values) {
      unawaited(watch.cancel());
    }
    _watches.clear();
    unawaited(_updates.close());
  }
}

/// A worktree root's reads for the file viewer, on the core's
/// [core.FileReader] (at most two at a time; the core maps failures to the
/// viewer's problems).
final class RustFileViewerSource implements FileViewerSource {
  const RustFileViewerSource(this.reader);
  final core.FileReader reader;

  @override
  Future<FileViewerText> readText(String path) async => switch (await reader
      .readText(path: path)) {
    core.FileTextOutcome_Text(:final contents, :final truncated) =>
      FileViewerText(contents: contents, truncated: truncated),
    core.FileTextOutcome_Problem(:final problem) => throw FileViewerException(
      sameName(FileViewerProblem.values, problem),
    ),
  };

  @override
  Future<Uint8List> readBytes(String path) async => switch (await reader
      .readBytes(path: path)) {
    core.FileBytesOutcome_Bytes(:final bytes) => bytes,
    core.FileBytesOutcome_Problem(:final problem) => throw FileViewerException(
      sameName(FileViewerProblem.values, problem),
    ),
  };
}

/// The worktree's file tabs (from the chat header) and viewer reads on the
/// core's [core.FilesService].
final class RustComputerFiles implements ComputerFiles {
  RustComputerFiles(this.service, this.reader);
  final core.FilesService service;
  final RustChatReader reader;

  @override
  List<ComputerFileTab> tabs(DeviceChatState? state) => [
    if (state != null)
      for (final tab in reader.header?.fileTabs ?? const <core.FileTabView>[])
        ComputerFileTab(tab),
  ];

  @override
  Future<ComputerFileLocation> open(ComputerFileTab tab) async {
    switch (await service.locate(tab: tab.tab)) {
      case core.LocateOutcome_Located(:final location):
        final files = service.reader(location: location);
        return ComputerFileLocation(
          path: location.relativePath,
          source: RustFileViewerSource(files),
          close: files.close,
        );
      case core.LocateOutcome_Outside():
        throw const ComputerFileOutsideWorktree();
      case core.LocateOutcome_Failed():
        // The chat screen words it; this text is not shown.
        throw const DeviceLinkException('file roots unreadable');
    }
  }

  @override
  void clear() => service.clear();
}
