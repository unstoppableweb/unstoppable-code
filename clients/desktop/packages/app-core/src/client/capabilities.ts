/**
 * Capability flags let a single shared component branch on what the host
 * platform can actually do, instead of branching on `isWeb`/`isDesktop`.
 *
 * Desktop reports the full local-first capability set; the web portal reports
 * per-target capabilities: cloud hosts a browser-connected PTY, while
 * Remote Control relays output without interactive terminal access. Each transport adapter constructs the concrete
 * {@link CanopyCapabilities} value — this package only declares the shape.
 */

/** File-system reach available to the host. Web is read-only; desktop is read-write. */
export type FileSystemAccessLevel = 'none' | 'read' | 'read-write';

/** How much of the settings surface the host can render. */
export type SettingsScope = 'full' | 'api-keys-only';

/** What the host can do with pipelines. Web relays runs but cannot execute locally. */
export type PipelineCapability = 'execute' | 'crud-only' | 'read-only';

/** How navigation is expressed: desktop keeps it in memory, web reflects it in the URL. */
export type RoutingMode = 'in-memory' | 'url';

/** Workspace creation modes exposed by a host. Unset is default-deny. */
export type WorkspaceCreationCapability = false | 'remote-clone' | 'full';

/** Workspace settings support exposed by a host. Unset is default-deny. */
/**
 * `'details'`: the host edits only the name and colour and removes the
 * project; the settings dialog shows just those tabs.
 */
export type WorkspaceSettingsCapability = false | 'details' | 'full';

/** Host-correct worktree removal behavior. Unset is default-deny. */
export type WorktreeRemovalCapability = false | 'archive' | 'delete';

/**
 * The platform-adapter switch consumed by shared components via a
 * `useCapabilities()` hook (added in `@canopy/app-state`). All fields are
 * readonly: capabilities are fixed for the lifetime of a client instance.
 */
export interface CanopyCapabilities {
  /** Locked Work Entry archive. Unconfigured or unavailable hosts default-deny. */
  readonly standaloneChatArchive?: boolean;
  /** Host can disarm agent-armed work entry removal and answer branch questions. Default-deny. */
  readonly workEntryAutoDelete?: 'manage';
  /** Error reports; absent means false. Enable only with a complete adapter. */
  readonly feedbackReports?: boolean;
  /**
   * Exact snapshot prepare/read/save/release and submit; absent means false.
   * The executing host can still decline per opening through `draft().diagnostics`.
   */
  readonly feedbackDiagnostics?: boolean;
  /** Native recovery launch on this computer. Missing is default-deny. */
  readonly workspaceRecovery?: boolean;
  /** Selected host implements shared creation/recovery. Missing is default-deny. */
  readonly sharedMultiRepo?: boolean;
  /** Source management is wired. Optional; unconfigured/unavailable hosts deny. */
  readonly marketplaceSources?: boolean;
  /** Add uses the selected source client's session, independently of list rollout. */
  readonly marketplaceSourceAdd?: boolean;
  /** Source plugin installation is wired. Optional, default-deny; web denies. */
  readonly marketplaceSourcePluginInstall?: boolean;
  /**
   * Host holds its own skills, plugins and MCP servers and can set them beside
   * a cloud chat's catalog with their cloud links (CAN-6176). Default-deny;
   * web denies.
   */
  readonly cloudCapabilityLinks?: boolean;
  /**
   * Host can let its own MCP servers be reached from the person's cloud
   * chats, ask before each call, and show what reached them (CAN-6176).
   * Default-deny; web denies.
   */
  readonly cloudReachBack?: boolean;
  /**
   * Host can embed account OAuth in its local browser pane. Default-deny for
   * both unconfigured and configured-but-unavailable hosts. Remote Control
   * uses external authorization even when its desktop target supports a pane.
   */
  readonly embeddedOAuthBrowser?: boolean;
  /**
   * Host can open in-app browser panels in this scope. Desktop main keeps
   * their sessions and state under the scope's local project and worktree,
   * so a cloud chat scope has none yet (CAN-6175). Default-deny.
   */
  readonly inAppBrowserPanel?: boolean;
  /** Host publishes current provider account quotas and accepts refresh. Default-deny. */
  readonly providerQuotas?: boolean;
  /** Local Cursor rule review and workspace opt-in. Unset is default-deny. */
  readonly repoRulesImport?: boolean;
  /** Human review and desktop preference API; execution also requires terminalPty. */
  readonly scriptActions?: boolean;
  /**
   * Host keeps onboarding tip dismissals (CAN-4904) through the
   * `onboardingTips.*` operations. Optional and default-deny: unset is the
   * confirmed default for unconfigured and configured-but-unavailable hosts,
   * and shared UI then shows no tips. Desktop keeps them in its preferences;
   * the Portal reports it when the paired desktop announces
   * `onboarding_tips_v1`; cloud chats have no store and leave it unset.
   */
  readonly onboardingTips?: boolean;
  /**
   * `suggestions.*` reads and writes the host's suggestion preferences
   * (CAN-4343). Absent on cloud chats and Portal hosts without
   * `suggestions_v1`: those clients keep pre-CAN-4343 behavior and make no
   * suggestions calls.
   */
  readonly suggestions?: boolean;
  /**
   * `claudeMods.*` reads and changes the host's Claude Mod admission (the
   * allowed Mods and the "turn off every Mod" switch). Optional and
   * default-deny: unset is the confirmed default for unconfigured and
   * configured-but-unavailable hosts, and shared UI then shows no Mod
   * controls. Desktop serves it; the Portal reports it when the paired
   * desktop announces `claude_mod_admission_v1`; cloud chats leave it unset.
   * Whether admission is on is the separate `ClaudeModsState.enabled`.
   */
  readonly claudeModAdmission?: boolean;
  /** Chat operations wired by this target's adapter. Missing members deny. */
  readonly chatWorkflows?: {
    readonly planMode?: boolean;
    readonly planReview?: boolean;
    readonly deferredCapabilities?: boolean;
    readonly independentFork?: boolean;
    /**
     * Host supports direct, trusted resume of an interrupted turn. Default-deny
     * for both unconfigured and configured-but-unavailable hosts. Desktop may
     * enable this for supported chat targets; Portal and cloud leave it unset.
     */
    readonly interruptedTurnResume?: boolean;
  };
  /** Complete chat inventory for sidebar Activity. Optional, default-deny.
   * Remote Control requires a live leg and host inventory; cloud has neither.
   */
  readonly sidebarActivityMode?: boolean;
  /**
   * Search palette scopes beyond chats and worktrees, which every host lists
   * from what its sidebar already holds. Optional and default-deny: unset is
   * the confirmed default for unconfigured and configured-but-unavailable
   * hosts, and the palette shows those scope tabs as unavailable. Desktop
   * serves all three from its own stores and transcript index; the Portal
   * leaves it unset because the paired desktop projects no command catalog,
   * workflow list or transcript search to the browser.
   */
  readonly searchPalette?: {
    /** Commands and settings (the Actions scope). */
    readonly actions?: boolean;
    /** Pipelines, scheduled workflows and watchers (the Workflows scope). */
    readonly workflows?: boolean;
    /** Text inside chats and plans (the Content scope). */
    readonly content?: boolean;
  };
  /** Host can read unsent composer drafts. Optional, default-deny; desktop only. */
  readonly chatDrafts?: boolean;
  /**
   * The chat's access (tool approval) mode can be changed from the composer
   * (`chat.set_approval_mode`). Optional and default-deny: unset is the
   * confirmed default for unconfigured and configured-but-unavailable hosts,
   * and the composer then hides the access mode control. Desktop reports
   * `true` for local chats; a cloud chat scope reports `false` because its
   * core runs cloud turns under its own policy (CAN-6175).
   */
  readonly chatApprovalMode?: boolean;
  /**
   * The chat's thinking level (effort) can be changed from the composer.
   * Optional and default-deny; desktop reports `true` for local chats. A
   * cloud chat scope reports it once its backend sends the level
   * (`modelConfig` on `core.chat.message.send`, CAN-6175 R5).
   */
  readonly chatThinkingLevel?: boolean;
  /**
   * The chat's fast mode (speed) can be toggled from the composer. Optional
   * and default-deny; desktop reports `true` for local chats. A cloud chat
   * scope reports it with the thinking level (CAN-6175 R5).
   */
  readonly chatFastMode?: boolean;
  /**
   * A chat can be forked into a new tab of the same scope from a turn.
   * Optional and default-deny; desktop reports `true` for local chats. A
   * cloud fork starts a new task, so a cloud chat scope reports it once the
   * web core forks within a task (CAN-6106).
   */
  readonly chatTabFork?: boolean;
  /**
   * The scope's first chat can be closed or archived like any other tab,
   * and every archived tab can be restored. Optional and default-deny;
   * desktop reports `true` for local chats. A cloud task's first chat is the
   * task itself: closing it would archive the whole task, and the web core
   * restores only that chat (CAN-6175 R3).
   */
  readonly chatRootTabLifecycle?: boolean;
  /**
   * The chat's plugin, skill and MCP selections can be changed from the
   * composer. Optional and default-deny; desktop reports `true` for local
   * chats. A cloud chat scope reports it once its backend writes
   * `pluginSelections` (CAN-6175 R5, CAN-6176).
   */
  readonly chatPluginSelections?: boolean;
  /**
   * Queued messages can be edited or sent now. Optional and default-deny;
   * desktop reports `true` for local chats. A cloud chat scope reports it
   * once the web core serves queued text and edit holds (CAN-6106).
   */
  readonly chatQueueEdits?: boolean;
  /**
   * The chat can be reset to an earlier point. Optional and default-deny;
   * desktop reports `true` for local chats. The web core has no rewind, so a
   * cloud chat scope leaves it unset.
   */
  readonly chatResetToPoint?: boolean;
  /**
   * The composer's @ typeahead can mention the scope's files. Optional and
   * default-deny; desktop reports `true` for local chats. A cloud chat scope
   * reports it once the typeahead searches the scope's own file source
   * rather than this computer's disk (CAN-6175 R7).
   */
  readonly chatFileMentions?: boolean;
  /**
   * The chat can switch interface modes (the Claude Code terminal view) and
   * use the controls that need the local runtime or local files: the
   * directory picker, Linear ticket attach and editor selection chips.
   * Optional and default-deny; desktop reports `true` for local chats.
   */
  readonly chatInterfaceModes?: boolean;
  /** The chat reports context window usage for the composer indicator. Optional and default-deny. */
  readonly chatContextUsage?: boolean;
  /**
   * The chat's session can be shared to, or exported for, the cloud.
   * Optional and default-deny. Desktop reports `true` for local chats; a
   * cloud chat is already in the cloud and reports `false`.
   */
  readonly chatSessionTransfer?: boolean;
  /**
   * Find in chat can search pages that aren't loaded
   * (`core.chat.transcript.search`). Optional and default-deny: without it,
   * find searches only the loaded transcript.
   */
  readonly chatTranscriptSearch?: boolean;
  /**
   * The chat keeps unread and attention state that the user can change
   * (`chat.mark_read`, `chat.mark_unread`, `chat.dismiss_attention`).
   * Optional and default-deny: without it, the mark read and unread actions
   * are hidden.
   */
  readonly chatReadState?: boolean;
  /**
   * The chat scope keeps archived chats the user can list, open and restore.
   * Optional and default-deny: without it, the archived chats control is
   * hidden. Desktop reports `true` for local chats; a cloud chat scope reports
   * it once its backend serves `core.chat.archive` (CAN-6175 R3).
   */
  readonly chatArchives?: boolean;
  /**
   * The target has a task summary its Summary section shows and its Refresh
   * regenerates. Optional and default-deny: without it, the Summary section
   * and its Refresh are hidden. Desktop reports `true` for local scopes and
   * the web for a paired desktop; a cloud scope has no summary yet, and
   * reports it once its web core serves `core.summary.get` (CAN-6568,
   * CAN-6573).
   */
  readonly taskSummary?: boolean;
  /** Host can run interactive GitHub sign-in locally. Missing means unavailable. */
  readonly githubConnection?: boolean;
  /** Browser checkout only; absent is default-deny. Desktop never embeds Stripe. */
  readonly inlineCheckout?: boolean;
  /**
   * Host can link to the desktop app's download page; absent is
   * default-deny. Desktop leaves it unset because the person already has
   * the app.
   */
  readonly desktopDownload?: boolean;
  /** Paired host can approve an app-owned proposal with its message. Default-deny. */
  readonly planProposalReview?: boolean;
  /**
   * Host serves the External agents (MCP) pages through
   * `CanopyClient.externalAgents`; absent is default-deny.
   */
  readonly externalAgents?: boolean;
  /**
   * Host can render the hosted account and organization settings pages
   * through `CanopyClient.settings`. Optional and default-deny: unset is the
   * confirmed default for unconfigured and configured-but-unavailable hosts.
   * Independent of {@link inlineCheckout}, server permissions and rollouts;
   * desktop reports `true` only when its settings bridge is wired, and keeps
   * payment forms in the browser.
   */
  readonly accountOrganizationSettings?: boolean;
  /** Can run pipelines, scripts, and other work locally on the host machine. */
  readonly localExecution: boolean;
  /** Can attach an interactive PTY (desktop or cloud; Remote Control only relays). */
  readonly terminalPty: boolean;
  /** File-system reach for browse/read/edit. */
  readonly fileSystemAccess: FileSystemAccessLevel;
  /** On-device voice dictation (macOS desktop only). */
  readonly voice: boolean;
  /** Which settings sections the host can render. */
  readonly settingsScope: SettingsScope;
  /** Pipeline affordances the host exposes. */
  readonly pipelines: PipelineCapability;
  /**
   * Where {@link pipelines} can run: whether shared UI may offer "Run on:
   * Cloud" (CAN-6085). A host sets it only from its web core manifest, with
   * `pipelineCloudRunsFromManifest`, never from its runtime kind.
   * Optional and default-deny: unset is the confirmed default for
   * unconfigured and configured-but-unavailable hosts. The desktop Run
   * dialog derives it from the signed-in account's web core manifest through
   * main (CAN-6187) instead of this fixed set; canopy-server reports no cloud
   * run operations, and the browser has no web core connection (CAN-4094).
   */
  readonly pipelineCloudRuns?: boolean;
  /** Navigation model the host's `NavigationController` adapter implements. */
  readonly routing: RoutingMode;
  /** Host can supply overview notifications (local on desktop or relayed). */
  readonly overviewNotifications: boolean;
  /**
   * Host exposes panel-layout controls (e.g. a worktree-top-bar toggle that
   * rearranges the Code-workspace panels). Optional and default-deny: an unset
   * field reads as "unavailable" through the gating layer's `=== true` checks
   * (see `meetsCapabilityRequirement`), never as a wire/version negotiation —
   * capabilities never cross the protocol. No shipped host reports `true` yet;
   * a real desktop panel-layout toggle (P2) flips desktop on.
   */
  readonly panelLayoutControls?: boolean;
  /**
   * The chat composer can attach files to a send: the + menu's Files and
   * folders row, pasting files and dropping them on the chat. Default-deny.
   * Desktop reports `true` for local chats; a desktop cloud chat scope
   * reports it once its sends carry attachments through
   * `core.chat.attachment.upload` (CAN-6175 R6).
   */
  readonly chatAttachments?: boolean;
  /**
   * The client serves the paired computer's Orchestrator itself
   * (`appAdvisor.chats`, `appAdvisor.changed` and the `appAdvisor.*` shell
   * commands over its own transport). Optional and default-deny. A Portal
   * session announces the Orchestrator through its session capability
   * instead; a directly controlled computer reports it here (CAN-5985).
   */
  readonly appAdvisorChats?: boolean;
  /**
   * The client serves the paired computer's plan, script, hook, pipeline and
   * summary rows itself (`worktree.activity` and `worktree.activityChanged`
   * over its own transport). Optional and default-deny. A Portal session
   * carries those rows in its shell state instead; a directly controlled
   * computer reports it here (CAN-5985).
   */
  readonly worktreeActivityRows?: boolean;
  /**
   * Host can create a standalone (Cowork) chat before its first send, so a
   * standalone chat can carry attachments and file references. Optional and
   * default-deny: without it, standalone sends stay text-only and the host
   * creates the chat on its first message. Remote Control sets it from the
   * paired desktop's `standalone_chat_create` announcement.
   */
  readonly standaloneChatCreate?: boolean;
  /**
   * Host creates a worktree chat with a New Task's model, provider and plugin
   * selections, and keeps Auto mode on that chat's first send. Optional and
   * default-deny: without it, a New Task sends its first message without a
   * chat id and the host creates the chat from that send's settings. Remote
   * Control sets it from the paired desktop's `chat_create_tab_settings`
   * announcement.
   */
  readonly chatCreateTabSettings?: boolean;
  /** Host atomically commits plugin selections and their deferred-loading policy. Default-deny. */
  readonly deferredPluginPolicy?: boolean;
  /** Host can list and download durable cowork deliverables. Default-deny. */
  readonly chatDeliverables?: boolean;
  /** A host reader for chat visuals is wired. Optional and default-deny; this is not the feature flag. */
  readonly chatVisuals?: boolean;
  /** Paired host projects sanitized watched GitHub progress. Default-deny. */
  readonly watchedGitHubItems?: boolean;
  /** Paired host lists and deletes watchers subscribed to this chat. Default-deny. */
  readonly chatWatchers?: boolean;
  /**
   * Host renders in a document whose clipboard can take a PNG plus HTML item,
   * for copying a diagram as a picture (CAN-5040). Optional and default-deny
   * for unconfigured and configured-but-unavailable hosts; shared UI also
   * checks the browser API, secure context and MIME support at runtime.
   */
  readonly imageClipboard?: boolean;
  /**
   * Host can open a worktree in a native IDE/Finder surface (the desktop
   * `OpenDropdown`). Optional and default-deny like {@link panelLayoutControls}:
   * unset reads as `false` via the gating layer's `=== true` checks. Desktop
   * reports `true` (the native Open behavior genuinely exists); the web portal
   * reports `false`.
   */
  readonly nativeWorktreeOpen?: boolean;
  /**
   * Host can list the signed-in user's own automation shares in Marketplace,
   * including public-link-only ones, and manage them there (the "Shared by me"
   * filter, CAN-3980). Optional and default-deny like
   * {@link nativeWorktreeOpen}: unset reads as unavailable, which is the
   * confirmed default for unconfigured and configured-but-unavailable hosts.
   * Desktop reports `true`; the web portal reports `false`.
   */
  readonly marketplaceOwnedAutomationShares?: boolean;
  /**
   * Host can list the signed-in user's own account shares on every
   * Marketplace type tab, All included, filtered by authorship on the server
   * (the "Shared by me" filter, CAN-4263). The automation-specific extras
   * (public-link-only shares, local sources) stay behind
   * {@link marketplaceOwnedAutomationShares}. Optional and default-deny: unset
   * reads as unavailable for unconfigured and configured-but-unavailable
   * hosts and for older capability payloads.
   */
  readonly marketplaceOwnedShares?: boolean;
  /**
   * Host can edit a shared collection's name, description and members from
   * its Marketplace detail (CAN-4263 AC2). The editor picks members from the
   * host's local skill and plugin catalog, so only the desktop reports
   * `true`. The web portal reports `false`: its owners can Unshare a
   * collection there and edit it in the desktop app. Optional and
   * default-deny: unset reads as unavailable for unconfigured and
   * configured-but-unavailable hosts and for older capability payloads.
   */
  readonly marketplaceSharedCollectionEdit?: boolean;
  /**
   * Host can open an editor for a custom skill from its Customize row
   * (CAN-4844). Only the desktop has a skill editor and reports `true`.
   * Optional and default-deny: absent or false, the shared Customize row
   * shows Edit disabled with a reason. That is the confirmed default for
   * unconfigured and configured-but-unavailable hosts and for older
   * capability payloads.
   */
  readonly customSkillEdit?: boolean;
  /**
   * Host can list, edit, schedule and run automations (the scheduled rows of
   * the Workflows Library, the Schedule tab and automation runs, CAN-3981).
   * Optional and default-deny like {@link marketplaceOwnedAutomationShares}:
   * unset reads as unavailable, which is the confirmed default for
   * unconfigured and configured-but-unavailable hosts. Desktop reports `true`;
   * the web portal leaves it unset because automations run on the desktop app.
   */
  readonly automations?: boolean;
  /**
   * Host can list, inspect and cancel watchers (the watcher rows and Kind
   * filter of the Workflows Runs feed, CAN-3981). Optional and default-deny
   * like {@link automations}. Desktop reports `true`; the web portal leaves it
   * unset.
   */
  readonly watchers?: boolean;
  /**
   * Host can edit, open the runs of, and delete workflows from the Customize
   * Workflows rows (CAN-4845). Optional and default-deny like
   * {@link automations}. Desktop reports `true`; the web portal leaves it unset
   * because it has no pipeline delete/enable or automation commands.
   */
  readonly workflowManagement?: boolean;
  /**
   * Workspace creation modes available on this host. Optional and
   * default-deny: unset means workspace creation is unavailable.
   */
  readonly workspaceCreation?: WorkspaceCreationCapability;
  /**
   * Host can persist workspace drag-reordering. Optional and default-deny:
   * unset is treated as `false`.
   */
  readonly workspaceReordering?: boolean;
  /**
   * Host can persist task/worktree drag-reordering. Optional and default-deny:
   * unset is treated as `false`.
   */
  readonly worktreeReordering?: boolean;
  /**
   * Host creates a worktree in this target through `worktree.create` (the
   * sidebar `+`). Optional and default-deny: unset is treated as `false`.
   */
  readonly worktreeCreation?: boolean;
  /**
   * Host creates a worktree branched from an existing one (a base worktree
   * and, with it, the base's open tabs) through `worktree.create` with
   * `baseWorktreeId` / `forkOpenTabs` (the row action "Branch from").
   * Optional and default-deny: unset is treated as `false`. Independent of
   * {@link worktreeCreation}: a target can create worktrees without being
   * able to branch from one (every cloud target), and the row action needs
   * both. Desktop and Remote Control report `true`.
   */
  readonly worktreeBranching?: boolean;
  /** Lists and accepts branch bases; Portal requires canonical v2 support. Absent means unsupported. */
  readonly worktreeBaseBranch?: boolean;
  /**
   * Host persists label and visibility edits through `worktree.update` for
   * this target. Optional and default-deny: unset is treated as `false`. A
   * `trackedBaseBranch` edit is honored only where the target's adapter
   * forwards it (a cloud repository worktree); the desktop and Remote Control
   * handlers ignore or refuse it.
   */
  readonly worktreeMetadata?: boolean;
  /**
   * How a worktree row presents its identity. Unset keeps the shared
   * sidebar's current presentation (desktop, Remote Control, Cowork).
   * `'id-and-branch'`: the row's id slot beside its branch. `'branch'`: the
   * row's real branch is its identity, with no separate id slot (a cloud
   * repository worktree, whose id names no local checkout).
   */
  readonly worktreeIdPresentation?: 'id-and-branch' | 'branch';
  /**
   * Activity sections this target implements, by section id. Unset keeps
   * every section its workspace type shows; a list narrows that set to the
   * named sections.
   */
  readonly activitySectionIds?: readonly string[];
  /**
   * Whether `diff.read` answers a request without a `path` (the whole
   * worktree's combined diff). Unset keeps the default, `true`: desktop and
   * the Portal serve it. A cloud repository worktree reads Core one path at a
   * time and reports `false`, so the shared DiffViewer shows a "select a
   * file" state instead of issuing a read that cannot succeed (REG-3024).
   */
  readonly wholeWorktreeDiff?: boolean;
  /**
   * Host can pin a task/worktree to the top of its section. Optional and
   * default-deny: unset is treated as `false`.
   */
  readonly worktreePinning?: boolean;
  /**
   * Host can move a Personal project to one of the viewer's organizations.
   * Optional and default-deny: unset is treated as `false`.
   */
  readonly workspaceMoveToOrganization?: boolean;
  /** Sidebar group mutations. Optional and default-deny until the host is wired. */
  readonly itemGrouping?: boolean;
  /**
   * `false` when the host lists the project but can't open its contents yet,
   * so its row says so instead of reading as empty. Unset means available.
   */
  readonly workspaceContents?: false;
  /**
   * Workspace settings support available on this host. Optional and
   * default-deny: unset means settings are unavailable.
   */
  readonly workspaceSettings?: WorkspaceSettingsCapability;
  /**
   * Host-correct workspace removal behavior. Optional and default-deny: unset
   * means removal is unavailable.
   */
  readonly workspaceRemoval?: false | 'archive' | 'delete';
  /**
   * Host-correct worktree removal behavior. Optional and default-deny: unset
   * means removal is unavailable.
   */
  readonly worktreeRemoval?: WorktreeRemovalCapability;
  /** Absent unless the host supports retained archive and delete transitions. */
  readonly worktreeRetention?: 'archive-or-delete';
  /**
   * How the worktree removal confirmation words a removal. Absent keeps the
   * row kind's own copy (a session's chats, a checkout removed from disk).
   * `saved-changes`: removal saves the worktree's changes first and asks the
   * user when it cannot (cloud repository worktrees, REG-3022).
   */
  readonly worktreeRemovalCopy?: 'saved-changes';
  /** Absent unless the host supports workspace retention. */
  readonly workspaceRetention?: 'archive-or-delete';
  /**
   * Host implements the turn-level thumbs up/down commands (CAN-1521).
   * Optional and default-deny: a host that has not wired
   * `turnFeedback.rate` / `turnFeedback.detail` renders no control at all
   * rather than throwing on dispatch.
   */
  readonly turnFeedback?: boolean;
  /**
   * Host stars the brand's source repository in app through
   * `sourceRepository.star`. Optional and default-deny: desktop reports
   * `true` when its IPC is wired; the Portal and cloud chats leave it unset
   * and the GitHub star prompt opens the repository URL instead.
   */
  readonly sourceRepositoryStar?: boolean;
  /**
   * Host implements `account.installUpdateEmails.get` / `.set` (CAN-2334).
   * Optional and default-deny. Unconfigured (absent): the settings row
   * renders nothing. Configured but the backend is unavailable (signed out,
   * guest, offline): the row is locked, with no switch and a retry, and
   * never persists a default.
   */
  readonly installUpdateEmails?: boolean;
  /** Host supports creating and managing split pull requests. Default-deny. */
  readonly worktreeSplitPr?: boolean;
  /**
   * The worktree header can start agent chats about its pull request: Fix
   * failing checks, Resolve conflicts and Triage review comments (REG-3025).
   * Default-deny: without it those actions show unavailable, with the
   * reason, rather than disappearing.
   */
  readonly worktreePrAgentHelpers?: boolean;
  /** Host supports grouping worktree branches. Default-deny. */
  readonly worktreeBranchGrouping?: boolean;
  /** Host supports attaching another repository to a worktree. Default-deny. */
  readonly worktreeRepositoryAttachment?: boolean;
  /**
   * Host has wired the organization-projects queries, commands, and events
   * (CAN-2944). Optional and default-deny: a host that reports nothing renders
   * no context switcher or catalog rows and never dispatches those calls.
   */
  readonly orgProjects?: boolean;
  /**
   * Host can stop a managed delegation, and its subtree, for the user.
   * Optional and default-deny: unset reads as `false`, so the subagent viewer
   * renders no Stop control.
   */
  readonly delegationStop?: boolean;
  /**
   * Host can deliver a user message, steer, or interrupt to a managed
   * delegate. Optional and default-deny: unset hides the delegate composer's
   * send, steer, and interrupt controls.
   */
  readonly delegationMessaging?: boolean;
  /**
   * Host can read an isolated delegate's worktree summary and changes.
   * Optional and default-deny: unset hides the delegate worktree details.
   */
  readonly delegationWorktreeDetails?: boolean;
  /**
   * Host reads a stream-backed delegation's child pages and stored bodies
   * through `CanopyClient.transcripts`. Optional and default-deny: unset shows
   * the child activity's unavailable state, never stale inline children.
   */
  readonly delegationTranscriptReads?: boolean;
  /**
   * Host reads a paged child row's blocks through
   * `CanopyClient.transcripts.blocks`. Optional and default-deny: unset keeps
   * the row's partial notice without a way to open its blocks.
   */
  readonly delegationBlockReads?: boolean;
  /** Host can read an authoritative managed-delegation lifetime status. Default-deny. */
  readonly delegationLifetimeStatusReads?: boolean;
  /** Host can request a user-authorized managed-delegation lifetime extension. Default-deny. */
  readonly delegationLifetimeLimitExtension?: boolean;
  /**
   * Host shows managed delegates but cannot read their worktree's lifetime
   * status, so the Subagents panel shows a static explanation instead.
   * Default-deny: unset renders no lifetime notice without status reads.
   */
  readonly delegationLifetimeStatusGated?: boolean;
  /**
   * Host reads a primary tool result's full body, stored apart or cut for
   * display, through `CanopyClient.transcripts.content`. Optional and
   * default-deny: unset shows only the result's preview.
   */
  readonly primaryContentReads?: boolean;
  /**
   * Host can interrupt a native Claude or Codex subagent. Optional and
   * default-deny: unset hides the native subagent interrupt control.
   */
  readonly nativeSubagentInterrupt?: boolean;
  /**
   * Host can read a work scope's Agent Ledger through a `LedgerClient`.
   * Optional and default-deny: a host without one never offers the Ledger
   * panel. Whether the Ledger is turned on is a separate, per-call check.
   */
  readonly ledger?: boolean;
  /**
   * Host can show the live state of the agents that own this device's Feed
   * work (L12): turns, waits, background work and Catching up, projected
   * from its canonical chat state. Optional and default-deny: unset shows
   * the Feed's rows without live state.
   */
  readonly ledgerLiveAgentStates?: boolean;
  /**
   * Host can read the Feed: the account's entries, and its teammates', from
   * the mirror through a `LedgerFeedClient`. Optional and default-deny: a
   * host without it never offers the Feed page.
   */
  readonly ledgerFeed?: boolean;
  /**
   * Host holds a Ledger itself: its scopes' views, entry changes, the
   * composer, corrections, navigation to sources and files. Optional and
   * default-deny: without it the Feed reads only.
   */
  readonly ledgerLocal?: boolean;
  /**
   * Host can read a work scope's observed cost through a `CostClient`.
   * Optional and default-deny: a host without one offers no Cost panel, no
   * Session breakdown and no cost row in the usage popover.
   */
  readonly costInsights?: boolean;
  /**
   * Host answers the `referencePreview.*` reads through its own provider
   * connections. Default-deny: transcripts render references as plain text.
   */
  readonly referencePreviews?: boolean;
  /**
   * Host can stop one native background task (a provider agent, workflow or
   * shell) by its task id through `activity.stopBackgroundTask`. Optional and
   * default-deny: a host that has not wired it renders no task Stop.
   */
  readonly backgroundTaskStop?: boolean;
  /**
   * Host can inspect unreadable destructive lifecycle journal entries and
   * move one to quarantine (CAN-5335). Default-deny: deletion and archive
   * refusals then show only their message.
   */
  readonly lifecycleJournalQuarantine?: boolean;
  /**
   * Host can describe and permanently discard a worktree whose ordinary
   * removal can't finish (CAN-5336). Default-deny: the refusal then shows
   * only its message.
   */
  readonly worktreeDiscard?: boolean;
  /** Incarnation-bound, settled recovery actions; description support alone is insufficient. */
  readonly worktreeRecovery?: boolean;
  /**
   * Host can list what keeps a project's deletion from finishing that a
   * person can discard, and supersede an interrupted deletion on request
   * (CAN-5337). Default-deny: the deletion's refusal then shows only its
   * message.
   */
  readonly projectDeletionDiscard?: boolean;
  /**
   * Host can promote the Personal organization into a team (CAN-3706).
   * Default-deny; the server still authorizes every promotion.
   */
  readonly personalOrganizationUpgrade?: boolean;
  /** Host can send organization invitations. Default-deny. */
  readonly organizationInvites?: boolean;
  /**
   * Host can list and bring Personal projects into a team: desktop locally,
   * web only through a paired desktop session. Default-deny.
   */
  readonly personalProjectConversion?: boolean;
  /**
   * Host detects repeated requests locally and offers to turn them into a
   * custom skill (CAN-385). Desktop only; default-deny keeps the banner and
   * suggestions list off web and Remote Control.
   */
  readonly skillSuggestions?: boolean;
}
