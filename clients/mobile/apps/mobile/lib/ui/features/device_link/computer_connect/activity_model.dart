import 'dart:async';

import 'package:computer_connect_core/computer_connect_core.dart' as core;
import 'package:mobile/data/models/computer_activity/activity.dart';
import 'package:mobile/data/models/computer_activity/pr.dart';
import 'package:mobile/data/models/computer_activity/pr_progress.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/worktree_ref.dart';
import 'package:mobile/ui/core/files/changed_files_grouping.dart';
import 'package:mobile/ui/core/files/changed_files_load_status.dart';

import 'pipelines_model.dart';

/// What the activity drawer shows for one chat's worktree.
final class DeviceActivityView {
  const DeviceActivityView({
    required this.activity,
    required this.filesStatus,
    this.errors = const [],
    this.insertions = 0,
    this.deletions = 0,
    this.prRepos,
    this.prBusy = false,
    this.prProgress,
    this.prError,
    this.hookError,
    this.todoUnavailableReason,
    this.fileSections = const [],
  });

  /// The worktree's activity, with its configured hooks once read.
  final RemoteWorktreeActivity activity;

  /// The changed files' load state while connected.
  final ChangedFilesLoadStatus filesStatus;

  /// The activity reads' failures.
  final List<String> errors;

  /// The changed files' line totals.
  final int insertions, deletions;

  /// The saved and pushed pull request observations; null until read.
  final List<RemotePrRepo>? prRepos;
  final bool prBusy;
  final RemotePrProgressState? prProgress;
  final String? prError;
  final String? hookError;
  final String? todoUnavailableReason;

  final List<ChangedFilesSection> fileSections;
}

/// A changed file's diff key (the same record as the Dart repository's).
typedef ComputerFileDiffKey = ({
  String projectId,
  String worktreeId,
  String? repoId,
  String path,
  bool committed,
});

/// Per-computer activity and diff views and actions.
abstract interface class ComputerActivity {
  /// Fires after every change of [view].
  Stream<void> get updates;

  /// What [ref]'s worktree shows now.
  DeviceActivityView view(DeviceChatRef ref);

  /// Shows [ref]'s worktree (the drawer opened); the returned function
  /// ends it.
  void Function() watch(DeviceChatRef ref);

  /// Reads [ref]'s worktree activity and configured hooks again.
  Future<void> load(DeviceChatRef ref);

  /// Sets a configured hook's paused state.
  Future<void> setHookPaused(DeviceChatRef ref, String hookKey, bool paused);

  /// Refreshes pull requests, or creates or merges one; completes with the
  /// desktop's result (or `remotePrActionDiscardedResult`).
  Future<Map<String, dynamic>> runPrAction(
    DeviceChatRef ref,
    RemotePrAction action, {
    String? repoId,
    RemotePrActionIdentity? identity,
    bool confirmUnresolvedComments = false,
  });

  void setWorkspaceKind(String id, String kind);
  String? workspaceKind(String id);

  /// The changed files' diffs.
  ComputerFileDiffs get diffs;

  /// The computer's pipelines and work drawers.
  ComputerPipelines get pipelines;

  Future<void> dispose();
}

/// One changed file's diff as its screen reads it.
abstract interface class ComputerFileDiffs {
  /// The keys whose view changed.
  Stream<ComputerFileDiffKey> get updates;
  ComputerFileDiffKey key(DeviceWorktreeRef ref, RemoteChangedFile file);

  /// What [file]'s diff screen shows now.
  core.FileDiffView view(DeviceWorktreeRef ref, RemoteChangedFile file);

  /// Shows [file]'s diff and reads it; the returned function ends it.
  void Function() watch(DeviceWorktreeRef ref, RemoteChangedFile file);
  Future<void> refresh(DeviceWorktreeRef ref, RemoteChangedFile file);
}
