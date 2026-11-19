/// Worktree-scoped "activity" and "files" slices projected in the Portal shell
/// state (`RemoteControlSessionShellState`), parsed for the mobile Remote Control
/// activity/files sidebar. All fields the desktop already projects into the
/// worktree-scoped `/state` snapshot; the mobile sidebar reads them straight
/// from the fetched snapshot without extra round trips.
library;

export '../changed_file.dart';
import '../changed_file.dart';
import 'package:mobile/data/models/computer_activity/background_process.dart';
import 'package:mobile/data/models/computer_activity/watcher.dart';
import 'package:mobile/data/models/computer_activity/pipeline_dispatch.dart';
import 'package:mobile/data/models/computer_activity/pipeline_run.dart';

/// One-line status entity: a name + a coarse status string, shared by script
/// rows and hook runs. An empty status renders no trailing label.
class RemoteActivityRun {
  const RemoteActivityRun({required this.name, required this.status});

  final String name;
  final String status;
}

/// A configured script visible in a worktree (`RemoteControlScriptDescriptor`). Run
/// rows (`RemoteControlScriptRunProjection`) carry the same identity fields.
class RemoteScriptDescriptor {
  const RemoteScriptDescriptor({
    required this.scriptKey,
    required this.scriptName,
    required this.name,
    this.target,
  });

  factory RemoteScriptDescriptor.fromJson(Map<String, dynamic> row) {
    final scriptKey =
        _stringOrNull(row['scriptKey']) ??
        _stringOrNull(row['scriptId']) ??
        _string(row['localId']);
    final scriptName =
        _stringOrNull(row['scriptName']) ?? _nameFromKey(scriptKey);
    return RemoteScriptDescriptor(
      scriptKey: scriptKey,
      scriptName: scriptName,
      name: _string(row['name'], fallback: scriptName),
      target: _stringOrNull(row['target']),
    );
  }

  /// Joins runs to their script.
  final String scriptKey;
  final String scriptName;
  final String name;

  /// `workspace-root | workspace-repo`; anything else is a project script.
  final String? target;

  static String _nameFromKey(String scriptKey) {
    final last = scriptKey.split(':').last;
    return last.isEmpty ? scriptKey : last;
  }

  /// Workspace setup/launch/teardown sort first, in that order
  /// (`workspaceLifecycleRank` in the shared portal scripts mapper). A repo
  /// script that happens to share one of these names is not ranked.
  int? get lifecycleRank {
    final rank = const ['setup', 'launch', 'teardown'].indexOf(scriptName);
    if (rank < 0) return null;
    final lifecycleIdentity = switch (target) {
      'workspace-root' =>
        scriptKey == 'workspace-$scriptName' ||
            scriptKey == 'workspace-root:$scriptName',
      'workspace-repo' => false,
      _ => scriptKey == 'project:$scriptName',
    };
    return lifecycleIdentity ? rank : null;
  }
}

/// One run of a script (`RemoteControlScriptRunProjection`).
class RemoteScriptRun {
  const RemoteScriptRun({
    required this.script,
    required this.status,
    this.startedAt,
  });

  factory RemoteScriptRun.fromJson(Map<String, dynamic> row) => RemoteScriptRun(
    script: RemoteScriptDescriptor.fromJson(row),
    status: _string(row['status']),
    startedAt: _stringOrNull(row['startedAt']),
  );

  final RemoteScriptDescriptor script;
  final String status;
  final String? startedAt;

  bool get isActive =>
      status == 'running' || status == 'queued' || status == 'pending';
}

/// The Scripts card rows, matching the shared portal scripts mapper
/// (`remoteControlScriptsToSectionModel`): one row per configured script with the
/// status of its latest run (empty if it never ran), then one row per script
/// that ran without a descriptor. Workspace lifecycle scripts come first,
/// then projection order.
List<RemoteActivityRun> scriptActivityRows(
  List<RemoteScriptDescriptor> descriptors,
  List<RemoteScriptRun> runs,
) {
  final latest = <String, RemoteScriptRun>{};
  for (final run in runs) {
    final existing = latest[run.script.scriptKey];
    final order = existing == null
        ? 1
        : (run.startedAt ?? '').compareTo(existing.startedAt ?? '');
    if (order > 0 || (order == 0 && run.isActive && !existing!.isActive)) {
      latest[run.script.scriptKey] = run;
    }
  }
  final descriptorKeys = {for (final script in descriptors) script.scriptKey};
  final entries = [
    for (final script in descriptors)
      (script, latest[script.scriptKey]?.status ?? ''),
    for (final run in latest.values)
      if (!descriptorKeys.contains(run.script.scriptKey))
        (run.script, run.status),
  ];
  // List.sort is not stable, so the projection index breaks ties.
  final indexed = entries.indexed.toList()
    ..sort((left, right) {
      final leftRank = left.$2.$1.lifecycleRank;
      final rightRank = right.$2.$1.lifecycleRank;
      if (leftRank != rightRank) {
        if (leftRank == null) return 1;
        if (rightRank == null) return -1;
        return leftRank - rightRank;
      }
      return left.$1 - right.$1;
    });
  return [
    for (final (_, (script, status)) in indexed)
      RemoteActivityRun(name: script.name, status: status),
  ];
}

/// The desktop's generated per-worktree summary card.
class RemoteWorktreeSummary {
  const RemoteWorktreeSummary({
    required this.title,
    required this.description,
    this.generatedAt,
    this.generating = false,
  });

  final String title;
  final String description;
  final String? generatedAt;
  final bool generating;
}

/// A tracked plan surfaced in the activity sidebar.
class RemoteActivityPlan {
  const RemoteActivityPlan({required this.title, required this.status});

  final String title;
  final String status;
}

/// One TODO row from a chat's `chat_todo` projection (`RemoteControlTodoItem`).
class RemoteTodoItem {
  const RemoteTodoItem({
    required this.id,
    required this.content,
    required this.status,
  });

  final String id;
  final String content;

  /// `pending | in_progress | completed` (open set).
  final String status;
}

/// Per-chat TODO list (`RemoteControlChatTodoProjection`), surfaced on
/// `RemoteControlSessionShellState.todoLists`.
class RemoteChatTodoList {
  const RemoteChatTodoList({required this.chatId, this.items = const []});

  final String chatId;
  final List<RemoteTodoItem> items;
}

/// A configured hook visible in a worktree (`RemoteControlHookDescriptor`).
class RemoteHookDescriptor {
  const RemoteHookDescriptor({
    required this.name,
    required this.hookKey,
    this.triggerName = '',
    this.paused = false,
    this.runDisabled = false,
    this.runDisabledReason,
  });

  factory RemoteHookDescriptor.fromJson(Map<String, dynamic> row) =>
      RemoteHookDescriptor(
        name: _string(row['name'], fallback: _string(row['hookKey'])),
        hookKey: _string(row['hookKey']),
        triggerName: _string(row['triggerName']),
        paused: row['paused'] == true,
        runDisabled: row['runDisabled'] == true,
        runDisabledReason: _stringOrNull(row['runDisabledReason']),
      );
  final String name;
  final String hookKey;
  final String triggerName;

  /// Paused hooks stay visible but do not auto-run.
  final bool paused;

  /// Host-computed manual-run availability; absent on the wire = runnable.
  final bool runDisabled;
  final String? runDisabledReason;
}

/// Aggregated activity + files slices for a single worktree.
class RemoteWorktreeActivity {
  const RemoteWorktreeActivity({
    this.summary,
    this.plans = const [],
    this.todoLists = const [],
    this.scriptDescriptors = const [],
    this.scriptRuns = const [],
    this.pipelineRuns = const [],
    this.hookDescriptors = const [],
    this.hookRuns = const [],
    this.changedFiles = const [],
    this.pipelines = const [],
    this.backgroundProcesses = const [],
    this.watchers = const [],
  });

  final RemoteWorktreeSummary? summary;
  final List<RemoteActivityPlan> plans;

  /// Per-chat TODO lists for this worktree, in projection order.
  final List<RemoteChatTodoList> todoLists;

  /// Configured scripts, in projection order.
  final List<RemoteScriptDescriptor> scriptDescriptors;
  final List<RemoteScriptRun> scriptRuns;
  final List<RemotePipelineRun> pipelineRuns;

  /// Configured hooks (with paused/runDisabled state), ahead of [hookRuns].
  final List<RemoteHookDescriptor> hookDescriptors;
  final List<RemoteActivityRun> hookRuns;

  /// Uncommitted changes first, then committed, mirroring the desktop order.
  final List<RemoteChangedFile> changedFiles;

  /// Pipelines the desktop offers for this worktree (the `pipelines` rows).
  final List<RemotePipelineDescriptor> pipelines;

  /// The worktree chats' background processes, in projection order.
  final List<RemoteBackgroundProcess> backgroundProcesses;

  final List<RemoteWatcher> watchers;

  RemoteWorktreeActivity withTodoLists(List<RemoteChatTodoList> lists) =>
      copyWith(todoLists: lists);
  RemoteWorktreeActivity copyWith({
    List<RemoteChatTodoList>? todoLists,
    List<RemoteHookDescriptor>? hookDescriptors,
  }) => RemoteWorktreeActivity(
    summary: summary,
    plans: plans,
    todoLists: todoLists ?? this.todoLists,
    scriptDescriptors: scriptDescriptors,
    scriptRuns: scriptRuns,
    pipelineRuns: pipelineRuns,
    hookDescriptors: hookDescriptors ?? this.hookDescriptors,
    hookRuns: hookRuns,
    changedFiles: changedFiles,
    pipelines: pipelines,
    backgroundProcesses: backgroundProcesses,
    watchers: watchers,
  );

  /// [chatId]'s background processes. Worktree ids can repeat across
  /// workspaces, so the workspace must match too.
  List<RemoteBackgroundProcess> backgroundProcessesForChat({
    required String workspaceLocalId,
    required String chatId,
  }) => [
    for (final process in backgroundProcesses)
      if (process.chatId == chatId &&
          process.workspaceLocalId == workspaceLocalId)
        process,
  ];

  /// The subset the Run picker lists (CAN-3174).
  List<RemotePipelineDescriptor> get dispatchablePipelines => [
    for (final pipeline in pipelines)
      if (pipeline.isDispatchable) pipeline,
  ];

  /// The Scripts card rows; see [scriptActivityRows].
  List<RemoteActivityRun> get scriptRows =>
      scriptActivityRows(scriptDescriptors, scriptRuns);

  bool get hasAnyActivity =>
      summary != null ||
      plans.isNotEmpty ||
      todoLists.isNotEmpty ||
      scriptDescriptors.isNotEmpty ||
      scriptRuns.isNotEmpty ||
      pipelineRuns.isNotEmpty ||
      hookDescriptors.isNotEmpty ||
      hookRuns.isNotEmpty ||
      changedFiles.isNotEmpty;

  /// Extracts the slices belonging to [worktreeLocalId] from a shell-state map
  /// (the `RemoteSessionSnapshot.raw` payload).
  factory RemoteWorktreeActivity.fromState({
    required String worktreeLocalId,
    required Map<String, dynamic> state,
  }) {
    bool ownedByWorktree(Map<String, dynamic> row) =>
        row['worktreeLocalId'] == worktreeLocalId;

    List<Map<String, dynamic>> rows(Object? value) => value is List
        ? value.whereType<Map<String, dynamic>>().toList(growable: false)
        : const [];

    final summaryRow = rows(
      state['worktreeSummaries'],
    ).where(ownedByWorktree).firstOrNull;

    final plans = [
      for (final row in rows(state['plans']).where(ownedByWorktree))
        RemoteActivityPlan(
          title: _string(row['title'], fallback: 'Untitled plan'),
          status: _string(row['status']),
        ),
    ];

    List<RemoteActivityRun> runs(Object? value) => [
      for (final row in rows(value).where(ownedByWorktree))
        RemoteActivityRun(
          name: _string(row['name'], fallback: 'Run'),
          status: _string(row['status']),
        ),
    ];

    final todoLists = [
      for (final row in rows(state['todoLists']).where(ownedByWorktree))
        RemoteChatTodoList(
          chatId: _string(row['chatId']),
          items: [
            for (final item in rows(row['items']))
              RemoteTodoItem(
                id: _string(item['id']),
                content: _string(item['content']),
                status: _string(item['status'], fallback: 'pending'),
              ),
          ],
        ),
    ];

    final hookDescriptors = [
      for (final row in rows(state['hookDescriptors']).where(ownedByWorktree))
        RemoteHookDescriptor.fromJson(row),
    ];

    return RemoteWorktreeActivity(
      summary: summaryRow == null
          ? null
          : RemoteWorktreeSummary(
              title: _string(summaryRow['title'], fallback: 'Summary'),
              description: _string(summaryRow['description']),
              generatedAt: _stringOrNull(summaryRow['generatedAt']),
              generating: summaryRow['generating'] == true,
            ),
      plans: plans,
      todoLists: todoLists,
      scriptDescriptors: [
        for (final row in rows(
          state['scriptDescriptors'],
        ).where(ownedByWorktree))
          RemoteScriptDescriptor.fromJson(row),
      ],
      scriptRuns: [
        for (final row in rows(state['scriptRuns']).where(ownedByWorktree))
          RemoteScriptRun.fromJson(row),
      ],
      pipelineRuns: [
        for (final row in rows(state['pipelineRuns']).where(ownedByWorktree))
          ?RemotePipelineRun.fromJson(row),
      ],
      hookDescriptors: hookDescriptors,
      hookRuns: runs(state['hookRuns']),
      changedFiles: _changedFiles(state['changedFiles'], worktreeLocalId),
      pipelines: [
        for (final row in rows(state['pipelines']).where(ownedByWorktree))
          ?RemotePipelineDescriptor.fromJson(row),
      ],
      watchers: [
        for (final row in rows(state['watchers']))
          if (RemoteWatcher.fromJson(row) case final watcher?)
            if (watcher.worktreeId == worktreeLocalId) watcher,
      ],
      backgroundProcesses: [
        for (final row in rows(
          state['backgroundProcesses'],
        ).where(ownedByWorktree))
          ?RemoteBackgroundProcess.fromJson(row),
      ],
    );
  }

  static List<RemoteChangedFile> _changedFiles(
    Object? value,
    String worktreeLocalId,
  ) {
    if (value is! Map<String, dynamic>) return const [];
    final entry = value[worktreeLocalId];
    if (entry is! Map<String, dynamic>) return const [];
    List<RemoteChangedFile> parse(Object? rows, {required bool committed}) =>
        rows is List
        ? [
            for (final row in rows.whereType<Map<String, dynamic>>())
              RemoteChangedFile(
                filePath: _string(row['filePath']),
                status: _string(row['status']),
                revision: _stringOrNull(entry['revision']),
                committed: committed,
                repoId: _stringOrNull(row['repoId']),
                repoName: _stringOrNull(row['repoName']),
                insertions: _intOrNull(row['insertions']),
                deletions: _intOrNull(row['deletions']),
              ),
          ]
        : const [];
    return [
      ...parse(entry['uncommitted'], committed: false),
      ...parse(entry['committed'], committed: true),
    ];
  }
}

String? _stringOrNull(Object? value) => value is String ? value : null;

int? _intOrNull(Object? value) => value is num ? value.toInt() : null;

String _string(Object? value, {String fallback = ''}) =>
    value is String ? value : fallback;
