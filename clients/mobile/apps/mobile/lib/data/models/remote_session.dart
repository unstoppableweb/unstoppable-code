/// Hand-written Dart mirror of the focused subset of the desktop Portal's
/// `RemoteControlSessionShellState` wire contract that the mobile Remote Control
/// (a.k.a. "Workspaces") feature renders.
///
/// Field names and JSON keys are kept **wire-accurate** (`localId`,
/// `workspaceLocalId`, `branch`, `type`, ...) so that when the real Portal
/// transport lands, the same shell-state payload deserializes here with no
/// remapping.  See `packages/protocol/src/remote-control/shell/index.ts`
/// (`RemoteControlSessionShellState`).
///
/// The wire shape carries more fields than we display today (`healthIssue`,
/// `setupPhase`, ...). Those are intentionally omitted here and can be added
/// incrementally as the UI grows.
library;

import 'computer_activity/pr_status.dart';
export 'computer_activity/pr_status.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_pr_merge_queue.dart';
import 'package:mobile/data/models/remote_provider_usage.dart';
import 'package:mobile/data/models/workspace_context.dart';

/// Mirrors the desktop's `WorkspaceType` as surfaced on the wire
/// (`'single-repo' | 'multi-repo' | 'cowork'`).
///
/// `cowork` workspaces have no worktrees; consumers that only distinguish
/// repo layouts should treat `cowork` like a workspace with zero repos.
enum RemoteWorkspaceType {
  singleRepo('single-repo'),
  multiRepo('multi-repo'),
  cowork('cowork');

  const RemoteWorkspaceType(this.wire);

  final String wire;

  /// Parses a wire value, returning `null` for absent/unknown values so the UI
  /// can render an explicit degraded state instead of mislabeling it.
  static RemoteWorkspaceType? fromWire(String? wire) {
    if (wire == null) return null;
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    return null;
  }
}

/// Mirrors the desktop's `RemoteControlWorktreePipelineStatus` union
/// (`'running' | 'unseen' | 'unseen-failure' | 'paused'`), driving the small
/// pipeline indicator badge in a worktree row.
enum RemoteWorktreePipelineStatus {
  running('running'),
  unseen('unseen'),
  unseenFailure('unseen-failure'),
  paused('paused');

  const RemoteWorktreePipelineStatus(this.wire);

  final String wire;

  /// Parses a wire value, returning `null` for absent/unknown values so the
  /// row simply renders no pipeline badge.
  static RemoteWorktreePipelineStatus? fromWire(String? wire) {
    if (wire == null) return null;
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    return null;
  }
}

/// Background git-setup phase for a worktree row, mirroring the desktop's
/// `RemoteControlWorktreeSetupPhase` union. A deferred create acknowledges before
/// `git worktree add` runs, so a `gitPending` row is a reservation that may
/// still roll back — success is not implied until the phase settles.
enum RemoteWorktreeSetupPhase {
  idle('idle'),
  gitPending('git-pending'),
  runningSetup('running-setup'),
  runningTeardown('running-teardown');

  const RemoteWorktreeSetupPhase(this.wire);

  final String wire;

  /// Parses a wire value, returning `null` for absent/unknown values.
  static RemoteWorktreeSetupPhase? fromWire(String? wire) {
    if (wire == null) return null;
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    return null;
  }
}

/// A child repo participating in a multi-repo workspace.
class RemoteRepo {
  const RemoteRepo({
    required this.id,
    required this.name,
    required this.repoPath,
  });

  final String id;
  final String name;
  final String repoPath;

  factory RemoteRepo.fromJson(Map<String, dynamic> json) => RemoteRepo(
    id: _stringValue(json['id']),
    name: _stringValue(json['name'], fallback: 'Repository'),
    repoPath: _stringValue(json['repoPath']),
  );
}

/// Sidebar placement axis for a workspace row, mirroring the protocol's
/// `workspaces[].layout` (REG-2819 split placement out of `type`): a `tree`
/// workspace renders worktree children while a `flat` one renders chats
/// directly. `type` remains the kind badge only.
enum RemoteWorkspaceLayout {
  tree('tree'),
  flat('flat');

  const RemoteWorkspaceLayout(this.wire);

  final String wire;

  /// Parses a wire value, returning `null` for absent/unknown values.
  static RemoteWorkspaceLayout? fromWire(String? wire) {
    if (wire == null) return null;
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    return null;
  }
}

/// A workspace entry in the desktop sidebar, mirroring one element of
/// `RemoteControlSessionShellState.workspaces`.
class RemoteWorkspace {
  const RemoteWorkspace({
    required this.localId,
    required this.name,
    required this.type,
    this.layout,
    this.rootPath,
    this.color,
    this.repos,
    this.temporary = false,
    this.hidden = false,
    this.alwaysShow = true,
    this.order,
    this.ownerContext = const WorkspaceContext.personal(),
    this.placeholder = false,
  });

  /// The context that owns this workspace, from the wire `owner` (CAN-4429).
  /// A missing owner means Personal, as older desktops send none. Null when
  /// an owner is present but unrecognized: such a workspace belongs to no
  /// context, rather than being guessed into Personal. Navigation only; it
  /// never grants access.
  final WorkspaceContext? ownerContext;

  /// True for a catalog-only row, which is never a local workspace.
  final bool placeholder;

  /// Saved desktop sidebar position; absent on older desktop payloads.
  final num? order;

  /// True for temporary (adhoc-combine) multi-repo workspaces.
  final bool temporary;

  /// The user's explicit hide toggle from the desktop sidebar filter.
  final bool hidden;

  /// Desktop sidebar visibility model: `false` marks workspaces (e.g.
  /// temporary ones) that only surface while they still hold at least one
  /// visible worktree. The desktop omits the field when default, so absent
  /// parses as `true`.
  final bool alwaysShow;

  final String localId;
  final String name;

  /// Absolute path of the workspace root on the desktop; may be absent.
  final String? rootPath;
  final RemoteWorkspaceType? type;

  /// Explicit placement axis when the desktop projects one; prefer
  /// [resolvedLayout], which also covers desktops that predate the field.
  final RemoteWorkspaceLayout? layout;

  /// The effective placement axis: the desktop's explicit [layout] when
  /// present, else the legacy rule (`cowork → flat, else tree`) — the mobile
  /// mirror of the protocol's `resolveWorkspaceLayout`.
  RemoteWorkspaceLayout get resolvedLayout =>
      layout ??
      (type == RemoteWorkspaceType.cowork
          ? RemoteWorkspaceLayout.flat
          : RemoteWorkspaceLayout.tree);

  /// Hex color assigned in the desktop sidebar, when present.
  final String? color;

  /// Multi-repo only: child repos that participate in this workspace.
  /// Single-repo/cowork workspaces omit the field or emit an empty list.
  final List<RemoteRepo>? repos;

  factory RemoteWorkspace.fromJson(Map<String, dynamic> json) {
    final rawRepos = json['repos'];
    return RemoteWorkspace(
      localId: _stringValue(json['localId']),
      name: _stringValue(json['name'], fallback: 'Untitled project'),
      order: json['order'] is num && (json['order'] as num).isFinite
          ? json['order'] as num
          : null,
      type: RemoteWorkspaceType.fromWire(_stringOrNull(json['type'])),
      layout: RemoteWorkspaceLayout.fromWire(_stringOrNull(json['layout'])),
      rootPath: _stringOrNull(json['rootPath']),
      color: _stringOrNull(json['color']),
      repos: rawRepos is List
          ? rawRepos
                .whereType<Map<String, dynamic>>()
                .map(RemoteRepo.fromJson)
                .toList(growable: false)
          : null,
      temporary: _boolOrNull(json['temporary']) ?? false,
      hidden: _boolOrNull(json['hidden']) ?? false,
      alwaysShow: _boolOrNull(json['alwaysShow']) ?? true,
      ownerContext: _ownerContext(json['owner']),
      placeholder: json['placeholder'] != null,
    );
  }
}

/// Maps the wire `owner` union to its context: absent is Personal, and an
/// organization owner needs its recognized type and a nonempty id.
WorkspaceContext? _ownerContext(Object? owner) {
  if (owner == null) return const WorkspaceContext.personal();
  if (owner is! Map<String, dynamic>) return null;
  final organizationId = _nonEmptyStringOrNull(owner['organizationId']);
  return switch (owner['type']) {
    'personal' => const WorkspaceContext.personal(),
    'organization' || 'cloud-organization' when organizationId != null =>
      WorkspaceContext.organization(organizationId),
    _ => null,
  };
}

/// One repo's most recent PR observation, projected from the worktree's
/// `lastKnownPrStatus.repos[].status` (null statuses are dropped) or from a
/// PR-action refresh's or live `pr_status` delta's `repos[].status`
/// ([RemoteWorktreePr.fromRemoteControl]). Only the Portal shape carries the
/// per-check list; `lastKnownPrStatus` does not.
/// Outcome of a `portal.worktree.create` submit.
///
/// The server waits for the desktop to reach a terminal state before
/// responding, because creating a worktree runs a real `git worktree add`
/// plus setup. That wait has a ceiling, so a create that is still running
/// when the ceiling elapses comes back with a [commandId] but **no**
/// [worktreeLocalId] — [isPending]. That is NOT a failure: the desktop keeps
/// going and the worktree appears in a later snapshot. Resubmitting in that
/// state would create a duplicate, so callers must reconcile by refreshing
/// instead of retrying.
class RemoteWorktreeCreateResult {
  const RemoteWorktreeCreateResult({
    required this.commandId,
    this.worktreeLocalId,
  });

  final String commandId;

  /// The created worktree's local id, echoed by the desktop when the create
  /// completed within the server's wait window.
  final String? worktreeLocalId;

  /// True when the create was accepted but has not reported a worktree yet.
  bool get isPending => worktreeLocalId == null;
}

/// A worktree row under a workspace, mirroring one element of
/// `RemoteControlSessionShellState.worktrees`.
enum RemotePrObservationSource { host, actionRead }

class RemoteWorktree {
  const RemoteWorktree({
    required this.localId,
    required this.workspaceLocalId,
    required this.branch,
    this.label,
    this.order,
    this.status,
    this.busy,
    this.isStreaming,
    this.backgroundTasks,
    this.hasUnread,
    this.hidden,
    this.awaitingApproval,
    this.pipelineStatus,
    this.scriptStatus,
    this.hookStatus,
    this.terminalStatus,
    this.setupPhase,
    this.lastActivityAt,
    this.createdAt,
    this.insertions,
    this.deletions,
    this.prStatuses = const [],
    this.prObservationSource = RemotePrObservationSource.host,
    List<RemoteWorktreePr>? hostPrStatuses,
    this.mergingPr = false,
    this.mergePrPhase,
    this.notificationSpaceId,
  }) : hostPrStatuses = hostPrStatuses ?? prStatuses;

  final String localId;
  final String workspaceLocalId;
  final String branch;

  /// Server notification space for this worktree (CAN-3615). Absent until the
  /// desktop has registered the space; notification choices need it.
  final String? notificationSpaceId;

  /// Saved desktop sidebar position. Older snapshots may omit it.
  final num? order;

  /// ISO-8601 creation timestamp from the desktop worktree record. Used to
  /// tell a genuinely new worktree from a pre-existing one that was merely
  /// missing from a stale snapshot when resolving a create.
  final String? createdAt;

  /// Optional custom title. Falls back to [branch] when blank; the short
  /// worktree identifier is [localId], displayed separately on the subtitle.
  final String? label;
  final String? status;

  /// Legacy agent-working flag. Current desktops no longer project it —
  /// prefer [isWorking], which also reads [isStreaming].
  final bool? busy;

  /// True when an agent turn is actively streaming for this worktree
  /// (`RemoteControlSessionShellState.worktrees[].isStreaming`).
  final bool? isStreaming;

  /// Whether an agent is actively working in this worktree, across both the
  /// current wire field ([isStreaming]) and the legacy one ([busy]).
  bool get isWorking => busy == true || isStreaming == true;

  /// Delegations and provider tasks still running after the agent's turn
  /// ended (`RemoteControlSessionShellState.worktrees[].backgroundTasks`).
  final int? backgroundTasks;

  /// True when the worktree has at least one unread chat update.
  final bool? hasUnread;

  /// Mirrors the desktop sidebar's hidden-worktree flag
  /// (`RemoteControlSessionShellState.worktrees[].hidden`).
  final bool? hidden;

  /// True when an ask-user prompt is awaiting the user's approval.
  final bool? awaitingApproval;
  final RemoteWorktreePipelineStatus? pipelineStatus;

  /// Sidebar script-running badge; wire value `'running'` when any tracked
  /// script is running (open set).
  final String? scriptStatus;

  /// Sidebar hook-running badge; wire value `'running'` (open set).
  final String? hookStatus;

  /// Sidebar terminal badge: `'running' | 'unseen' | 'unseen-failure'`
  /// (open set).
  final String? terminalStatus;

  /// Deferred-create/setup phase (`worktrees[].setupPhase`). `gitPending`
  /// means the desktop acknowledged the create but its background git setup
  /// is still running and may roll the reservation back.
  final RemoteWorktreeSetupPhase? setupPhase;

  /// ISO-8601 timestamp of the most recent activity on this worktree.
  final String? lastActivityAt;

  /// Aggregate diff stats (`diffStats.insertions` / `.deletions`), driving
  /// the plain `+N -M` subtitle counters.
  final int? insertions;
  final int? deletions;

  /// Per-repo PR observations from `lastKnownPrStatus`; drives the PR badge.
  final List<RemoteWorktreePr> prStatuses;

  /// Client-only provenance; action reads are not persisted host summaries.
  final RemotePrObservationSource prObservationSource;

  /// The row's own `lastKnownPrStatus`. A live `pr_status` observation
  /// replaces [prStatuses] only; removing it restores these, as an overview
  /// read would.
  final List<RemoteWorktreePr> hostPrStatuses;

  /// Live desktop merge state; absent on older snapshots. The flag is
  /// authoritative so an old phase cannot keep a completed merge spinning.
  final bool mergingPr;
  final String? mergePrPhase;

  String? get mergeProgressLabel => !mergingPr
      ? null
      : switch (mergePrPhase) {
          'queued' => 'Merge queued',
          'checking_mergeability' => 'Checking mergeability',
          'waiting_mergeability' => 'Waiting for GitHub',
          'refreshing_pr_status' => 'Refreshing PR status',
          _ => 'Merging pull request',
        };

  RemoteWorktree withUnread(bool unread) => withChatActivity(hasUnread: unread);

  RemoteWorktree withChatActivity({bool? isStreaming, bool? hasUnread}) =>
      _copyWith(isStreaming: isStreaming, hasUnread: hasUnread);

  RemoteWorktree withPrStatuses(
    List<RemoteWorktreePr> statuses, {
    RemotePrObservationSource source = RemotePrObservationSource.host,
  }) => _copyWith(prStatuses: statuses, prObservationSource: source);

  RemoteWorktree inheritPrChecks(RemoteWorktree? previous) {
    if (previous == null) return this;
    final inherited = [
      for (final pr in prStatuses)
        pr.inheritChecks(
          previous.prStatuses
                  .where((old) => old.url != null && old.url == pr.url)
                  .firstOrNull ??
              pr,
        ),
    ];
    return withPrStatuses(
      sameRemotePrStatuses(inherited, previous.prStatuses)
          ? previous.prStatuses
          : inherited,
      source: prObservationSource,
    );
  }

  /// Runtime rows can lag an action read while their host PR summary is empty.
  /// Full snapshots and non-empty host summaries remain authoritative.
  RemoteWorktree inheritRuntimePr(RemoteWorktree? previous) {
    if (previous != null &&
        previous.prObservationSource == RemotePrObservationSource.actionRead &&
        hostPrStatuses.isEmpty &&
        previous.hostPrStatuses.isEmpty &&
        prStatuses.isEmpty) {
      return withPrStatuses(
        previous.prStatuses,
        source: previous.prObservationSource,
      );
    }
    return inheritPrChecks(previous);
  }

  /// Drops a live PR observation, back to [hostPrStatuses].
  RemoteWorktree withoutPrObservation() => withPrStatuses(hostPrStatuses);

  RemoteWorktree _copyWith({
    bool? isStreaming,
    bool? hasUnread,
    List<RemoteWorktreePr>? prStatuses,
    RemotePrObservationSource? prObservationSource,
  }) => RemoteWorktree(
    localId: localId,
    workspaceLocalId: workspaceLocalId,
    branch: branch,
    label: label,
    order: order,
    status: status,
    busy: busy,
    isStreaming: isStreaming ?? this.isStreaming,
    backgroundTasks: backgroundTasks,
    hasUnread: hasUnread ?? this.hasUnread,
    hidden: hidden,
    awaitingApproval: awaitingApproval,
    pipelineStatus: pipelineStatus,
    scriptStatus: scriptStatus,
    hookStatus: hookStatus,
    terminalStatus: terminalStatus,
    setupPhase: setupPhase,
    lastActivityAt: lastActivityAt,
    createdAt: createdAt,
    insertions: insertions,
    deletions: deletions,
    prStatuses: prStatuses ?? this.prStatuses,
    prObservationSource: prObservationSource ?? this.prObservationSource,
    hostPrStatuses: hostPrStatuses,
    mergingPr: mergingPr,
    mergePrPhase: mergePrPhase,
    notificationSpaceId: notificationSpaceId,
  );

  factory RemoteWorktree.fromJson(Map<String, dynamic> json) {
    final rawDiff = json['diffStats'];
    final diff = rawDiff is Map<String, dynamic> ? rawDiff : null;
    final insertions = diff?['insertions'];
    final deletions = diff?['deletions'];
    return RemoteWorktree(
      localId: _stringValue(json['localId']),
      workspaceLocalId: _stringValue(json['workspaceLocalId']),
      branch: _stringValue(json['branch'], fallback: 'Detached worktree'),
      label: _stringOrNull(json['label']),
      order: json['order'] is num && (json['order'] as num).isFinite
          ? json['order'] as num
          : null,
      status: _stringOrNull(json['status']),
      busy: _boolOrNull(json['busy']),
      isStreaming: _boolOrNull(json['isStreaming']),
      backgroundTasks: json['backgroundTasks'] is num
          ? (json['backgroundTasks'] as num).toInt()
          : null,
      hasUnread: _boolOrNull(json['hasUnread']),
      hidden: _boolOrNull(json['hidden']),
      awaitingApproval: _boolOrNull(json['awaitingApproval']),
      pipelineStatus: RemoteWorktreePipelineStatus.fromWire(
        _stringOrNull(json['pipelineStatus']),
      ),
      scriptStatus: _stringOrNull(json['scriptStatus']),
      hookStatus: _stringOrNull(json['hookStatus']),
      terminalStatus: _stringOrNull(json['terminalStatus']),
      setupPhase: RemoteWorktreeSetupPhase.fromWire(
        _stringOrNull(json['setupPhase']),
      ),
      lastActivityAt: _stringOrNull(json['lastActivityAt']),
      createdAt: _stringOrNull(json['createdAt']),
      insertions: insertions is num ? insertions.toInt() : null,
      deletions: deletions is num ? deletions.toInt() : null,
      prStatuses: _parsePrStatuses(json['lastKnownPrStatus']),
      mergingPr: _boolOrNull(json['mergingPr']) ?? false,
      mergePrPhase: _stringOrNull(json['mergePrPhase']),
      notificationSpaceId: _nonEmptyStringOrNull(json['notificationSpaceId']),
    );
  }

  static List<RemoteWorktreePr> _parsePrStatuses(Object? rawPr) {
    if (rawPr is! Map<String, dynamic>) return const [];
    final repos = rawPr['repos'];
    if (repos is! List) return const [];
    final statuses = <RemoteWorktreePr>[];
    for (final repo in repos.whereType<Map<String, dynamic>>()) {
      final status = repo['status'];
      if (status is! Map<String, dynamic>) continue;
      final state = _stringOrNull(status['state']);
      if (state == null || state.isEmpty) continue;
      final prNumber = status['prNumber'];
      final commentCount = status['commentCount'];
      final unresolvedThreads = status['unresolvedReviewThreadCount'];
      final review = _stringOrNull(status['reviewStatus']);
      statuses.add(
        RemoteWorktreePr(
          repoId: _stringOrNull(repo['repoId']),
          prNumber: prNumber is num ? prNumber.toInt() : null,
          state: state,
          url: _stringOrNull(status['prUrl']),
          title: _stringOrNull(status['title']),
          baseRefName: _stringOrNull(status['baseRefName']),
          checkStatus: _stringOrNull(status['checkStatus']),
          reviewStatus: switch (review) {
            'none' => null,
            'changes_requested' => 'changes-requested',
            _ => review,
          },
          hasConflicts: _boolOrNull(status['hasConflicts']),
          mergeReady: _boolOrNull(status['mergeReady']),
          commentCount: commentCount is num ? commentCount.toInt() : null,
          unresolvedReviewThreadCount: unresolvedThreads is num
              ? unresolvedThreads.toInt()
              : null,
          mergeQueue: RemotePrMergeQueue.tryParse(status['mergeQueue']),
        ),
      );
    }
    return statuses;
  }
}

/// A standalone (cowork) chat row, mirroring one element of
/// `RemoteControlSessionShellState.standaloneChats`.
class RemoteStandaloneChat {
  const RemoteStandaloneChat({
    required this.localId,
    required this.projectLocalId,
    required this.title,
    this.description,
    this.workEntryId,
    this.workEntryTitle,
    this.workEntryNotificationSpaceId,
    this.modelLabel,
    this.lastMessageAt,
    this.providerType,
    this.executionHarness,
    this.modelHarnessLocked,
    this.archived,
    this.hasActiveChat,
    this.hasUnread,
    this.model,
    this.providerAvailability,
    this.availableModels = const [],
    this.modelCatalogProjected = false,
    this.pluginSelectionsDetail,
  });

  final String localId;

  /// The owning chat-project's `localId`.  For workspace-scoped rendering we
  /// treat this as the workspace association (the desktop cowork workspace id).
  final String projectLocalId;
  final String title;
  final String? description;
  final String? workEntryId;
  final String? workEntryTitle;

  /// Server notification space for the chat's Work Entry (CAN-3615). Absent
  /// until the desktop has registered the space, and for a chat outside a
  /// Work Entry.
  final String? workEntryNotificationSpaceId;

  /// Desktop's resolved container title takes precedence over chat metadata.
  String get displayTitle {
    for (final value in [workEntryTitle, description, title]) {
      if (value != null && value.trim().isNotEmpty) return value.trim();
    }
    return 'Untitled chat';
  }

  /// A row retains a real chat target while reflecting all sibling activity.
  RemoteStandaloneChat withEntryActivity({
    required bool active,
    required bool unread,
  }) => RemoteStandaloneChat(
    localId: localId,
    projectLocalId: projectLocalId,
    title: title,
    description: description,
    workEntryId: workEntryId,
    workEntryTitle: workEntryTitle,
    workEntryNotificationSpaceId: workEntryNotificationSpaceId,
    modelLabel: modelLabel,
    lastMessageAt: lastMessageAt,
    providerType: providerType,
    executionHarness: executionHarness,
    modelHarnessLocked: modelHarnessLocked,
    archived: archived,
    hasActiveChat: active,
    hasUnread: unread,
    model: model,
    providerAvailability: providerAvailability,
    availableModels: availableModels,
    modelCatalogProjected: modelCatalogProjected,
    pluginSelectionsDetail: pluginSelectionsDetail,
  );
  final String? modelLabel;

  /// ISO-8601 timestamp of the most recent message.
  final String? lastMessageAt;

  /// Provider that owns the chat session (`'claude' | 'codex'` on the wire).
  final String? providerType;
  final String? executionHarness;
  final bool? modelHarnessLocked;

  /// True when the chat has been archived from the active list.
  final bool? archived;

  /// Mirrors the desktop cowork entry row's thinking indicator.
  final bool? hasActiveChat;

  /// Mirrors the desktop cowork entry row's unread indicator.
  final bool? hasUnread;

  /// Current model id (registry key) persisted on the chat (CAN-1219).
  final String? model;

  /// Provider availability the desktop cheaply projects from cached auth.
  final ProviderAvailability? providerAvailability;

  /// The desktop's projected model catalog for the standalone model picker.
  final List<ModelOption> availableModels;

  /// True when the desktop explicitly supplied a catalog, including an empty
  /// owner-filtered list. Missing catalogs may use a cached fallback.
  final bool modelCatalogProjected;

  bool get hasProjectedModelCatalog =>
      modelCatalogProjected || availableModels.isNotEmpty;

  /// The chat's own complete plugin selection (CAN-3923). Null until the
  /// desktop projects it; an empty selection means nothing is selected.
  final Map<String, Object?>? pluginSelectionsDetail;

  factory RemoteStandaloneChat.fromJson(Map<String, dynamic> json) =>
      RemoteStandaloneChat(
        localId: _stringValue(json['localId']),
        projectLocalId: _stringValue(json['projectLocalId']),
        title: _stringValue(json['title'], fallback: 'Untitled chat'),
        description: _stringOrNull(json['description']),
        workEntryId: _stringOrNull(json['workEntryId']),
        workEntryTitle: _stringOrNull(json['workEntryTitle']),
        workEntryNotificationSpaceId: _nonEmptyStringOrNull(
          json['workEntryNotificationSpaceId'],
        ),
        modelLabel: _stringOrNull(json['modelLabel']),
        lastMessageAt: _stringOrNull(json['lastMessageAt']),
        providerType: _stringOrNull(json['providerType']),
        executionHarness: _stringOrNull(json['executionHarness']),
        modelHarnessLocked: _boolOrNull(json['modelHarnessLocked']),
        archived: _boolOrNull(json['archived']),
        hasActiveChat: _boolOrNull(json['hasActiveChat']),
        hasUnread: _boolOrNull(json['hasUnread']),
        model: _stringOrNull(json['model']),
        providerAvailability: ProviderAvailability.maybeFromJson(
          json['providerAvailability'],
        ),
        availableModels: ModelOption.listFromJson(json['availableModels']),
        modelCatalogProjected: json['availableModels'] is List,
        pluginSelectionsDetail: switch (json['pluginSelectionsDetail']) {
          final Map<String, dynamic> detail => Map.unmodifiable(detail),
          _ => null,
        },
      );
}

/// The focused slice of `RemoteControlSessionShellState` the Remote Control feature
/// consumes: workspaces plus their worktrees, standalone chats, chat tabs,
/// and cached transcript rows.
///
/// [fromJson] reads the same top-level keys as the full shell-state payload
/// (`workspaces`, `worktrees`, `standaloneChats`, `chatSummaries`,
/// `chatMessages`), ignoring the many other keys, so a real shell-state
/// snapshot deserializes without transformation.
class RemoteSessionSnapshot {
  const RemoteSessionSnapshot({
    required this.workspaces,
    required this.worktrees,
    required this.standaloneChats,
    this.chatSummaries = const [],
    this.chatMessages = const [],
    this.refreshing = false,
    this.raw = const {},
    this.eventCursor,
    this.providerUsage,
  });

  final List<RemoteWorkspace> workspaces;
  final List<RemoteWorktree> worktrees;
  final List<RemoteStandaloneChat> standaloneChats;

  /// The server's projection cursor for an overview read: the shell reflects
  /// every portal event up to and including this id. Null when unknown
  /// (older servers, snapshots built directly in mocks/tests).
  final int? eventCursor;

  /// True when the server found its cached projection missing/stale and
  /// transparently asked the desktop for a fresh snapshot — i.e. this data is
  /// still syncing and a fuller snapshot is expected to land shortly. Mirrors
  /// `RemoteControlSessionShellState.refreshing`.
  final bool refreshing;

  /// Chat tabs projected from `state.chatSummaries`; hydrated per worktree by
  /// worktree-scoped state requests, so this may lag the sidebar lists.
  final List<RemoteChatSummary> chatSummaries;

  /// Cached transcript rows from `state.chatMessages`
  /// (`RemoteControlChatMessageView` shape), across all hydrated chats.
  final List<RemoteChatMessage> chatMessages;

  /// The raw shell-state map this snapshot was parsed from, retained so the
  /// activity/files sidebar can extract its per-worktree slices (summaries,
  /// plans, scripts, pipeline/hook runs, changed files) without a separate
  /// typed field per slice. Empty for snapshots built directly (mock/tests).
  final Map<String, dynamic> raw;

  /// The account-level `provider_usage` singleton from the read's raw overview
  /// entities. Null when the response carried no raw overview snapshot.
  final RemoteProviderUsageUpdate? providerUsage;

  RemoteSessionSnapshot copyWith({
    List<RemoteWorkspace>? workspaces,
    List<RemoteWorktree>? worktrees,
    List<RemoteStandaloneChat>? standaloneChats,
    List<RemoteChatSummary>? chatSummaries,
    List<RemoteChatMessage>? chatMessages,
    bool? refreshing,
    Map<String, dynamic>? raw,
    int? eventCursor,
    RemoteProviderUsageUpdate? providerUsage,
  }) => RemoteSessionSnapshot(
    workspaces: workspaces ?? this.workspaces,
    worktrees: worktrees ?? this.worktrees,
    standaloneChats: standaloneChats ?? this.standaloneChats,
    chatSummaries: chatSummaries ?? this.chatSummaries,
    chatMessages: chatMessages ?? this.chatMessages,
    refreshing: refreshing ?? this.refreshing,
    raw: raw ?? this.raw,
    eventCursor: eventCursor ?? this.eventCursor,
    providerUsage: providerUsage ?? this.providerUsage,
  );

  factory RemoteSessionSnapshot.fromJson(Map<String, dynamic> json) {
    final workspaces = _jsonObjectRows(
      json['workspaces'],
    ).map(RemoteWorkspace.fromJson).toList(growable: false);
    final worktrees = _jsonObjectRows(
      json['worktrees'],
    ).map(RemoteWorktree.fromJson).toList(growable: false);
    final standaloneChats = _jsonObjectRows(
      json['standaloneChats'],
    ).map(RemoteStandaloneChat.fromJson).toList(growable: false);
    final chatSummaries = _jsonObjectRows(
      json['chatSummaries'],
    ).map(RemoteChatSummary.fromJson).toList(growable: false);
    final chatMessages = _jsonObjectRows(
      json['chatMessages'],
    ).map(RemoteChatMessage.fromViewJson).toList(growable: false);
    return RemoteSessionSnapshot(
      workspaces: workspaces,
      worktrees: worktrees,
      standaloneChats: standaloneChats,
      chatSummaries: chatSummaries,
      chatMessages: chatMessages,
      refreshing: _boolOrNull(json['refreshing']) ?? false,
      raw: json,
    );
  }
}

String? _stringOrNull(Object? value) => value is String ? value : null;

String? _nonEmptyStringOrNull(Object? value) =>
    value is String && value.isNotEmpty ? value : null;

String _stringValue(Object? value, {String fallback = ''}) =>
    _stringOrNull(value) ?? fallback;

bool? _boolOrNull(Object? value) => value is bool ? value : null;

Iterable<Map<String, dynamic>> _jsonObjectRows(Object? value) {
  if (value is! List) return const [];
  return value.whereType<Map<String, dynamic>>();
}
