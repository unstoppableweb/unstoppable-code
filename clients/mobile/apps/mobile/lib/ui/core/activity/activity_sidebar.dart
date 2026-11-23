import 'dart:async';
import 'package:mobile/data/models/computer_activity/action_exception.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:mobile/data/models/computer_activity/pr.dart';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/button/canopy_mini_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/core/design-system/progress/canopy_progress_checklist.dart';
import 'package:mobile/data/models/computer_activity/activity.dart';
import 'package:mobile/data/models/computer_activity/pipeline_run.dart';
import 'package:mobile/data/models/computer_activity/pr_merge_queue.dart';
import 'package:mobile/data/models/computer_activity/pr_progress.dart';
import 'package:mobile/data/models/computer_activity/progress_phases.dart';
import 'package:mobile/data/models/computer_activity/pr_status.dart';
import 'worktree_activity_context.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/activity/pipeline_run_display.dart';
import 'package:mobile/ui/core/activity/pr_check_display.dart';
import 'package:mobile/ui/core/activity/pr_merge_queue_display.dart';
import 'package:mobile/ui/core/files/changed_files_grouping.dart';
import 'package:mobile/ui/core/files/changed_files_tab.dart';
import 'package:mobile/ui/core/files/changed_files_load_status.dart';
import 'package:mobile/ui/core/activity/pipeline_run_dot_track.dart';
import 'package:mobile/ui/core/activity/pr_checks_list.dart';

/// Right-hand drawer for a worktree chat, mirroring the web portal's
/// ACTIVITY / FILES sidebar: activity cards (summary, PRs, changed files,
/// plans, scripts, pipeline & hook runs) and the worktree's changed files.
///
/// All list data is read from the already-fetched worktree-scoped snapshot;
/// the only extra Portal round trip is the on-demand per-file diff read
/// when a changed-file row is tapped ([RemoteFileDiffScreen]).
class WorktreeActivitySidebar extends StatefulWidget {
  const WorktreeActivitySidebar({
    super.key,
    required this.worktree,
    required this.activity,
    this.selectedChatId,
    this.todoUnavailableReason,
    this.onSetHookPaused,
    this.runPrAction,
    this.prProgress,
    this.cachedPrRepos,
    this.cachedPrBusy = false,
    this.changedFilesStatus = ChangedFilesLoadStatus.loaded,
    this.onRetryChangedFiles,
    required this.onOpenDiff,
    this.onOpenPipelinePicker,
    this.onOpenPipelineRun,
    this.pipelineRuns,
    this.notice,
    this.changedFileSections = const [],
  });

  final WorktreeActivityContext worktree;
  final RemoteWorktreeActivity activity;

  /// The chat the drawer was opened from; scopes the Todos card to that
  /// conversation (web parity), falling back to all chats when absent.
  final String? selectedChatId;
  final String? todoUnavailableReason;

  /// Invoked with the hook key and the DESIRED paused state when the user
  /// taps a hook's pause/resume toggle. Null hides the toggles (read-only).
  final void Function(String hookKey, bool paused)? onSetHookPaused;
  final RemotePrActionRunner? runPrAction;

  /// Live PR creation/merge progress for this worktree, pushed by the desktop
  /// over `pr_status`. Null when nothing is in flight or the host is older
  /// than the feed; the card then falls back to its flat status line.
  final RemotePrProgressState? prProgress;
  final List<RemotePrRepo>? cachedPrRepos;
  final bool cachedPrBusy;

  /// Whether [activity]'s changed files are loading, loaded, or failed to
  /// load; the Files tab never shows a list it cannot confirm as empty.
  final ChangedFilesLoadStatus changedFilesStatus;
  final VoidCallback? onRetryChangedFiles;
  final ValueChanged<RemoteChangedFile> onOpenDiff;
  final VoidCallback? onOpenPipelinePicker;
  final ValueChanged<RemotePipelineRun>? onOpenPipelineRun;
  final List<RemotePipelineRun>? pipelineRuns;
  final Widget? notice;

  final List<ChangedFilesSection> changedFileSections;

  @override
  State<WorktreeActivitySidebar> createState() =>
      _WorktreeActivitySidebarState();
}

class _WorktreeActivitySidebarState extends State<WorktreeActivitySidebar> {
  /// Check-list expand/collapse choices by repository and PR. The drawer
  /// owns them so a list that leaves the tree (a failed refresh, the Files
  /// tab) keeps its user's choice; closing the drawer discards them.
  final Map<String, bool> _checksExpanded = {};

  @override
  Widget build(BuildContext context) {
    // Flutter's 304 default was set for a rail beside a wide app; on a phone
    // it wastes a third of the screen. Near-full-bleed, capped so a tablet
    // does not get one enormous column.
    final width = MediaQuery.sizeOf(context).width * 0.88;
    return Drawer(
      width: width > 420 ? 420 : width,
      // The chat's snack bars draw beneath the open drawer; a messenger of
      // its own shows the drawer's launch failures where they can be seen.
      child: ScaffoldMessenger(
        child: Scaffold(
          backgroundColor: Colors.transparent,
          body: SafeArea(
            child: DefaultTabController(
              length: 2,
              child: Column(
                children: [
                  ?widget.notice,
                  TabBar(
                    tabs: [
                      const Tab(text: 'Activity'),
                      const Tab(text: 'Files'),
                    ],
                    labelStyle: AppTypography.compactLabel,
                  ),
                  Expanded(
                    child: TabBarView(
                      children: [
                        _ActivityTab(
                          worktree: widget.worktree,
                          onOpenPipelinePicker: widget.onOpenPipelinePicker,
                          onOpenPipelineRun: widget.onOpenPipelineRun,
                          pipelineRuns: widget.pipelineRuns,
                          activity: widget.activity,
                          selectedChatId: widget.selectedChatId,
                          todoUnavailableReason: widget.todoUnavailableReason,
                          onSetHookPaused: widget.onSetHookPaused,
                          runPrAction: widget.runPrAction,
                          prProgress: widget.prProgress,
                          cachedPrRepos: widget.cachedPrRepos,
                          cachedPrBusy: widget.cachedPrBusy,
                          checksExpanded: _checksExpanded,
                          onChecksExpandedChanged: (key, expanded) =>
                              setState(() => _checksExpanded[key] = expanded),
                        ),
                        ChangedFilesTab(
                          onOpenDiff: widget.onOpenDiff,
                          status: widget.changedFilesStatus,
                          onRetry: widget.onRetryChangedFiles,
                          sections: widget.changedFileSections,
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ActivityTab extends StatelessWidget {
  const _ActivityTab({
    required this.worktree,
    required this.activity,
    this.selectedChatId,
    this.todoUnavailableReason,
    this.onSetHookPaused,
    this.runPrAction,
    this.prProgress,
    this.cachedPrRepos,
    this.cachedPrBusy = false,
    this.onOpenPipelinePicker,
    this.onOpenPipelineRun,
    this.pipelineRuns,
    required this.checksExpanded,
    required this.onChecksExpandedChanged,
  });

  final WorktreeActivityContext worktree;
  final RemoteWorktreeActivity activity;
  final String? selectedChatId;
  final String? todoUnavailableReason;
  final VoidCallback? onOpenPipelinePicker;
  final ValueChanged<RemotePipelineRun>? onOpenPipelineRun;
  final List<RemotePipelineRun>? pipelineRuns;
  final void Function(String hookKey, bool paused)? onSetHookPaused;
  final RemotePrActionRunner? runPrAction;
  final RemotePrProgressState? prProgress;
  final List<RemotePrRepo>? cachedPrRepos;
  final bool cachedPrBusy;
  final Map<String, bool> checksExpanded;
  final void Function(String key, bool expanded) onChecksExpandedChanged;

  /// The bound chat's todo lists — scoped strictly when a chat is selected
  /// (an empty card is honest; another conversation's todos are misleading).
  /// The all-chats view only applies when no chat is bound.
  List<RemoteChatTodoList> get _visibleTodoLists {
    final chatId = selectedChatId;
    if (chatId == null) return activity.todoLists;
    return [
      for (final list in activity.todoLists)
        if (list.chatId == chatId) list,
    ];
  }

  @override
  Widget build(BuildContext context) {
    final summary = activity.summary;
    final shownPipelineRuns =
        pipelineRuns ??
        activity.pipelineRuns
            .where((run) => run.isRoot && !run.hidden)
            .toList(growable: false);
    final diff = (worktree.insertions ?? 0) > 0 || (worktree.deletions ?? 0) > 0
        ? '+${worktree.insertions ?? 0}  -${worktree.deletions ?? 0}'
        : null;
    return ListView(
      padding: const EdgeInsets.all(12),
      children: [
        _ActivityCard(
          icon: Icons.description_outlined,
          title: 'Summary',
          emptyLabel: 'No summary yet',
          children: summary == null
              ? const []
              : [
                  Text(
                    summary.title,
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                  const SizedBox(height: 4),
                  if (summary.description.isNotEmpty)
                    Text(
                      summary.description,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                ],
        ),
        _PullRequests(
          key: ValueKey('${worktree.workspaceLocalId}/${worktree.localId}'),
          worktree: worktree,
          runAction: runPrAction,
          prProgress: prProgress,
          cachedRepos: cachedPrRepos,
          cachedBusy: cachedPrBusy,
          checksExpanded: checksExpanded,
          onChecksExpandedChanged: onChecksExpandedChanged,
        ),
        _ActivityCard(
          icon: Icons.insert_drive_file_outlined,
          title: 'Changed Files',
          emptyLabel: 'No local changes',
          children: [
            if (activity.changedFiles.isNotEmpty)
              _LineItem(
                label:
                    '${activity.changedFiles.length} file'
                    '${activity.changedFiles.length == 1 ? '' : 's'} changed',
                trailing: diff,
              )
            // The overview snapshot carries diff totals before the per-file
            // list has hydrated — show the totals without claiming "0 files".
            else if (diff != null)
              _LineItem(label: 'Changes detected', trailing: diff),
          ],
        ),
        _ActivityCard(
          icon: Icons.map_outlined,
          title: 'Plans',
          emptyLabel: 'No tracked plans yet',
          children: [
            for (final plan in activity.plans)
              _LineItem(label: plan.title, trailing: plan.status),
          ],
        ),
        _ActivityCard(
          icon: Icons.checklist_outlined,
          title: 'Todos',
          emptyLabel: todoUnavailableReason ?? 'No todos yet',
          children: [
            for (final todoList in _visibleTodoLists)
              for (final item in todoList.items) _TodoLine(item: item),
          ],
        ),
        _RunCard(
          icon: Icons.rocket_launch_outlined,
          title: 'Scripts',
          // Every configured script with its latest run status (CAN-4433).
          runs: activity.scriptRows,
        ),
        _ActivityCard(
          icon: Icons.account_tree_outlined,
          title: 'Pipeline Runs',
          emptyLabel: 'None yet',
          // Absent rather than disabled on desktops that cannot describe a
          // dispatch form (CAN-2865, CAN-3174).
          trailing: onOpenPipelinePicker != null
              ? CanopyMiniButton(
                  key: const ValueKey('pipeline-dispatch-open'),
                  glyph: CanopyGlyph.play,
                  label: 'Run',
                  // The spoken name states the action; the visible label
                  // stays short for the card header.
                  semanticsLabel: 'Run a pipeline',
                  onPressed: onOpenPipelinePicker,
                )
              : null,
          children: [
            for (final run in shownPipelineRuns)
              _PipelineRunRow(
                key: ValueKey('pipeline-run-row:${run.localId}'),
                run: run,
                onTap: () => onOpenPipelineRun?.call(run),
              ),
          ],
        ),
        _ActivityCard(
          icon: Icons.link,
          title: 'Hooks',
          emptyLabel: 'None yet',
          children: [
            for (final hook in activity.hookDescriptors)
              _HookLine(hook: hook, onSetPaused: onSetHookPaused),
            for (final run in activity.hookRuns)
              _LineItem(label: run.name, trailing: run.status),
          ],
        ),
      ],
    );
  }
}

class _RunCard extends StatelessWidget {
  const _RunCard({required this.icon, required this.title, required this.runs});

  final IconData icon;
  final String title;
  final List<RemoteActivityRun> runs;

  @override
  Widget build(BuildContext context) {
    return _ActivityCard(
      icon: icon,
      title: title,
      emptyLabel: 'None yet',
      children: [
        for (final run in runs)
          _LineItem(label: run.name, trailing: run.status),
      ],
    );
  }
}

/// One openable pipeline run: trigger icon, name, progress, status, and —
/// when the desktop sent the run's jobs — the desktop's job progress dots
/// underneath.
class _PipelineRunRow extends StatelessWidget {
  const _PipelineRunRow({super.key, required this.run, required this.onTap});

  final RemotePipelineRun run;
  final VoidCallback onTap;

  /// Trigger icon plus its gap, so the dots line up under the name.
  static const double _dotsInset = 22;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = StatusColors.of(context);
    final progress = run.progress;
    final tiers = buildPipelineRunDotTiers(run.jobs ?? const []);
    return Semantics(
      button: true,
      excludeSemantics: true,
      label: '${run.pipelineName}, ${pipelineRunStatusLabel(run.status)}',
      onTap: onTap,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _summary(theme, colors, progress),
              if (tiers.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(left: _dotsInset, top: 8),
                  child: PipelineRunDotTrack(
                    key: ValueKey('pipeline-run-dots:${run.localId}'),
                    executionId: run.localId,
                    tiers: tiers,
                    muted: !isPipelineRunActive(run.status),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _summary(
    ThemeData theme,
    StatusColors colors,
    RemotePipelineRunProgress? progress,
  ) => Row(
    children: [
      Icon(
        pipelineTriggerIcon(run.triggerSource),
        size: 14,
        color: theme.colorScheme.onSurfaceVariant,
      ),
      const SizedBox(width: 8),
      Expanded(
        child: Text(
          run.pipelineName,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: theme.textTheme.bodyMedium,
        ),
      ),
      if (progress != null && progress.totalSteps > 0) ...[
        const SizedBox(width: 8),
        Text(
          '${progress.completedSteps}/${progress.totalSteps}',
          style: theme.textTheme.labelSmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      ],
      const SizedBox(width: 8),
      Text(
        pipelineRunStatusLabel(run.status),
        style: theme.textTheme.labelSmall?.copyWith(
          color: pipelineRunStatusColor(run.status, colors),
        ),
      ),
      Icon(
        Icons.chevron_right,
        size: 16,
        color: theme.colorScheme.onSurfaceVariant,
      ),
    ],
  );
}

class _ActivityCard extends StatelessWidget {
  const _ActivityCard({
    required this.icon,
    required this.title,
    required this.emptyLabel,
    required this.children,
    this.trailing,
  });

  final IconData icon;
  final String title;
  final String emptyLabel;
  final List<Widget> children;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: theme.colorScheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 16, color: theme.colorScheme.onSurfaceVariant),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  title,
                  style: theme.textTheme.titleSmall?.copyWith(
                    fontWeight: AppTypography.emphasisWeight,
                    fontVariations: AppTypography.emphasisVariations,
                  ),
                ),
              ),
              ?trailing,
            ],
          ),
          const SizedBox(height: 8),
          if (children.isEmpty)
            Text(
              emptyLabel,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            )
          else
            ...children,
        ],
      ),
    );
  }
}

class _LineItem extends StatelessWidget {
  const _LineItem({required this.label, this.trailing});

  final String label;
  final String? trailing;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Expanded(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodyMedium,
            ),
          ),
          if (trailing != null && trailing!.isNotEmpty) ...[
            const SizedBox(width: 8),
            Text(
              trailing!,
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// Desktop-computed blockers, phrased as the next step the user can take.
/// `pr_open` and `no_pr` stay silent: the PR line beside them already says it.
String? _createBlockedCopy(String? reason) => switch (reason) {
  'pr_status_unavailable' =>
    'Refresh to verify whether a pull request already exists.',
  'no_remote' => 'Add an origin remote to open a pull request.',
  'detached_head' => 'Check out a branch to open a pull request.',
  'base_branch' => 'Switch to a feature branch to open a pull request.',
  'no_changes' => 'Make a change to open a pull request.',
  'needs_pull' => 'Pull the latest commits to open a pull request.',
  _ => null,
};

String? _mergeBlockedCopy(String? reason) => switch (reason) {
  'draft' => 'Mark the pull request ready for review to merge.',
  'conflicts' => 'Resolve the conflicts on the desktop to merge.',
  'checks_failing' => 'Fix the failing checks to merge.',
  'checks_pending' => 'Wait for the checks to finish to merge.',
  'review_pending' => 'Get an approving review to merge.',
  'local_changes' => 'Commit and push the local changes to merge.',
  'other_repo_changes' =>
    'Another repository has local changes to commit and push.',
  'not_ready' => 'GitHub reports this pull request cannot merge yet.',
  _ => null,
};

Widget? _blockedNote(String? copy) => copy == null ? null : _BlockedNote(copy);

RemotePrActionIdentity? _actionIdentity(
  RemotePrRepo repo, {
  required bool needsPr,
}) {
  final baseBranch = repo.baseBranch;
  final headBranch = repo.headBranch;
  final prNumber = repo.pr?.prNumber;
  if (baseBranch == null ||
      headBranch == null ||
      (needsPr && prNumber == null)) {
    return null;
  }
  return RemotePrActionIdentity(
    baseBranch: baseBranch,
    headBranch: headBranch,
    prNumber: needsPr ? prNumber : null,
  );
}

/// Why an action is missing, in the space the action would have occupied.
class _BlockedNote extends StatelessWidget {
  const _BlockedNote(this.copy);

  final String copy;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Text(
        copy,
        style: theme.textTheme.labelSmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
    );
  }
}

/// The create call reports per-repo outcomes rather than throwing, so a PR that
/// never opened has to be read out of the response.
String? _describeUnopenedPr(Map<String, dynamic> result) {
  final localOnly = result['localOnlyCommittedRepos'];
  if (localOnly is List && localOnly.isNotEmpty) {
    return 'Committed the changes locally. Add an origin remote to open a pull request.';
  }
  final skipped = result['skippedRepos'];
  if (skipped is List && skipped.isNotEmpty) {
    final reason = skipped.whereType<Map>().first['reason'];
    return switch (reason) {
      'no_remote_origin' =>
        "Couldn't open the pull request. Add an origin remote first.",
      'no_changes' =>
        "Couldn't open the pull request. There are no changes to submit.",
      _ => "Couldn't open the pull request. Refresh and try again.",
    };
  }
  return null;
}

CanopyProgressChecklist? _creationChecklist(RemotePrCreationProgress progress) {
  final isActive =
      progress.currentPhase != RemotePrCreationPhase.done &&
      progress.currentPhase != RemotePrCreationPhase.error;
  final steps = [
    for (final phase in kRemotePrOrderedPhases)
      CanopyProgressChecklistStep(
        label: remotePrPhaseLabel(phase),
        status: deriveRemotePhaseStatus(
          phase: phase.wireValue,
          orderedPhases: [for (final p in kRemotePrOrderedPhases) p.wireValue],
          steps: progress.steps,
          currentPhase: progress.currentPhase.wireValue,
          isActive: isActive,
        ),
      ),
  ];
  return CanopyProgressChecklist(
    steps: steps,
    error: progress.steps
        .where((s) => s.phase == RemotePrCreationPhase.error)
        .map((s) => s.error)
        .whereType<String>()
        .firstOrNull,
    badge: switch (progress.currentPhase) {
      RemotePrCreationPhase.error => const CanopyProgressBadge(
        label: 'Failed',
        tone: CanopyProgressBadgeTone.error,
      ),
      RemotePrCreationPhase.done => const CanopyProgressBadge(
        label: 'Created',
        tone: CanopyProgressBadgeTone.success,
      ),
      _ => const CanopyProgressBadge(
        label: 'Creating',
        tone: CanopyProgressBadgeTone.progress,
      ),
    },
  );
}

CanopyProgressChecklist _mergeChecklist(RemoteMergePrProgress progress) {
  final isActive =
      progress.currentPhase != RemoteMergePrPhase.done &&
      progress.currentPhase != RemoteMergePrPhase.error;
  final orderedWire = [for (final p in kRemoteMergeOrderedPhases) p.wireValue];

  // A queued row only appears when the merge actually waited behind others.
  final queued = progress.steps
      .where((s) => s.phase == RemoteMergePrPhase.queued)
      .lastOrNull;
  final waiting = progress.steps
      .where((s) => s.phase == RemoteMergePrPhase.waitingMergeability)
      .lastOrNull;

  final steps = <CanopyProgressChecklistStep>[
    if (queued != null && (queued.queuePosition ?? 1) > 1)
      CanopyProgressChecklistStep(
        label: queued.queuePosition != null && queued.queueLength != null
            ? 'Queued (${queued.queuePosition} of ${queued.queueLength})'
            : 'Queued',
        status: progress.currentPhase == RemoteMergePrPhase.queued
            ? RemoteProgressStepStatus.active
            : RemoteProgressStepStatus.completed,
      ),
    for (final phase in kRemoteMergeOrderedPhases)
      CanopyProgressChecklistStep(
        label:
            phase == RemoteMergePrPhase.waitingMergeability &&
                waiting?.retryDelayMs != null
            ? '${remoteMergePhaseLabel(phase)} '
                  '(${(waiting!.retryDelayMs! / 1000).round()}s)'
            : remoteMergePhaseLabel(phase),
        status: deriveRemotePhaseStatus(
          phase: phase.wireValue,
          orderedPhases: orderedWire,
          steps: progress.steps,
          currentPhase: progress.currentPhase.wireValue,
          isActive: isActive,
        ),
      ),
  ];

  return CanopyProgressChecklist(
    steps: steps,
    error: progress.steps
        .where((s) => s.phase == RemoteMergePrPhase.error)
        .map((s) => s.error)
        .whereType<String>()
        .firstOrNull,
    badge: switch (progress.currentPhase) {
      RemoteMergePrPhase.error => const CanopyProgressBadge(
        label: 'Failed',
        tone: CanopyProgressBadgeTone.error,
      ),
      RemoteMergePrPhase.done => const CanopyProgressBadge(
        label: 'Merged',
        tone: CanopyProgressBadgeTone.success,
      ),
      _ => const CanopyProgressBadge(
        label: 'Merging',
        tone: CanopyProgressBadgeTone.progress,
      ),
    },
  );
}

class _PullRequests extends StatefulWidget {
  const _PullRequests({
    super.key,
    required this.worktree,
    this.runAction,
    this.prProgress,
    this.cachedRepos,
    this.cachedBusy = false,
    required this.checksExpanded,
    required this.onChecksExpandedChanged,
  });
  final WorktreeActivityContext worktree;
  final RemotePrActionRunner? runAction;
  final RemotePrProgressState? prProgress;
  final List<RemotePrRepo>? cachedRepos;
  final bool cachedBusy;
  final Map<String, bool> checksExpanded;
  final void Function(String key, bool expanded) onChecksExpandedChanged;
  @override
  State<_PullRequests> createState() => _PullRequestsState();
}

class _PullRequestsState extends State<_PullRequests> {
  List<RemotePrRepo>? _repos;
  bool _loading = false;
  bool _hostBusy = false;
  List<RemotePrRepo>? _pendingCachedRepos;
  bool _pendingCachedBusy = false;
  bool _hasPendingCachedState = false;
  RemotePrAction? _activeAction;
  String? _activeRepoId;
  String? _error;
  String? _progress;

  @override
  void initState() {
    super.initState();
    _repos = widget.cachedRepos;
    _hostBusy = widget.cachedBusy;
  }

  @override
  void didUpdateWidget(_PullRequests oldWidget) {
    super.didUpdateWidget(oldWidget);
    final cacheChanged =
        !identical(oldWidget.cachedRepos, widget.cachedRepos) ||
        oldWidget.cachedBusy != widget.cachedBusy;
    if (!cacheChanged) return;
    if (_loading) {
      _pendingCachedRepos = widget.cachedRepos;
      _pendingCachedBusy = widget.cachedBusy;
      _hasPendingCachedState = true;
    } else {
      _repos = widget.cachedRepos;
      _hostBusy = widget.cachedBusy;
    }
  }

  Future<void> _refresh() => _run(RemotePrAction.refresh);

  RemotePrMergeQueue? _mergeQueueOf(RemoteWorktreePr pr) =>
      mergeQueueForActionPr(pr, widget.worktree.prStatuses);

  /// A queued PR has nothing left to merge: GitHub would reject the action.
  bool _offersMerge(RemotePrRepo repo) {
    final pr = repo.pr;
    return repo.canMerge &&
        pr != null &&
        pr.state == 'open' &&
        _mergeQueueOf(pr) == null;
  }

  /// Outside the PR link so a row opens its check, not the PR. PR numbers
  /// repeat across repositories, so the choice is keyed by both.
  Widget _checksList(RemotePrRepo repo, RemoteWorktreePr pr) {
    final key = '${repo.repoId}#${pr.prNumber ?? pr.url}';
    return PrChecksList(
      checks: pr.checks,
      expanded:
          widget.checksExpanded[key] ??
          prChecksExpandedByDefault(pr.checkStatus),
      onExpandedChanged: (expanded) =>
          widget.onChecksExpandedChanged(key, expanded),
    );
  }

  RemotePrRepo _reconcileMergedPr(RemotePrRepo repo) {
    final cached = repo.pr;
    if (cached == null || cached.state == 'merged') return repo;
    // PR numbers are repository-local. Only a full PR URL can join the
    // worktree observation to cached action details without confusing siblings
    // or a previous PR on the same branch. Older hosts without URLs wait for
    // the normal action-state refresh.
    final merged = widget.worktree.prStatuses
        .where(
          (pr) =>
              pr.state == 'merged' &&
              pr.url != null &&
              pr.url!.isNotEmpty &&
              pr.url == cached.url,
        )
        .firstOrNull;
    if (merged == null) return repo;
    return RemotePrRepo(
      repoId: repo.repoId,
      repoName: repo.repoName,
      pr: merged,
      baseBranch: repo.baseBranch,
      headBranch: repo.headBranch,
      // Eligibility came from the pre-merge cache. The terminal observation
      // retires those actions; a later host response supplies new eligibility.
    );
  }

  Future<void> _run(
    RemotePrAction action, {
    String? repoId,
    RemotePrActionIdentity? identity,
    bool confirmed = false,
  }) async {
    final runner = widget.runAction;
    if (runner == null || (_loading && !confirmed)) return;
    setState(() {
      _loading = true;
      _activeAction = action;
      _activeRepoId = repoId;
      _error = null;
      _progress = switch (action) {
        RemotePrAction.create => 'Creating PR…',
        RemotePrAction.merge => 'Merging PR…',
        _ => null,
      };
    });
    try {
      final result = await runner(
        action,
        repoId: repoId,
        identity: identity,
        confirmUnresolvedComments: confirmed,
      );
      if (!mounted) return;
      if (isRemotePrActionResultDiscarded(result)) return;
      final pending = result['requiresUnresolvedConfirmation'];
      if (pending is List && pending.isNotEmpty) {
        final accepted = await showDialog<bool>(
          context: context,
          builder: (context) => AlertDialog(
            title: const Text('Merge with unresolved comments?'),
            content: const Text(
              'This pull request has unresolved review threads, or GitHub could not verify them. Merge it anyway?',
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const Text('Cancel'),
              ),
              TextButton(
                onPressed: () => Navigator.pop(context, true),
                child: const Text('Merge PR'),
              ),
            ],
          ),
        );
        if (accepted == true && mounted) {
          await _run(
            action,
            repoId: repoId,
            identity: identity,
            confirmed: true,
          );
        }
        return;
      }
      final failed = result['failedRepos'];
      if (failed is List && failed.isNotEmpty) {
        throw Exception(
          failed
              .whereType<Map>()
              .map((r) => r['error'] ?? 'Merge failed')
              .join('\n'),
        );
      }
      if (result['cancelled'] == true) {
        throw Exception('The action was cancelled.');
      }
      // A merge queue chat is a handoff: the pull request has not merged, so
      // say where the work continues instead of leaving a silent refresh.
      final queueChats = result['mergeQueueChats'];
      if (action == RemotePrAction.merge &&
          queueChats is List &&
          queueChats.isNotEmpty &&
          mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Opened a chat on the desktop to merge through the merge queue.',
            ),
          ),
        );
      }
      if (action == RemotePrAction.merge && mounted) {
        if (mergeEnqueuedMessage(result) case final message?) {
          ScaffoldMessenger.of(
            context,
          ).showSnackBar(SnackBar(content: Text(message)));
        }
      }
      if (action == RemotePrAction.create) {
        // A create can succeed as a call and still open no PR (nothing to
        // submit, no remote, or a local-only commit); refreshing alone would
        // read as silent success.
        final opened = (result['repos'] as List? ?? [])
            .whereType<Map<String, dynamic>>()
            .where((repo) => repo['prNumber'] is num)
            .map((repo) => '#${(repo['prNumber'] as num).toInt()}')
            .toList();
        if (opened.isEmpty) {
          final blocked = _describeUnopenedPr(result);
          if (blocked != null) throw Exception(blocked);
        } else if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text('Created pull request ${opened.join(', ')}.'),
            ),
          );
        }
      }
      final state = action == RemotePrAction.refresh
          ? result
          : await runner(RemotePrAction.refresh);
      if (!mounted) return;
      if (isRemotePrActionResultDiscarded(state)) return;
      setState(() {
        _repos = (state['repos'] as List? ?? [])
            .whereType<Map<String, dynamic>>()
            .map(RemotePrRepo.fromJson)
            .toList();
        _hostBusy = state['busy'] == true;
      });
    } catch (error) {
      if (mounted) {
        setState(() {
          _error = error is RemoteControlException
              ? error.message
              : error.toString().replaceFirst('Exception: ', '');
          _repos = null;
        });
      }
    } finally {
      if (mounted) {
        setState(() {
          if (_hasPendingCachedState) {
            _repos = _pendingCachedRepos;
            _hostBusy = _pendingCachedBusy;
            _pendingCachedRepos = null;
            _pendingCachedBusy = false;
            _hasPendingCachedState = false;
          }
          _loading = false;
          _activeAction = null;
          _activeRepoId = null;
          _progress = null;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = StatusColors.of(context);
    final feeds = widget.prProgress;
    final mergeFeed = feeds?.merge;
    final creationFeed = feeds?.creation;
    final creationLive =
        creationFeed != null &&
        creationFeed.currentPhase != RemotePrCreationPhase.done &&
        creationFeed.currentPhase != RemotePrCreationPhase.error;
    final mergeLive =
        mergeFeed != null &&
        mergeFeed.currentPhase != RemoteMergePrPhase.done &&
        mergeFeed.currentPhase != RemoteMergePrPhase.error;
    final repos = _repos?.map(_reconcileMergedPr).toList(growable: false);
    final merging =
        (_loading && _activeAction == RemotePrAction.merge) ||
        widget.worktree.mergingPr;
    final activeMergeRepoId = _loading && _activeAction == RemotePrAction.merge
        ? _activeRepoId
        : mergeFeed?.steps
              .where(
                (step) =>
                    step.phase == mergeFeed.currentPhase && step.repoId != null,
              )
              .lastOrNull
              ?.repoId;
    // Mirrors `showProgress` in
    // `packages/ui-app/src/code/activity/PullRequestSectionBody.tsx`: a
    // succeeded feed gives way to the PR card once the state it describes has
    // arrived. A failed feed keeps rendering — `Failed` is the result.
    //
    // Explicit null tombstones clear cancelled feeds. Successful terminal
    // feeds stay available until the authoritative PR state for the same
    // repositories arrives, without letting a sibling PR retire them early.
    final createdRepoNames = creationFeed?.steps
        .where(
          (step) =>
              step.phase == RemotePrCreationPhase.done && step.repoName != null,
        )
        .map((step) => step.repoName!)
        .toSet();
    final mergedRepoSteps = mergeFeed?.steps
        .where(
          (step) =>
              step.phase == RemoteMergePrPhase.done &&
              (step.repoId != null || step.repoName != null),
        )
        .toList();
    final hasCreatedPr = createdRepoNames?.isNotEmpty == true
        ? repos != null &&
              createdRepoNames!.every(
                (repoName) => repos.any(
                  (repo) =>
                      repo.repoName == repoName &&
                      (repo.pr?.state == 'open' || repo.pr?.state == 'draft'),
                ),
              )
        : widget.worktree.prStatuses.isNotEmpty;
    final hasMergedPr = mergedRepoSteps?.isNotEmpty == true
        ? repos != null &&
              mergedRepoSteps!.every(
                (step) => repos.any(
                  (repo) =>
                      (step.repoId != null
                          ? repo.repoId == step.repoId
                          : repo.repoName == step.repoName) &&
                      repo.pr?.state == 'merged',
                ),
              )
        : widget.worktree.prStatuses.any((status) => status.state == 'merged');
    final mergeConfirmed =
        mergeFeed?.currentPhase == RemoteMergePrPhase.done && hasMergedPr;
    final localMergeConfirmed =
        _activeAction == RemotePrAction.merge &&
        _activeRepoId != null &&
        (repos?.any(
              (repo) =>
                  repo.repoId == _activeRepoId && repo.pr?.state == 'merged',
            ) ??
            false);
    final busy =
        _loading ||
        (_hostBusy && !mergeConfirmed) ||
        widget.worktree.mergingPr ||
        creationLive ||
        mergeLive;
    final creationAttemptedOpen =
        creationFeed?.steps.any(
          (step) =>
              step.phase == RemotePrCreationPhase.creatingPr ||
              (step.phase == RemotePrCreationPhase.done &&
                  step.repoName != null),
        ) ??
        false;
    final showMergeFeed =
        mergeFeed != null &&
        !(mergeFeed.currentPhase == RemoteMergePrPhase.done && hasMergedPr);
    final showCreationFeed =
        creationFeed != null &&
        !(creationFeed.currentPhase == RemotePrCreationPhase.done &&
            (hasCreatedPr || !creationAttemptedOpen));
    final mergeSettled =
        mergeFeed?.currentPhase == RemoteMergePrPhase.done ||
        mergeFeed?.currentPhase == RemoteMergePrPhase.error;
    // Merge wins over creation only while it is still worth showing, so a
    // settled merge cannot mask a live creation checklist.
    final Widget? pushedProgress =
        mergeFeed != null && showMergeFeed && !(mergeSettled && creationLive)
        ? _mergeChecklist(mergeFeed)
        : creationFeed != null && showCreationFeed
        ? _creationChecklist(creationFeed)
        : null;
    final mergeProgressInButton =
        merging &&
        repos != null &&
        repos.any(
          (repo) =>
              repo.repoId == activeMergeRepoId &&
              _offersMerge(repo) &&
              _actionIdentity(repo, needsPr: true) != null,
        );
    return _ActivityCard(
      icon: Icons.merge_type,
      title: 'Pull Requests',
      trailing: widget.runAction == null
          ? null
          : IconButton(
              key: const ValueKey('refresh-pr'),
              tooltip: 'Refresh pull requests',
              onPressed: _loading ? null : _refresh,
              icon: const Icon(Icons.refresh, size: 18),
              visualDensity: VisualDensity.compact,
            ),
      emptyLabel: 'No pull request',
      children: [
        if (repos == null) ...[
          for (final pr in widget.worktree.prStatuses)
            _PrLine(
              pr: pr,
              details: _prDetails(pr),
              mergeQueue: pr.isInMergeQueue ? pr.mergeQueue : null,
            ),
          if (widget.runAction == null)
            const _BlockedNote(
              'Update the desktop app to create pull requests from here.',
            )
          else if (widget.worktree.prStatuses.isEmpty && !_loading)
            const Text('No pull request'),
        ] else
          for (final repo in repos) ...[
            if (repos.length > 1)
              Text(
                repo.repoName,
                style: Theme.of(context).textTheme.labelSmall,
              ),
            if (repo.pr case final pr?
                when pr.state != 'none' && pr.state.isNotEmpty)
              if (pr.checks.isEmpty)
                _PrLine(
                  pr: pr,
                  details: _prDetails(pr),
                  mergeQueue: _mergeQueueOf(pr),
                )
              else ...[
                // The list's header carries the CI status.
                _PrLine(
                  pr: pr,
                  details: _prReviewDetails(pr),
                  mergeQueue: _mergeQueueOf(pr),
                ),
                _checksList(repo, pr),
              ],
            if (repo.canCreate && _actionIdentity(repo, needsPr: false) != null)
              CanopyButton(
                key: ValueKey('create-pr-${repo.repoId}'),
                variant: CanopyButtonVariant.inline,
                foregroundColor: colors.accent,
                onPressed: busy
                    ? null
                    : () => _run(
                        RemotePrAction.create,
                        repoId: repo.repoId,
                        identity: _actionIdentity(repo, needsPr: false),
                      ),
                glyph: CanopyGlyph.pullRequestSimple,
                // Naming the base branch keeps the target of an otherwise
                // one-tap commit-push-open flow visible before the tap.
                label: repo.baseBranch == null
                    ? 'Create PR'
                    : 'Create PR into ${repo.baseBranch}',
              ),
            if (_offersMerge(repo) &&
                _actionIdentity(repo, needsPr: true) != null)
              CanopyButton(
                key: ValueKey('merge-pr-${repo.repoId}'),
                variant: CanopyButtonVariant.inline,
                foregroundColor: repo.mergeWarning
                    ? colors.warning
                    : colors.merged,
                // The pushed checklist owns progress animation while visible;
                // keep the action disabled without stacking a second spinner.
                loading:
                    merging &&
                    repo.repoId == activeMergeRepoId &&
                    !showMergeFeed,
                onPressed: busy
                    ? null
                    : () => _run(
                        RemotePrAction.merge,
                        repoId: repo.repoId,
                        identity: _actionIdentity(repo, needsPr: true),
                      ),
                glyph: CanopyGlyph.mergedSimple,
                label: merging && repo.repoId == activeMergeRepoId
                    ? 'Merging PR…'
                    : 'Merge PR',
              ),
            if (repo.canCreate && _actionIdentity(repo, needsPr: false) == null)
              const _BlockedNote(
                'Choose a base branch on the desktop to open a pull request.',
              ),
            if (_offersMerge(repo) &&
                _actionIdentity(repo, needsPr: true) == null)
              const _BlockedNote(
                'Choose a base branch on the desktop to merge this pull request.',
              ),
            ?_blockedNote(_createBlockedCopy(repo.createBlockedReason)),
            ?_blockedNote(_mergeBlockedCopy(repo.mergeBlockedReason)),
            if (repo.pr == null &&
                !repo.canCreate &&
                _createBlockedCopy(repo.createBlockedReason) == null)
              const Text('No pull request'),
          ],
        if (pushedProgress != null)
          pushedProgress
        else if (busy && !mergeProgressInButton && !localMergeConfirmed)
          Row(
            children: [
              const SizedBox(
                width: 14,
                height: 14,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  _progress ??
                      widget.worktree.mergeProgressLabel ??
                      (_hostBusy
                          ? 'PR action in progress…'
                          : 'Checking PR status…'),
                ),
              ),
            ],
          ),
        if (_error != null)
          Text(_error!, style: TextStyle(color: colors.failed)),
      ],
    );
  }
}

class _PrLine extends StatelessWidget {
  const _PrLine({required this.pr, required this.details, this.mergeQueue});

  final RemoteWorktreePr pr;

  /// Set while the open PR is in GitHub's merge queue.
  final RemotePrMergeQueue? mergeQueue;

  /// Summary fragments under the title, joined with `·`.
  final List<String> details;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final number = pr.prNumber == null ? 'PR' : 'PR #${pr.prNumber}';
    final title = pr.title;
    final summary = details.join(' · ');
    final colors = StatusColors.of(context);
    final queue = mergeQueue;
    final color = switch (pr.state) {
      _ when queue != null => colors.warning,
      'open' => colors.success,
      'merged' => colors.merged,
      'closed' => colors.failed,
      _ => colors.neutral,
    };
    final queueDetail = queue == null ? null : mergeQueueDetail(queue);
    final uri = Uri.tryParse(pr.url ?? '');
    final canOpen =
        uri != null &&
        (uri.scheme == 'https' || uri.scheme == 'http') &&
        uri.host.isNotEmpty;
    return Semantics(
      link: canOpen,
      child: InkWell(
        key: ValueKey('pr-link-${pr.prNumber}'),
        onTap: !canOpen
            ? null
            : () async {
                try {
                  if (await launchUrl(
                    uri,
                    mode: LaunchMode.externalApplication,
                  )) {
                    return;
                  }
                } catch (_) {
                  /* Report a launch failure without losing the drawer. */
                }
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(
                      content: Text('Could not open the pull request.'),
                    ),
                  );
                }
              },
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              LayoutBuilder(
                builder: (context, constraints) => Row(
                  children: [
                    Expanded(
                      child: Text(
                        title == null || title.isEmpty
                            ? number
                            : '$number · $title',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: color,
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    // Large text can leave the queue label no room of its own.
                    ConstrainedBox(
                      constraints: BoxConstraints(
                        maxWidth: constraints.maxWidth / 2,
                      ),
                      child: Text(
                        queue == null ? pr.state : 'In merge queue',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.labelSmall?.copyWith(
                          color: color,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              if (queueDetail != null)
                Text(
                  queueDetail,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: queue?.phase == RemotePrMergeQueuePhase.unmergeable
                        ? colors.warning
                        : theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              if (summary.isNotEmpty)
                Text(
                  summary,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A PR line's summary: check, review, conflict and comment state. Live
/// `pr_status` deltas may fill [RemoteWorktreePr.checks] where no check list
/// is drawn, so only the caller knows whether the CI fragment is needed.
List<String> _prDetails(RemoteWorktreePr pr) => [
  // The uninformative `none`/`neutral` check values stay hidden.
  if (pr.checkStatus case final checks?
      when checks != 'none' && checks != 'neutral')
    'checks $checks',
  ..._prReviewDetails(pr),
];

/// [_prDetails] without the CI fragment, for a line whose check list's header
/// carries it. When the desktop reports unresolved review threads, that count
/// supersedes the raw comment tally (resolved comments are not actionable —
/// portal-badge parity).
List<String> _prReviewDetails(RemoteWorktreePr pr) {
  final discussion = switch (pr.unresolvedReviewThreadCount) {
    final threads? when threads > 0 =>
      '$threads unresolved thread${threads == 1 ? '' : 's'}',
    final int _ => null, // All threads resolved: nothing actionable.
    null => switch (pr.commentCount) {
      final comments? when comments > 0 =>
        '$comments comment${comments == 1 ? '' : 's'}',
      _ => null,
    },
  };
  return [
    if (pr.reviewStatus == 'approved') 'approved',
    if (pr.reviewStatus == 'changes-requested') 'changes requested',
    if (pr.hasConflicts == true) 'conflicts',
    ?discussion,
  ];
}

class _HookLine extends StatelessWidget {
  const _HookLine({required this.hook, required this.onSetPaused});

  final RemoteHookDescriptor hook;
  final void Function(String hookKey, bool paused)? onSetPaused;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    final reason = hook.runDisabled ? hook.runDisabledReason : null;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  hook.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    decoration: hook.paused ? TextDecoration.lineThrough : null,
                    color: hook.paused ? muted : null,
                  ),
                ),
                if (reason != null && reason.isNotEmpty)
                  Text(
                    reason,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.labelSmall?.copyWith(color: muted),
                  ),
              ],
            ),
          ),
          if (onSetPaused != null)
            IconButton(
              key: ValueKey('hook-toggle-${hook.hookKey}'),
              icon: Icon(
                hook.paused
                    ? Icons.play_circle_outline
                    : Icons.pause_circle_outline,
                size: 18,
              ),
              tooltip: hook.paused ? 'Resume hook' : 'Pause hook',
              visualDensity: VisualDensity.compact,
              onPressed: () => onSetPaused?.call(hook.hookKey, !hook.paused),
            ),
        ],
      ),
    );
  }
}

class _TodoLine extends StatelessWidget {
  const _TodoLine({required this.item});

  final RemoteTodoItem item;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final statusColors = StatusColors.of(context);
    final completed = item.status == 'completed';
    final (icon, color) = switch (item.status) {
      'completed' => (Icons.check_circle, statusColors.success),
      'in_progress' => (Icons.timelapse, statusColors.accent),
      _ => (Icons.radio_button_unchecked, theme.colorScheme.onSurfaceVariant),
    };
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Icon(icon, size: 16, color: color),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              item.content,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodyMedium?.copyWith(
                decoration: completed ? TextDecoration.lineThrough : null,
                color: completed ? theme.colorScheme.onSurfaceVariant : null,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
