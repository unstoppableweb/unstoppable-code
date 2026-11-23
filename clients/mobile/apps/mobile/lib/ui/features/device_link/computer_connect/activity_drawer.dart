import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/ui/core/activity/activity_sidebar.dart';
import 'package:mobile/ui/core/activity/worktree_activity_context.dart';
import 'package:mobile/ui/core/files/changed_files_load_status.dart';
import 'package:mobile/ui/core/widgets/inline_notice.dart';
import 'activity_model.dart';
import 'file_diff_screen.dart';
import '../pipelines/picker_screen.dart';
import '../pipelines/run_screen.dart';

class DeviceActivityDrawer extends StatefulWidget {
  const DeviceActivityDrawer({
    super.key,
    required this.repository,
    required this.ref,
    required this.worktree,
    required this.online,
  });
  final ComputerActivity repository;
  final DeviceChatRef ref;
  final WorktreeActivityContext worktree;
  final bool online;
  @override
  State<DeviceActivityDrawer> createState() => _DeviceActivityDrawerState();
}

class _DeviceActivityDrawerState extends State<DeviceActivityDrawer> {
  late void Function() _release;
  @override
  void initState() {
    super.initState();
    _release = widget.repository.watch(widget.ref);
  }

  @override
  void didUpdateWidget(DeviceActivityDrawer old) {
    super.didUpdateWidget(old);
    if (old.ref.key != widget.ref.key) {
      _release();
      _release = widget.repository.watch(widget.ref);
    }
  }

  @override
  void dispose() {
    _release();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => StreamBuilder<void>(
    stream: widget.repository.updates,
    builder: (context, _) {
      final view = widget.repository.view(widget.ref);
      final errors = [
        ...view.errors,
        ?view.prError,
        ?widget.repository.pipelines.error(widget.ref),
        ?view.hookError,
      ];
      return WorktreeActivitySidebar(
        worktree: WorktreeActivityContext(
          workspaceLocalId: widget.worktree.workspaceLocalId,
          localId: widget.worktree.localId,
          insertions: view.insertions,
          deletions: view.deletions,
          prStatuses:
              view.prRepos?.map((repo) => repo.pr).nonNulls.toList() ??
              widget.worktree.prStatuses,
        ),
        activity: view.activity,
        onSetHookPaused: widget.online
            ? (key, paused) => unawaited(
                widget.repository.setHookPaused(widget.ref, key, paused),
              )
            : null,
        pipelineRuns: widget.repository.pipelines.runs(widget.ref),
        onOpenPipelinePicker: () => unawaited(
          Navigator.of(context).push(
            MaterialPageRoute<void>(
              builder: (_) => DevicePipelinePickerScreen(
                repository: widget.repository.pipelines,
                ref: widget.ref,
              ),
            ),
          ),
        ),
        onOpenPipelineRun: (run) => unawaited(
          Navigator.of(context).push(
            MaterialPageRoute<void>(
              builder: (_) => DevicePipelineRunScreen(
                repository: widget.repository.pipelines,
                ref: widget.ref,
                id: run.localId,
                name: run.pipelineName,
              ),
            ),
          ),
        ),
        cachedPrRepos: view.prRepos,
        cachedPrBusy: view.prBusy,
        prProgress: view.prProgress,
        changedFileSections: view.fileSections,
        runPrAction: widget.online
            ? (action, {repoId, identity, confirmUnresolvedComments = false}) =>
                  widget.repository.runPrAction(
                    widget.ref,
                    action,
                    repoId: repoId,
                    identity: identity,
                    confirmUnresolvedComments: confirmUnresolvedComments,
                  )
            : null,
        selectedChatId: widget.ref.id,
        todoUnavailableReason: view.todoUnavailableReason,
        notice: errors.isEmpty
            ? null
            : Padding(
                padding: const EdgeInsets.all(12),
                child: InlineNotice(
                  glyph: CanopyGlyph.circleInfo,
                  state: errors.join('\n'),
                ),
              ),
        changedFilesStatus: widget.online
            ? view.filesStatus
            : ChangedFilesLoadStatus.offline,
        onRetryChangedFiles: () =>
            unawaited(widget.repository.load(widget.ref)),
        onOpenDiff: (file) => unawaited(
          Navigator.of(context).push(
            MaterialPageRoute<void>(
              builder: (_) => DeviceFileDiffScreen(
                repository: widget.repository.diffs,
                ref: widget.ref,
                file: file,
              ),
            ),
          ),
        ),
      );
    },
  );
}
