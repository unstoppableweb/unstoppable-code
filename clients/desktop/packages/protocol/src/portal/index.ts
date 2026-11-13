import type { CoworkFolderMissing } from '../canopy-core/core/workspace/cowork-folder';
export * from './w5-recovery';
import type { W5RecoveryStatus } from './w5-recovery';
import type {
  PortalWatcherDeletePayload,
  PortalWatcherEntity,
} from './watchers';
export * from './watchers';
export * from './shared-multi-repo';
export * from './lifecycle-journal';
import type { PortalSharedMultiRepoCommand } from './shared-multi-repo';
import type { LifecycleJournalQuarantineRequest } from './lifecycle-journal';
import type { AutoResumeMetadata } from './transcript-metadata';
import type { ToolInterruption } from './transcript-metadata';
export * from './transcript-metadata';
export * from './worktree-discard';
export * from './project-deletion-discard';
import type {
  PortalWorktreeDiscardDescribePayload,
  PortalWorktreeDiscardPayload,
} from './worktree-discard';
import type { PortalProjectDeletionDiscardDescribePayload } from './project-deletion-discard';
import type { WorkerFilesystemRootsListResult } from '../canopy-core/worker/filesystem';
import type { TurnFileRecord } from '../turn-files';
import type { SuggestionsUpdate } from '../suggestions';
import type { OnboardingTipsUpdate } from '../onboarding-tips';
import type { ClaudeModsGetArgs, ClaudeModsUpdate } from '../claude-mods';
import type { ChatPlanReviewApproval } from '../canopy-core/chat-plan-review';
export {
  TrackedPlanImplementationInputSchema,
  TrackedPlanImplementationSchema,
  ChatPlanReviewApprovalSchema,
} from '../canopy-core/chat-plan-review';
export type {
  TrackedPlanImplementationInput,
  TrackedPlanImplementation,
  ChatPlanReviewApproval,
} from '../canopy-core/chat-plan-review';
import type { OpenCodeReportedUsage } from './opencode-usage';
export {
  parseOpenCodeReportedUsage,
  type OpenCodeReportedUsage,
} from './opencode-usage';
import type { OpenCodeAccountSnapshot } from './opencode-accounts';
export {
  openCodeAccountMetadataSchema,
  openCodeAccountSnapshotSchema,
  type OpenCodeAccountSnapshot,
  type OpenCodeAccountMethod,
  type OpenCodeAccountUsage,
} from './opencode-accounts';
import type {
  ScriptActionsListRequest,
  ScriptActionsContext,
  ScriptActionsReviewRequest,
  ScriptActionsShortcutRequest,
  ScriptActionsPinRequest,
  ScriptActionsReceiptRequest,
} from '@canopy/protocol/script-actions';
import type {
  InstalledItemSnapshot,
  InstalledItemMutationResult,
  SetInstalledItemStatusRequest,
  UninstallInstalledItemRequest,
} from '../installed-items';
import type { PortalMcpServerStatus } from './mcp-management';
export * from './mcp-management';
import { normalizeRepositoryCloneUrl } from './repository-clone';
import { normalizeGitHubRepositoryIdentity } from '../portable-tasks/pull-request-reference';
export {
  normalizeRepositoryCloneUrl,
  repositoryCloneErrorMessage,
  REPOSITORY_CLONE_FAILURE_MESSAGE,
  PORTAL_REPOSITORY_CLONE_UNCONFIRMED_MESSAGE,
  portalRepositoryCloneErrorMessage,
} from './repository-clone';
import type { AgentArtifactReceiptV1 } from '../agent-artifacts';
import type { TryItCapability } from '../try-it';
import type { PersonalProjectConversionRequest } from '../organizations';
import type {
  AgentSentInfo,
  ExternalAgentSender,
} from './external-agent-sender';
import type {
  SidebarItemGroup,
  SidebarItemGroupCreationOptions,
  SidebarItemGroupScope,
  SidebarItemGroupColor,
  SidebarItemGroupCreateRequest,
  SidebarItemGroupUpdateRequest,
  SidebarItemGroupMoveItemRequest,
  SidebarItemGroupMoveRequest,
} from '../sidebar';
import type {
  MarketplaceEntryShareResolution,
  ShareAudience,
  ShareFailure,
  ShareOrganizationAccess,
} from '../sharing';
import type {
  ChatInputDeliveryAction,
  ChatInputDeliveryView,
  ChatSteeringCapabilities,
} from './input-delivery';
import type {
  ChatTurnPhase,
  QueuedMessageRetryBlockedReason,
  QueuedMessageWaitingReason,
  SettingsHeldChange,
} from './turn-phase';
import type { OrgProjectPlaceholderState } from '../org-projects';
/**
 * Shared protocol types for the Canopy Portal feature.
 *
 * These types describe the environment-neutral wire contract between local
 * Canopy and Canopy Server. Keep this package free of Prisma, Next, Electron,
 * Node, and React imports.
 */
import type { ModelCatalog } from '../models';
export type * from './input-delivery';
export type {
  ChatTurnPhase,
  QueuedMessageRetryBlockedReason,
  QueuedMessageWaitingReason,
  SettingsHeldChange,
} from './turn-phase';
export {
  SETTINGS_HELD_CHANGES,
  orderedSettingsHeldChanges,
} from './turn-phase';
export {
  parseInputDeliveryViews,
  parseChatWatcherFiredInfo,
  parseChatAgentSentInfo,
  parseSteeringCapabilities,
} from './input-delivery';
import {
  parseChatWatcherFiredInfo,
  type ChatWatcherFiredInfo,
} from './input-delivery';
import type { AgentExecutionHarness } from '../models';
import type { ThinkingLevel, ThinkingSetting } from '../thinking/index';
import type { CodexSpeed } from '../automations';
import {
  CLOUD_ATTACHMENT_FILENAME_MAX_BYTES,
  cloudAttachmentFilenameByteLength,
  CLOUD_ATTACHMENTS_MAX_PER_MESSAGE,
} from '../cloud-attachments';
import type {
  MarketplaceInfo,
  MarketplaceProviderStatus,
  PluginDetails,
  PluginInfo,
  PluginProvider,
} from '../plugins';
import type { InstalledSkillInfo, SkillRiskInfo } from '../skills';
import type {
  McpHttpAuthHandler,
  McpServerIndexEntry,
  ProviderConnectorListResult,
  McpServerScope,
  McpServerType,
} from '../mcp-servers';
import type {
  ApplyCollectionUpdateResult,
  CollectionConfig,
  CollectionIndexEntry,
  CollectionMcpRef,
  CollectionPluginRef,
  CollectionSkillRef,
} from '../collections';
import type { CuratedMcpUrlOption } from '../mcp-catalog';
import type { CapabilityUnavailable } from '../capability-bundle';
import type { AgentTaskStopReason } from '../cloud-session/agent-task';
import type {
  PortalChatContentReadPayload,
  PortalChatTranscriptBlocksPagePayload,
  PortalChatTranscriptPagePayload,
} from './transcript-reads';
import type {
  UnifiedEntryKind,
  UnifiedEntryOrigin,
  UnifiedEntryRef,
  UnifiedEntryState,
} from '../unified-entry/index';

export {
  sanitizePortalEventEnvelope,
  sanitizeStorableJson,
  sanitizeStorableString,
} from './portal-event-sanitization';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Status enums
// ---------------------------------------------------------------------------

/**
 * Persisted lifecycle of a `PortalSession` row in the server database. A
 * session is created in `pending_auth`, transitions to `active` once the user
 * has typed the matching pairing code in their browser, and ends in
 * `inactive` once the user (or local Canopy) terminates it.
 */
export type PortalSessionStatus = 'pending_auth' | 'active' | 'inactive';

/**
 * Lifecycle of the local-Canopy ↔ server connection from the server's view.
 *
 * - `pending`      — waiting for code activation;
 * - `active`       — healthy, polling/streaming normally;
 * - `reconnecting` — transient failure, cached state retained;
 * - `inactive`     — exceeded stale threshold, cached state retained;
 * - `ended`        — explicitly ended; cached state must be purged.
 *
 * Cached UI remains visible while the connection is `reconnecting` or
 * `inactive`; only the banner and command-blocking change. Commands may
 * queue while `reconnecting` and are blocked only when `inactive` or
 * `ended`. Cached state purge happens on `ended`, or when an `inactive`
 * session passes the configurable retention window (default 7 days).
 */
export type PortalConnectionStatus =
  | 'pending'
  | 'active'
  | 'reconnecting'
  | 'inactive'
  | 'ended';

/**
 * Lifecycle of a single queued command row (`PortalCommand`). Commands move
 * through these states monotonically: `pending` → `delivered` → (`completed` |
 * `failed` | `expired`). A command never moves back to `pending`.
 */
export type PortalCommandStatus =
  | 'pending'
  | 'delivered'
  | 'completed'
  | 'failed'
  | 'expired';

/**
 * Closed enumeration of all supported portal command types. Adapters MUST
 * reject anything not in this set. New families MUST be added here first
 * before any adapter or service can use them.
 */
export const PORTAL_CAPABILITY_ITEM_GROUPING = 'sidebar_item_groups';
/** Edit acquisitions support durable, attempt-scoped timeout cleanup. */
export const PORTAL_CAPABILITY_QUEUE_EDIT_LOCK_OWNERSHIP =
  'queue_edit_lock_ownership';

export type PortalCommandType =
  | 'portal.sidebar.item_groups.list'
  | 'portal.sidebar.item_groups.create'
  | 'portal.sidebar.item_groups.update'
  | 'portal.sidebar.item_groups.ungroup'
  | 'portal.sidebar.item_groups.move_item'
  | 'portal.sidebar.item_groups.move_group'
  | 'portal.sidebar.item_groups.assign_named'
  | 'portal.auth.validate_code'
  | 'portal.session.end'
  | 'portal.state.request'
  | 'portal.org_projects.shared_multi_repo'
  | 'portal.org_projects.find_repository_owner'
  | 'portal.personal_organization.projects.list'
  | 'portal.personal_organization.projects.convert'
  | 'portal.personal_organization.projects.status'
  | 'portal.chat.send'
  | 'portal.chat.cancel'
  | 'portal.chat.cancel_turn'
  | 'portal.watcher.delete'
  | 'portal.chat.mark_read'
  | 'portal.chat.set_unread'
  | 'portal.chat.visual.read'
  | 'portal.chat.queue.cancel'
  | 'portal.chat.queue.edit'
  | 'portal.chat.queue.force'
  | 'portal.chat.queue.steer'
  | 'portal.chat.input_delivery'
  | 'portal.chat.queue.set_edit_lock'
  | 'portal.chat.set_model'
  | 'portal.chat.set_thinking_level'
  | 'portal.chat.set_plan_mode'
  | 'portal.chat.set_fast_mode'
  | 'portal.chat.set_plugin_selections'
  | 'portal.chat.list_plugin_catalog'
  | 'portal.chat.create_tab'
  | 'portal.chat.close_tab'
  | 'portal.chat.fork'
  | 'portal.chat.branch'
  | 'portal.chat.share'
  | 'portal.chat.answer_question'
  | 'portal.chat.dismiss_question'
  | 'portal.standalone_chat.send'
  | 'portal.standalone_chat.create'
  | 'portal.standalone_chat.cancel'
  | 'portal.standalone_chat.set_model'
  | 'portal.standalone_chat.set_plugin_selections'
  | 'portal.app_advisor.send'
  | 'portal.app_advisor.cancel'
  | 'portal.app_advisor.set_model'
  | 'portal.app_advisor.create_tab'
  | 'portal.app_advisor.close_tab'
  | 'portal.app_advisor.answer_question'
  | 'portal.app_advisor.dismiss_question'
  | 'portal.app_advisor.settings.get'
  | 'portal.app_advisor.settings.save'
  | 'portal.suggestions.get'
  | 'portal.suggestions.update'
  | 'portal.onboarding_tips.get'
  | 'portal.onboarding_tips.update'
  | 'portal.claude_mods.get'
  | 'portal.claude_mods.update'
  | 'portal.script_actions.list'
  | 'portal.script_actions.rescan'
  | 'portal.script_actions.review'
  | 'portal.script_actions.set_shortcut'
  | 'portal.script_actions.set_pinned'
  | 'portal.script_actions.enable_shell_alias_scan'
  | 'portal.script_actions.receipt'
  | 'portal.terminal.open'
  | 'portal.terminal.write'
  | 'portal.terminal.resize'
  | 'portal.terminal.close'
  | 'portal.script.run'
  | 'portal.script.cancel'
  | 'portal.script.source_info'
  | 'portal.script.log_request'
  | 'portal.hook.run'
  | 'portal.hook.cancel'
  | 'portal.hook.pause'
  | 'portal.hook.resume'
  | 'portal.hook.source_info'
  | 'portal.plan.list'
  | 'portal.plan.get'
  | 'portal.plan.create'
  | 'portal.plan.update'
  | 'portal.plan.delete'
  | 'portal.plan.open'
  | 'portal.workspace_items.list_notes'
  | 'portal.workspace_items.read_note'
  | 'portal.workspace_items.list_prompts'
  | 'portal.workspace_items.read_prompt'
  | 'portal.workspace_items.list_attachments'
  | 'portal.pipeline.list'
  | 'portal.pipeline.get'
  | 'portal.pipeline.run'
  | 'portal.pipeline.cancel'
  | 'portal.pipeline.execution.get'
  | 'portal.pipeline.execution_list'
  | 'portal.pipeline.resume'
  | 'portal.pipeline.retry'
  | 'portal.pipeline.rerun'
  | 'portal.pipeline.log_request'
  | 'portal.pipeline.chat_follow_up.prepare'
  | 'portal.pipeline.content.read'
  | 'portal.diff.read'
  | 'portal.pr.action'
  | 'portal.pr.refresh'
  | 'portal.summary.refresh'
  | 'portal.pr.create'
  | 'portal.file.resolve_link'
  | 'portal.file.roots'
  | 'portal.file.directory'
  | 'portal.file.preview'
  | 'portal.file.read'
  | 'portal.file.asset.read'
  | 'portal.chat.asset.read'
  | 'portal.chat.transcript.page'
  | 'portal.chat.transcript.blocks.page'
  | 'portal.chat.content.read'
  | 'portal.file.save'
  | 'portal.editor.list_slash_commands'
  | 'portal.editor.list_file_mentions'
  | 'portal.editor.list_invocables'
  | 'portal.editor.resolve_invocable'
  | 'portal.session.set_view_mode'
  | 'portal.workspace.set_section_order'
  | 'portal.workspace.reorder'
  | 'portal.worktree.create'
  | 'portal.worktree.archive'
  | 'portal.worktree.discard.describe'
  | 'portal.worktree.discard'
  | 'portal.worktree.update'
  | 'portal.work_entry.update'
  | 'portal.work_entry.delete'
  | 'portal.task_refs.list'
  | 'portal.worktree.reorder'
  | 'portal.workspace.create'
  | 'portal.workspace.delete'
  | 'portal.workspace.delete.discard.describe'
  | 'portal.lifecycle_journal.inspect'
  | 'portal.lifecycle_journal.quarantine'
  | 'portal.workspace.update'
  | 'portal.workspace.claude_md.get'
  | 'portal.workspace.claude_md.save'
  | 'portal.workspace.scripts.get'
  | 'portal.workspace.scripts.save'
  | 'portal.plugins.list_marketplaces'
  | 'portal.plugins.get_plugin_detail'
  | 'portal.plugins.read_component_content'
  | 'portal.plugins.install_builtin'
  | 'portal.plugins.share_plugin'
  | 'portal.plugins.install_external'
  | 'portal.marketplace.add'
  | 'portal.marketplace.update'
  | 'portal.marketplace.remove'
  | 'portal.marketplace.refresh_all'
  | 'portal.skills.list'
  | 'portal.skills.read'
  | 'portal.skills.share_skill'
  | 'portal.sharing.account'
  | 'portal.sharing.existing_share'
  | 'portal.pipeline.share'
  | 'portal.pipeline.install_curated'
  | 'portal.collections.share'
  | 'portal.sharing.list_teams'
  | 'portal.sharing.list_organizations'
  | 'portal.mcp.list_servers'
  | 'portal.mcp.get_server'
  | 'portal.mcp.set_config_enabled'
  | 'portal.mcp.test_connection'
  | 'portal.mcp.delete_server'
  | 'portal.collections.list'
  | 'portal.collections.get'
  | 'portal.collections.save'
  | 'portal.collections.apply_update'
  | 'portal.installed_items.list_status'
  | 'portal.installed_items.set_status'
  | 'portal.installed_items.uninstall'
  | 'portal.provider_usage.refresh';

/**
 * Frozen runtime list of every supported `PortalCommandType`. Use this in
 * validators and tests so the closed enum stays in lockstep with the type.
 */
export const PORTAL_COMMAND_TYPES = [
  'portal.sidebar.item_groups.list',
  'portal.sidebar.item_groups.create',
  'portal.sidebar.item_groups.update',
  'portal.sidebar.item_groups.ungroup',
  'portal.sidebar.item_groups.move_item',
  'portal.sidebar.item_groups.move_group',
  'portal.sidebar.item_groups.assign_named',
  'portal.auth.validate_code',
  'portal.session.end',
  'portal.state.request',
  'portal.org_projects.shared_multi_repo',
  'portal.org_projects.find_repository_owner',
  'portal.personal_organization.projects.list',
  'portal.personal_organization.projects.convert',
  'portal.personal_organization.projects.status',
  'portal.chat.send',
  'portal.chat.cancel',
  'portal.chat.cancel_turn',
  'portal.watcher.delete',
  'portal.chat.mark_read',
  'portal.chat.set_unread',
  'portal.chat.visual.read',
  'portal.chat.queue.cancel',
  'portal.chat.queue.edit',
  'portal.chat.queue.force',
  'portal.chat.queue.steer',
  'portal.chat.input_delivery',
  'portal.chat.queue.set_edit_lock',
  'portal.chat.set_model',
  'portal.chat.set_thinking_level',
  'portal.chat.set_plan_mode',
  'portal.chat.set_fast_mode',
  'portal.chat.set_plugin_selections',
  'portal.chat.list_plugin_catalog',
  'portal.chat.create_tab',
  'portal.chat.close_tab',
  'portal.chat.fork',
  'portal.chat.branch',
  'portal.chat.share',
  'portal.chat.answer_question',
  'portal.chat.dismiss_question',
  'portal.standalone_chat.send',
  'portal.standalone_chat.create',
  'portal.standalone_chat.cancel',
  'portal.standalone_chat.set_model',
  'portal.standalone_chat.set_plugin_selections',
  'portal.app_advisor.send',
  'portal.app_advisor.cancel',
  'portal.app_advisor.set_model',
  'portal.app_advisor.create_tab',
  'portal.app_advisor.close_tab',
  'portal.app_advisor.answer_question',
  'portal.app_advisor.dismiss_question',
  'portal.app_advisor.settings.get',
  'portal.app_advisor.settings.save',
  'portal.suggestions.get',
  'portal.suggestions.update',
  'portal.onboarding_tips.get',
  'portal.onboarding_tips.update',
  'portal.claude_mods.get',
  'portal.claude_mods.update',
  'portal.script_actions.list',
  'portal.script_actions.rescan',
  'portal.script_actions.review',
  'portal.script_actions.set_shortcut',
  'portal.script_actions.set_pinned',
  'portal.script_actions.enable_shell_alias_scan',
  'portal.script_actions.receipt',
  'portal.terminal.open',
  'portal.terminal.write',
  'portal.terminal.resize',
  'portal.terminal.close',
  'portal.script.run',
  'portal.script.cancel',
  'portal.script.source_info',
  'portal.script.log_request',
  'portal.hook.run',
  'portal.hook.cancel',
  'portal.hook.pause',
  'portal.hook.resume',
  'portal.hook.source_info',
  'portal.plan.list',
  'portal.plan.get',
  'portal.plan.create',
  'portal.plan.update',
  'portal.plan.delete',
  'portal.plan.open',
  'portal.workspace_items.list_notes',
  'portal.workspace_items.read_note',
  'portal.workspace_items.list_prompts',
  'portal.workspace_items.read_prompt',
  'portal.workspace_items.list_attachments',
  'portal.pipeline.list',
  'portal.pipeline.get',
  'portal.pipeline.run',
  'portal.pipeline.cancel',
  'portal.pipeline.execution.get',
  'portal.pipeline.execution_list',
  'portal.pipeline.resume',
  'portal.pipeline.retry',
  'portal.pipeline.rerun',
  'portal.pipeline.log_request',
  'portal.pipeline.chat_follow_up.prepare',
  'portal.pipeline.content.read',
  'portal.diff.read',
  'portal.pr.action',
  'portal.pr.refresh',
  'portal.summary.refresh',
  'portal.pr.create',
  'portal.file.resolve_link',
  'portal.file.roots',
  'portal.file.directory',
  'portal.file.preview',
  'portal.file.read',
  'portal.file.asset.read',
  'portal.chat.asset.read',
  'portal.chat.transcript.page',
  'portal.chat.transcript.blocks.page',
  'portal.chat.content.read',
  'portal.file.save',
  'portal.editor.list_slash_commands',
  'portal.editor.list_file_mentions',
  'portal.editor.list_invocables',
  'portal.editor.resolve_invocable',
  'portal.session.set_view_mode',
  'portal.workspace.set_section_order',
  'portal.workspace.reorder',
  'portal.worktree.create',
  'portal.worktree.archive',
  'portal.worktree.discard.describe',
  'portal.worktree.discard',
  'portal.worktree.update',
  'portal.work_entry.update',
  'portal.work_entry.delete',
  'portal.task_refs.list',
  'portal.worktree.reorder',
  'portal.workspace.create',
  'portal.workspace.delete',
  'portal.workspace.delete.discard.describe',
  'portal.lifecycle_journal.inspect',
  'portal.lifecycle_journal.quarantine',
  'portal.workspace.update',
  'portal.workspace.claude_md.get',
  'portal.workspace.claude_md.save',
  'portal.workspace.scripts.get',
  'portal.workspace.scripts.save',
  'portal.plugins.list_marketplaces',
  'portal.plugins.get_plugin_detail',
  'portal.plugins.read_component_content',
  'portal.plugins.install_builtin',
  'portal.plugins.share_plugin',
  'portal.plugins.install_external',
  'portal.marketplace.add',
  'portal.marketplace.update',
  'portal.marketplace.remove',
  'portal.marketplace.refresh_all',
  'portal.skills.list',
  'portal.skills.read',
  'portal.skills.share_skill',
  'portal.sharing.account',
  'portal.sharing.existing_share',
  'portal.pipeline.share',
  'portal.pipeline.install_curated',
  'portal.collections.share',
  'portal.sharing.list_teams',
  'portal.sharing.list_organizations',
  'portal.mcp.list_servers',
  'portal.mcp.get_server',
  'portal.mcp.set_config_enabled',
  'portal.mcp.test_connection',
  'portal.mcp.delete_server',
  'portal.collections.list',
  'portal.collections.get',
  'portal.collections.save',
  'portal.collections.apply_update',
  'portal.installed_items.list_status',
  'portal.installed_items.set_status',
  'portal.installed_items.uninstall',
  'portal.provider_usage.refresh',
] as const satisfies readonly PortalCommandType[];

/**
 * Set form of `PORTAL_COMMAND_TYPES`. Wrapped in a `Set<string>` so the
 * runtime check inside `command-service` can `.has(...)` an unvalidated
 * input string without first narrowing it.
 * Construction only reads the local array. Keep it pure so browser imports
 * of unrelated Portal helpers do not retain the full command catalog.
 */
export const PORTAL_COMMAND_TYPES_SET: ReadonlySet<string> =
  /*#__PURE__*/ new Set(PORTAL_COMMAND_TYPES);

/**
 * Compile-time parity guards for the closed command enum. The union, the
 * runtime array, and the payload map are maintained by hand in three places;
 * a command registered in the payload map but missing from the union/array is
 * silently rejected by the web command service before it ever reaches an
 * adapter — the command exists in types but is inert on the wire, and no
 * runtime test can catch it because the payload map is type-only. Each alias
 * fails `tsc` when the sets drift.
 */
type PortalCommandTypeMissingFromArray = Exclude<
  PortalCommandType,
  (typeof PORTAL_COMMAND_TYPES)[number]
>;
type PortalPayloadKeyMissingFromUnion = Exclude<
  keyof PortalCommandPayloadMap,
  PortalCommandType
>;
type PortalCommandParityAssert<T extends true> = T;
export type PortalCommandEnumParityGuards = [
  PortalCommandParityAssert<
    PortalCommandTypeMissingFromArray extends never ? true : false
  >,
  PortalCommandParityAssert<
    PortalPayloadKeyMissingFromUnion extends never ? true : false
  >,
];

/**
 * Portal command types that perform an IRREVERSIBLE destructive operation on
 * the paired desktop and remain gated by the `canopy-portal-destructive-actions`
 * kill-switch flag, enforced server-side at command acceptance (not just in the
 * browser UI). Keep this in lockstep with any new flag-gated destructive command
 * added to {@link PortalCommandType}.
 *
 * NOTE: `portal.workspace.delete` is destructive too, but is intentionally
 * NOT in this set — workspace removal is a first-class, always-available portal
 * action guarded by an in-browser confirmation dialog rather than the flag.
 * Adding it back here would re-gate workspace removal behind the flag.
 */
export const PORTAL_DESTRUCTIVE_COMMAND_TYPES: ReadonlySet<PortalCommandType> =
  new Set<PortalCommandType>([
    'portal.worktree.archive',
    'portal.worktree.discard',
    'portal.installed_items.uninstall',
    'portal.work_entry.delete',
  ]);

/**
 * Portal command types that behave as small synchronous RPCs: the browser
 * command route waits briefly for the desktop's completion and returns
 * the `result` inline on the submit response instead of forcing the browser
 * to poll the event stream. Every member MUST produce a result comfortably
 * under the portal event size cap (~1 MiB) — list commands never carry file
 * bodies, detail commands truncate a single body to
 * {@link PORTAL_CATALOG_CONTENT_MAX_BYTES}, and every catalog result is
 * capped at {@link PORTAL_CATALOG_RESULT_MAX_BYTES} serialized bytes.
 *
 * Real wall-clock operations (`portal.workspace.create`, the plugin/
 * marketplace mutations, …) intentionally stay OUT of this set: they wait
 * longer, on a coarser poll, via {@link PORTAL_LONG_RPC_COMMAND_TYPES}.
 */
export const PORTAL_SMALL_RPC_COMMAND_TYPES: ReadonlySet<PortalCommandType> =
  new Set<PortalCommandType>([
    'portal.watcher.delete',
    'portal.lifecycle_journal.inspect',
    'portal.lifecycle_journal.quarantine',
    'portal.chat.create_tab',
    'portal.standalone_chat.create',
    'portal.work_entry.update',
    'portal.work_entry.delete',
    'portal.sidebar.item_groups.assign_named',
    'portal.task_refs.list',
    'portal.chat.asset.read',
    'portal.file.asset.read',
    'portal.chat.transcript.page',
    'portal.chat.transcript.blocks.page',
    'portal.chat.content.read',
    'portal.app_advisor.create_tab',
    'portal.sidebar.item_groups.list',
    'portal.sidebar.item_groups.create',
    'portal.sidebar.item_groups.update',
    'portal.sidebar.item_groups.ungroup',
    'portal.sidebar.item_groups.move_item',
    'portal.sidebar.item_groups.move_group',
    'portal.editor.list_slash_commands',
    'portal.editor.list_file_mentions',
    'portal.editor.list_invocables',
    'portal.chat.list_plugin_catalog',
    'portal.app_advisor.settings.get',
    'portal.suggestions.get',
    'portal.suggestions.update',
    'portal.onboarding_tips.get',
    'portal.onboarding_tips.update',
    'portal.claude_mods.get',
    'portal.claude_mods.update',
    'portal.workspace.claude_md.get',
    'portal.script_actions.list',
    'portal.script_actions.rescan',
    'portal.script_actions.review',
    'portal.script_actions.set_shortcut',
    'portal.script_actions.set_pinned',
    'portal.script_actions.enable_shell_alias_scan',
    'portal.script_actions.receipt',
    'portal.workspace.scripts.get',
    'portal.workspace.update',
    'portal.state.request',
    'portal.org_projects.shared_multi_repo',
    'portal.org_projects.find_repository_owner',
    'portal.personal_organization.projects.list',
    'portal.personal_organization.projects.status',
    'portal.plugins.list_marketplaces',
    'portal.plugins.get_plugin_detail',
    'portal.plugins.read_component_content',
    'portal.skills.list',
    'portal.skills.read',
    'portal.sharing.account',
    'portal.sharing.existing_share',
    'portal.sharing.list_teams',
    'portal.sharing.list_organizations',
    'portal.mcp.list_servers',
    'portal.mcp.get_server',
    'portal.mcp.set_config_enabled',
    'portal.mcp.delete_server',
    'portal.collections.list',
    'portal.collections.get',
    // A collection save is a fast local file write, completed inline like the
    // MCP config toggle.
    'portal.collections.save',
    'portal.workspace_items.list_notes',
    'portal.workspace_items.read_note',
    'portal.workspace_items.list_prompts',
    'portal.workspace_items.read_prompt',
    'portal.workspace_items.list_attachments',
    'portal.pipeline.list',
    'portal.pipeline.get',
    'portal.pipeline.execution_list',
    'portal.pipeline.chat_follow_up.prepare',
    'portal.pipeline.content.read',
    'portal.provider_usage.refresh',
    'portal.worktree.discard.describe',
    'portal.workspace.delete.discard.describe',
  ]);

/**
 * How long the browser command route waits for a small RPC result. The
 * desktop work is fast, but delivery shares the runner and database with the
 * portal UI; 15 seconds leaves headroom for loaded environments while staying
 * below the proven long-poll ceiling.
 */
export const PORTAL_SMALL_RPC_RESULT_TIMEOUT_MS = 15_000;

/**
 * `errorCode` of an asset read submit that stopped waiting before the desktop
 * answered. The desktop can still complete that command and the server keeps
 * its chunk, so the browser follows the same command through
 * `GET .../commands/{commandId}` instead of failing or reading again.
 */
export const PORTAL_ASSET_READ_PENDING_ERROR_CODE = 'portal_asset_read_pending';

/**
 * Portal command types that behave as LONG synchronous RPCs: the browser
 * command route waits up to {@link PORTAL_LONG_RPC_RESULT_TIMEOUT_MS} on a
 * coarse (250ms) poll for the desktop's terminal state and returns the
 * `result`/`error` inline when it arrives in time. A timeout is NOT an error:
 * the route answers `202` without a result, the desktop keeps working, and the
 * browser reconciles with a later refetch.
 *
 * Members are real wall-clock operations (git clone, provider CLI installs,
 * marketplace syncs) that usually finish inside the window but may not.
 * `portal.marketplace.refresh_all` intentionally stays OUT of this set: it
 * fans out N provider CLI refreshes and routinely takes MINUTES — far past
 * both this wait window and the 60s command TTL — so it is fire-and-forget
 * (immediate `202`, browser refetches later).
 */
export const PORTAL_LONG_RPC_COMMAND_TYPES: ReadonlySet<PortalCommandType> =
  new Set<PortalCommandType>([
    'portal.installed_items.list_status',
    'portal.installed_items.set_status',
    'portal.installed_items.uninstall',
    'portal.personal_organization.projects.convert',
    'portal.workspace.create',
    'portal.worktree.create',
    'portal.worktree.discard',
    'portal.plugins.install_builtin',
    'portal.plugins.install_external',
    'portal.plugins.share_plugin',
    'portal.skills.share_skill',
    'portal.pipeline.share',
    'portal.pipeline.install_curated',
    'portal.collections.share',
    'portal.collections.apply_update',
    'portal.marketplace.add',
    'portal.marketplace.update',
    'portal.marketplace.remove',
    // Resolving may prepare a Codex compatibility plugin before it commits.
    'portal.editor.resolve_invocable',
  ]);

/**
 * Closed set of event kinds that local Canopy may post to the server. Events
 * either correlate to a queued command (`commandId` set) or represent a
 * spontaneous local change (heartbeat, state delta, etc.).
 */
export type PortalEventType =
  | 'portal.auth.result'
  | 'portal.heartbeat'
  | 'portal.connection.restored'
  | 'portal.session.ended'
  | 'portal.state.snapshot'
  | 'portal.state.delta'
  | 'portal.command.completed'
  | 'portal.command.failed'
  | 'portal.chat.event'
  | 'portal.app_advisor.event'
  | 'portal.terminal.output'
  | 'portal.script.event'
  | 'portal.hook.event'
  | 'portal.plan.event'
  | 'portal.pipeline.event'
  | 'portal.diff.snapshot'
  | 'portal.file.snapshot';

/**
 * Frozen runtime list of every supported `PortalEventType`. Mirrors
 * `PORTAL_COMMAND_TYPES` so cross-repo contract tests can compare the two
 * repos' enums element-by-element.
 */
export const PORTAL_EVENT_TYPES = [
  'portal.auth.result',
  'portal.heartbeat',
  'portal.connection.restored',
  'portal.session.ended',
  'portal.state.snapshot',
  'portal.state.delta',
  'portal.command.completed',
  'portal.command.failed',
  'portal.chat.event',
  'portal.app_advisor.event',
  'portal.terminal.output',
  'portal.script.event',
  'portal.hook.event',
  'portal.plan.event',
  'portal.pipeline.event',
  'portal.diff.snapshot',
  'portal.file.snapshot',
] as const satisfies readonly PortalEventType[];

// ---------------------------------------------------------------------------
// Cached entities
// ---------------------------------------------------------------------------

/**
 * Closed set of `PortalCachedEntity` types projected by the server's state
 * cache. Local Canopy emits these inside `portal.state.snapshot` and
 * `portal.state.delta` envelopes; the browser portal hydrates its UI from
 * the cached rows.
 */
export type PortalEntityType =
  | 'workspace'
  | 'worktree'
  | 'worktree_summary'
  | 'standalone_chat'
  | 'chat_project'
  | 'chat_summary'
  | 'chat_todo'
  | 'activity_summary'
  | 'terminal_session'
  | 'script_descriptor'
  | 'script_run'
  | 'hook_descriptor'
  | 'hook_run'
  | 'mcp_server'
  | 'watcher'
  | 'background_process'
  | 'plan'
  | 'pipeline'
  | 'pipeline_run'
  | 'changed_files'
  | 'diff_snapshot'
  | 'pr_status'
  | 'file_root'
  | 'file_tree'
  | 'file_preview'
  | 'app_advisor_chat'
  | 'app_advisor_item_groups'
  | 'provider_usage';

/**
 * Frozen runtime list of every supported `PortalEntityType`. Mirrors
 * `PORTAL_COMMAND_TYPES` so cross-repo contract tests can verify entity-type
 * parity element-by-element.
 */
export const PORTAL_ENTITY_TYPES = [
  'workspace',
  'worktree',
  'worktree_summary',
  'standalone_chat',
  'chat_project',
  'chat_summary',
  'chat_todo',
  'activity_summary',
  'terminal_session',
  'script_descriptor',
  'script_run',
  'hook_descriptor',
  'hook_run',
  'mcp_server',
  'watcher',
  'background_process',
  'plan',
  'pipeline',
  'pipeline_run',
  'changed_files',
  'diff_snapshot',
  'pr_status',
  'file_root',
  'file_tree',
  'file_preview',
  'app_advisor_chat',
  'app_advisor_item_groups',
  'provider_usage',
] as const satisfies readonly PortalEntityType[];

export const PORTAL_ENTITY_TYPES_SET: ReadonlySet<string> =
  /*#__PURE__*/ new Set(PORTAL_ENTITY_TYPES);

/**
 * Returns the `parentLocalId` convention for every worktree-child cache entity
 * so its cache identity is workspace-unique even when two workspaces use the
 * same worktree local id.
 */
export function worktreeScopedParentLocalId(
  workspaceLocalId: string,
  worktreeLocalId: string,
): string {
  return `${workspaceLocalId}:${worktreeLocalId}`;
}

/**
 * Reads a worktree id from either the canonical workspace-scoped parent or a
 * legacy bare-worktree parent emitted by older desktop builds. Worktree local
 * ids are validated against `/^[a-z0-9][a-z0-9-]*$/`, so bare ids cannot
 * contain the `:` separator used by composite parents.
 */
export function worktreeLocalIdFromParent(
  parentLocalId: string | null | undefined,
  workspaceLocalId?: string | null,
): string | undefined {
  if (!parentLocalId) return undefined;
  if (workspaceLocalId) {
    const prefix = `${workspaceLocalId}:`;
    if (parentLocalId.startsWith(prefix)) {
      return parentLocalId.slice(prefix.length);
    }
    return parentLocalId.includes(':') ? undefined : parentLocalId;
  }
  const separator = parentLocalId.indexOf(':');
  return separator >= 0 ? parentLocalId.slice(separator + 1) : parentLocalId;
}

/**
 * Wire envelope for a single cached entity. `parentLocalId` lets the cache
 * model parent/child relationships (e.g. a `worktree` rolling up to a
 * `workspace`) without coupling renderers to the local id namespace. For
 * worktree-child cache entities, it is
 * `${workspaceLocalId}:${worktreeLocalId}` (see
 * {@link worktreeScopedParentLocalId}) while local ids stay worktree-scoped.
 */
export interface PortalEntityEnvelope<TPayload = unknown> {
  entityType: PortalEntityType;
  localId: string;
  parentLocalId?: string;
  payload: TPayload;
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

/**
 * Routing hints embedded in a command envelope. Every field is optional; the
 * caller fills in only those that disambiguate the target on the local side.
 *
 * IDs are local Canopy ids (workspace/worktree/etc. local primary keys), not
 * server ids. The local handler is responsible for resolving the
 * (workspace, worktree, ...) tuple to a concrete in-memory subject. File
 * paths are resolved relative to `fileRootLocalId` so the local main process
 * can bound the lookup to allowed roots.
 */
export interface PortalTarget {
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  /** Local id of the standalone chat project that owns `standaloneChatLocalId`. */
  projectLocalId?: string;
  standaloneChatLocalId?: string;
  terminalLocalId?: string;
  scriptLocalId?: string;
  hookLocalId?: string;
  planLocalId?: string;
  pipelineLocalId?: string;
  fileRootLocalId?: string;
  /** Resolved relative to `fileRootLocalId`. */
  filePath?: string;
  /**
   * Local id of an explicitly-selected chat thread. Set by `chat`-scoped
   * state requests when neither the worktree- nor standalone-chat-scoped
   * targets uniquely identify the chat (e.g. multiple chats per worktree).
   */
  chatLocalId?: string;
  /**
   * Optional secondary path used by `files`-scoped state requests to carry
   * both the directory listing path (`filePath`) and the file preview path
   * (`previewPath`) on a single request.
   */
  previewPath?: string;
  /**
   * Optional path used by `diff`-scoped state requests to identify the
   * changed file whose patch should be returned alongside the changed-files
   * summary.
   */
  diffPath?: string;
}

/**
 * Canonical key list for `PortalTarget`. The closed enum lives both as a
 * TypeScript interface (compile-time safety) and a runtime array
 * (cross-repo contract tests). No legacy aliases (`workspaceId`,
 * `worktreeId`, `standaloneChatId`, ...) are permitted — adapters and
 * panels must not need to map between target shapes.
 */
export const PORTAL_TARGET_KEYS = [
  'workspaceLocalId',
  'worktreeLocalId',
  'projectLocalId',
  'standaloneChatLocalId',
  'terminalLocalId',
  'scriptLocalId',
  'hookLocalId',
  'planLocalId',
  'pipelineLocalId',
  'fileRootLocalId',
  'filePath',
  'chatLocalId',
  'previewPath',
  'diffPath',
] as const satisfies readonly (keyof PortalTarget)[];

export type PortalTargetKey = (typeof PORTAL_TARGET_KEYS)[number];

/**
 * Canonical client-side selection target. Use the same `*LocalId` field
 * names that the rest of the Portal already emits (mirrors
 * `PortalSidebarTarget` in the browser shell). The discriminated union keeps
 * empty / workspace / worktree / standalone-chat selection cases distinct so
 * the panels and state-request hooks cannot accidentally mix them.
 *
 * The flat-record {@link PortalTarget} is the routing-hint envelope used on
 * the wire by `PortalCommandEnvelope.target` and
 * `PortalStateRequestPayload.target`. {@link PortalSelectionTarget} is the
 * UI-side companion: panels translate the discriminated union into a flat
 * `PortalTarget` when issuing commands or scoped state requests.
 */
export type PortalSelectionTarget =
  | { kind: 'empty' }
  | { kind: 'workspace'; workspaceLocalId: string }
  | {
      kind: 'worktree';
      workspaceLocalId: string;
      worktreeLocalId: string;
    }
  | {
      kind: 'standalone-chat';
      standaloneChatLocalId: string;
      projectLocalId?: string;
    };

/**
 * Wire shape of a queued command row as returned by the long-poll endpoint.
 *
 * - `id` is the UUID command id (`PortalCommand.externalId`) referenced by
 *   `PortalEventEnvelope.commandId` for completion/failure correlation.
 * - `sequence` is the numeric `PortalCommand.id` cursor used by local Canopy
 *   to long-poll with `?after=<sequence>` and to resume after restart.
 * - `expiresAt` is server-assigned and tells local Canopy when to drop the
 *   command if it has not started executing yet.
 */
export interface PortalCommandEnvelope<TPayload = unknown> {
  id: string;
  sequence: number;
  type: PortalCommandType;
  status?: PortalCommandStatus;
  target?: PortalTarget;
  payload: TPayload;
  createdAt: string;
  expiresAt: string | null;
  /**
   * Server-only provenance of an MCP-originated command. Set only by the
   * trusted hosted adapter, and only for desktops announcing
   * {@link PORTAL_CAPABILITY_COMMAND_ORIGIN}; browser submissions can never
   * carry it. Sender metadata is never copied into `payload`.
   */
  origin?: ExternalAgentSender;
}

/**
 * Wire shape of a single event posted by local Canopy.
 *
 * - `eventId` is generated by local Canopy and used by the server to
 *   deduplicate event inserts via the unique event id for the session
 *   constraint, so retries are safe.
 * - `commandId` MUST be set when the event correlates to a previously queued
 *   command (e.g. `portal.command.completed`, `portal.auth.result`). It MUST
 *   be unset for spontaneous events (e.g. `portal.heartbeat`).
 */
export interface PortalEventEnvelope<TPayload = unknown> {
  type: PortalEventType;
  commandId?: string;
  eventId: string;
  /** Server-assigned row cursor on browser reads; absent on local event posts. */
  cursor?: number;
  clientEventId?: string;
  occurredAt: string;
  payload: TPayload;
}

// ---------------------------------------------------------------------------
// Connection thresholds (used by both UI and backend)
// ---------------------------------------------------------------------------

/**
 * Inclusive upper bound (in milliseconds) on `now - lastSeenAt` for a session
 * to be considered `active`. Above this, the session is `reconnecting`.
 */
export const PORTAL_CONNECTED_MAX_AGE_MS = 30_000;

/**
 * Inclusive upper bound (in milliseconds) on `now - lastSeenAt` for a session
 * to be considered `reconnecting`. Above this, the session is `inactive`.
 */
export const PORTAL_RECONNECTING_MAX_AGE_MS = 90_000;

/**
 * Browser UI debounce: wait this long before showing `reconnecting` after a
 * heartbeat gap, to avoid flicker on transient network blips.
 */
export const PORTAL_UI_RECONNECTING_DEBOUNCE_MS = 3_000;

/**
 * Browser UI debounce: wait this long before showing `inactive`. Pairs
 * with `PORTAL_UI_RECONNECTING_DEBOUNCE_MS`.
 */
export const PORTAL_UI_DISCONNECTED_DEBOUNCE_MS = 5_000;

/**
 * Maximum number of events accepted in a single batch by
 * `POST /api/v1/desktop-app/portal/sessions/[sessionId]/events`. Local Canopy MUST
 * chunk larger batches.
 */
export const PORTAL_EVENT_BATCH_MAX_COUNT = 100;

/**
 * Maximum total payload size (bytes) accepted in a single events batch.
 */
export const PORTAL_EVENT_BATCH_MAX_BYTES = 1_048_576;

/**
 * Maximum long-poll duration (milliseconds) honored by the server for both
 * the local commands long-poll and the browser events long-poll.
 */
export const PORTAL_LONG_POLL_MAX_TIMEOUT_MS = 25_000;

/**
 * Default expiration window applied by `command-service` to non-auth portal
 * commands. The auth command keeps its own (shorter) TTL because the 6-digit
 * code is far more sensitive than the body of a typical command.
 */
export const PORTAL_COMMAND_DEFAULT_EXPIRATION_MS = 60_000;

/**
 * Historical long-RPC result timeout, still used by worktree creates and
 * plugin/marketplace mutations. Workspace clones use the shorter handoff from
 * {@link portalLongRpcResultWaitMs}; pending responses carry their command ID.
 */
export const PORTAL_WORKSPACE_CREATE_RESULT_TIMEOUT_MS =
  PORTAL_LONG_POLL_MAX_TIMEOUT_MS;

/**
 * How long the browser `commands` route blocks waiting for ANY member of
 * {@link PORTAL_LONG_RPC_COMMAND_TYPES} to reach a terminal state before
 * returning `202` with no result. Generalizes
 * {@link PORTAL_WORKSPACE_CREATE_RESULT_TIMEOUT_MS} (kept as the historical
 * name for the same value) to every long-RPC portal command: same
 * timeout-is-not-an-error semantics, same
 * {@link PORTAL_LONG_POLL_MAX_TIMEOUT_MS} infra ceiling.
 */
export const PORTAL_LONG_RPC_RESULT_TIMEOUT_MS =
  PORTAL_WORKSPACE_CREATE_RESULT_TIMEOUT_MS;

/** Web clone handoff bounds the result wait; native clones retain their three-second handoff. */
export const PORTAL_WORKSPACE_CREATE_HANDOFF_WAIT_MS = 1_000;

/** A queued clone may start within this window; expiry does not cancel desktop execution. */
export const PORTAL_WORKSPACE_CREATE_EXPIRATION_MS = 30 * 60_000;

export function portalLongRpcResultWaitMs(type: PortalCommandType): number {
  return type === 'portal.workspace.create'
    ? PORTAL_WORKSPACE_CREATE_HANDOFF_WAIT_MS
    : PORTAL_LONG_RPC_RESULT_TIMEOUT_MS;
}

/**
 * Display/destination name from a remote path, including supported bare/local
 * inputs. Scheme URL userinfo, queries and fragments do not contribute.
 */
export function repositoryNameFromCloneUrl(remoteUrl: string): string {
  const trimmed = normalizeRepositoryCloneUrl(remoteUrl);
  let remotePath = trimmed;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) {
    try {
      remotePath = new URL(trimmed).pathname;
    } catch {
      return 'repository';
    }
  } else if (/^[^/\\]+@[^/\\]+:/.test(trimmed)) {
    remotePath = trimmed.slice(trimmed.indexOf(':') + 1);
  }
  const segment =
    remotePath
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() ?? '';
  return segment.replace(/\.git$/, '') || 'repository';
}

/**
 * Maximum JSON body size (in bytes) the server accepts for a single portal
 * command. Mirrors the events batch ceiling so a hostile or buggy client
 * cannot enqueue a megabyte-scale command.
 */
export const PORTAL_COMMAND_MAX_BODY_BYTES = 1_048_576;

/**
 * Default retention window (in ms) for an `inactive` session before its
 * cached state is purged. Reaching `inactive` itself does not purge; the
 * sweeper checks `endedAt`/`lastSeenAt` against this bound.
 */
export const PORTAL_INACTIVE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Local Canopy ↔ Server HTTP API: API-key routes
// (called by the local Canopy main process)
// ---------------------------------------------------------------------------

/**
 * `POST /api/v1/desktop-app/portal/sessions`
 */
export interface CreatePortalSessionRequest {
  /**
   * Stable identifier for this user's local Canopy install. Used by the server
   * to detect re-pairing from the same device.
   */
  clientDeviceId: string;
  /** Human-friendly device name shown in the browser portal UI. */
  clientName: string;
  clientVersion?: string;
  clientHostname?: string;
  /** Operating system of the host; older desktops omit it. */
  clientPlatform?: PortalClientPlatform;
  /**
   * Optional capability flags announced by local Canopy. Reserved for future
   * gating; the initial server implementation ignores unknown keys.
   */
  capabilities?: Record<string, boolean>;
}

export interface CreatePortalSessionResponse {
  sessionId: string;
  status: 'pending_auth';
  pendingExpiresAt: string;
  /** Initial cursor for the commands long-poll; always `0` on creation. */
  commandCursor: number;
}

/**
 * Session shape returned by the local-side commands long-poll. Mirrors a
 * subset of `PortalSession` columns that local Canopy needs to reconcile its
 * own view of the session.
 */
export interface PortalSessionForLocal {
  id: string;
  status: PortalSessionStatus;
  connectionStatus: PortalConnectionStatus;
  activatedAt: string | null;
  lastSeenAt: string | null;
  endedAt: string | null;
}

/**
 * `POST /api/v1/desktop-app/portal/sessions/[sessionId]/commands`
 *
 * `nextCursor` equals the highest returned `commands[].sequence`, or the input
 * `afterSeq` if `commands` is empty (timeout with no new rows).
 *
 * If the session is inactive the response is
 * `{ session: { status: 'inactive', ... }, commands: [], nextCursor: afterSeq }`.
 */
export interface PollPortalCommandsRequest {
  /** Sequence cursor; only commands with `sequence > afterSeq` are returned. */
  afterSeq: number;
  /** Default 50, hard-capped at 200. */
  maxBatch?: number;
}

export interface PollPortalCommandsResponse {
  session: PortalSessionForLocal;
  commands: PortalCommandEnvelope[];
  nextCursor: number;
}

/**
 * `POST /api/v1/desktop-app/portal/sessions/[sessionId]/events`
 *
 * Events are inserted idempotently by `(sessionId, eventId)`; duplicates
 * are ignored without erroring.
 */
export interface PostPortalEventsRequest {
  events: PortalEventEnvelope[];
}

export interface PostPortalEventsResponse {
  /** Number of events newly inserted on this call. */
  accepted: number;
  /** Number of events skipped because they collided with an existing row. */
  duplicates: number;
  connectionStatus: PortalConnectionStatus;
}

/**
 * `POST /api/v1/desktop-app/portal/sessions/[sessionId]/heartbeat`
 */
/** Operating systems a desktop reports for its Portal session. */
export const PORTAL_CLIENT_PLATFORMS = ['windows', 'mac', 'linux'] as const;
export type PortalClientPlatform = (typeof PORTAL_CLIENT_PLATFORMS)[number];

export interface PortalHeartbeatRequest {
  /** Current packaged build; refreshed on restore instead of key-mint version. */
  clientVersion?: string;
  /** Refreshes capabilities for a session restored by a newer desktop. */
  capabilities?: Record<string, boolean>;
  /** Refreshes the operating system for a session restored by a newer desktop. */
  clientPlatform?: PortalClientPlatform;
}

export interface PortalHeartbeatResponse {
  ok: true;
  status: PortalSessionStatus;
  /** Host code agents use for this device install; older servers omit it. */
  hostCode?: string;
}

/**
 * `POST /api/v1/desktop-app/portal/sessions/[sessionId]/end`
 */
export interface EndPortalSessionResponse {
  ok: true;
}

// ---------------------------------------------------------------------------
// Browser-authenticated routes (called by the Canopy Server portal UI)
// ---------------------------------------------------------------------------

/**
 * Subset of `PortalSession` columns surfaced to the browser portal UI.
 */
export interface PortalSessionForBrowser {
  /** Server-evaluated archive gate. Absent values must be treated as false. */
  destructiveActionsEnabled?: boolean;
  /**
   * Server-evaluated switch for per-space notification choices (CAN-3615).
   * Absent values must be treated as false: the choices stay hidden.
   */
  spaceNotificationSettingsEnabled?: boolean;
  id: string;
  status: PortalSessionStatus;
  connectionStatus: PortalConnectionStatus;
  /**
   * The paired desktop's stable device id, so browser surfaces that also
   * read the cloud-synced inventory (CAN-2830) can tell whether a synced
   * document belongs to THIS desktop before scoping it by this session's
   * workspace selection.
   */
  clientDeviceId: string;
  clientName: string;
  clientVersion: string | null;
  activatedAt: string | null;
  lastSeenAt: string | null;
  /**
   * Capability flags announced by the desktop at session creation, surfaced
   * so browsers can gate newer request shapes such as `worktree_actions`.
   */
  capabilities?: Record<string, boolean>;
}

/**
 * `GET /api/portal/session`
 */
export interface GetBrowserPortalSessionResponse {
  session: PortalSessionForBrowser | null;
}

/**
 * `POST /api/portal/connect`
 *
 * The `code` field MUST match `/^\d{6}$/`. The route handler MUST NOT log the
 * request body and HTTP request/response logging middleware MUST redact this
 * field globally by key name.
 */
export interface ConnectBrowserPortalRequest {
  code: string;
}

export interface ConnectBrowserPortalSuccessResponse {
  sessionId: string;
  status: 'active';
  /**
   * Name of the desktop that accepted the code (its `PortalSession.clientName`),
   * so the browser can confirm which machine it just connected (CAN-2938).
   */
  clientName: string;
}

export interface ConnectBrowserPortalErrorResponse {
  error: string;
}

// `PORTAL_PAIRING_CODE_PATTERN` lives in `./pairing-link` with the QR pairing
// link helpers that share it, and is re-exported at the bottom of this file.

/**
 * `POST /api/portal/sessions/[sessionId]/commands`
 */
export interface SubmitBrowserPortalCommandRequest<TPayload = unknown> {
  type: PortalCommandType;
  target?: PortalTarget;
  payload: TPayload;
}

export const BROWSER_PORTAL_COMMAND_STATUSES = [
  'QUEUED',
  'DELIVERED',
  'COMPLETED',
  'FAILED',
  'EXPIRED',
] as const;
export type BrowserPortalCommandStatus =
  (typeof BROWSER_PORTAL_COMMAND_STATUSES)[number];

/**
 * Response of `GET .../portal/browser/sessions/{sessionId}/commands/{commandId}`.
 * A small-RPC submit waits a bounded time for the desktop completion; when the
 * paired desktop's outbox is saturated the completion can land well after that
 * wait expires. This endpoint lets the browser keep asking for the late result
 * instead of treating the queued submit as a failure.
 */
export interface BrowserPortalCommandStatusResponse {
  /** Delivered work may outlive expiry; only undelivered expiry is retryable. */
  delivered?: boolean;
  commandId: string;
  status: BrowserPortalCommandStatus;
  /** Present once `status` is `COMPLETED` and the desktop returned a payload. */
  result?: Record<string, unknown>;
  /** Present once `status` is `FAILED` or `EXPIRED`; always path-free. */
  error?: string;
}

export interface SubmitBrowserPortalCommandResponse {
  commandId: string;
  /**
   * `true` when the session is `reconnecting` at insert time. The command is
   * queued and will be delivered when local Canopy resumes long-polling.
   */
  queuedWhileReconnecting: boolean;
  /**
   * Present when the command completed during the submit request and local
   * Canopy returned an immediate success payload.
   */
  ok?: boolean;
  /**
   * Returned by chat send commands when local Canopy resolved or created the
   * canonical chat thread id.
   */
  chatId?: string;
  /**
   * Generic completion payload echoed by select small-RPC commands (e.g.
   * `portal.editor.list_slash_commands`, `portal.editor.list_file_mentions`)
   * that need a synchronous response so the UI can populate a typeahead
   * without waiting for an out-of-band event projection.
   */
  result?: Record<string, unknown>;
  /**
   * Generic, path-free failure message echoed by waited commands that reached a
   * terminal `FAILED`/`EXPIRED` state during the submit request (e.g.
   * `portal.workspace.create` when the clone fails). Lets the browser surface an
   * actionable error instead of silently discarding the failure (CAN-1232).
   */
  error?: string;
  /** Coded handled failure for local adapters that can offer a recovery UI. */
  errorCode?: string;
  /** Structured recovery metadata paired with {@link errorCode}. */
  errorDetails?: unknown;
}

/**
 * `GET /api/portal/sessions/[sessionId]/events`
 *
 * Long-polls up to `PORTAL_LONG_POLL_MAX_TIMEOUT_MS` and is the primary source
 * for debounced UI status updates.
 */
export interface PollBrowserPortalEventsQuery {
  after: number;
  timeoutMs?: number;
}

export interface PollBrowserPortalEventsResponse {
  events: PortalEventEnvelope[];
  nextCursor: number;
  connectionStatus: PortalConnectionStatus;
}

/** A completed targeted snapshot seeded exactly these cached rows, in desktop order. */
export interface PortalCachedChatTailCoverage {
  snapshotCursor: number;
  orderedMessageIds: string[];
}

/**
 * `GET /api/portal/sessions/[sessionId]/state`
 *
 * If data is missing/stale and status is `active`/`reconnecting`, the
 * server transparently enqueues `portal.state.request` and returns the cached
 * snapshot with `refreshing: true`. If `inactive`/`ended`, returns cached
 * data with `refreshing: false`.
 */
export interface GetBrowserPortalStateResponse<
  TState = PortalSessionShellState,
> {
  state: TState;
  chatTailCoverage?: PortalCachedChatTailCoverage;
  scope?: PortalStateScope;
  snapshot?: unknown;
  connectionStatus: PortalConnectionStatus;
  refreshing: boolean;
  /**
   * True only while the server has no projected snapshot to hydrate. This is
   * distinct from `refreshing`, which can also describe background
   * reconciliation of a valid (including legitimately empty) snapshot.
   */
  projectionPending?: boolean;
  /**
   * Highest persisted event id at the time this state was read. The browser
   * hands this to the event poller as its initial cursor so live long-polling
   * resumes *after* the hydrated snapshot instead of replaying the whole
   * session event history over freshly-hydrated state (regression B1/B2).
   * Optional for backward compatibility with older servers.
   */
  eventCursor?: number;
}

/**
 * `POST /api/portal/sessions/[sessionId]/end`
 */
export interface EndBrowserPortalSessionResponse {
  ok: true;
}

// ---------------------------------------------------------------------------
// Auth fan-out / correlation contract
// ---------------------------------------------------------------------------

/**
 * Payload for a `portal.auth.validate_code` command. A single
 * `POST /api/portal/connect` call may fan out one of these per pending session
 * for the user; every command in a fan-out shares the same `attemptExternalId`
 * so the waiting browser handler can filter for the corresponding result.
 */
export interface PortalAuthValidateCodePayload {
  code: string;
  attemptExternalId: string;
}

/**
 * Payload for a `portal.auth.result` event. The local handler MUST set
 * `commandId` on the envelope to the validate command's `externalId` (i.e.
 * `PortalCommandEnvelope.id`).
 */
export interface PortalAuthResultPayload {
  approved: boolean;
  attemptExternalId: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Command payload contracts (wire-only mirrors of the local IPC requests)
//
// The wire shapes are intentionally lax (`Record<string, unknown>` style) so
// the server-side adapters can hand the payload through to the local
// handlers without re-validating every individual IPC request shape — local
// Canopy already owns those validators. The server MUST reject the closed
// `PortalCommandType` enum and the body-size cap (see command-service.ts);
// per-payload field validation is delegated to local Canopy.
// ---------------------------------------------------------------------------

/** No-op payload reserved for future fields; tolerated as `{}` on the wire. */
export interface PortalSessionEndPayload {
  reason?: 'local_disconnect' | 'replaced' | 'server_disconnect';
}

/**
 * Scope of a `portal.state.request`. `overview` returns the top-level shell
 * (workspaces, worktrees, running activity); the remaining scopes return a
 * single subtree keyed by the matching `PortalTarget` field, except the
 * batched untargeted scopes: `worktree_actions` contains scripts and
 * pipelines entities for every worktree across all workspaces (CAN-1602),
 * and `worktree_chat_summaries` contains chat_summary entities for every
 * worktree across all workspaces (CAN-1990 sidebar chat search). App Advisor
 * accepts an optional `target.chatLocalId` projection hint so the desktop can
 * hydrate the selected transcript without scanning inactive histories; an
 * untargeted request remains authoritative for the whole tab collection.
 */
export type PortalStateScope =
  | 'overview'
  | 'workspace'
  | 'worktree'
  | 'standalone_chat'
  | 'chat'
  | 'terminal'
  | 'scripts'
  | 'hooks'
  | 'plans'
  | 'pipelines'
  | 'worktree_actions'
  | 'worktree_chat_summaries'
  | 'diff'
  | 'pr'
  | 'files'
  | 'app_advisor';

/** Desktop supports selected-only foreground hydration using the chat scope. */
export const PORTAL_CAPABILITY_FOREGROUND_WORKTREE_CHAT =
  'foreground_worktree_chat' as const;

/** Desktop supports revision-checked read acknowledgements (CAN-2809). */
export const PORTAL_CAPABILITY_CHAT_MARK_READ = 'chat_mark_read' as const;

/** Acknowledge the latest displayed message; a stale acknowledgement is a no-op. */
export type PortalChatMarkReadPayload = {
  chatId: string;
  /** Null acknowledges a chat with no displayable transcript messages. */
  lastMessageId: string | null;
} & (
  | { scope: 'worktree'; projectId: string; worktreeId: string }
  | { scope: 'standalone'; projectLocalId: string }
);

/** Desktop supports explicit mark unread / mark read from a chat tab (CAN-4378). */
export const PORTAL_CAPABILITY_CHAT_SET_UNREAD = 'chat_set_unread' as const;

/**
 * Set a chat's read state at the user's request. Unread marks are recorded as
 * manual; there is no staleness guard because the user chose the state.
 */
export type PortalChatSetUnreadPayload = {
  chatId: string;
  unread: boolean;
} & (
  | { scope: 'worktree'; projectId: string; worktreeId: string }
  | { scope: 'standalone'; projectLocalId: string }
);

/** Capability for the batched, untargeted worktree_actions state scope. */
export const PORTAL_CAPABILITY_WORKTREE_ACTIONS_SCOPE =
  'worktree_actions_scope' as const;

/**
 * Capability for the batched, untargeted `worktree_chat_summaries` state
 * scope (CAN-1990). Browsers gate the sidebar chat-search hydration request
 * on this flag; older desktops without it simply never receive the request.
 */
export const PORTAL_CAPABILITY_WORKTREE_CHAT_SUMMARIES_SCOPE =
  'worktree_chat_summaries_scope' as const;

/**
 * Capability for the strict sidebar Activity inventory (CAN-390): the desktop
 * honors `includeChatSummaries` on `worktree_chat_summaries` state requests,
 * rejecting rather than degrading a partial list, and projects
 * `lastMessageRole`. Older desktops announce only the scope and would
 * silently ignore the flag, so browsers gate Activity on this instead.
 */
export const PORTAL_CAPABILITY_SIDEBAR_ACTIVITY_INVENTORY =
  'sidebar_activity_inventory' as const;

/**
 * Capability for the App Advisor remote-view surface (CAN-2562). Desktops
 * announce it once they ship the `portal.app_advisor.*` adapter; browsers
 * gate the App Advisor overlay trigger on it so older desktops never receive
 * commands they cannot execute.
 */
export const PORTAL_CAPABILITY_APP_ADVISOR = 'app_advisor' as const;

/**
 * Capability for retained worktree archive/delete semantics. Desktops announce
 * it once archive commands honor the requested retention mode and workspace
 * snapshots expose the resolved deletion-retention window.
 */
export const PORTAL_CAPABILITY_WORKTREE_RETENTION =
  'worktree_retention' as const;

/**
 * Capability for the portal Plugins-section mutation commands (phase B of
 * docs/planning/2026-08-27-portal-plugins-section/design.md). Desktops
 * announce it once they ship the plugin/marketplace/MCP mutation adapters;
 * browsers gate the mutation controls on it so older desktops never receive
 * commands they cannot execute.
 */
export const PORTAL_CAPABILITY_PLUGIN_MUTATIONS = 'plugin_mutations' as const;

/** Read-only plugin share preflight and canonical existing-share link fields. */
export const PORTAL_CAPABILITY_PLUGIN_SHARE_PREFLIGHT =
  'plugin_share_preflight_v1' as const;
/**
 * Desktop serves `portal.installed_items.*` (CAN-4255). Pairing and the
 * generic {@link PORTAL_CAPABILITY_PLUGIN_MUTATIONS} do not imply it.
 */
export const PORTAL_CAPABILITY_INSTALLED_ITEMS = 'installed_items_v1' as const;
/**
 * Desktop serves `portal.collections.save` (CAN-4847): create, edit and
 * duplicate collections from the Portal. Older desktops lack it, so browsers
 * hide those controls rather than send an unknown command.
 */
export const PORTAL_CAPABILITY_COLLECTION_MUTATIONS =
  'collection_mutations_v1' as const;
/** Revision-guarded shared updates, independent of local collection editing. */
export const PORTAL_CAPABILITY_COLLECTION_UPDATES =
  'collection_updates_v1' as const;
/** Desktop serves `portal.worktree.discard.describe` and `.discard` (CAN-5334). */
export const PORTAL_CAPABILITY_WORKTREE_DISCARD =
  'worktree_discard_v1' as const;
/**
 * Desktop serves `portal.workspace.delete.discard.describe` and honors
 * `supersedeInterruptedDeletion` on `portal.workspace.delete` (CAN-5337).
 * {@link PORTAL_CAPABILITY_WORKTREE_DISCARD} does not imply it.
 */
export const PORTAL_CAPABILITY_PROJECT_DELETION_DISCARD =
  'project_deletion_discard_v1' as const;
/** Cached MCP health and device test/delete operations (CAN-4265). */
export const PORTAL_CAPABILITY_MCP_MANAGEMENT = 'mcp_management' as const;

/** Desktop can fetch and import a hash-pinned curated pipeline into its user library. */
export const PORTAL_CAPABILITY_CURATED_PIPELINE_IMPORT =
  'curated_pipeline_import' as const;

/**
 * Capability for the portal workspace-items read commands. Desktops
 * announce it once they ship the workspace-items adapter; browsers gate
 * workspace-items data fetches on it so older desktops never receive
 * commands they cannot execute.
 */
export const PORTAL_CAPABILITY_WORKSPACE_ITEMS = 'workspace_items' as const;

/**
 * Capability for phone/browser-originated chat attachments on a paired
 * desktop. Desktops announce it once they materialize
 * `PortalChatSendPayload.cloudAttachments` into local files; clients gate
 * the attach control on it so older desktops never receive refs they would
 * silently drop.
 */
export const PORTAL_CAPABILITY_CHAT_ATTACHMENTS = 'chat_attachments' as const;

export const PORTAL_CAPABILITY_CHAT_ASSETS = 'chat_assets_v1' as const;

/**
 * Capability for the standalone (Cowork) chat create handshake. Desktops
 * announce it together with `portal.standalone_chat.create`, and only they
 * accept attachments and file references on `portal.standalone_chat.send`,
 * which require a chat that already exists. Clients create a new standalone
 * chat with that command before staging attachments, and enable standalone
 * attachments only when this is announced. Without it, clients send text
 * through the older first-send path, where the desktop creates the chat
 * itself. `chat_attachments` predates the handshake and does not imply it.
 */
export const PORTAL_CAPABILITY_STANDALONE_CHAT_CREATE =
  'standalone_chat_create' as const;

/**
 * `portal.worktree.create` accepts `existingBranch`, `baseBranch`,
 * `pullRequest`, `sidebarItemGroupName` and `firstChat`, and completes with
 * {@link PortalWorktreeCreateResult}.
 */
export const PORTAL_CAPABILITY_WORKTREE_CREATE_FROM =
  'worktree_create_from_v1' as const;

/**
 * `portal.work_entry.update` and `portal.work_entry.delete`, and
 * `workEntryId`, `sidebarItemGroupName` and `firstChat` on
 * `portal.standalone_chat.create`.
 */
export const PORTAL_CAPABILITY_WORK_ENTRY_COMMANDS =
  'work_entry_commands_v1' as const;

/** `portal.sidebar.item_groups.assign_named`. */
export const PORTAL_CAPABILITY_SIDEBAR_ITEM_GROUP_NAMES =
  'sidebar_item_group_names_v1' as const;

/** `portal.task_refs.list`. */
export const PORTAL_CAPABILITY_TASK_REFS = 'task_refs_v1' as const;

/**
 * Workspace entities carry `repositoryIdentity`, and `portal.worktree.create`
 * accepts `pullRequest.repository`, which the host checks against its root
 * repository's current `origin` before creating.
 */
export const PORTAL_CAPABILITY_PROJECT_REPOSITORY_IDENTITY =
  'project_repository_identity_v1' as const;

/**
 * A project's GitHub repository, lowercased. Never a URL, remote name or
 * path; for a multi-repo project it names the root repository.
 */
export interface PortalRepositoryIdentity {
  owner: string;
  repo: string;
}

/** The validated identity, or undefined for anything malformed. */
export function parsePortalRepositoryIdentity(
  value: unknown,
): PortalRepositoryIdentity | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return (
    normalizeGitHubRepositoryIdentity(
      Reflect.get(value, 'owner'),
      Reflect.get(value, 'repo'),
    ) ?? undefined
  );
}

/**
 * Capability for New Task settings on `portal.chat.create_tab`. Desktops
 * announce it once create_tab applies the submitted `model`, `providerType`
 * and `pluginSelections`, and the canonical `portal.chat.send` keeps
 * `modelSelectionMode: 'auto'`. Clients create a remote Code New Task chat
 * with create_tab and send to it only when this is announced. Older desktops
 * ignore those create_tab fields and seed their default model, so clients send
 * the first message without a `chatId` instead, where the desktop creates the
 * chat with the settings the send carries.
 */
export const PORTAL_CAPABILITY_CHAT_CREATE_TAB_SETTINGS =
  'chat_create_tab_settings' as const;

/** Paired desktop accepts an exact app-owned plan review with a message. */
export const PORTAL_CAPABILITY_CHAT_PLAN_REVIEW =
  'chat_plan_review_v1' as const;

export interface PortalChatPlanReview extends ChatPlanReviewApproval {
  source: 'opencode';
}

/** Desktop accepts and validates the server-only command `origin`. */
export const PORTAL_CAPABILITY_COMMAND_ORIGIN = 'command_origin' as const;

/** Desktop handles `portal.chat.cancel_turn` (exact-turn cancel). */
export const PORTAL_CAPABILITY_CHAT_CANCEL_TURN = 'chat_cancel_turn' as const;

export const PORTAL_ASSET_CHUNK_BYTES = 192 * 1024;
export const PORTAL_ASSET_MAX_BYTES = 100 * 1024 * 1024;

export interface PortalAssetReadRange {
  offset?: number;
  version?: string;
}

export interface PortalChatAssetReadPayload extends PortalAssetReadRange {
  projectId: string;
  worktreeId: string;
  chatId: string;
  assetId: string;
  scope?: 'worktree' | 'standalone';
  projectLocalId?: string;
}

export interface PortalFileAssetReadPayload
  extends PortalFileReadPayload, PortalAssetReadRange {}

export interface PortalAssetReadResult {
  assetId: string;
  filename: string;
  mediaType: string;
  size: number;
  version: string;
  offset: number;
  dataBase64: string;
  contentSha256: string;
  nextOffset: number | null;
}

export function portalChatAssetId(
  messageId: string,
  kind: 'attachment' | 'image',
  index: number,
): string {
  return `asset-${encodeURIComponent(messageId)}-${kind}-${index}`;
}

/**
 * Capability for agent visuals in Portal chats (chat visuals phase 07).
 * Desktops announce it exactly when they serve `portal.chat.visual.read`;
 * clients render the visual only for those, and older desktops keep the
 * ShowVisual tool row.
 */
export const PORTAL_CAPABILITY_CHAT_VISUALS = 'chat_visuals' as const;

/**
 * Raw bytes per `portal.chat.visual.read` page. A multiple of 3, so a full
 * page is exactly 512,000 base64 characters with no padding, and one
 * completion stays under 512 KiB, the desktop's batch target, and the 1 MiB
 * events POST cap. A 4 MiB visual is 11 pages.
 */
export const PORTAL_CHAT_VISUAL_PAGE_BYTES = 384_000;

/**
 * Commands only the web server may enqueue. Browsers never send them through
 * the generic command routes; visual pages, for example, reach a browser only
 * as inert bytes from the visual route, which clears each page after reading.
 */
export const PORTAL_SERVER_ONLY_COMMAND_TYPES: ReadonlySet<PortalCommandType> =
  new Set<PortalCommandType>([
    'portal.auth.validate_code',
    'portal.chat.visual.read',
  ]);

/**
 * The promoted visual reference a Portal `tool_result` part carries as
 * `data.visual`. Mirrors `core.chat.visual.read@1`'s reference, which the
 * desktop requires in full, so a read can be built from the part alone.
 */
export interface PortalChatVisualReference {
  version: 1;
  visualId: string;
  artifactId: string;
  byteLength: number;
  sha256: string;
  mediaType: 'text/html';
  title: string;
  maxHeight: number;
  heights?: ReadonlyArray<readonly [number, number]>;
}

/**
 * Read one raw byte range of a promoted visual from the paired desktop. Only
 * the web visual route enqueues it ({@link PORTAL_SERVER_ONLY_COMMAND_TYPES});
 * the desktop resolves the chat, its archive state, and authority itself.
 */
export type PortalChatVisualReadPayload = {
  chatId: string;
  /** The message holding the visual's `tool_result` block. */
  messageId: string;
  toolUseId: string;
  reference: PortalChatVisualReference;
  /** Raw byte offset, from 0; never a character position. */
  offset: number;
  /** At most {@link PORTAL_CHAT_VISUAL_PAGE_BYTES}. */
  limit: number;
  /** Server-issued read identity, shared by every page of one visual load. */
  read: { id: string; pageCount: number };
} & (
  | { scope: 'worktree'; projectId: string; worktreeId: string }
  | { scope: 'standalone'; projectLocalId: string }
);

/**
 * One page of a visual read. `data` is the base64 of exactly `length` raw
 * bytes starting at `offset`; `byteLength` and `sha256` are the whole
 * document's. The planned object-storage transport adds a reserved
 * `{ kind: 'object', ... }` variant (chat visuals design, "Planned path to
 * object storage"); consumers must fail closed on any other `kind`.
 */
export interface PortalChatVisualReadResult {
  kind: 'inline-page';
  data: string;
  offset: number;
  length: number;
  byteLength: number;
  sha256: string;
}

const PORTAL_VISUAL_ID_PATTERN =
  /^vis_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PORTAL_VISUAL_SHA256_PATTERN = /^[0-9a-f]{64}$/;
// The same limits as `core.chat.visual.read@1`; a contract test keeps the
// guard and the core schema in agreement.
const PORTAL_VISUAL_MAX_BYTES = 4 * 1024 * 1024;
const PORTAL_VISUAL_TITLE_MAX_LENGTH = 120;
const PORTAL_VISUAL_MIN_HEIGHT = 80;
const PORTAL_VISUAL_MAX_HEIGHT = 2000;
const PORTAL_VISUAL_HEIGHTS_MAX_ENTRIES = 32;
const PORTAL_VISUAL_REFERENCE_KEYS: ReadonlySet<string> = new Set([
  'version',
  'visualId',
  'artifactId',
  'byteLength',
  'sha256',
  'mediaType',
  'title',
  'maxHeight',
  'heights',
]);

function isPortalVisualRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPortalVisualHeightPair(
  value: unknown,
): value is readonly [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every(
      (item: unknown) =>
        typeof item === 'number' && Number.isFinite(item) && item > 0,
    )
  );
}

/**
 * The complete visual reference on a Portal `tool_result` part, or null for
 * any other part, an older part, or a malformed or partial reference.
 */
export function readPortalChatPartVisual(
  part: PortalChatPart,
): PortalChatVisualReference | null {
  if (part.kind !== 'tool_result' || !isPortalVisualRecord(part.data)) {
    return null;
  }
  const visual = part.data.visual;
  if (!isPortalVisualRecord(visual)) return null;
  if (Object.keys(visual).some((key) => !PORTAL_VISUAL_REFERENCE_KEYS.has(key)))
    return null;
  const {
    version,
    visualId,
    artifactId,
    byteLength,
    sha256,
    mediaType,
    title,
    maxHeight,
    heights,
  } = visual;
  if (
    version !== 1 ||
    typeof visualId !== 'string' ||
    !PORTAL_VISUAL_ID_PATTERN.test(visualId) ||
    typeof artifactId !== 'string' ||
    artifactId.length === 0 ||
    typeof byteLength !== 'number' ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    byteLength > PORTAL_VISUAL_MAX_BYTES ||
    typeof sha256 !== 'string' ||
    !PORTAL_VISUAL_SHA256_PATTERN.test(sha256) ||
    mediaType !== 'text/html' ||
    typeof title !== 'string' ||
    title.length === 0 ||
    title.length > PORTAL_VISUAL_TITLE_MAX_LENGTH ||
    typeof maxHeight !== 'number' ||
    !Number.isInteger(maxHeight) ||
    maxHeight < PORTAL_VISUAL_MIN_HEIGHT ||
    maxHeight > PORTAL_VISUAL_MAX_HEIGHT
  ) {
    return null;
  }
  const reference: PortalChatVisualReference = {
    version,
    visualId,
    artifactId,
    byteLength,
    sha256,
    mediaType,
    title,
    maxHeight,
  };
  if (heights === undefined) return reference;
  if (
    !Array.isArray(heights) ||
    heights.length > PORTAL_VISUAL_HEIGHTS_MAX_ENTRIES ||
    !heights.every(isPortalVisualHeightPair)
  ) {
    return null;
  }
  return { ...reference, heights };
}

/**
 * Capability for dispatching pipelines from a phone or browser (CAN-3174).
 * Desktops announce it once `portal.pipeline.get` carries the dispatch
 * trigger's inputs and resolves bundled and user pipelines; clients gate the
 * Run action on it so an older desktop is never asked for a form it cannot
 * describe.
 */
export const PORTAL_CAPABILITY_PIPELINE_DISPATCH = 'pipeline_dispatch' as const;

/**
 * Capability for chat turn links on `pipeline_run` entities (CAN-3619).
 * Desktops announce it once every projected run carries
 * {@link PortalPipelineRun.chatTurns}, attributed by the same rules as the
 * desktop transcript's Agent activity panel. Clients show inline chat run
 * panels only when it is announced; older desktops keep runs reachable from
 * the worktree's run list.
 */
export const PORTAL_CAPABILITY_PIPELINE_RUN_CHAT_LINKS =
  'pipeline_run_chat_links' as const;

/**
 * Capability for a manual chat follow-up from a run's saved plan or report
 * (CAN-3719). Desktops announce it once every projected run carries
 * {@link PortalPipelineRun.chatFollowUp} and
 * `portal.pipeline.chat_follow_up.prepare` is handled. Clients offer the
 * action only when it is announced.
 */
export const PORTAL_CAPABILITY_PIPELINE_CHAT_FOLLOW_UP =
  'pipeline_chat_follow_up' as const;

/**
 * Capability for complete pipeline content reads (CAN-3717). Desktops
 * announce it once `portal.pipeline.content.read` handles a step's readable
 * output and the run's saved report. Without it clients keep the streamed
 * step tail and never present it as the complete output.
 */
export const PORTAL_CAPABILITY_PIPELINE_CONTENT = 'pipeline_content' as const;

/**
 * Capability for the account-level Claude and Codex plan usage projection
 * (CAN-3635). Desktops announce it once overview snapshots carry the
 * `provider_usage` singleton, usage changes publish it as a delta, and
 * `portal.provider_usage.refresh` is handled. Absent or false means the
 * client treats plan usage as unavailable.
 */
export const PORTAL_CAPABILITY_PROVIDER_USAGE = 'provider_usage' as const;

/** Plugin selections and deferred-loading policy share one durable chat commit. */
export const PORTAL_CAPABILITY_DEFERRED_PLUGIN_POLICY =
  'deferred_plugin_policy' as const;

/**
 * Capability for the invocable inventory commands (CAN-3923):
 * `portal.editor.list_invocables`, `portal.editor.resolve_invocable` and
 * `portal.standalone_chat.set_plugin_selections`. Desktops announce it only
 * when all three are handled; clients without it keep the discovery-only
 * `portal.editor.list_slash_commands` fallback.
 */
export const PORTAL_CAPABILITY_INVOCABLE_INVENTORY =
  'invocable_inventory' as const;

/**
 * Canonical name used by the transport plan and the local snapshot builders.
 * Aliased onto {@link PortalStateScope} so existing call sites that import
 * the older name keep working while new call sites read the union under its
 * plan-friendly name.
 */
export type PortalSnapshotScope = PortalStateScope;

/**
 * Frozen runtime list of every supported `PortalSnapshotScope`. Mirrors the
 * union so cross-repo contract tests can compare scope coverage
 * element-by-element.
 */
export const PORTAL_SNAPSHOT_SCOPES = [
  'overview',
  'workspace',
  'worktree',
  'standalone_chat',
  'chat',
  'terminal',
  'scripts',
  'hooks',
  'plans',
  'pipelines',
  'worktree_actions',
  'worktree_chat_summaries',
  'diff',
  'pr',
  'files',
  'app_advisor',
] as const satisfies readonly PortalSnapshotScope[];

export const PORTAL_SNAPSHOT_SCOPES_SET: ReadonlySet<string> =
  /*#__PURE__*/ new Set(PORTAL_SNAPSHOT_SCOPES);

// ---------------------------------------------------------------------------
// Snapshot scope replacement sets (transport plan Phase T5)
//
// Each list enumerates the entity types the matching snapshot scope
// replaces atomically when its `portal.state.snapshot` lands. Both repos
// MUST agree on which entity types belong in which scope's set, so the
// cross-repo contract tests pin these arrays element-by-element.
//
// Important: `chat_message` is not a `PortalEntityType` (chat messages
// live in their own table, not the cached entity store) — it is therefore
// absent from every list below. Chat messages are replaced atomically by
// the `chat` feature scope and updated incrementally by `portal.chat.event`
// frames; a `worktree` snapshot MUST NOT delete cached chat rows.
// ---------------------------------------------------------------------------

/**
 * Entity types replaced by a `worktree`-scoped snapshot. Documented in
 * transport plan Phase T5.2.
 */
export const WORKTREE_SCOPE_ENTITY_TYPES = [
  'worktree',
  'worktree_summary',
  'chat_summary',
  'chat_todo',
  'changed_files',
  'pr_status',
  'terminal_session',
  'script_descriptor',
  'script_run',
  'hook_descriptor',
  'hook_run',
  'mcp_server',
  'watcher',
  'background_process',
  'plan',
  'pipeline',
  'pipeline_run',
  'file_root',
] as const satisfies readonly PortalEntityType[];

/**
 * Entity types replaced by an `overview`-scoped snapshot (transport plan
 * Phase T5.3). The overview shell carries top-level workspaces, worktrees,
 * standalone chats, the recent-activity summary row, and the account-level
 * `provider_usage` singleton. Worktree chat summaries are owned by targeted
 * worktree/chat snapshots.
 */
export const OVERVIEW_SCOPE_ENTITY_TYPES = [
  'workspace',
  'worktree',
  'standalone_chat',
  'activity_summary',
  'provider_usage',
] as const satisfies readonly PortalEntityType[];

/**
 * Entity types replaced by a `workspace`-scoped snapshot (transport plan
 * Phase T5.3). Carries the selected workspace, its worktrees, and the
 * lightweight per-workspace activity summary entity.
 */
export const WORKSPACE_SCOPE_ENTITY_TYPES = [
  'workspace',
  'worktree',
  'activity_summary',
] as const satisfies readonly PortalEntityType[];

/**
 * Entity types replaced by a `standalone_chat`-scoped snapshot
 * (transport plan Phase T5.3).
 */
export const STANDALONE_CHAT_SCOPE_ENTITY_TYPES = [
  'standalone_chat',
  'chat_summary',
] as const satisfies readonly PortalEntityType[];

/**
 * Per-feature scope replacement sets (transport plan Phase T5.3). Each
 * feature scope replaces only the entity types belonging to that feature
 * for the selected target — not the surrounding worktree shell.
 */
export const PORTAL_FEATURE_SCOPE_ENTITY_TYPES = {
  chat: ['chat_summary', 'chat_todo', 'watcher'] as const,
  terminal: ['terminal_session'] as const,
  scripts: ['script_descriptor', 'script_run'] as const,
  hooks: ['hook_descriptor', 'hook_run'] as const,
  plans: ['plan'] as const,
  pipelines: ['pipeline', 'pipeline_run'] as const,
  files: ['file_root', 'file_tree', 'file_preview'] as const,
  diff: ['changed_files', 'diff_snapshot'] as const,
  pr: ['pr_status'] as const,
  app_advisor: [
    'app_advisor_chat',
    'app_advisor_item_groups',
    'watcher',
  ] as const,
} satisfies Record<
  Exclude<
    PortalSnapshotScope,
    | 'overview'
    | 'workspace'
    | 'worktree'
    | 'standalone_chat'
    | 'worktree_actions'
    | 'worktree_chat_summaries'
  >,
  readonly PortalEntityType[]
>;

/** Replacement set for a batched `worktree_actions` snapshot. */
export const WORKTREE_ACTIONS_SCOPE_ENTITY_TYPES = [
  ...PORTAL_FEATURE_SCOPE_ENTITY_TYPES.scripts,
  ...PORTAL_FEATURE_SCOPE_ENTITY_TYPES.pipelines,
] as const satisfies readonly PortalEntityType[];

/**
 * Replacement set for a batched `worktree_chat_summaries` snapshot
 * (CAN-1990). The snapshot is authoritative for WORKTREE-scoped chat
 * summaries only: both cache layers must preserve standalone-scope
 * `chat_summary` rows (payload `scope: 'standalone'`), which are owned by
 * `standalone_chat` snapshots and live deltas.
 */
export const WORKTREE_CHAT_SUMMARIES_SCOPE_ENTITY_TYPES = [
  'chat_summary',
] as const satisfies readonly PortalEntityType[];

export interface PortalStateRequestPayload {
  /** On overview or worktree_chat_summaries, return complete visible chat
   * summaries or reject. Omitted requests keep the existing batch behavior.
   */
  includeChatSummaries?: boolean;
  /**
   * Requires foreground_worktree_chat. On the chat scope, hydrate only the
   * explicit chatLocalId, otherwise the active tab (falling back to the first).
   * The response echoes the resolved target and the authoritative tab list.
   * Omit on older hosts; their untargeted chat scope still seeds all histories.
   */
  selectedChatOnly?: boolean;
  /** Request the next changed-files page for the explicit diff target. */
  changedFilesPage?: {
    group: PortalChangedFilesGroup;
    cursor: string;
    limit?: number;
  };
  scope: PortalStateScope;
  target?: PortalTarget;
  /** When true, force a refresh even if a cached snapshot is still warm. */
  refresh?: boolean;
}

export interface PortalStateSnapshotPayload {
  /** This overview replaces all worktree chat summaries, including removals. */
  chatSummariesComplete?: true;
  /** Foreground chat head authoritatively replaces this worktree's tab list. */
  selectedChatOnly?: boolean;
  scope: PortalStateScope;
  target?: PortalTarget;
  entities: PortalEntityEnvelope[];
  /**
   * Current portal view mode selected by the browser. Desktop snapshots include
   * this so the server cache can rehydrate the browser shell after a reload.
   */
  viewMode?: PortalViewMode;
  /**
   * Top-level array carrying canonical chat messages bundled into the
   * snapshot. When present, server ingestion replaces the chat-table slice
   * for the snapshot's scope/target tuple in the same transaction as the
   * entity replacement (see Phase T14 of the transport plan). When omitted,
   * server ingestion leaves cached `PortalChatMessage` rows untouched —
   * snapshots that do not carry chat data (e.g. `overview`) MUST omit this
   * field rather than send an empty array.
   */
  chatMessages?: PortalChatMessage[];
  /**
   * True when `chatMessages` is only a bounded tail of the desktop transcript.
   * Cache ingestion must not prune older rows when this is set.
   */
  chatMessagesTruncated?: boolean;
  generatedAt: string;
}

/**
 * Reference to a single entity that should be evicted from the cache by a
 * `portal.state.delta` event. `entityType` + `parentLocalId` + `localId` form
 * the cache key. A removal without `parentLocalId` evicts matching rows under
 * any parent.
 */
export interface PortalEntityRemoval {
  entityType: PortalEntityType;
  localId: string;
  parentLocalId?: string;
}

/** Terminal failure from deferred Git setup for an accepted worktree create. */
export interface PortalWorktreeSetupFailure {
  workspaceLocalId: string;
  worktreeLocalId: string;
  error: string;
}

/**
 * Wire shape of a `portal.state.delta` event.
 *
 * Unlike `portal.state.snapshot` (which is an authoritative scoped
 * replacement), a delta is a partial mutation:
 *
 * - `entities` upserts the matching cache rows (by `entityType` +
 *   `parentLocalId` + `localId`), preserving rows not mentioned.
 * - `removed` deletes the referenced row by the same key, or matching rows
 *   under any parent when `parentLocalId` is absent.
 *
 * When both `entities` and `removed` are absent or empty, the projection
 * layer treats the event as a no-op (debug-log only): it does NOT bump
 * `generatedAt` on cached rows and does NOT throw. This shape is
 * intentionally distinct from `PortalStateSnapshotPayload` — the previous
 * alias of delta-to-snapshot left deletion semantics undefined and is no
 * longer permitted.
 */
export interface PortalStateDeltaPayload {
  scope: PortalStateScope;
  target?: PortalTarget;
  entities?: PortalEntityEnvelope[];
  removed?: PortalEntityRemoval[];
  /**
   * Explicit terminal signal for deferred setup failures. This remains
   * present even when a multi-repo rollback removes the reserved worktree.
   */
  worktreeSetupFailure?: PortalWorktreeSetupFailure;
  generatedAt: string;
}

// Chat

/**
 * Wire-side mirror of canopy's `FileReference` (transport plan §1.7). The
 * server does not import canopy renderer types, so the relevant fields are
 * mirrored here verbatim. `repoName` is optional so single-repo workspaces
 * can omit it.
 */
export interface PortalChatFileReference {
  displayPath: string;
  referenceId: string;
  repoName?: string;
  /**
   * Opaque host-defined mention kind (mirrors `FileReference.kind`). The
   * desktop uses `'prompt'` to mark a prompt pill that must be expanded into
   * the outgoing text at send time.
   */
  kind?: string;
  /** Start offset of the pill in the accompanying serialized text. */
  textStart?: number;
}

/**
 * Wire-side mirror of canopy's `ChatTabPluginSelections` (transport plan
 * §1.7). Server adapters forward the structure verbatim to local Canopy;
 * per-field validation lives on the local side.
 *
 * After the Bundles → Collections rename, the canonical field is
 * `collectionIds`. The legacy `bundleIds` field is preserved as an optional,
 * deprecated read-side alias so older portal clients can still forward
 * pre-migration selections without breaking the wire.
 */
export interface PortalChatTabPluginSelections {
  /** Catalog selections awaiting installation/auth; never runtime filesystem refs. */
  unresolvedCapabilities?: TryItCapability[];
  collectionIds: string[];
  /**
   * @deprecated Forwarded for read-side migration only. New portal payloads
   * must emit `collectionIds`; receivers merge any `bundleIds` into
   * `collectionIds` via canopy's `normalizePluginSelections` helper.
   */
  bundleIds?: string[];
  skillRefs: { sourceId: string; skillName: string }[];
  pluginRefs: { marketplaceId: string; pluginName: string }[];
  mcpServerRefs?: { serverId: string; configId: string }[];
  mcpHttpAuthPreferences?: Array<{
    target:
      | { kind: 'standalone'; serverId: string; configId: string }
      | {
          kind: 'plugin';
          marketplaceId: string;
          pluginName: string;
          serverName: string;
        };
    handler: McpHttpAuthHandler;
  }>;
}

/** Canonical thinking level carried by the Portal wire contract. */
export type PortalChatThinkingLevel = ThinkingLevel;

/** Composer setting accepted by hosts that support clearing an override. */
export type PortalChatThinkingSetting = ThinkingSetting;

/**
 * Wire-side mirror of canopy's `ChatModel` alias (transport plan §1.7).
 * Currently a free-form string keyed by the runtime model registry.
 */
export type PortalChatModel = string;

/**
 * Wire-side mirror of canopy's `AgentProviderType` (transport plan §1.7).
 */
export type PortalChatAgentProviderType =
  | 'claude'
  | 'codex'
  | 'ollama'
  | 'cursor'
  | 'opencode'
  | 'copilot';

export interface PortalAgentModelConfig {
  thinkingLevel?: PortalChatThinkingLevel;
  /**
   * Exact requested Codex speed. Authoritative when present; `fastMode` is its
   * legacy projection (`speed === 'fast'`, never true for `ultrafast`).
   */
  speed?: CodexSpeed;
  fastMode?: boolean;
}

/** Browser-safe reference to a ready cloud chat attachment. */
export interface PortalChatCloudAttachmentRef {
  attachmentId: string;
  filename: string;
  mediaType: string;
  size: number;
  contentSha256: string;
  storageKind: 'blob';
  source: string;
}

/**
 * Display-only reference to a file the user attached to a chat message.
 * A projection of {@link PortalChatCloudAttachmentRef} (or of core's
 * persisted context rail) that carries no byte source: hosts resolve Open,
 * Download and thumbnails through their own attachment endpoints.
 */
export interface PortalChatMessageAttachment {
  attachmentId: string;
  assetId?: string;
  filename: string;
  mediaType: string;
  /** Byte size when the host knows it; desktop-local projections omit it. */
  size?: number;
}

function readMessageAttachment(
  value: unknown,
): PortalChatMessageAttachment | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  if (
    !('attachmentId' in value && 'filename' in value && 'mediaType' in value)
  ) {
    return null;
  }
  const { attachmentId, filename, mediaType } = value;
  const size = 'size' in value ? value.size : undefined;
  const assetId =
    'assetId' in value &&
    typeof value.assetId === 'string' &&
    value.assetId.startsWith('asset-') &&
    value.assetId.length <= 1024
      ? value.assetId
      : undefined;
  if (
    typeof attachmentId !== 'string' ||
    attachmentId.trim().length === 0 ||
    typeof filename !== 'string' ||
    filename.trim().length === 0 ||
    cloudAttachmentFilenameByteLength(filename) >
      CLOUD_ATTACHMENT_FILENAME_MAX_BYTES ||
    typeof mediaType !== 'string' ||
    mediaType.trim().length === 0
  ) {
    return null;
  }
  if (size !== undefined) {
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      return null;
    }
    return {
      attachmentId,
      filename,
      mediaType,
      size,
      ...(assetId ? { assetId } : {}),
    };
  }
  return { attachmentId, filename, mediaType, ...(assetId ? { assetId } : {}) };
}

/**
 * Read a message's `attachments` field from an untrusted payload. Malformed
 * items (including an over-long filename) are dropped; collection stops once
 * {@link CLOUD_ATTACHMENTS_MAX_PER_MESSAGE} well-formed items are found, so a
 * hostile or buggy payload cannot force unbounded work or storage.
 * `undefined` is returned when nothing well-formed remains so callers can
 * spread it conditionally.
 */
export function readPortalChatMessageAttachments(
  value: unknown,
): PortalChatMessageAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments: PortalChatMessageAttachment[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (attachments.length >= CLOUD_ATTACHMENTS_MAX_PER_MESSAGE) break;
    const attachment = readMessageAttachment(item);
    if (attachment === null || seen.has(attachment.attachmentId)) continue;
    seen.add(attachment.attachmentId);
    attachments.push(attachment);
  }
  return attachments.length > 0 ? attachments : undefined;
}

/** Project composer-ready refs into the display shape a message carries. */
export function portalChatMessageAttachmentsFromRefs(
  refs: readonly PortalChatCloudAttachmentRef[],
): PortalChatMessageAttachment[] {
  return refs.map(({ attachmentId, filename, mediaType, size }) => ({
    attachmentId,
    filename,
    mediaType,
    size,
  }));
}

/**
 * Canonical payload for `portal.chat.send` (transport plan §1.7).
 *
 * Replaces the previous loose `[extra: string]: unknown` shape so the wire
 * contract is explicit: the server may either send to an existing chat (set
 * `chatId`) or let local Canopy mint a new chat thread (omit `chatId`).
 * `userMessageId` is similarly optional — local Canopy generates one when
 * the server does not pre-allocate it. All routing / provider hints from
 * the local IPC `ChatSendMessageRequest` are surfaced explicitly so server
 * adapters are not coupled to a renderer-only type.
 *
 * Per-field validation lives on local Canopy; the server validator only
 * enforces the closed `PortalCommandType` enum and the body-size cap.
 */
export interface PortalChatSendPayload {
  /** Approve exactly this app-owned proposal with the accepted message. */
  planReviewApproval?: ChatPlanReviewApproval;
  projectId: string;
  worktreeId: string;
  /** Optional chat thread id. Omit to let local Canopy create a new chat. */
  chatId?: string;
  /** Optional user-message id. Omit to let local Canopy mint one. */
  userMessageId?: string;
  text: string;
  fileReferences?: PortalChatFileReference[];
  /** Ready cloud uploads to expose to the next Core turn. */
  cloudAttachments?: PortalChatCloudAttachmentRef[];
  attachmentPaths?: string[];
  planMode?: boolean;
  modelConfig?: PortalAgentModelConfig;
  /** @deprecated Use modelConfig.thinkingLevel. */
  thinkingLevel?: PortalChatThinkingLevel;
  model?: PortalChatModel;
  sdkSessionId?: string;
  pluginSelections?: PortalChatTabPluginSelections;
  providerType?: PortalChatAgentProviderType;
  /** @deprecated Use modelConfig.fastMode. */
  codexFastModeEnabled?: boolean;
  codexProposalMode?: 'optional' | 'required';
  inputMode?: 'typed' | 'voice';
  selectedRepoId?: string;
  /** Absent means manual for compatibility with older hosts. */
  modelSelectionMode?: 'auto';
}

export interface PortalChatCancelPayload {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

/**
 * `portal.chat.cancel_turn`: stop one named turn of a worktree chat. `turnId`
 * is the desktop-local userMessageId that started the turn. The desktop stops
 * only when that turn is the chat's active turn and otherwise changes nothing
 * (`turn_not_active`); it never falls back to whole-chat cancel. Sent only to
 * desktops announcing {@link PORTAL_CAPABILITY_CHAT_CANCEL_TURN}.
 */
export interface PortalChatCancelTurnPayload extends PortalChatCancelPayload {
  turnId: string;
}

/** Completion result of `portal.chat.cancel_turn`. */
export interface PortalChatCancelTurnResult {
  ok: true;
  outcome: 'stop_requested' | 'turn_not_active';
}

/** Address one host-owned queued message for a worktree chat. */
export interface PortalChatQueueEntryPayload extends PortalChatCancelPayload {
  entryId: string;
}

/** Text-only v1 patch for one host-owned queued message. */
export interface PortalChatInputDeliveryPayload extends PortalChatCancelPayload {
  rowId: string;
  rowRevision: number;
  action: ChatInputDeliveryAction;
  text?: string;
}

export interface PortalChatQueueEditPayload extends PortalChatQueueEntryPayload {
  text: string;
}

/** Hold or release a queued row while a portal inline editor is open. */
export interface PortalChatQueueSetEditLockPayload extends PortalChatQueueEntryPayload {
  locked: boolean;
  /**
   * Browser-minted owner for an acquisition, so the browser can release it
   * conditionally when the acquisition's outcome never reaches it. Absent,
   * the acquiring command's id owns the lock.
   */
  acquisitionId?: string;
  /** Release only the lock acquired by this command; used for timeout cleanup. */
  releaseAcquisitionId?: string;
}

/**
 * Routing fields shared by every persistent composer setter command
 * (`portal.chat.set_*`). These mutate a worktree chat tab's composer state on
 * the desktop WITHOUT sending a message, so the portal chips can persist a flip
 * and the desktop UI reflects it live (CAN-1217). Per-field validation lives on
 * the desktop adapter; the server only enforces the closed command enum.
 */
export interface PortalChatSetterTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

/** Payload for `portal.chat.set_model`. */
export type PortalChatSetModelPayload = PortalChatSetterTarget &
  (
    | {
        selectionMode?: 'manual';
        model: PortalChatModel;
        executionHarness?: AgentExecutionHarness;
      }
    | { selectionMode: 'auto'; model?: never }
  );

/**
 * Payload for `portal.chat.set_thinking_level`.
 *
 * Carries the composer setting: the cloud chat host accepts the `default`
 * sentinel (validated with `isThinkingSetting` and encoded to the persisted
 * `ThinkingUpdate` reset) to clear a per-chat override, while the desktop
 * adapter validates with `isThinkingLevel` — clients only send `default` to
 * hosts that project a clearable override (cloud workspaces).
 */
export interface PortalChatSetThinkingLevelPayload extends PortalChatSetterTarget {
  thinkingLevel: PortalChatThinkingSetting;
}

/** Payload for `portal.chat.set_plan_mode`. */
export interface PortalChatSetPlanModePayload extends PortalChatSetterTarget {
  planMode: boolean;
}

/** Payload for `portal.chat.set_fast_mode`. */
export interface PortalChatSetFastModePayload extends PortalChatSetterTarget {
  fastMode: boolean;
}

/**
 * Payload for `portal.chat.create_tab` (CAN-1233). Creates a new, empty
 * worktree chat tab on the desktop with the browser-minted `chatId`, so the
 * portal `+` tab button reaches parity with the desktop (which appends an empty
 * tab immediately, before any message is sent). The desktop appends the tab and
 * re-projects it as a `chat_summary` delta; the browser optimistically selects
 * `chatId` and reconciles when that delta arrives. The desktop adapter validates
 * the routing fields; the server only enforces the closed command enum.
 */
export interface PortalChatCreateTabPayload extends PortalChatSetterTarget {
  /** Chat that should display a recovery notice if creation is credit-refused. */
  creditRecoveryChatId?: string;
  /**
   * Initial model for a New Task chat. Absent means the desktop's scoped
   * default; older desktops ignore it and seed that default.
   */
  model?: PortalChatModel;
  /** Provider for `model`; ignored without a model. */
  providerType?: PortalChatAgentProviderType;
  /** Initial plugin selections for a New Task chat. */
  pluginSelections?: PortalChatTabPluginSelections;
}

/**
 * Payload for `portal.chat.close_tab`. Closes an existing worktree chat tab on
 * the desktop (the same action as the desktop tab's hover close button: a chat
 * with sent messages is archived, an empty one is discarded, and closing the
 * last tab replaces it with a fresh empty one). The desktop drives its renderer
 * `closeTab` — which honors the streaming/queued/pending-plan guard — and the
 * subsequent tab persist emits a `chat_summary` removal delta so every connected
 * portal client evicts the closed tab. The desktop adapter validates the routing
 * fields; the server only enforces the closed command enum.
 */
export type PortalChatCloseTabPayload = PortalChatSetterTarget;

/**
 * Payload for `portal.chat.fork` (CAN-2527). Forks a worktree chat into a new
 * tab, carrying the transcript up to and including `forkAfterUserMessageId`.
 * Omitting that id forks the whole chat, which is what the desktop does for a
 * still-running turn.
 *
 * The desktop adapter pushes this to the renderer, which drives its own
 * `forkTab` — so the portal inherits the desktop's fork semantics (model config
 * normalized for the target provider, thinking level carried and clamped)
 * instead of reimplementing them. The server only enforces the closed command
 * enum.
 */
export interface PortalChatForkPayload extends PortalChatSetterTarget {
  /**
   * Fork the transcript up to and including this user message. Omitted forks
   * the entire chat.
   */
  forkAfterUserMessageId?: string;
}

/**
 * Payload for `portal.chat.branch` (CAN-2528). Branches a worktree chat into a
 * new worktree, carrying the transcript up to and including
 * `forkAfterUserMessageId`. Omitting that id branches the whole chat.
 *
 * The desktop adapter pushes this to the renderer, which drives its own
 * `branchTab` — so the portal inherits the desktop's branch semantics (a new
 * worktree branched from the source, the cloned tab installed there, and
 * plan-approval state preserved) instead of reimplementing them. The server
 * only enforces the closed command enum.
 */
export interface PortalChatBranchPayload extends PortalChatSetterTarget {
  /**
   * Branch the transcript up to and including this user message. Omitted
   * branches the entire chat.
   */
  forkAfterUserMessageId?: string;
}

/** Payload for `portal.chat.share`. Shares a worktree chat as a run. */
export interface PortalChatSharePayload extends PortalChatSetterTarget {
  shareScope: 'private' | 'team' | 'organization';
  teamId?: string;
  organizationId?: string;
}

/**
 * Payload for `portal.chat.set_plugin_selections` (CAN-1219). Persists the full
 * plugin/collection/skill/MCP selection set onto a worktree chat tab WITHOUT
 * sending a message, so the portal plugins selector can flip selections and the
 * desktop composer's Plugins chip reflects it live. The desktop adapter
 * normalizes and validates {@link PortalChatTabPluginSelections}; the server
 * only enforces the closed command enum.
 */
export interface PortalChatSetPluginSelectionsPayload extends PortalChatSetterTarget {
  selections: PortalChatTabPluginSelections;
  /** Committed atomically with selections when the host advertises support. */
  deferredToolsAllowed?: boolean;
}

export { validateQuestionControlAnswers } from './question-controls';

/** Optional presentation for the existing structured question/answer transport. */
export interface PortalQuestionControl {
  control?: 'buttons' | 'select' | 'text' | 'textarea' | 'number' | 'date';
  required?: boolean;
  placeholder?: string;
}

/**
 * A single Canopy AskUserQuestion projected over the portal wire so the browser
 * can render the SAME choices the desktop shows (instead of raw JSON). This is a
 * browser-safe, serializable mirror of the desktop `McpQuestion`; every field
 * needed for parity is preserved:
 *
 * - `id` — stable question id (optional; multi-question prompts key on it);
 * - `header` — short heading shown above the question;
 * - `question` — the prompt text;
 * - `options` — the selectable choices;
 * - `multiSelect` — whether more than one option may be chosen;
 * - `optionDescriptions` — optional per-option helper text (index-aligned);
 * - `allowOther` — whether a freeform "other" answer is permitted;
 * - `secret` — whether the answer is sensitive and must be redacted for display;
 * - `keepTextOnPick` — a picked option leaves the composer's typed text as it
 *   is, for a provider that cannot take both.
 */
export interface PortalAskUserQuestion extends PortalQuestionControl {
  id?: string;
  header?: string;
  question: string;
  options: string[];
  multiSelect?: boolean;
  optionDescriptions?: string[];
  allowOther?: boolean;
  secret?: boolean;
  keepTextOnPick?: boolean;
}

/**
 * An answer to a single {@link PortalAskUserQuestion}. Used in two directions
 * with different redaction semantics:
 *
 * - **Command (browser → desktop)**, in {@link PortalChatAnswerQuestionPayload}:
 *   carries the raw, unredacted user input — the desktop must forward the real
 *   value to the provider, then redact before persisting/projecting.
 * - **Projection (desktop → browser)**, in
 *   {@link PortalAskUserQuestionState.answers}: display-safe only. For `secret`
 *   questions `freeformText` is the redacted form (`[hidden]`), never the raw
 *   sensitive value.
 */
export interface PortalAskUserQuestionAnswer {
  questionId?: string;
  question: string;
  selectedOptions: string[];
  freeformText?: string;
}

/**
 * Projected lifecycle state of one AskUserQuestion request for a chat, carried
 * on {@link PortalChatSummaryEntity.pendingQuestions}. Represents both awaiting
 * and answered entries:
 *
 * - **Awaiting:** `answered: false`, no `answers`.
 * - **Answered:** `answered: true`, with display-safe `answers`.
 *
 * Dismissed/expired requests are REMOVED from `pendingQuestions` rather than
 * synthesized as an answered entry. `requestId` is the authoritative
 * correlation key used by the answer/dismiss commands; `toolUseId`, when
 * present, lets the browser match the card to a transcript `tool_use` block.
 */
export interface PortalAskUserQuestionState {
  requestId: string;
  toolUseId?: string;
  questions: PortalAskUserQuestion[];
  answered: boolean;
  answers?: PortalAskUserQuestionAnswer[];
}

/**
 * Payload for `portal.chat.answer_question`. Sent by the browser to answer an
 * awaiting AskUserQuestion. Routing reuses the established desktop names
 * `projectId`/`worktreeId`/`chatId` (inherited via {@link PortalChatSetterTarget}),
 * while the browser command envelope carries the existing
 * `workspaceLocalId`/`worktreeLocalId`/`chatLocalId` target fields. `requestId`
 * correlates to the awaiting {@link PortalAskUserQuestionState}. The desktop
 * adapter validates the fields; the server only enforces the closed command
 * enum.
 */
export interface PortalChatAnswerQuestionPayload extends PortalChatSetterTarget {
  requestId: string;
  answers: PortalAskUserQuestionAnswer[];
}

/**
 * Payload for `portal.chat.dismiss_question`. Sent by the browser to dismiss an
 * awaiting AskUserQuestion without answering. Same routing contract as
 * {@link PortalChatAnswerQuestionPayload}; `requestId` correlates to the
 * awaiting {@link PortalAskUserQuestionState}.
 */
export interface PortalChatDismissQuestionPayload extends PortalChatSetterTarget {
  requestId: string;
}

// ---------------------------------------------------------------------------
// App Advisor commands (CAN-2562)
//
// The App Advisor portal surface is a REMOTE VIEW of the paired desktop's App
// Advisor session: commands are relayed to the desktop, which keeps owning the
// agent session, tool execution, and the `?surface=app-advisor` renderer as
// the single writer of App Advisor chat state. Unlike the worktree chat
// family, these payloads intentionally carry NO `projectId`/`worktreeId`
// routing — the desktop adapter always targets the App Advisor sentinel
// workspace, so a remote client cannot re-route the family at another chat
// scope. UI-state snapshots relayed for this surface must continue to exclude
// pairing codes and other portal secrets.
// ---------------------------------------------------------------------------

/**
 * Payload for `portal.app_advisor.send`. Mirrors the routing-free subset of
 * {@link PortalChatSendPayload}: omit `chatId` to let the desktop mint a new
 * App Advisor chat tab, and omit `userMessageId` to let it mint the message
 * id. Per-field validation lives on the desktop adapter; the server only
 * enforces the closed command enum and the body-size cap.
 */
export interface PortalAppAdvisorSendPayload {
  /**
   * Existing App Advisor Work Entry that should own a chat minted by this
   * send. Omit for the legacy behavior that creates a new Work Entry.
   */
  workEntryId?: string;
  /** Optional App Advisor chat tab id. Omit to create a new tab. */
  chatId?: string;
  /** Optional user-message id. Omit to let the desktop mint one. */
  userMessageId?: string;
  text: string;
  fileReferences?: PortalChatFileReference[];
  attachmentPaths?: string[];
  model?: PortalChatModel;
  modelConfig?: PortalAgentModelConfig;
  pluginSelections?: PortalChatTabPluginSelections;
  providerType?: PortalChatAgentProviderType;
  inputMode?: 'typed' | 'voice';
}

/**
 * Routing target shared by every App Advisor command that addresses an
 * existing chat tab. Deliberately chat-only — see the family note above.
 */
export interface PortalAppAdvisorChatTarget {
  chatId: string;
}

/** Payload for `portal.app_advisor.cancel`. */
export type PortalAppAdvisorCancelPayload = PortalAppAdvisorChatTarget;

/**
 * Persist the selected model on an App Advisor chat without sending a message.
 * The desktop applies the same model-policy and captured-harness checks as its
 * native App Advisor picker, then re-projects the authoritative chat summary.
 */
export interface PortalAppAdvisorSetModelPayload extends PortalAppAdvisorChatTarget {
  model: PortalChatModel;
  executionHarness?: AgentExecutionHarness;
}

/**
 * Payload for `portal.app_advisor.create_tab`. Creates a new, empty App
 * Advisor chat tab on the desktop with the browser-minted `chatId`, mirroring
 * `portal.chat.create_tab` (CAN-1233) semantics.
 */
export interface PortalAppAdvisorCreateTabPayload
  extends PortalAppAdvisorChatTarget, SidebarItemGroupCreationOptions {
  /**
   * Existing App Advisor Work Entry that should receive the new sub-chat.
   * Omit for compatibility with older clients that created a new Work Entry.
   */
  workEntryId?: string;
}

/**
 * Payload for `portal.app_advisor.close_tab`. Mirrors
 * `portal.chat.close_tab` semantics for App Advisor tabs.
 */
export type PortalAppAdvisorCloseTabPayload = PortalAppAdvisorChatTarget;

/**
 * Payload for `portal.app_advisor.answer_question`. Same redaction contract
 * as {@link PortalChatAnswerQuestionPayload}: carries the raw answer, the
 * desktop forwards it to the provider and redacts before projecting.
 */
export interface PortalAppAdvisorAnswerQuestionPayload extends PortalAppAdvisorChatTarget {
  requestId: string;
  answers: PortalAskUserQuestionAnswer[];
}

/**
 * Payload for `portal.app_advisor.dismiss_question`. Same contract as
 * {@link PortalChatDismissQuestionPayload} for App Advisor question cards.
 */
export interface PortalAppAdvisorDismissQuestionPayload extends PortalAppAdvisorChatTarget {
  requestId: string;
}

/** Request payload for the App Advisor settings small-RPC. */
export type PortalAppAdvisorSettingsGetPayload = Record<string, never>;

/** Owner identity selectable by the App Advisor project-agent access setting. */
export type PortalAppAdvisorProjectAgentAccessOwner =
  | { kind: 'personal' }
  | { kind: 'organization'; organizationId: string };

/** Saved access policy for project agents that message App Advisor. */
export interface PortalAppAdvisorProjectAgentAccess {
  mode: 'enabled' | 'selected-owners' | 'disabled';
  selectedOwners: PortalAppAdvisorProjectAgentAccessOwner[];
}

/** Browser-safe owner choice presented alongside the saved access policy. */
export interface PortalAppAdvisorProjectAgentAccessOwnerOption {
  owner: PortalAppAdvisorProjectAgentAccessOwner;
  label: string;
  unavailable?: boolean;
}

/**
 * Browser-safe projection of the desktop App Advisor settings modal. The
 * catalog fields let the portal render the same model/plugin choices without
 * importing desktop-only registries or reading the local filesystem.
 */
export interface PortalAppAdvisorSettings {
  model: string;
  thinkingLevel: ThinkingLevel;
  pluginSelections: PortalChatTabPluginSelections;
  instructions: string;
  archiveRetentionDays: number | null;
  autoArchiveDays: number | null;
  availableModels: ModelCatalog;
  providerAvailability: PortalChatProviderAvailability;
  pluginCatalog: PortalPluginCatalog;
  /** Desktop-global dismissal state for the composer approvals notice. */
  approvalsUpgradeNoticeDismissed: boolean;
  /** Absent when the paired desktop predates project-agent access settings. */
  projectAgentAccess?: PortalAppAdvisorProjectAgentAccess;
  /** Absent when the paired desktop predates project-agent access settings. */
  projectAgentAccessOwnerOptions?: PortalAppAdvisorProjectAgentAccessOwnerOption[];
}

/**
 * Partial save used by the portal settings modal. Defaults save immediately;
 * instructions and retention are submitted from the modal's Save action.
 */
export interface PortalAppAdvisorSettingsSavePayload {
  model?: string;
  thinkingLevel?: ThinkingLevel;
  pluginSelections?: PortalChatTabPluginSelections;
  instructions?: string;
  archiveRetentionDays?: number | null;
  autoArchiveDays?: number | null;
  approvalsUpgradeNoticeDismissed?: boolean;
  projectAgentAccess?: PortalAppAdvisorProjectAgentAccess;
}

/**
 * Payload for `portal.chat.list_plugin_catalog` (CAN-1219). A request/response
 * command — mirroring `portal.editor.list_slash_commands` — that returns the
 * browser-safe plugin/collection/skill/MCP inventory the connected desktop can
 * currently offer, so the portal plugins selector renders the SAME picker the
 * desktop shows without any local filesystem access. The desktop reads its
 * cached local inventory (never a network refresh) and completes the command
 * with a {@link PortalPluginCatalog}.
 */
export interface PortalChatListPluginCatalogPayload {
  projectId: string;
  /** Worktree scope; omitted for standalone/cowork scope. */
  worktreeId?: string;
  /** Optional chat id for context; the catalog itself is worktree-global. */
  chatId?: string;
  /** Optional provider scope so the catalog can flag unsupported plugins. */
  providerType?: PortalChatAgentProviderType;
}

/**
 * Browser-safe collection row in a {@link PortalPluginCatalog}. Mirrors the
 * desktop `CollectionIndexEntry`, which already carries the child counts.
 */
export interface PortalPluginCatalogCollection {
  id: string;
  name: string;
  description: string;
  skillCount: number;
  pluginCount: number;
  mcpServerCount: number;
}

/**
 * Browser-safe skill row in a {@link PortalPluginCatalog}. `sourceId`/`skillName`
 * form the selection key (`${sourceId}/${skillName}`) used by
 * {@link PortalChatTabPluginSelections.skillRefs}.
 */
export interface PortalPluginCatalogSkill {
  sourceId: string;
  skillName: string;
  name: string;
  description: string;
  /** Display label of the skill's source (built-in / custom / marketplace). */
  source: string;
  builtIn?: boolean;
}

/**
 * Browser-safe plugin row in a {@link PortalPluginCatalog}. `marketplaceId`/
 * `pluginName` form the selection key used by
 * {@link PortalChatTabPluginSelections.pluginRefs}. The provider-support flags
 * let the portal disable rows the active provider cannot run.
 */
export interface PortalPluginCatalogPlugin {
  marketplaceId: string;
  pluginName: string;
  name: string;
  description: string;
  /** Display label of the owning marketplace. */
  marketplaceName: string;
  claudeSupported: boolean;
  codexSupported: boolean;
  /**
   * GitHub tree URL of the plugin root at the exact commit the cloud ingest
   * read, built server-side from the validated owner, repository, revision,
   * and root; absent for rows synced before provenance was recorded.
   */
  sourceUrl?: string;
  /** Plugin manifest `license` string, verbatim; absent when undeclared. */
  license?: string;
  /**
   * Plugin-level roll-up of the advisory skill security audit captured at
   * sync time (worst level across skills, summed Socket alerts); absent when
   * no usable audit was stored.
   */
  securityAudit?: SkillRiskInfo;
}

/**
 * Browser-safe MCP-server row in a {@link PortalPluginCatalog}. One row per
 * enabled server config; `serverId`/`configId` form the selection key used by
 * {@link PortalChatTabPluginSelections.mcpServerRefs}.
 */
/** Optional account metadata; absent preserves legacy/desktop catalog behavior. */
export interface PortalMcpConnectionMetadata {
  authMode?: 'OAUTH' | 'BEARER' | 'NONE';
  connectionState?:
    | 'connected'
    | 'reauth_required'
    | 'not_connected'
    | 'desktop_only';
  connectionId?: string;
  /** null means all tools; [] disables every tool. */
  enabledTools?: string[] | null;
  connectionRequiresAuth?: boolean;
  /** Host of the endpoint the stored connection uses. */
  upstreamHost?: string;
  /**
   * False when the user turned the stored connection off; chats and agents
   * do not get it. Absent without a connection and from older clouds.
   */
  connectionEnabled?: boolean;
}

export interface PortalPluginCatalogMcpServer extends PortalMcpConnectionMetadata {
  serverId: string;
  configId: string;
  serverName: string;
  configName: string;
  description: string;
  transport: 'command' | 'http';
  /** A curated server's selectable endpoints, from its catalog entry. */
  urlOptions?: CuratedMcpUrlOption[];
}

export interface PortalPluginCatalogSkillMember {
  name: string;
  description: string;
  path: string;
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
}

export interface PortalPluginCatalogMarkdownMember {
  name: string;
  description: string;
  filePath: string;
  /** Generated Codex skill name when that member exists in the projection. */
  codexName?: string;
}

export interface PortalPluginCatalogHookMember {
  event: string;
  matcher?: string;
  hookType: string;
  command?: string;
}

export interface PortalPluginCatalogModMember {
  module: string;
  hooksFile: string;
}

export interface PortalPluginCatalogMcpMember {
  name: string;
  type: 'command' | 'http';
  command?: string;
  args?: string[];
  url?: string;
}

export interface PortalPluginCatalogLspMember {
  name: string;
  command: string;
  args?: string[];
  languages?: string[];
}

/** Stored, parse-free plugin member inventory projected over the catalog. */
export interface PortalPluginCatalogMemberInventory {
  skills: PortalPluginCatalogSkillMember[];
  commands: PortalPluginCatalogMarkdownMember[];
  agents: PortalPluginCatalogMarkdownMember[];
  /** Absent on catalogs produced before REG-2841 compatibility version 5. */
  apps?: PortalPluginCatalogMarkdownMember[];
  hooks: PortalPluginCatalogHookMember[];
  /** Absent on catalogs produced before Mod member inventory support. */
  mods?: PortalPluginCatalogModMember[];
  mcpServers: PortalPluginCatalogMcpMember[];
  lspServers: PortalPluginCatalogLspMember[];
}

export interface PortalPluginCatalogMemberSummary {
  skills: number;
  commands: number;
  agents: number;
  /** Absent on catalogs produced before REG-2841 compatibility version 5. */
  apps?: number;
  hooks: number;
  mcpServers: number;
  lspServers: number;
}

export interface PortalPluginCatalogCloudCapabilities {
  hasSkills: boolean;
  hasCommands: boolean;
  hasAgents: boolean;
  mcpOnly: boolean;
  hooksStripped: boolean;
}

/** Additive unified catalog row used by the shared desktop/cloud picker. */
export interface PortalPluginCatalogUnifiedEntry extends PortalMcpConnectionMetadata {
  id: string;
  kind: UnifiedEntryKind;
  origin: UnifiedEntryOrigin;
  state: UnifiedEntryState;
  name: string;
  description: string;
  source: { id: string; label: string };
  providerSupport: { claude: boolean; codex: boolean };
  cloudCapabilities: PortalPluginCatalogCloudCapabilities;
  lastUpdated: string;
  memberSummary: PortalPluginCatalogMemberSummary;
  memberInventory?: PortalPluginCatalogMemberInventory;
  /**
   * The account MCP servers a curated plugin brings, in the plugin's order,
   * each as the ref a direct selection would carry. The cloud catalog sets
   * it on every curated plugin (empty when it brings none), whatever the
   * state of {@link memberInventory}; desktop-relayed and marketplace entries
   * omit it. Read it through `resolveSelectedMcpServers` (REG-3030).
   */
  mcpServerRefs?: { serverId: string; configId: string }[];
  /** Bounded plain-text reason a marketplace plugin could not be synchronized. */
  syncError?: string;
  /**
   * GitHub tree URL of a marketplace plugin's root at the exact ingested
   * commit; absent for other origins and for rows synced before provenance
   * was recorded.
   */
  sourceUrl?: string;
  /** Plugin manifest `license` string, verbatim; absent when undeclared. */
  license?: string;
  /**
   * Plugin-level roll-up of the advisory skill security audit captured at
   * sync time; absent for other origins and when no usable audit was stored.
   */
  securityAudit?: SkillRiskInfo;
  selectionRef: UnifiedEntryRef;
}

/**
 * Result of `portal.chat.list_plugin_catalog` (CAN-1219): the flat,
 * serializable inventory the connected desktop can currently offer, grouped by
 * kind. Each list is empty when the desktop has no items of that kind.
 */
export interface PortalPluginCatalog {
  collections: PortalPluginCatalogCollection[];
  skills: PortalPluginCatalogSkill[];
  plugins: PortalPluginCatalogPlugin[];
  mcpServers: PortalPluginCatalogMcpServer[];
  /** Additive migration field; older desktop relays may omit it. */
  entries?: PortalPluginCatalogUnifiedEntry[];
}

// ---------------------------------------------------------------------------
// Portal Plugins-section browse commands (design:
// docs/planning/2026-08-27-portal-plugins-section/design.md, PR 3).
//
// Read-only, small-RPC query commands that let the web portal browse the
// paired desktop's CACHED plugin/skill/MCP/collection inventory. All rows are
// deliberately minimal projections of the neutral catalog shapes hoisted into
// `../plugins` / `../skills` / `../mcp-servers` / `../collections` — bulky or
// machine-local fields (absolute paths, facets, install locations) and every
// credential (MCP auth tokens, env var values, OAuth secrets, header values)
// are omitted so nothing sensitive or oversized ever reaches the browser.
// ---------------------------------------------------------------------------

/**
 * Maximum SERIALIZED UTF-8 BYTES of a single markdown body (plugin README,
 * component content, SKILL.md) returned by a portal catalog detail command.
 * Bodies over the cap are cut on a full code-point boundary and flagged
 * `truncated: true` so the result stays far below the ~1 MiB portal event
 * size limit. Measured in bytes (not UTF-16 code units) because the event
 * size cap is a byte cap.
 */
export const PORTAL_CATALOG_CONTENT_MAX_BYTES = 256 * 1024;

/**
 * Conservative maximum SERIALIZED UTF-8 BYTES for an ENTIRE portal catalog
 * command result (`JSON.stringify(result)`), applied by the desktop builders
 * as a final guard after per-body truncation. Results over this budget are
 * deterministically degraded (bodies dropped first, then lists prefix-cut)
 * and flagged with the result-level `truncated: true` so the small-RPC wait
 * never times out on a silently dropped >1 MiB event.
 */
export const PORTAL_CATALOG_RESULT_MAX_BYTES = 700 * 1024;

/** Payload for `portal.plugins.list_marketplaces`. */
export interface PortalPluginsListMarketplacesPayload {
  projectId: string;
}

/** Payload for `portal.plugins.get_plugin_detail`. */
export interface PortalPluginsGetPluginDetailPayload {
  projectId: string;
  marketplaceId: string;
  pluginName: string;
}

/**
 * Payload for `portal.plugins.share_plugin`: the browser names the plugin, the
 * desktop resolves the shareable source from its own marketplace state,
 * creates the shared plugin in Canopy Cloud and publishes its public share.
 */
export interface PortalPluginsSharePluginPayload {
  projectId: string;
  marketplaceId: string;
  pluginName: string;
  scope: PortalShareScope;
  teamId?: string;
  organizationId?: string;
}

/** Result of `portal.plugins.share_plugin`: the public share path on the web host. */
export interface PortalPluginsSharePluginResult {
  sharePath: string;
  /** Absolute share URL from the publishing desktop's cloud origin. */
  shareUrl?: string;
}

/**
 * Scope a share is minted at. `private` keeps the copy to the sharer's account;
 * `team`/`organization` grant the named group; `public` mints a link anyone can
 * open. Mirrors the desktop share modal's scope selector.
 */
export type PortalShareScope = ShareAudience;

/**
 * Payload for `portal.skills.share_skill`: the browser names an installed
 * skill and a scope, the desktop reads the skill's raw bytes, creates the
 * shared copy in Canopy Cloud under ITS OWN account, and returns the link.
 */
export interface PortalSkillsShareSkillPayload {
  projectId: string;
  sourceId: string;
  skillName: string;
  scope: PortalShareScope;
  /** Required when `scope` is `team`. */
  teamId?: string;
  /** Required when `scope` is `organization`. */
  organizationId?: string;
}

/**
 * Result of a share command. `sharePath` is absent when the scope mints no
 * link, or when publishing degraded after the copy was created — `message`
 * then explains what the user got.
 */
export interface PortalShareResult {
  sharePath?: string;
  /**
   * Absolute share URL resolved from the publishing desktop account's cloud
   * origin. Older desktops omit it; browsers then fall back to `sharePath`.
   */
  shareUrl?: string;
  message?: string;
  /** Structured failure; older desktops send only the legacy error string. */
  failure?: ShareFailure;
}

/**
 * Payload for `portal.sharing.list_teams` / `.list_organizations`. The share is
 * created under the DESKTOP's Cloud account, so its teams and organizations —
 * not the browser user's — are what the picker must offer.
 */
export interface PortalSharingListTeamsPayload {
  projectId: string;
  /** Substring filter; absent or empty lists the first page unfiltered. */
  query?: string;
}

export type PortalSharingListOrganizationsPayload =
  PortalSharingListTeamsPayload;

/**
 * Payload for `portal.sharing.account`: the desktop's own Cloud account state.
 * The browser must not assume the paired desktop is connected or capable —
 * `shareable` on a row says the DESKTOP could share that resource, not that its
 * account currently supports teams or organizations.
 */
export interface PortalSharingAccountPayload {
  projectId: string;
}

/** Result of `portal.sharing.account`. */
export interface PortalSharingAccountResult {
  /** Desktop policy applicability and its authoritative Personal exception. */
  organizationOwnershipPolicy?: {
    enabled: boolean;
    personalOrganizationId: string | null;
  };
  /** Whether the desktop has a usable Cloud account configured. */
  connected: boolean;
  /** Stable desktop Cloud account identity, when known. */
  id?: string;
  /** Capability ids the account advertises, e.g. `skills-crud-v1`. */
  capabilities: string[];
  /** Whether the desktop account belongs to at least one organization. */
  hasOrganization?: boolean;
  /** Whether the desktop account belongs to at least one team. */
  hasTeam?: boolean;
  /**
   * Advisory per-organization share access facts for the desktop account.
   * Older desktops omit it; absence never implies denial.
   */
  organizationAccess?: ShareOrganizationAccess[];
}

/** Local resource whose current author-side Cloud share should be loaded. */
export type PortalSharingExistingSharePayload = {
  projectId: string;
} & (
  | { resourceType: 'skill'; sourceId: string; skillName: string }
  | { resourceType: 'plugin'; marketplaceId: string; pluginName: string }
  | { resourceType: 'collection'; collectionId: string }
  | {
      resourceType: 'pipeline';
      pipelineId: string;
      worktreeId?: string;
    }
);

/** Browser-safe current-share state used to preselect the common dialog. */
export interface PortalSharingExistingShare {
  audience: ShareAudience;
  target?: PortalShareTargetRow;
  /** Owner scope, independent of the audience of a legacy public link. */
  targetAudience?: 'team' | 'organization';
  publicLinkStale?: boolean;
  /** Canonical item URL from the connected desktop's publishing origin. */
  linkUrl?: string;
  /** ISO time of the last pinned snapshot update, never its creation time. */
  publicLinkPinnedAt?: string;
  /** The public link's absolute URL, resolved against the desktop's cloud. */
  publicUrl?: string;
}

/** Result of `portal.sharing.existing_share`. */
export interface PortalSharingExistingShareResult {
  existingShare: PortalSharingExistingShare | null;
}

/**
 * Payload for `portal.pipeline.share`. The desktop re-reads the pipeline's YAML
 * from disk and creates the shared copy under its own Cloud account.
 *
 * DEFINITION-ONLY: the desktop's packaged share needs an interactive analyze
 * step (dependency closure, optional-resource selection, upload progress) that
 * a single command cannot express, so package distribution stays a desktop
 * flow. Sharing here publishes the pipeline definition alone.
 */
/**
 * Payload for `portal.collections.share`. The desktop rebuilds the Collection
 * payload from local state (member refs, and the raw bytes of any custom
 * skills it contains) and creates the shared copy under its own Cloud account.
 *
 * Public scope publishes the pinned Collection snapshot after its private
 * registry row is created or updated.
 */
export interface PortalCollectionsSharePayload {
  projectId: string;
  collectionId: string;
  scope: PortalShareScope;
  teamId?: string;
  organizationId?: string;
}

export interface PortalPipelineSharePayload {
  projectId: string;
  /** Worktree owning the pipeline; absent for workspace-scoped pipelines. */
  worktreeId?: string;
  pipelineId: string;
  scope: PortalShareScope;
  teamId?: string;
  organizationId?: string;
}

/** One share target the desktop's Cloud account can share to. */
export interface PortalShareTargetRow {
  id: string;
  name: string;
  /** Owning organization id, for a team row. */
  organizationId?: string;
  /** Owning organization name, for a team row. */
  secondaryLabel?: string;
}

/** Result of `portal.sharing.list_teams` / `.list_organizations`. */
export interface PortalSharingListTargetsResult {
  targets: PortalShareTargetRow[];
}

/**
 * Payload for `portal.plugins.read_component_content`. `componentFile` is the
 * plugin-relative file path echoed from a {@link PluginDetails} row; the
 * desktop re-resolves it under the plugin's trusted root and rejects absolute
 * paths and traversal, so the browser can never name an arbitrary file.
 */
export interface PortalPluginsReadComponentContentPayload {
  projectId: string;
  marketplaceId: string;
  pluginName: string;
  /** Component family the file came from (display/context only). */
  componentType: string;
  componentFile: string;
}

/** Payload for `portal.skills.list`. */
export interface PortalSkillsListPayload {
  projectId: string;
}

/** Payload for `portal.skills.read`. */
export interface PortalSkillsReadPayload {
  projectId: string;
  sourceId: string;
  skillName: string;
}

/** Payload for `portal.mcp.list_servers`. */
export interface PortalMcpListServersPayload {
  projectId: string;
}

/** Payload for `portal.mcp.get_server`. */
export interface PortalMcpGetServerPayload {
  projectId: string;
  serverId: string;
}

/** Payload for `portal.collections.list`. */
export interface PortalCollectionsListPayload {
  projectId: string;
}

/** Payload for `portal.collections.get`. */
export interface PortalCollectionsGetPayload {
  projectId: string;
  collectionId: string;
}

/** A shared update names only the local copy and the revision being replaced. */
export interface PortalCollectionsApplyUpdatePayload {
  projectId: string;
  collectionId: string;
  expectedRevision: string;
}

/** Partial imports are retained even when the final grouping was not saved. */
export type PortalCollectionsApplyUpdateResult =
  | {
      success: true;
      update: ApplyCollectionUpdateResult;
    }
  | {
      success: false;
      code:
        | 'invalid_payload'
        | 'permission_denied'
        | 'not_found'
        | 'conflict'
        | 'execution_failed';
      message: string;
      partialResourceEffects: string[];
    };

/**
 * Payload for `portal.collections.save`: create a collection (no `id`) or
 * replace an existing one's name, description and members. Share links
 * (`remote`, `sharedSource`) and `createdAt` are never accepted from the
 * browser; the desktop keeps the stored values.
 */
export interface PortalCollectionsSavePayload {
  projectId: string;
  collection: {
    id?: string;
    /** Echo the complete local snapshot revision on edit; omitted on create. */
    expectedRevision?: string;
    name: string;
    description: string;
    skills: CollectionSkillRef[];
    plugins: CollectionPluginRef[];
    mcpServers: CollectionMcpRef[];
  };
}

/**
 * Frontmatter + markdown body returned by the catalog content read commands
 * (`portal.plugins.read_component_content`, `portal.skills.read`). `truncated`
 * is true when `body` was cut at {@link PORTAL_CATALOG_CONTENT_MAX_BYTES}
 * (UTF-8 bytes, cut on a code-point boundary) or when the frontmatter had to
 * be dropped to fit {@link PORTAL_CATALOG_RESULT_MAX_BYTES}.
 */
export interface PortalCatalogMarkdownContent {
  frontmatter: Record<string, unknown>;
  body: string;
  truncated: boolean;
}

/**
 * Browser-safe MCP server a marketplace plugin bundles. Projects a
 * {@link PluginDetails} `mcpServers` entry without `command`, `args`, or env;
 * `url` is present only for http servers and is SANITIZED (scheme + host +
 * port + path). An http server whose URL does not sanitize is omitted.
 */
export interface PortalMarketplacePluginMcpServer {
  name: string;
  type: 'command' | 'http';
  url?: string;
}

/**
 * Browser-safe skill a marketplace plugin bundles. Projects a
 * {@link PluginDetails} `skills` entry without its `path`.
 */
export interface PortalMarketplacePluginSkill {
  name: string;
  description: string;
}

/**
 * Browser-safe plugin summary row inside a {@link PortalMarketplaceRow}.
 * Projects {@link PluginInfo} without paths, facets, or install locations;
 * `installed` collapses the machine-local cache state into a single flag.
 */
export interface PortalMarketplacePluginRow extends Pick<
  PluginInfo,
  | 'name'
  | 'displayName'
  | 'tryNowPrompt'
  | 'description'
  | 'version'
  | 'author'
  | 'category'
  | 'marketplaceId'
  | 'builtIn'
  | 'curated'
  | 'recommended'
  | 'providerSupport'
> {
  /** True when the plugin has a populated local cache (or is bundled). */
  installed: boolean;
  /**
   * True when the desktop can mint a public share link for this plugin (the
   * marketplace resolves to a shareable source). Computed desktop-side so the
   * browser shows the same Share affordances the desktop Marketplace shows.
   */
  shareable?: boolean;
  /** Additive authoritative state and existing command target (CAN-3704). */
  sharing?: MarketplaceEntryShareResolution;
  /** Parent sharing for a curated MCP card, even without an installed connection. */
  foldedMcp?: { key: string; sharing: MarketplaceEntryShareResolution };
  /**
   * What the share dialog names as the public source, computed by the desktop
   * from the same reference it publishes (so the dialog never shows a display
   * name that differs from the concrete source in the public reference).
   */
  shareSourceLabel?: string;
  /**
   * SANITIZED `externalSource.url` of the plugin's own package (scheme + host
   * + port + path), so the browser can name its publisher and tell two
   * same-named plugins apart (CAN-3653). Absent when the plugin has no
   * external source, the URL does not parse or is not http(s), or the desktop
   * predates it.
   */
  externalSourceUrl?: string;
  /**
   * MCP servers the plugin bundles, so the browser can join an installed
   * server to its plugin (CAN-3653). Absent when the plugin details were not
   * fetched, it bundles none, or the desktop predates it.
   */
  mcpServers?: PortalMarketplacePluginMcpServer[];
  /**
   * Skills the plugin bundles, so the browser lists them under the plugin's
   * status (CAN-4844). Absent when the plugin is not installed, details were
   * not fetched, it bundles none, or the desktop predates it.
   */
  skills?: PortalMarketplacePluginSkill[];
}

/**
 * Browser-safe per-provider marketplace status. Projects
 * {@link MarketplaceProviderStatus} without provider-side filesystem paths.
 */
export type PortalMarketplaceProviderStatusRow = Pick<
  MarketplaceProviderStatus,
  'provider' | 'state' | 'accepted' | 'pluginCount' | 'lastCheckedAt' | 'error'
>;

/**
 * Browser-safe marketplace row for the portal Plugins section list page.
 * Projects {@link MarketplaceInfo} without `installLocation` and with
 * summary-only plugin rows.
 *
 * `sourceUrl` is SANITIZED before it crosses the portal boundary: full URLs
 * are reduced to scheme + host + port + path (userinfo, query, and fragment
 * stripped; unparseable URLs collapse to ''), while opaque source refs
 * (`owner/repo`, `builtin:app`, `curated:cloud`) pass through unchanged.
 */
export interface PortalMarketplaceRow extends Pick<
  MarketplaceInfo,
  | 'id'
  | 'name'
  | 'description'
  | 'sourceType'
  | 'sourceUrl'
  | 'builtIn'
  | 'curated'
  | 'removable'
  | 'lastUpdated'
  | 'pluginCount'
  | 'validProviders'
> {
  providerStatus: {
    claude: PortalMarketplaceProviderStatusRow;
    codex: PortalMarketplaceProviderStatusRow;
  };
  plugins: PortalMarketplacePluginRow[];
}

/** Result of `portal.plugins.list_marketplaces`. */
export interface PortalPluginsListMarketplacesResult {
  marketplaces: PortalMarketplaceRow[];
  /** ISO timestamp of the desktop's last marketplace refresh ('' if never). */
  lastRefreshed: string;
  /**
   * True when the marketplace list was prefix-cut to fit
   * {@link PORTAL_CATALOG_RESULT_MAX_BYTES}. Absent means complete.
   */
  truncated?: boolean;
}

/**
 * Result of `portal.plugins.get_plugin_detail`: everything the plugin detail
 * page renders — summary row, component lists, and the (truncated) README.
 */
export interface PortalPluginDetailResult {
  marketplaceId: string;
  marketplaceName: string;
  plugin: PortalMarketplacePluginRow;
  /**
   * Plugin homepage, SANITIZED to scheme + host + port + path (userinfo,
   * query, and fragment stripped); omitted when unparseable.
   */
  homepage?: string;
  /**
   * Component lists (skills/agents/commands/apps/hooks/MCP/LSP). MCP server
   * `url` fields inside are SANITIZED like every other portal URL; entries
   * with unparseable URLs have the field omitted.
   */
  details: PluginDetails | null;
  /** README markdown, or null when the plugin ships none / it failed to read. */
  readme: { body: string; truncated: boolean } | null;
  /**
   * Harnesses the desktop offers (its harness gates), so the Portal plugin
   * page lists the same harness rows. Absent from older desktops; the Portal
   * then lists only the harnesses every build offers.
   */
  harnesses?: AgentExecutionHarness[];
  /**
   * Per-provider installation from the desktop's install status, so the
   * Portal harness rows match the desktop's. Absent when the desktop has no
   * per-provider status (older desktops too); the Portal then uses
   * `plugin.installed`.
   */
  harnessInstallation?: { claude: boolean; codex: boolean };
  /** The Claude plugin's Codex compatibility setting is off. */
  codexCompatDisabled?: boolean;
  /**
   * True when the README/details had to be dropped to fit
   * {@link PORTAL_CATALOG_RESULT_MAX_BYTES}. Absent means complete.
   */
  truncated?: boolean;
}

/**
 * Browser-safe installed-skill row. Projects {@link InstalledSkillInfo}
 * without the portable-source metadata the list page does not need.
 */
export type PortalSkillRow = Pick<
  InstalledSkillInfo,
  | 'name'
  | 'sourceId'
  | 'description'
  | 'source'
  | 'installedAt'
  | 'updatedAt'
  | 'updateAvailable'
  | 'builtIn'
  | 'custom'
  | 'installedFromShare'
> & {
  /**
   * True when the paired desktop can share this skill. Computed on the desktop
   * from the same rule its own Skills tab uses — the browser must never guess
   * what is shareable. Absent means "not shareable" (including desktops that
   * predate this field).
   */
  shareable?: boolean;
  /** Absent on older desktops; absence is not a blocked reason. */
  sharing?: MarketplaceEntryShareResolution;
  /** Author-side identity for matching a positively owned shared skill. */
  shareRemoteId?: string;
};

/** Result of `portal.skills.list`. */
export interface PortalSkillsListResult {
  skills: PortalSkillRow[];
  /**
   * True when the skill list was prefix-cut to fit
   * {@link PORTAL_CATALOG_RESULT_MAX_BYTES}. Absent means complete.
   */
  truncated?: boolean;
}

/**
 * Browser-safe MCP server list row. The persisted index entry is already
 * credential-free (names, transport, config summaries, curated display data);
 * the desktop additionally SANITIZES `logoUrl` (scheme + host + port + path
 * only; omitted when unparseable) before the row crosses the portal boundary.
 */
export type PortalMcpServerRow = McpServerIndexEntry & {
  status?: PortalMcpServerStatus;
  /** Shares a resolved folded plugin, otherwise explains unsupported sharing. */
  sharing?: MarketplaceEntryShareResolution;
};

/** Result of `portal.mcp.list_servers`. */
export interface PortalMcpListServersResult {
  servers: PortalMcpServerRow[];
  /** Optional on older desktops. Only credential-free provider link facts. */
  providerConnectors?: Array<{
    provider: ProviderConnectorListResult['provider'];
    connectors: Array<
      Pick<
        ProviderConnectorListResult['connectors'][number],
        'displayName' | 'connected'
      >
    >;
  }>;
  /**
   * True when the server list was prefix-cut to fit
   * {@link PORTAL_CATALOG_RESULT_MAX_BYTES}. Absent means complete.
   */
  truncated?: boolean;
}

/**
 * REDACTED OAuth summary on a {@link PortalMcpServerDetail}: presence flags
 * plus non-secret endpoints/scopes. Client id/secret values never leave the
 * desktop. `authorizationUrl`/`tokenUrl` carry the SANITIZED endpoint only
 * (scheme + host + port + path — userinfo, query, and fragment stripped;
 * omitted entirely when unparseable), because raw URLs can embed credentials.
 */
export interface PortalMcpOAuthConfigSummary {
  hasClientId: boolean;
  hasClientSecret: boolean;
  authorizationUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
  audience?: string;
}

/**
 * Explicit curated-catalog projection on a {@link PortalMcpServerDetail}.
 * Mirrors the desktop `McpServerCuratedMetadata` field-for-field but is
 * deliberately a SEPARATE portal type: the desktop builds it field by field
 * (never forwards the stored object wholesale) and every URL field is
 * SANITIZED to scheme + host + port + path — userinfo, query, and fragment
 * stripped, unparseable URLs omitted — before it crosses the portal boundary.
 */
export interface PortalMcpCuratedMetadata {
  /** Catalog key of the originating curated entry. */
  key: string;
  logoUrl?: string;
  docsUrl?: string;
  supportUrl?: string;
  privacyPolicyUrl?: string;
  authorName?: string;
  authorUrl?: string;
  requiresProviderAuth?: boolean;
}

/**
 * REDACTED config variant on a {@link PortalMcpServerDetail}. Env var and
 * extra-header VALUES are stripped (names only), the bearer token collapses
 * to a presence flag, and extra CLI arguments collapse to a COUNT — argument
 * vectors are arbitrary user config and routinely carry tokens/passwords
 * (`["--token", "…"]`), so raw values must never reach the browser.
 */
export interface PortalMcpServerConfigDetail {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  envVarNames: string[];
  /** Number of extra CLI args on this config; VALUES are never exposed. */
  extraArgCount: number;
  extraHeaderNames: string[];
  /**
   * Account servers only: whether the cloud connection stores extra
   * headers. Their names and values never leave the cloud, so
   * `extraHeaderNames` stays empty. Absent for device servers (their names are
   * authoritative) and when an older cloud does not report presence.
   */
  hasExtraHeaders?: boolean;
  hasAuthToken: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * REDACTED standalone MCP server detail for `portal.mcp.get_server`.
 *
 * Sanitization contract:
 * - Definition header VALUES are stripped (names only).
 * - Definition CLI arguments collapse to `argCount`; raw values never leave
 *   the desktop (they can carry tokens/passwords).
 * - `url` (and the OAuth endpoint URLs on {@link PortalMcpOAuthConfigSummary})
 *   are SANITIZED to scheme + host + port + path — userinfo, query, and
 *   fragment are stripped, and unparseable URLs are omitted entirely —
 *   because URLs can embed credentials in any of those positions.
 * - `curated` is an explicit {@link PortalMcpCuratedMetadata} projection with
 *   each URL field individually sanitized; the stored metadata object is
 *   never forwarded wholesale.
 * - OAuth secrets and per-config credentials reduce per the nested shapes.
 */
export interface PortalMcpServerDetail {
  /** Positive authorization projection of a canonical device file; absent on older peers and account/provider targets. */
  managementTarget?: { serverId: string; testConfigIds: string[] };
  status?: PortalMcpServerStatus;
  /** Same authoritative resolution as the list row. */
  sharing?: MarketplaceEntryShareResolution;
  id: string;
  name: string;
  description: string;
  type: McpServerType;
  /**
   * `'account'` when the desktop served this from the signed-in account's
   * connections rather than a device file. Its configurations live in the
   * cloud, so the portal offers no enable toggle. Absent means a device server.
   */
  scope?: McpServerScope;
  command?: string;
  /** Number of definition CLI args; VALUES are never exposed. */
  argCount?: number;
  url?: string;
  headerNames?: string[];
  oauth?: PortalMcpOAuthConfigSummary;
  curated?: PortalMcpCuratedMetadata;
  httpAuthHandler?: McpHttpAuthHandler;
  /**
   * Device servers always carry their stored timestamps. Account servers
   * (`scope: 'account'`) omit them: the cloud reports none, so none are
   * invented.
   */
  createdAt?: string;
  updatedAt?: string;
  configs: PortalMcpServerConfigDetail[];
}

/** Result of `portal.mcp.get_server`. */
export interface PortalMcpGetServerResult {
  server: PortalMcpServerDetail;
  /**
   * True when the config list was prefix-cut to fit
   * {@link PORTAL_CATALOG_RESULT_MAX_BYTES}. Absent means complete.
   */
  truncated?: boolean;
}

/** Browser-safe Collection list row (the index entry is already neutral). */
export type PortalCollectionRow = CollectionIndexEntry & {
  /**
   * True when the paired desktop can share this Collection. Computed on the
   * desktop; absent means "not shareable" (including desktops that predate
   * this field).
   */
  shareable?: boolean;
  /** True when the local Collection is already bound to a Cloud share. */
  hasExistingShare?: boolean;
  /** Author-side identity for matching a positively owned shared Collection. */
  shareRemoteId?: string;
};

/** Result of `portal.collections.list`. */
export interface PortalCollectionsListResult {
  collections: PortalCollectionRow[];
  /**
   * True when the Collection list was prefix-cut to fit
   * {@link PORTAL_CATALOG_RESULT_MAX_BYTES}. Absent means complete.
   */
  truncated?: boolean;
}

/** Result of `portal.collections.save`: the collection as stored. */
export interface PortalCollectionsSaveResult {
  collection: CollectionConfig;
}

/** Result of `portal.collections.get`. */
export interface PortalCollectionsGetResult {
  collection: CollectionConfig;
  /**
   * True when the Collection's item ref lists were prefix-cut to fit
   * {@link PORTAL_CATALOG_RESULT_MAX_BYTES}. Absent means complete.
   */
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// Portal Plugins-section mutation commands (design:
// docs/planning/2026-08-27-portal-plugins-section/design.md, phase B).
//
// Long-RPC / small-RPC mutation commands over the SAME desktop plugin/MCP
// services the renderer IPC handlers use. None of these is in
// PORTAL_DESTRUCTIVE_COMMAND_TYPES: every operation is reversible (a removed
// marketplace can be re-added, an uninstalled plugin re-installed, a disabled
// MCP config re-enabled), so browser confirmation dialogs — not the
// kill-switch flag — are the right guard, matching `portal.workspace.delete`.
// Results reuse the phase-A reduced projections so nothing machine-local or
// credential-bearing crosses the boundary.
// ---------------------------------------------------------------------------

/**
 * Payload for `portal.plugins.install_builtin`: install a plugin the desktop
 * already knows from a cached marketplace (built-in/curated/github rows all
 * install through the provider CLI path). `providers` names the provider
 * facets to install for and must be non-empty.
 */
export interface PortalPluginsInstallBuiltinPayload {
  projectId: string;
  marketplaceId: string;
  pluginName: string;
  providers: PluginProvider[];
}

/**
 * Payload for `portal.plugins.install_external`: install an external
 * (git-sourced) plugin. The desktop resolves the clone URL from ITS OWN
 * cached marketplace entry — the browser can never supply a URL, so a
 * compromised portal cannot point the desktop at an arbitrary repository.
 */
export interface PortalPluginsInstallExternalPayload {
  projectId: string;
  marketplaceId: string;
  pluginName: string;
}

/**
 * Result of the plugin install commands: the freshly rescanned plugin,
 * projected through the same reduced row builder as
 * `portal.plugins.list_marketplaces`.
 *
 * NOTE: there is deliberately NO `portal.plugins.uninstall_*` command. The
 * desktop product has no per-plugin uninstall either — removal is modeled as
 * provider-scoped marketplace removal (`portal.marketplace.remove` with
 * `providers`), so the portal mirrors that instead of inventing a new
 * desktop-only code path.
 */
export interface PortalPluginMutationResult {
  plugin: PortalMarketplacePluginRow;
}

/**
 * Payload for `portal.marketplace.add`. `repo` is an `owner/repo` shorthand
 * or an https GitHub URL; the desktop re-validates it with the SAME GitHub
 * source parser its renderer path uses and rejects anything else.
 */
export interface PortalMarketplaceAddPayload {
  projectId: string;
  repo: string;
}

/** Payload for `portal.marketplace.update`. */
export interface PortalMarketplaceUpdatePayload {
  projectId: string;
  marketplaceId: string;
}

/**
 * Payload for `portal.marketplace.remove`. `providers` optionally limits the
 * removal to specific provider registrations; omitted removes everywhere.
 */
export interface PortalMarketplaceRemovePayload {
  projectId: string;
  marketplaceId: string;
  providers?: PluginProvider[];
}

/**
 * Payload for `portal.marketplace.refresh_all`. FIRE-AND-FORGET: the browser
 * gets an immediate `202` and refetches later; the desktop's fan-out refresh
 * can far exceed both the long-RPC wait window and the 60s command TTL, and
 * the desktop still finishes (and completes the possibly-expired command
 * harmlessly) after the row has expired server-side.
 */
export interface PortalMarketplaceRefreshAllPayload {
  projectId: string;
}

/**
 * Result of `portal.marketplace.add` / `portal.marketplace.update`: the fresh
 * marketplace projected through the same reduced row builder as
 * `portal.plugins.list_marketplaces`.
 */
export interface PortalMarketplaceMutationResult {
  marketplace: PortalMarketplaceRow;
  /**
   * True when the row's plugin list was prefix-cut to fit
   * {@link PORTAL_CATALOG_RESULT_MAX_BYTES}. Absent means complete.
   */
  truncated?: boolean;
}

/**
 * Result of `portal.marketplace.remove`. `alreadyAbsent` is true when the
 * marketplace was not registered to begin with (removal is idempotent).
 */
export interface PortalMarketplaceRemoveResult {
  removed: true;
  alreadyAbsent?: boolean;
}

/**
 * Payload for `portal.mcp.set_config_enabled`: flip the `enabled` flag on one
 * config of a standalone MCP server. Deliberately NARROW — the browser names
 * ids and a boolean only and the desktop re-reads, mutates, and saves its own
 * stored `McpServerData` through the normal validated save path, because the
 * browser's copy of the server is REDACTED and must never round-trip back.
 */
export interface PortalMcpSetConfigEnabledPayload {
  projectId: string;
  serverId: string;
  configId: string;
  enabled: boolean;
}

/**
 * Result of `portal.mcp.set_config_enabled`: the saved server, projected
 * through the same REDACTED detail shape as `portal.mcp.get_server`.
 */
export interface PortalMcpSetConfigEnabledResult {
  server: PortalMcpServerDetail;
  /**
   * True when the config list was prefix-cut to fit
   * {@link PORTAL_CATALOG_RESULT_MAX_BYTES}. Absent means complete.
   */
  truncated?: boolean;
}

export interface PortalStandaloneChatCreatePayload {
  projectLocalId: string;
  chatId: string;
  /**
   * Sidebar item group the new Work Entry joins, as on
   * `portal.standalone_chat.send`. Applies only when the entry is created.
   */
  sidebarItemGroupId?: string;
  /** Add the chat to this existing Work Entry (`work_entry_commands_v1`). */
  workEntryId?: string;
  /**
   * Group a new Work Entry joins by name, creating it when missing. Applies
   * only when the entry is created (`work_entry_commands_v1`).
   */
  sidebarItemGroupName?: PortalTaskSidebarItemGroupName;
  /** Submit the chat's first message (`work_entry_commands_v1`). */
  firstChat?: PortalTaskFirstChat;
}

export interface PortalStandaloneChatCreateResult {
  ok: true;
  chatId: string;
  projectLocalId: string;
  projectId: string;
  worktreeId: string;
  workEntryId: string;
  chat?: PortalTaskFirstChatResult;
  /** Why the first chat message was not sent; the chat itself was created. */
  chatError?: string;
  /** Why the new Work Entry stayed ungrouped; the chat itself was created. */
  groupError?: string;
}

/**
 * Canonical payload for `portal.standalone_chat.send`. Mirrors the
 * `sendStandaloneChatMessage` service signature in transport Phase T17.
 */
export interface PortalStandaloneChatSendPayload extends SidebarItemGroupCreationOptions {
  /** Local id of the standalone chat project/container. */
  projectLocalId?: string;
  /** Service-layer alias for `projectLocalId`; retained for local callers. */
  projectId?: string;
  /** Local id of the standalone chat thread (matches `PortalSession.chatLocalId`). */
  chatId: string;
  userMessageId?: string;
  fileReferences?: PortalChatFileReference[];
  cloudAttachments?: PortalChatCloudAttachmentRef[];
  /** Plain-text user prompt. */
  message: string;
  /** Optional model override; the local service falls back to the chat default. */
  model?: string;
  /**
   * Optional per-turn provider config (thinking level + fast mode). Additive in
   * CAN-1217 so the standalone composer's thinking/fast chips carry their values
   * on send. The desktop standalone service already reads these fields; this
   * only makes the wire contract explicit.
   */
  modelConfig?: PortalAgentModelConfig;
  /** How the user composed this turn; drives voice-specific presentation. */
  inputMode?: 'typed' | 'voice';
  /**
   * Optional provider override for this turn.
   *
   * It selects a stored default ONLY when neither this payload nor the target
   * chat tab names a model. The desktop pairs a provider with whoever supplied
   * the model — payload model → this field; tab model → the provider derived
   * from that model, and this field is ignored; no model at all → this field,
   * else the tab's provider — because an explicit `providerType` outranks the
   * model's own provider downstream, so a mismatched pair would start a
   * session for one provider running another provider's model id.
   *
   * Declared because web already sends it (`portal-shell.tsx` spreads it
   * independently of `model`, from the cowork reference chat's provider) and
   * the desktop service already consumes it. It was previously live on the
   * wire but absent from this contract, which led the cowork send preflight to
   * judge `'claude'` for a turn that would dispatch a Codex default.
   */
  providerType?: PortalChatAgentProviderType;
  /** @deprecated Use modelConfig.thinkingLevel. */
  thinkingLevel?: PortalChatThinkingLevel;
}

/** Canonical payload for `portal.standalone_chat.cancel`. */
export interface PortalStandaloneChatCancelPayload {
  /** Local id of the standalone chat project/container. */
  projectLocalId?: string;
  /** Service-layer alias for `projectLocalId`; retained for local callers. */
  projectId?: string;
  /** Local id of the standalone chat whose run should be cancelled. */
  chatId: string;
}

/**
 * Payload for `portal.standalone_chat.set_model` (CAN-1219). Persists the model
 * on a standalone/cowork chat tab WITHOUT sending a message, so the portal's
 * standalone model picker mirrors desktop cowork's persistent picker. The
 * desktop standalone adapter validates and persists it, then re-projects the
 * standalone summary so the portal reconciles.
 */
export interface PortalStandaloneChatSetModelPayload {
  /** Local id of the standalone chat project/container. */
  projectLocalId?: string;
  /** Service-layer alias for `projectLocalId`; retained for local callers. */
  projectId?: string;
  /** Local id of the standalone chat thread. */
  chatId: string;
  /** Registry model id to persist as the chat default. */
  model: PortalChatModel;
  /** Explicit choice advertised by the paired desktop's model catalog. */
  executionHarness?: AgentExecutionHarness;
}

/**
 * Payload for `portal.standalone_chat.set_plugin_selections` (CAN-3923). The
 * standalone equivalent of `portal.chat.set_plugin_selections`: persists the
 * full selection set on an existing standalone chat WITHOUT sending a
 * message. The desktop normalizes the selections, commits them through the
 * canonical chat writer and re-projects the standalone summary.
 */
export interface PortalStandaloneChatSetPluginSelectionsPayload {
  /** Committed atomically with selections when the host advertises support. */
  deferredToolsAllowed?: boolean;
  /** Local id of the standalone chat project/container. */
  projectLocalId?: string;
  /** Service-layer alias for `projectLocalId`; retained for local callers. */
  projectId?: string;
  /** Local id of the standalone chat thread. */
  chatId: string;
  selections: PortalChatTabPluginSelections;
}

// Terminal
export interface PortalTerminalOpenPayload {
  relativeCwd?: string;
  projectId: string;
  worktreeId: string;
  selectedRepoId?: string;
  cols: number;
  rows: number;
}

export interface PortalTerminalWritePayload {
  terminalId: string;
  data: string;
}

export interface PortalTerminalResizePayload {
  terminalId: string;
  cols: number;
  rows: number;
}

export interface PortalTerminalClosePayload {
  terminalId: string;
}

// Scripts
export interface PortalScriptRunPayload {
  target: 'project' | 'workspace-repo' | 'workspace-root';
  scriptName: string;
  projectId?: string;
  worktreeId?: string;
  workspaceId?: string;
  repoId?: string;
}

export interface PortalScriptCancelPayload {
  projectId: string;
  worktreeId: string;
  scriptKey: string;
}

export interface PortalScriptSourceInfoPayload {
  target: 'project' | 'workspace-repo' | 'workspace-root';
  scriptName: string;
  projectId?: string;
  worktreeId?: string;
  workspaceId?: string;
  repoId?: string;
}

export interface PortalScriptLogRequestPayload {
  /** Composite script key (matches local `ScriptDescriptor.scriptKey`). */
  scriptKey: string;
  projectId?: string;
  worktreeId?: string;
  /** Optional cursor for incremental log fetches; opaque to the server. */
  afterLine?: number;
}

// Hooks
export interface PortalHookRunPayload {
  target: 'project' | 'workspace-repo' | 'workspace-root';
  triggerName: string;
  projectId?: string;
  worktreeId?: string;
  workspaceId?: string;
  repoId?: string;
}

export interface PortalHookCancelPayload {
  projectId: string;
  worktreeId: string;
  hookKey: string;
}

export interface PortalHookPausePayload {
  projectId: string;
  worktreeId: string;
  hookKey?: string;
  all?: boolean;
}

export interface PortalHookSourceInfoPayload {
  target: 'project' | 'workspace-repo' | 'workspace-root';
  triggerName: string;
  projectId?: string;
  worktreeId?: string;
  workspaceId?: string;
  repoId?: string;
}

// Plans
export interface PortalPlanListPayload {
  projectId: string;
  worktreeId: string;
}

export interface PortalPlanGetPayload extends PortalPlanListPayload {
  planId: string;
  /** Positive safe integer. Omit for latest; unavailable revisions return null. */
  revisionNumber?: number;
}

export interface PortalPlanCreatePayload extends PortalPlanListPayload {
  source: string;
  content: string;
  title?: string;
  reviewStatus?: string;
  linkedExecutionId?: string;
}

export interface PortalPlanUpdatePayload extends Omit<
  PortalPlanGetPayload,
  'revisionNumber'
> {
  content?: string;
  title?: string;
  source?: string;
  reviewStatus?: string;
  linkedExecutionId?: string;
  approvedAt?: string | null;
  dismissedAt?: string | null;
  hidden?: boolean;
}

export type PortalPlanDeletePayload = Omit<
  PortalPlanGetPayload,
  'revisionNumber'
>;

/**
 * Canonical payload for `portal.plan.open`. Identifies a plan by its local id
 * within a worktree so the local service can surface its content (e.g.
 * trigger the editor to open the plan file or stream its detail back as a
 * `plan` entity in a `plans`-scoped delta).
 */
export type PortalPlanOpenPayload = PortalPlanGetPayload;

/**
 * Canonical payload for `portal.workspace_items.list_notes`.
 *
 * `projectId` is the WORKSPACE id. For a cowork workspace the desktop resolves
 * notes, prompts, and attachments alike from the workspace root, so the browser
 * needs nothing beyond the id it already holds as
 * `PortalStandaloneChatEntity.projectLocalId`.
 */
export interface PortalWorkspaceItemsListNotesPayload {
  projectId: string;
}

/** Canonical payload for `portal.workspace_items.read_note`. */
export interface PortalWorkspaceItemsReadNotePayload {
  projectId: string;
  noteId: string;
}

/** Canonical payload for `portal.workspace_items.list_prompts`. */
export interface PortalWorkspaceItemsListPromptsPayload {
  projectId: string;
}

/** Canonical payload for `portal.workspace_items.read_prompt`. */
export interface PortalWorkspaceItemsReadPromptPayload {
  projectId: string;
  promptId: string;
}

/**
 * Canonical payload for `portal.workspace_items.list_attachments`.
 *
 * `worktreeId` is carried for the code-workspace case, whose attachments are
 * per-worktree. A cowork workspace ignores it — `listCoworkAttachments` reads
 * the workspace-level managed directory — but the one command must serve both.
 */
export interface PortalWorkspaceItemsListAttachmentsPayload {
  projectId: string;
  worktreeId: string;
}

/**
 * Browser-facing branch origin of a note/prompt composed from a worktree
 * surface. Mirrors the desktop `WorkspaceItemOrigin`.
 */
export interface PortalWorkspaceItemOrigin {
  worktreeId: string;
  branchName: string;
  worktreeExists: boolean;
}

export interface PortalWorkspaceNoteItem {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  origin?: PortalWorkspaceItemOrigin;
}

export interface PortalWorkspacePromptItem {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  origin?: PortalWorkspaceItemOrigin;
}

export interface PortalWorkspaceAttachmentItem {
  filename: string;
  sizeBytes: number;
  createdAt: string;
}

export interface PortalWorkspaceItemsListNotesResult {
  ok: true;
  notes: PortalWorkspaceNoteItem[];
  /**
   * True when entries were dropped to fit
   * {@link PORTAL_CATALOG_RESULT_MAX_BYTES}.
   */
  truncated?: boolean;
}

export interface PortalWorkspaceItemsReadNoteResult {
  ok: true;
  meta: PortalWorkspaceNoteItem;
  content: string;
  /**
   * True when `content` was cut at {@link PORTAL_CATALOG_CONTENT_MAX_BYTES}
   * (UTF-8 bytes, cut on a code-point boundary).
   */
  truncated: boolean;
}

export interface PortalWorkspaceItemsListPromptsResult {
  ok: true;
  prompts: PortalWorkspacePromptItem[];
  /**
   * True when entries were dropped to fit
   * {@link PORTAL_CATALOG_RESULT_MAX_BYTES}.
   */
  truncated?: boolean;
}

export interface PortalWorkspaceItemsReadPromptResult {
  ok: true;
  meta: PortalWorkspacePromptItem;
  content: string;
  /**
   * True when `content` was cut at {@link PORTAL_CATALOG_CONTENT_MAX_BYTES}
   * (UTF-8 bytes, cut on a code-point boundary).
   */
  truncated: boolean;
}

export interface PortalWorkspaceItemsListAttachmentsResult {
  ok: true;
  attachments: PortalWorkspaceAttachmentItem[];
  /**
   * True when entries were dropped to fit
   * {@link PORTAL_CATALOG_RESULT_MAX_BYTES}.
   */
  truncated?: boolean;
}

// Pipelines
export interface PortalPipelineInstallCuratedPayload {
  key: string;
  expectedContentHash: string;
}

export interface PortalPipelineInstallCuratedResult {
  pipelineId: string;
}

export interface PortalPipelineListPayload {
  /** When set, only return executions for this project's worktree. */
  projectId?: string;
  worktreeId?: string;
  /** Page size hint; the server may cap or ignore. */
  limit?: number;
}

/** Explicit workspace-scoped locator for an on-demand pipeline definition read. */
export interface PortalPipelineGetPayload {
  pipelineId: string;
  projectId: string;
  worktreeId?: string;
}

export interface PortalPipelineRunPayload {
  pipelineId: string;
  fileReferences?: PortalChatFileReference[];
  cwd?: string;
  inputs?: Record<string, string>;
  modelConfig?: PortalAgentModelConfig;
  /** @deprecated Use modelConfig.fastMode. */
  codexFastModeEnabled?: boolean;
  projectId?: string;
  worktreeId?: string;
  planId?: string;
  /** Local id of an already-fetched shared pipeline source, when applicable. */
  sharedPipeline?: { serverId: string; remoteId: string };
  /**
   * Where the run executes (CAN-6187, decision P6), apart from the task it
   * goes to. Absent runs on the desktop; the cloud target
   * (`CLOUD_PIPELINE_RUN_TARGET_ID`) asks for a cloud run. A desktop never
   * runs a targeted command itself: a cloud run can't go to a task yet
   * (CP-36), so it refuses it. Older desktops ignore the field, which is why
   * it bumped `REMOTE_PROTOCOL_VERSION`.
   */
  targetId?: string;
  /** Trigger context used by task- and plan-ready pipeline modes. */
  eventName?: 'task_ready' | 'plan_ready';
  eventData?: {
    task_ready?: {
      task_text?: string;
    };
    plan_ready?: {
      plan_text?: string;
      planId?: string;
    };
  };
}

export interface PortalPipelineCancelPayload {
  executionId: string;
}

export interface PortalPipelineExecutionGetPayload {
  executionId: string;
}

export interface PortalPipelineExecutionListPayload {
  projectId?: string;
  worktreeId?: string;
  limit?: number;
}

/** Saved output a chat follow-up reviews (CAN-3719). */
export type PortalPipelineChatFollowUpOutput = 'plan' | 'report';

/**
 * `portal.pipeline.chat_follow_up.prepare` (CAN-3719): asks the run owner's
 * desktop for the review prompt of one saved output. The desktop resolves
 * the saved reference itself; the client never sends a path, prompt or chat.
 * Read-only: preparation creates no chat and sends no message.
 */
export interface PortalPipelineChatFollowUpPreparePayload {
  projectId: string;
  worktreeId: string;
  executionId: string;
  output: PortalPipelineChatFollowUpOutput;
}

/**
 * Result of `portal.pipeline.chat_follow_up.prepare`. The client sends
 * {@link prompt} through the normal chat send to {@link chatId}, the owner's
 * active writable chat or another writable chat. A chat that its Claude Code
 * terminal drives is never chosen. An absent `chatId` means the owner has no
 * eligible chat, and the client creates a chat. {@link prompt} is
 * host-authored chat content that names the saved reference; clients send it
 * verbatim and never parse or build a path from it.
 */
export interface PortalPipelineChatFollowUpPrepareResult {
  executionId: string;
  projectId: string;
  worktreeId: string;
  output: PortalPipelineChatFollowUpOutput;
  prompt: string;
  chatId?: string;
}

export interface PortalPipelinePauseResponse {
  checkpointId: string;
  jobId: string;
  stepId: string;
  answers?: Record<string, string | number | boolean>;
}

export interface PortalPipelineResumePayload {
  executionId: string;
  pauseResponses?: PortalPipelinePauseResponse[];
}

export interface PortalPipelineRetryPayload {
  executionId: string;
}

export interface PortalPipelineRerunPayload {
  executionId: string;
}

export interface PortalPipelineLogRequestPayload {
  executionId: string;
  jobId: string;
  stepId: string;
  attempt?: number;
  iteration?: number;
}

/**
 * What `portal.pipeline.content.read` reads: one step's current attempt,
 * named by its physical job id (a matrix variant's own id), or the run's
 * saved report.
 */
export type PortalPipelineContentSource =
  | { kind: 'step_output'; jobId: string; stepId: string }
  | { kind: 'report' };

/**
 * Most UTF-16 code units in one `portal.pipeline.content.read` page. Even
 * when every unit needs a six-byte JSON escape, a page stays below
 * {@link PORTAL_CATALOG_RESULT_MAX_BYTES}.
 */
export const PORTAL_PIPELINE_CONTENT_PAGE_MAX_CHARS = 96 * 1024;

/**
 * Payload for `portal.pipeline.content.read` (CAN-3717): one page of a step's
 * complete readable output or of the run's saved report. Read on demand only;
 * streamed `pipeline_run` tails stay bounded. The desktop resolves every file
 * from the execution it owns; the client never names a path.
 */
export interface PortalPipelineContentReadPayload {
  projectId: string;
  worktreeId: string;
  executionId: string;
  source: PortalPipelineContentSource;
  /** UTF-16 offset of the page in the document. Omitted means 0. */
  offset?: number;
  /**
   * The first page's {@link PortalPipelineContentReadResult.revision}. When
   * the document changed since, the read fails with `stale` instead of
   * joining two versions.
   */
  revision?: string;
}

/**
 * One page of pipeline content. The document is complete when `nextOffset`
 * equals `length`; an empty document has `length` 0. Agent step output is the
 * assistant's readable text and the report is the desktop's report view
 * (text report, then JSON report), both `markdown`; any other step output is
 * its saved log, `text`.
 */
export interface PortalPipelineContentReadResult {
  format: 'markdown' | 'text';
  content: string;
  offset: number;
  nextOffset: number;
  length: number;
  revision: string;
}

// Diffs
/**
 * @deprecated Use {@link PortalDiffReadPayload} instead. The legacy
 * `portal.diff.request` shape is missing `worktreeId` in its historical
 * three-field form (`{ kind, projectId, filePath }`) and cannot be safely
 * aliased onto the canonical command. Validators MUST reject any legacy
 * payload missing `worktreeId` (transport plan Phase T2.2).
 */
export type PortalDiffRequestPayload =
  | {
      kind: 'activity';
      projectId: string;
      worktreeId: string;
      filePath: string;
      source: 'uncommitted' | 'committed' | 'combined';
      repoId?: string;
    }
  | {
      kind: 'turn';
      projectId: string;
      worktreeId: string;
      filePath: string;
      startTree: string;
      endTree: string;
      repoId?: string;
    };

/**
 * Canonical payload for `portal.diff.read` (transport plan Phase T2.2).
 * Mirrors the `readDiff` service signature in transport Phase T17. When
 * `path` is omitted the local service returns the combined diff for the
 * worktree. The legacy `portal.diff.request` shape (`{ kind, projectId,
 * filePath }`) has no `worktreeId` and is intentionally not aliased onto
 * this type.
 */
export interface PortalDiffReadPayload {
  workspaceId: string;
  worktreeId: string;
  /** Owning repo id when the path belongs to a multi-repo worktree. */
  repoId?: string;
  /** Relative path inside the worktree; omit for the combined diff. */
  path?: string;
  /**
   * Diff source to read. Omitted is accepted for older clients, but the Portal
   * UI sends this explicitly so committed-only files are read from the branch
   * range instead of the working tree.
   */
  source?: 'uncommitted' | 'committed' | 'combined';
}

// PR actions
export const PORTAL_CAPABILITY_PR_WORKTREE_ACTIONS =
  'pr_worktree_actions' as const;

/** PR status changes are pushed as pr_status deltas; idle reads are unnecessary. */
export const PORTAL_CAPABILITY_PR_STATUS_PUSH = 'pr_status_push_v1' as const;

/**
 * Why a repo cannot open a pull request. The desktop owns this vocabulary so
 * remote surfaces explain the blocker instead of hiding the action silently.
 */
export type PortalPrCreateBlockedReason =
  | 'pr_open'
  | 'pr_status_unavailable'
  | 'no_remote'
  | 'detached_head'
  | 'base_branch'
  | 'no_changes'
  | 'needs_pull'
  /**
   * Cloud (REG-3025): the worktree's sandbox is asleep, so its branch and
   * head cannot be read without waking it. Desktop never reports it.
   */
  | 'worktree_asleep';

/** Why a repo's open pull request cannot be merged. See the create twin. */
export type PortalPrMergeBlockedReason =
  | 'no_pr'
  | 'draft'
  | 'conflicts'
  | 'checks_failing'
  | 'checks_pending'
  | 'review_pending'
  | 'local_changes'
  | 'other_repo_changes'
  | 'not_ready';

/** Desktop-computed eligibility for the remote Activity drawer. */
export interface PortalWorktreePrActionsState {
  busy: boolean;
  repos: Array<
    PortalPullRequestRepo & {
      /** Base branch a new PR targets; absent when it cannot be resolved. */
      baseBranch?: string;
      /** Current local branch whose state the action buttons represent. */
      headBranch: string;
      canCreate: boolean;
      canMerge: boolean;
      mergeWarning: boolean;
      /** Set exactly when `canCreate` is false. */
      createBlockedReason?: PortalPrCreateBlockedReason;
      /** Set exactly when `canMerge` is false. */
      mergeBlockedReason?: PortalPrMergeBlockedReason;
      /**
       * The git sample the eligibility was decided from (cloud, REG-3025).
       * Optional and lenient-read: desktop omits them. `headSha` is sent
       * back as `expectedHeadSha` so a stale action is refused.
       */
      headSha?: string | null;
      /**
       * The open PR's head on GitHub (cloud, REG-3025): sent back with Merge
       * as `expectedHeadSha`, so a sandbox behind the PR can still merge what
       * the user saw. Null without an open PR.
       */
      prHeadSha?: string | null;
      /** Staged, unstaged or untracked changes exist. */
      dirty?: boolean;
      /** Commits not on the upstream; null without an upstream. */
      ahead?: number | null;
      /** Upstream commits not in HEAD; null without an upstream. */
      behind?: number | null;
      /** The branch has an upstream on the remote. */
      published?: boolean;
      /**
       * The branch has commits its base branch does not (REG-3025): what
       * the header's Create PR needs. Absent when unknown.
       */
      commitsAhead?: boolean;
    }
  >;
}

/**
 * Routing fields shared by every {@link PortalPrActionPayload} variant
 * (transport plan Phase T2.4). The discriminated union below adds per-action
 * fields on top.
 */
export interface PortalPrActionBase {
  workspaceLocalId: string;
  worktreeLocalId: string;
  /**
   * Optional repo scoping. When set, only the listed repos within the
   * worktree are touched (e.g. multi-repo workspaces where the user picks a
   * subset). Omit to apply the action to every repo in the worktree.
   */
  repoIds?: string[];
  /**
   * The HEAD the user saw when choosing the action (REG-3025). A host that
   * receives it refuses the action when the branch moved since. Optional:
   * desktop hosts do not read it.
   */
  expectedHeadSha?: string;
}

/**
 * Canonical payload for `portal.pr.action` (transport plan Phase T2.4).
 *
 * Discriminated by `action` so each variant carries only the fields it
 * needs and so future actions cannot silently fall through to a misspelled
 * `action` literal. The backend routes the envelope to the matching action
 * implementation; the frontend MUST only emit actions whose buttons are
 * enabled.
 *
 * `'create'` keeps the legacy fields (`title`, `body`, `draft`) — but
 * `title` and `body` are now required at the type level so the backend
 * cannot fall back to a derived branch label.
 */
export type PortalPrActionPayload =
  /** Requires PORTAL_CAPABILITY_PR_WORKTREE_ACTIONS; mutations select one repo. */
  | (PortalPrActionBase & { action: 'get_actions' })
  | (PortalPrActionBase & {
      action: 'create_auto';
      /** Identity snapshot displayed when the user chose this action. */
      expectedBaseBranch: string;
      expectedHeadBranch: string;
    })
  | (PortalPrActionBase & {
      action: 'merge';
      /** Identity snapshot displayed when the user chose this action. */
      expectedBaseBranch: string;
      expectedHeadBranch: string;
      expectedPrNumber: number;
      confirmUnresolvedComments?: boolean;
    })
  | (PortalPrActionBase & {
      action: 'create';
      /** PR title; required so the create flow has a deterministic header. */
      title: string;
      /** PR body / description; required for the same reason as `title`. */
      body: string;
      /** When true, opens the PR in draft state. */
      draft?: boolean;
    })
  | (PortalPrActionBase & {
      action: 'commit_and_push';
      /** Required commit message; the backend no longer scaffolds a default. */
      commitMessage: string;
    })
  | (PortalPrActionBase & {
      /**
       * Commit every change (cloud, REG-3025): the header's Commit & Push
       * with `push`, and Pull, Commit & Push with `pullFirst` too. Absent
       * `commitMessage` lets the host write one. Desktop hosts ignore it.
       */
      action: 'commit';
      commitMessage?: string;
      push?: boolean;
      pullFirst?: boolean;
    })
  | (PortalPrActionBase & {
      /**
       * Cancel the worktree's running git action (cloud, REG-3025). Desktop
       * hosts cancel through their own action store.
       */
      action: 'cancel';
    })
  | (PortalPrActionBase & { action: 'push' })
  | (PortalPrActionBase & { action: 'pull' })
  | (PortalPrActionBase & {
      action: 'update_base_branch';
      /** Target base branch (e.g. `main`). Required. */
      baseBranch: string;
      /**
       * When the local branch is behind the new base, rebase onto it
       * before updating the PR. Defaults to `false`.
       */
      rebaseOntoNewBase?: boolean;
    });

/**
 * Convenience alias for the `action` discriminator. Kept as a separate type
 * so call sites and validators can pin the closed action set without
 * re-deriving it from the payload union.
 */
export type PortalPrAction = PortalPrActionPayload['action'];

/**
 * Canonical payload for `portal.pr.refresh` (transport plan Phase T2.4).
 * Asks the local PR service to refresh its cached PR state for the
 * targeted worktree.
 */
export interface PortalPrRefreshPayload {
  workspaceLocalId: string;
  worktreeLocalId: string;
}

/** Starts a bounded, asynchronous full refresh of a worktree summary. */
export interface PortalSummaryRefreshPayload {
  projectId: string;
  worktreeId: string;
}

/**
 * Canonical payload for `portal.pr.create` (transport plan Phase T2.4).
 * Mirrors the `createPullRequest` service signature in transport Phase T17.
 */
export interface PortalPrCreatePayload {
  workspaceLocalId: string;
  worktreeLocalId: string;
  title: string;
  body: string;
  /** When true, the local service opens the PR in draft state. */
  draft?: boolean;
}

// Files
export interface PortalFileLinkResolvePayload {
  projectId: string;
  worktreeId: string;
  /** Agent-authored relative path, absolute path, or local file URL. */
  href: string;
  /** Cloud-only active chat whose sandbox must supply the resolved file. */
  chatId?: string;
}

/** Existing workspace file selected by a transcript link. */
export interface PortalFileLinkResolution {
  fileRootLocalId: string;
  relativePath: string;
}

export interface PortalFileRootsPayload {
  projectId: string;
  worktreeId: string;
}

export interface PortalFileDirectoryPayload {
  projectId: string;
  worktreeId: string;
  repoId: string;
  /** Empty string means the root of the repo/attachments/workspace. */
  relativeDir: string;
  /** Cloud sandbox reads wake a sleeping sandbox only after explicit consent. */
  wake?: boolean;
}

/**
 * Canonical payload shared by file-read, file-preview, and file-save
 * commands (transport plan Phase T1.1). Replaces the legacy
 * absolute-path-based payloads on the Portal wire so local Canopy can
 * perform safe containment checks: paths are resolved inside
 * `repoId`/`fileRootLocalId` and rejected when they escape.
 */
export interface PortalFileReadPayload {
  projectId: string;
  worktreeId: string;
  /** Multi-repo workspaces target a specific repo via `repoId`. */
  repoId?: string;
  /**
   * Alternative root scoping when `repoId` is not appropriate (e.g.
   * attachments root, workspace root). Either `repoId` OR `fileRootLocalId`
   * MUST be set; setting both is permitted but `fileRootLocalId` wins.
   */
  fileRootLocalId?: string;
  /** Path relative to the resolved root; empty string means the root itself. */
  relativePath: string;
}

/** A neutral file or changed-file diff selection opened by shared Code UI. */
export type PortalCodeViewerSelection =
  | {
      readonly kind: 'file';
      readonly title: string;
      /** Optional MIME metadata used only to select the in-app renderer. */
      readonly mediaType?: string;
      /** Optional client presentation metadata; never part of a file request. */
      readonly reveal?: { readonly line: number; readonly lineEnd?: number };
      readonly request: PortalFileReadPayload;
    }
  | {
      readonly kind: 'diff';
      readonly title: string;
      readonly request: PortalDiffReadPayload & {
        readonly source: 'uncommitted' | 'committed';
      };
    };

/**
 * Payload for `portal.file.preview`. Identical to
 * {@link PortalFileReadPayload}; the difference is server-side handling
 * (the preview pipeline truncates more aggressively than full-read).
 */
export type PortalFilePreviewPayload = PortalFileReadPayload;

/**
 * Payload for `portal.file.save` (transport plan Phase T1.1). Adds the
 * write fields on top of the canonical relative-path read payload.
 */
export interface PortalFileSavePayload extends PortalFileReadPayload {
  /** UTF-8 file body to write. */
  content: string;
  /** Opaque save-conflict cookie from the last confirmed file preview. */
  expectedVersion?: string;
  /**
   * `fs.stat().mtimeMs` of the file at load time. Round-tripped from
   * `portal.file.snapshot.modifiedAtMs`; the local service rejects the save
   * when supplied and the on-disk mtime has drifted by more than 1 ms.
   */
  expectedModifiedAtMs?: number;
}

export interface PortalFileMutationPayload {
  projectId: string;
  worktreeId: string;
  fileRootLocalId: string;
  /** Root-relative path, never empty. */
  relativePath: string;
}
export type PortalFileCreatePayload = PortalFileMutationPayload;
export type PortalFileMkdirPayload = PortalFileMutationPayload;
export interface PortalFileRenamePayload extends PortalFileMutationPayload {
  toRelativePath: string;
}
export interface PortalFileDeletePayload extends PortalFileMutationPayload {
  recursive?: boolean;
}
export interface PortalFileMutationResult {
  fileRootLocalId: string;
  path: string;
  kind: 'create' | 'mkdir' | 'rename' | 'delete';
  fromPath?: string;
  modifiedAt?: string;
}
export interface PortalFileIndexPayload {
  projectId: string;
  worktreeId: string;
  fileRootLocalId: string;
  /** Case-insensitive substring over the relative path. */
  q?: string;
  limit?: number;
  /** Bypass a cached snapshot on explicit Refresh. */
  refresh?: boolean;
}
export interface PortalFileIndex {
  fileRootLocalId: string;
  paths: string[];
  truncated: boolean;
}

/**
 * Payload for `portal.editor.list_slash_commands` — Phase 5 chat editor
 * support. Returns the slash-command catalog discovered for a particular
 * worktree so the shared Slate editor can populate its `/` typeahead without
 * the renderer holding any local discovery state.
 */
export interface PortalEditorListSlashCommandsPayload {
  projectId: string;
  worktreeId: string;
  /** Optional provider scope; defaults to all discovered providers. */
  providerType?: PortalChatAgentProviderType;
}

/**
 * Single slash-command row returned by
 * `portal.editor.list_slash_commands`. Mirrors the desktop's
 * `SlashCommandData` shape but lives on the wire so the web portal can
 * dispatch without importing renderer-only types.
 */
export interface PortalEditorSlashCommandOption {
  name: string;
  description?: string;
  displayName?: string;
  insertText?: string;
  category?: string;
}

/**
 * The chat an invocable inventory command acts on (CAN-3923). Worktree chats
 * are named by workspace, worktree and chat ids; standalone chats by their
 * project and chat ids. The desktop resolves the owning scope itself.
 */
export type PortalInvocableChatTarget =
  | { kind: 'worktree'; projectId: string; worktreeId: string; chatId: string }
  | { kind: 'standalone'; projectLocalId: string; chatId: string };

/**
 * Payload for `portal.editor.list_invocables`: the rows the desktop composer
 * offers for the chat's `/` and `$` menu, including "Available to enable"
 * rows from the cached invocable inventory.
 */
export interface PortalEditorListInvocablesPayload {
  target: PortalInvocableChatTarget;
  /** Optional provider scope; refused when it differs from the chat's. */
  providerType?: PortalChatAgentProviderType;
}

/**
 * One menu row returned by `portal.editor.list_invocables`, in desktop menu
 * order. `discovered` rows insert their text as is, unless
 * `requiresResolution` is set. `available` rows always require
 * `portal.editor.resolve_invocable`, which enables the item for the chat and
 * returns the text to insert.
 */
export interface PortalEditorInvocableOption extends PortalEditorSlashCommandOption {
  /** Plugin search identity; independent of the harness invocation text. */
  pluginName?: string;
  /** Original member identity, before harness-specific name projection. */
  memberName?: string;
  section: 'discovered' | 'available';
  /** Opaque inventory row id; present on inventory-backed rows. */
  entryId?: string;
  /** True when the row must be resolved before its text is inserted. */
  requiresResolution?: true;
}

/** Result of `portal.editor.list_invocables`. */
export interface PortalEditorListInvocablesResult {
  commands: PortalEditorInvocableOption[];
  /** The inventory cache is older than the last inventory change. */
  stale: boolean;
  /** The desktop is rebuilding the inventory cache. */
  rebuilding: boolean;
  /** ISO-8601 time the served inventory cache was built. */
  builtAt?: string;
  /** Rows were cut to fit the Portal result budget. */
  truncated?: true;
}

/** Payload for `portal.editor.resolve_invocable`. */
export interface PortalEditorResolveInvocablePayload {
  target: PortalInvocableChatTarget;
  /** {@link PortalEditorInvocableOption.entryId} of the chosen row. */
  entryId: string;
  /** Optional provider scope; refused when it differs from the chat's. */
  providerType?: PortalChatAgentProviderType;
}

/** Result of `portal.editor.resolve_invocable`. */
export interface PortalEditorResolveInvocableResult {
  /** Authoritative text to insert for this chat. */
  insertText: string;
  invocationKey: string;
  /**
   * The chat's committed selections when resolving enabled the item. Absent
   * when nothing had to be enabled.
   */
  pluginSelections?: PortalChatTabPluginSelections;
}

/**
 * Payload for `portal.editor.list_file_mentions` — returns the file-roots
 * plus a flat list of files for the `@`-mention typeahead. The local side
 * keeps the search-result list bounded so the wire payload stays small.
 */
export interface PortalEditorListFileMentionsPayload {
  projectId: string;
  worktreeId: string;
  /** Optional substring filter; the local side applies basic fuzzy matching. */
  query?: string;
  /** Maximum number of mention candidates to return (capped at 200). */
  limit?: number;
  selector?: {
    repoId: string;
    relativePath: string;
    kind: 'file' | 'directory';
  };
  rebind?: {
    sourceProjectId: string;
    sourceWorktreeId: string;
    fileReferences: PortalChatFileReference[];
  };
}

/**
 * Single file-mention row returned by
 * `portal.editor.list_file_mentions`. Carries everything the shared editor
 * needs to render a pill (`relativePath`, `referenceId`, optional
 * `repoName`).
 */
export interface PortalEditorFileMentionOption {
  repoId: string;
  repoName: string;
  relativePath: string;
  filename: string;
  referenceId: string;
  kind?: 'file' | 'directory';
  /** Set when the entry lives outside the repo (Canopy attachments root). */
  isAttachment?: boolean;
}

export interface PortalEditorFileMentionsResult {
  files: PortalEditorFileMentionOption[];
  fileReferences?: PortalChatFileReference[];
}

/**
 * Payload for `portal.session.set_view_mode` — persists the browser's last
 * selected view mode (worktrees vs. standalone-chats) server-side so the
 * portal shell can restore the same mode after a reload.
 */
export interface PortalSetViewModePayload {
  viewMode: PortalViewMode;
}

/**
 * Payload for `portal.workspace.set_section_order` — persists the user's
 * preferred activity section order for a given workspace so the activity
 * rail renders sections in the same order across reloads. `order` mirrors
 * `WorkspaceIndexEntry.activitySectionOrder` on the desktop.
 */
export interface PortalSetSectionOrderPayload {
  workspaceLocalId: string;
  order: string[];
}

/**
 * Payload for `portal.worktree.create` — asks the desktop to create a new
 * worktree ("task") in the given workspace, mirroring the desktop sidebar's
 * add-worktree / Create Task action. `workspaceId` is the portal workspace
 * localId (1:1 with the desktop workspace id); the desktop auto-generates the
 * branch name and picks single- vs multi-repo creation from the workspace type.
 */
export interface PortalWorktreeCreatePayload extends SidebarItemGroupCreationOptions {
  workspaceId: string;
  /**
   * Initial model for the chat allocated with this task. Cloud hosts use it
   * when starting the Core session; desktop hosts ignore it.
   */
  model?: PortalChatModel;
  /** Initial Auto mode; absent means manual for older hosts. */
  modelSelectionMode?: 'auto';
  /** Initial composer model settings for the allocated chat. */
  modelConfig?: PortalAgentModelConfig;
  /**
   * Existing worktree ids in the workspace, used by the desktop to keep the
   * auto-generated default branch name unique. Optional.
   */
  existingWorktreeIds?: string[];
  /** Optional existing worktree to branch the new one from. */
  baseWorktreeId?: string;
  /**
   * Marks a create dispatched for a submitted New Task composer so a cloud
   * host can attach a typed credit refusal to that recovery surface. Omitted
   * for workspace-header creates, which have no recoverable submission.
   */
  creditRecoveryIntent?: 'new-task';
  /**
   * Fork the base worktree's live chat tabs and copy its file tabs into the
   * new worktree. Archived chats remain attached only to the base worktree.
   * Used by the worktree-row "Branch from" action, not by ordinary create
   * flows that merely choose an existing Git base.
   */
  forkOpenTabs?: boolean;
  /**
   * Client-minted idempotency claim for the chat this create allocates, stable
   * across retries of the SAME submission. The cloud handler adopts it as the
   * Core `externalId`, so a retry after an ambiguous failure is answered from
   * the already-created row instead of minting a second billable session. Bare
   * (un-namespaced) to satisfy the desktop's `[a-z0-9][a-z0-9-]*` id rule.
   * The desktop create ignores it — a worktree owns no client-supplied id.
   */
  chatId?: string;
  /** Check out this existing branch instead of creating one (`worktree_create_from_v1`). */
  existingBranch?: string;
  /** Start the new branch from this base branch (`worktree_create_from_v1`). */
  baseBranch?: string;
  /**
   * A pull request on the project's repository: check out its head branch, or
   * start a new branch from it (`worktree_create_from_v1`).
   */
  pullRequest?: {
    number: number;
    as: 'checkout' | 'base';
    /**
     * The repository the caller named. The host refuses with
     * `pr_not_in_repository` unless it matches the root repository's current
     * `origin` (`project_repository_identity_v1`).
     */
    repository?: PortalRepositoryIdentity;
  };
  /** Join the group with this name, creating it when missing (`worktree_create_from_v1`). */
  sidebarItemGroupName?: PortalTaskSidebarItemGroupName;
  /**
   * Create the task's first chat and submit its first message, which waits
   * for git setup in the chat's queue (`worktree_create_from_v1`).
   */
  firstChat?: PortalTaskFirstChat;
}

/** A sidebar item group chosen by name; a missing group is created. */
export interface PortalTaskSidebarItemGroupName {
  name: string;
  color?: SidebarItemGroupColor;
}

/**
 * The first chat of a new task and its first message. `chatId` and
 * `userMessageId` are client-minted and stable across retries of the same
 * submission, so a redelivered create replays instead of adding a chat.
 */
export interface PortalTaskFirstChat {
  chatId: string;
  userMessageId: string;
  text: string;
  planMode?: boolean;
  model?: PortalChatModel;
  providerType?: PortalChatAgentProviderType;
  modelConfig?: PortalAgentModelConfig;
  pluginSelections?: PortalChatTabPluginSelections;
}

/** The first chat a task create made, and how its message was delivered. */
export interface PortalTaskFirstChatResult {
  chatId: string;
  userMessageId: string;
  delivery: 'started' | 'queued';
}

/**
 * Result of `portal.worktree.create`. `id` is the new worktree's id, as on
 * older hosts; `chat`, `chatError` and `groupError` are added by hosts with
 * `worktree_create_from_v1`.
 */
export interface PortalWorktreeCreateResult {
  id: string;
  branchName: string;
  createdAt?: string;
  trackedBaseBranch?: string | null;
  /** Git checkout state when the create completed; not the setup-script phase. */
  setupPhase?: 'git-pending' | 'git-ready';
  chat?: PortalTaskFirstChatResult;
  /** Why the task stayed ungrouped; the task itself was created. */
  groupError?: string;
  /** Why the first chat message was not sent; the task itself was created. */
  chatError?: string;
}

/**
 * `portal.work_entry.update` (`work_entry_commands_v1`): `title: null` clears
 * it. Work Entries have no Hide, so there is no `hidden` field.
 */
export interface PortalWorkEntryUpdatePayload {
  projectLocalId: string;
  entryId: string;
  title?: string | null;
}

/** `portal.work_entry.delete` (`work_entry_commands_v1`): `archive` keeps it as Archived. */
export interface PortalWorkEntryDeletePayload {
  projectLocalId: string;
  entryId: string;
  archive: boolean;
}

/** `portal.sidebar.item_groups.assign_named` (`sidebar_item_group_names_v1`). */
export interface PortalSidebarItemGroupsAssignNamedPayload {
  scope: SidebarItemGroupScope;
  itemId: string;
  name: string;
  color?: SidebarItemGroupColor;
}

export interface PortalSidebarItemGroupsAssignNamedResult {
  group: SidebarItemGroup;
  created: boolean;
}

/** `portal.task_refs.list` (`task_refs_v1`): branches and open pull requests to start a task from. */
export interface PortalTaskRefsListPayload {
  workspaceId: string;
  kind?: 'branch' | 'pr';
  /** Case-insensitive filter, 1-200 characters. */
  query?: string;
  limit: number;
  offset: number;
}

export type PortalTaskRef =
  | {
      kind: 'branch';
      name: string;
      local: boolean;
      remote: boolean;
      isDefault: boolean;
      /**
       * Any checkout has this branch, including one the host doesn't manage,
       * such as the repository root. Absent on older hosts.
       */
      checkedOut?: true;
      /** The worktree that has this branch checked out, when the host manages it. */
      checkedOutWorktreeId?: string;
    }
  | {
      kind: 'pr';
      number: number;
      title: string;
      headBranch: string;
      baseBranch: string;
      draft: boolean;
      updatedAt?: string;
      checkedOutWorktreeId?: string;
    };

export interface PortalTaskRefsListResult {
  items: PortalTaskRef[];
  /** Offset of the next page; absent on the last page. */
  nextOffset?: number;
}

/**
 * Payload for `portal.worktree.archive` — asks the desktop to remove an active
 * worktree while retaining a restorable item. An absent or `archive` mode keeps
 * that retained item until it is explicitly deleted; `delete` keeps it for the
 * workspace's deletion-retention window.
 * Clients must confirm first, and the action is gated by the
 * `canopy-portal-destructive-actions` flag. `workspaceId`/`worktreeId` are
 * the portal localIds (1:1 with the desktop ids).
 */
export interface PortalWorktreeArchivePayload {
  /** Absent means archive; delete requires host retention support. */
  mode?: 'archive' | 'delete';
  workspaceId: string;
  worktreeId: string;
  /**
   * CAN-5334: complete an ordinary refusal with `{ success: false, refusal }`
   * and its discard description instead of failing. Older desktops ignore it.
   */
  typedRefusal?: boolean;
}

/** Read-only organization repository ownership advice; never accepts a host path. */
export interface PortalOrgProjectsFindRepositoryOwnerPayload {
  remoteUrl: string;
}

/**
 * Persist a drag-reorder of two visible workspace rows. The desktop applies
 * the same active-over move used by its dnd-kit sidebar and normalizes the
 * resulting workspace order. Hidden workspaces keep their relative position.
 */
export interface PortalWorkspaceReorderPayload {
  activeWorkspaceId: string;
  overWorkspaceId: string;
}

/**
 * Update browser-editable worktree display metadata. `label: null` clears the
 * custom label; omitting `label` leaves it untouched. Hiding is reversible and
 * therefore is not part of the destructive-action feature gate.
 *
 * `trackedBaseBranch` sets the base branch the worktree tracks (mirrors
 * `WorktreeData.trackedBaseBranch`); `null` clears it and omitting it leaves
 * the tracked base untouched. `trackedRepoBaseBranches` does the same per
 * repository id in a multi-repository project.
 */
export interface PortalWorktreeUpdatePayload {
  workspaceId: string;
  worktreeId: string;
  label?: string | null;
  hidden?: boolean;
  trackedBaseBranch?: string | null;
  trackedRepoBaseBranches?: Record<string, string | null>;
}

/** Persist a drag-reorder of two visible worktrees in one workspace. */
export interface PortalWorktreeReorderPayload {
  workspaceId: string;
  activeWorktreeId: string;
  overWorktreeId: string;
}

/**
 * Payload for `portal.workspace.create` — asks the desktop to create a new
 * workspace ("project") from the browser Remote Control sidebar, mirroring the
 * desktop "add workspace" modal.
 *
 * Only the `remote-clone` mode is exposed today: the browser supplies a git
 * repo URL, the desktop resolves the clone destination itself (the default
 * repos directory) and derives the workspace name from the repo, exactly as
 * the desktop remote-add flow does. The desktop's "add existing local folder"
 * mode needs a native folder picker + a local path a browser cannot supply, and
 * the `cowork` mode is deferred (CAN-1199) because a freshly-created cowork
 * workspace does not yet surface in the portal standalone rail. The payload is
 * kept a discriminated union so those modes can be re-added without a breaking
 * change.
 *
 * Creation is additive (not destructive), so this command is NOT gated by the
 * `canopy-portal-destructive-actions` flag — matching `portal.worktree.create`.
 */
export type PortalWorkspaceCreatePayload = {
  kind: 'remote-clone';
  remoteUrl: string;
};

/**
 * Payload for `portal.workspace.delete` — asks the desktop to delete an entire
 * workspace (project), mirroring the desktop sidebar's delete-workspace action.
 * Deleting removes the persisted workspace directory (all of its worktree
 * checkouts, chats, and summaries) — it is irreversible, so the browser must
 * confirm first. Workspace removal is a first-class, always-available portal
 * action: it is NOT in {@link PORTAL_DESTRUCTIVE_COMMAND_TYPES} and therefore
 * NOT gated by the `canopy-portal-destructive-actions` flag; the confirmation
 * dialog is the safeguard. `workspaceId` is the portal workspace localId (1:1
 * with the desktop workspace id).
 */
export interface PortalWorkspaceDeletePayload {
  /** Absent means archive; delete requires host retention support. */
  mode?: 'archive' | 'delete';
  workspaceId: string;
  /**
   * CAN-5337: the interrupted deletion a person confirmed superseding, from
   * the project deletion discard description. Older desktops ignore it.
   */
  supersedeInterruptedDeletion?: string;
}

/**
 * Payload for `portal.workspace.update` — rename and/or recolor a workspace
 * from the browser workspace-settings dialog ("Details"). Both fields are
 * optional (send only what changed). `color` must be one of the desktop palette
 * swatches (`PROJECT_COLORS`); the desktop re-validates. Editing metadata is
 * additive, so this is NOT gated by the `canopy-portal-destructive-actions` flag.
 */
export interface PortalWorkspaceUpdatePayload {
  workspaceId: string;
  name?: string;
  color?: string;
  /**
   * Sidebar group collapse for the workspace header. A view preference, not a
   * CRUD edit: the browser persists its own copy and mirrors the choice here
   * so the paired desktop's sidebar index remembers it too.
   */
  collapsed?: boolean;
}

/**
 * Payload for `portal.workspace.claude_md.get` — read a workspace's editable
 * `CLAUDE.md` from the browser workspace-settings dialog. A small-RPC command:
 * the desktop returns the content in the command completion result
 * (`{ content }`), so the browser can populate the editor without waiting for an
 * out-of-band snapshot. For a source-backed workspace the desktop reads the
 * attached source repo's `CLAUDE.md`; a missing file returns an empty string.
 */
export interface PortalWorkspaceClaudeMdGetPayload {
  workspaceId: string;
}

/**
 * Payload for `portal.workspace.claude_md.save` — write a workspace's
 * `CLAUDE.md` from the browser workspace-settings dialog. Editing config is
 * additive (a normal file edit), so this is NOT gated by the
 * `canopy-portal-destructive-actions` flag.
 */
export interface PortalWorkspaceClaudeMdSavePayload {
  workspaceId: string;
  content: string;
}

/**
 * Payload for `portal.workspace.scripts.get` — read a workspace's lifecycle
 * script overrides for the browser settings Scripts section. Small-RPC: the
 * desktop returns the workspace `ScriptInputMap` in the completion result
 * (`{ scripts }`).
 */
export interface PortalWorkspaceScriptsGetPayload {
  workspaceId: string;
  /** Select a worktree's frozen setup rather than project configuration. */
  worktreeId?: string;
}

/**
 * Payload for `portal.workspace.scripts.save` — write a workspace's lifecycle
 * script commands. `commands` maps a script name (e.g. `setup`/`launch`/
 * `teardown`) to its command string; an empty string clears (removes) that
 * script. The browser only sends the phases it edited: the desktop MERGES them
 * into the persisted `ScriptInputMap`, preserving untouched entries (custom
 * scripts, workspace-root phases) AND any non-command `ScriptDefinition` fields
 * (timeout/shell/dev-server) on edited entries, then persists through the same
 * `saveWorkspaceScripts`/`normalizeScriptInputMap` path the renderer uses.
 * Editing config is additive → NOT gated by the destructive flag.
 */
export interface PortalWorkspaceScriptsSavePayload {
  workspaceId: string;
  commands: Record<string, string>;
}

/**
 * Discriminated lookup table mapping `PortalCommandType` to its payload
 * alias. Adapters and tests can use `PortalCommandPayloadMap[type]` to get
 * the matching payload shape.
 */
export interface PortalCommandPayloadMap {
  'portal.personal_organization.projects.list': Record<string, never>;
  'portal.personal_organization.projects.convert': PersonalProjectConversionRequest;
  'portal.personal_organization.projects.status': { operationId: string };
  'portal.org_projects.shared_multi_repo': PortalSharedMultiRepoCommand;
  'portal.org_projects.find_repository_owner': PortalOrgProjectsFindRepositoryOwnerPayload;
  'portal.sidebar.item_groups.list': { scope: SidebarItemGroupScope };
  'portal.sidebar.item_groups.create': SidebarItemGroupCreateRequest;
  'portal.sidebar.item_groups.update': SidebarItemGroupUpdateRequest;
  'portal.sidebar.item_groups.ungroup': {
    scope: SidebarItemGroupScope;
    groupId: string;
  };
  'portal.sidebar.item_groups.move_item': SidebarItemGroupMoveItemRequest;
  'portal.sidebar.item_groups.move_group': SidebarItemGroupMoveRequest;
  'portal.sidebar.item_groups.assign_named': PortalSidebarItemGroupsAssignNamedPayload;
  'portal.auth.validate_code': PortalAuthValidateCodePayload;
  'portal.session.end': PortalSessionEndPayload;
  'portal.state.request': PortalStateRequestPayload;
  'portal.chat.send': PortalChatSendPayload;
  'portal.chat.cancel': PortalChatCancelPayload;
  'portal.chat.cancel_turn': PortalChatCancelTurnPayload;
  'portal.watcher.delete': PortalWatcherDeletePayload;
  'portal.chat.mark_read': PortalChatMarkReadPayload;
  'portal.chat.set_unread': PortalChatSetUnreadPayload;
  'portal.chat.visual.read': PortalChatVisualReadPayload;
  'portal.chat.queue.cancel': PortalChatQueueEntryPayload;
  'portal.chat.queue.edit': PortalChatQueueEditPayload;
  'portal.chat.queue.force': PortalChatQueueEntryPayload;
  'portal.chat.queue.steer': PortalChatQueueEntryPayload;
  'portal.chat.input_delivery': PortalChatInputDeliveryPayload;
  'portal.chat.queue.set_edit_lock': PortalChatQueueSetEditLockPayload;
  'portal.chat.set_model': PortalChatSetModelPayload;
  'portal.chat.set_thinking_level': PortalChatSetThinkingLevelPayload;
  'portal.chat.set_plan_mode': PortalChatSetPlanModePayload;
  'portal.chat.set_fast_mode': PortalChatSetFastModePayload;
  'portal.chat.set_plugin_selections': PortalChatSetPluginSelectionsPayload;
  'portal.chat.list_plugin_catalog': PortalChatListPluginCatalogPayload;
  'portal.chat.create_tab': PortalChatCreateTabPayload;
  'portal.chat.fork': PortalChatForkPayload;
  'portal.chat.branch': PortalChatBranchPayload;
  'portal.chat.share': PortalChatSharePayload;
  'portal.chat.close_tab': PortalChatCloseTabPayload;
  'portal.chat.answer_question': PortalChatAnswerQuestionPayload;
  'portal.chat.dismiss_question': PortalChatDismissQuestionPayload;
  'portal.standalone_chat.send': PortalStandaloneChatSendPayload;
  'portal.standalone_chat.create': PortalStandaloneChatCreatePayload;
  'portal.standalone_chat.cancel': PortalStandaloneChatCancelPayload;
  'portal.standalone_chat.set_model': PortalStandaloneChatSetModelPayload;
  'portal.standalone_chat.set_plugin_selections': PortalStandaloneChatSetPluginSelectionsPayload;
  'portal.app_advisor.send': PortalAppAdvisorSendPayload;
  'portal.app_advisor.cancel': PortalAppAdvisorCancelPayload;
  'portal.app_advisor.set_model': PortalAppAdvisorSetModelPayload;
  'portal.app_advisor.create_tab': PortalAppAdvisorCreateTabPayload;
  'portal.app_advisor.close_tab': PortalAppAdvisorCloseTabPayload;
  'portal.app_advisor.answer_question': PortalAppAdvisorAnswerQuestionPayload;
  'portal.app_advisor.dismiss_question': PortalAppAdvisorDismissQuestionPayload;
  'portal.app_advisor.settings.get': PortalAppAdvisorSettingsGetPayload;
  'portal.app_advisor.settings.save': PortalAppAdvisorSettingsSavePayload;
  'portal.suggestions.get': Record<string, never>;
  'portal.suggestions.update': SuggestionsUpdate;
  'portal.onboarding_tips.get': PortalOnboardingTipsGetPayload;
  'portal.onboarding_tips.update': OnboardingTipsUpdate;
  'portal.claude_mods.get': ClaudeModsGetArgs;
  'portal.claude_mods.update': ClaudeModsUpdate;
  'portal.script_actions.list': ScriptActionsListRequest;
  'portal.script_actions.rescan': ScriptActionsContext;
  'portal.script_actions.review': ScriptActionsReviewRequest;
  'portal.script_actions.set_shortcut': ScriptActionsShortcutRequest;
  'portal.script_actions.set_pinned': ScriptActionsPinRequest;
  'portal.script_actions.enable_shell_alias_scan': ScriptActionsContext;
  'portal.script_actions.receipt': ScriptActionsReceiptRequest;
  'portal.terminal.open': PortalTerminalOpenPayload;
  'portal.terminal.write': PortalTerminalWritePayload;
  'portal.terminal.resize': PortalTerminalResizePayload;
  'portal.terminal.close': PortalTerminalClosePayload;
  'portal.script.run': PortalScriptRunPayload;
  'portal.script.cancel': PortalScriptCancelPayload;
  'portal.script.source_info': PortalScriptSourceInfoPayload;
  'portal.script.log_request': PortalScriptLogRequestPayload;
  'portal.hook.run': PortalHookRunPayload;
  'portal.hook.cancel': PortalHookCancelPayload;
  'portal.hook.pause': PortalHookPausePayload;
  'portal.hook.resume': PortalHookPausePayload;
  'portal.hook.source_info': PortalHookSourceInfoPayload;
  'portal.plan.list': PortalPlanListPayload;
  'portal.plan.get': PortalPlanGetPayload;
  'portal.plan.create': PortalPlanCreatePayload;
  'portal.plan.update': PortalPlanUpdatePayload;
  'portal.plan.delete': PortalPlanDeletePayload;
  'portal.plan.open': PortalPlanOpenPayload;
  'portal.workspace_items.list_notes': PortalWorkspaceItemsListNotesPayload;
  'portal.workspace_items.read_note': PortalWorkspaceItemsReadNotePayload;
  'portal.workspace_items.list_prompts': PortalWorkspaceItemsListPromptsPayload;
  'portal.workspace_items.read_prompt': PortalWorkspaceItemsReadPromptPayload;
  'portal.workspace_items.list_attachments': PortalWorkspaceItemsListAttachmentsPayload;
  'portal.pipeline.list': PortalPipelineListPayload;
  'portal.pipeline.get': PortalPipelineGetPayload;
  'portal.pipeline.run': PortalPipelineRunPayload;
  'portal.pipeline.cancel': PortalPipelineCancelPayload;
  'portal.pipeline.execution.get': PortalPipelineExecutionGetPayload;
  'portal.pipeline.execution_list': PortalPipelineExecutionListPayload;
  'portal.pipeline.resume': PortalPipelineResumePayload;
  'portal.pipeline.retry': PortalPipelineRetryPayload;
  'portal.pipeline.rerun': PortalPipelineRerunPayload;
  'portal.pipeline.log_request': PortalPipelineLogRequestPayload;
  'portal.pipeline.content.read': PortalPipelineContentReadPayload;
  'portal.pipeline.chat_follow_up.prepare': PortalPipelineChatFollowUpPreparePayload;
  'portal.diff.read': PortalDiffReadPayload;
  'portal.pr.action': PortalPrActionPayload;
  'portal.pr.refresh': PortalPrRefreshPayload;
  'portal.summary.refresh': PortalSummaryRefreshPayload;
  'portal.pr.create': PortalPrCreatePayload;
  'portal.file.resolve_link': PortalFileLinkResolvePayload;
  'portal.file.roots': PortalFileRootsPayload;
  'portal.file.directory': PortalFileDirectoryPayload;
  'portal.file.preview': PortalFilePreviewPayload;
  'portal.file.read': PortalFileReadPayload;
  'portal.file.asset.read': PortalFileAssetReadPayload;
  'portal.chat.asset.read': PortalChatAssetReadPayload;
  'portal.chat.transcript.page': PortalChatTranscriptPagePayload;
  'portal.chat.transcript.blocks.page': PortalChatTranscriptBlocksPagePayload;
  'portal.chat.content.read': PortalChatContentReadPayload;
  'portal.file.save': PortalFileSavePayload;
  'portal.editor.list_slash_commands': PortalEditorListSlashCommandsPayload;
  'portal.editor.list_file_mentions': PortalEditorListFileMentionsPayload;
  'portal.editor.list_invocables': PortalEditorListInvocablesPayload;
  'portal.editor.resolve_invocable': PortalEditorResolveInvocablePayload;
  'portal.session.set_view_mode': PortalSetViewModePayload;
  'portal.workspace.set_section_order': PortalSetSectionOrderPayload;
  'portal.workspace.reorder': PortalWorkspaceReorderPayload;
  'portal.worktree.create': PortalWorktreeCreatePayload;
  'portal.worktree.archive': PortalWorktreeArchivePayload;
  'portal.worktree.discard.describe': PortalWorktreeDiscardDescribePayload;
  'portal.worktree.discard': PortalWorktreeDiscardPayload;
  'portal.worktree.update': PortalWorktreeUpdatePayload;
  'portal.work_entry.update': PortalWorkEntryUpdatePayload;
  'portal.work_entry.delete': PortalWorkEntryDeletePayload;
  'portal.task_refs.list': PortalTaskRefsListPayload;
  'portal.worktree.reorder': PortalWorktreeReorderPayload;
  'portal.workspace.create': PortalWorkspaceCreatePayload;
  'portal.workspace.delete': PortalWorkspaceDeletePayload;
  'portal.workspace.delete.discard.describe': PortalProjectDeletionDiscardDescribePayload;
  'portal.lifecycle_journal.inspect': Record<string, never>;
  'portal.lifecycle_journal.quarantine': LifecycleJournalQuarantineRequest;
  'portal.workspace.update': PortalWorkspaceUpdatePayload;
  'portal.workspace.claude_md.get': PortalWorkspaceClaudeMdGetPayload;
  'portal.workspace.claude_md.save': PortalWorkspaceClaudeMdSavePayload;
  'portal.workspace.scripts.get': PortalWorkspaceScriptsGetPayload;
  'portal.workspace.scripts.save': PortalWorkspaceScriptsSavePayload;
  'portal.plugins.list_marketplaces': PortalPluginsListMarketplacesPayload;
  'portal.plugins.get_plugin_detail': PortalPluginsGetPluginDetailPayload;
  'portal.plugins.read_component_content': PortalPluginsReadComponentContentPayload;
  'portal.plugins.install_builtin': PortalPluginsInstallBuiltinPayload;
  'portal.plugins.share_plugin': PortalPluginsSharePluginPayload;
  'portal.plugins.install_external': PortalPluginsInstallExternalPayload;
  'portal.marketplace.add': PortalMarketplaceAddPayload;
  'portal.marketplace.update': PortalMarketplaceUpdatePayload;
  'portal.marketplace.remove': PortalMarketplaceRemovePayload;
  'portal.marketplace.refresh_all': PortalMarketplaceRefreshAllPayload;
  'portal.skills.list': PortalSkillsListPayload;
  'portal.skills.read': PortalSkillsReadPayload;
  'portal.skills.share_skill': PortalSkillsShareSkillPayload;
  'portal.sharing.account': PortalSharingAccountPayload;
  'portal.sharing.existing_share': PortalSharingExistingSharePayload;
  'portal.pipeline.share': PortalPipelineSharePayload;
  'portal.pipeline.install_curated': PortalPipelineInstallCuratedPayload;
  'portal.collections.share': PortalCollectionsSharePayload;
  'portal.sharing.list_teams': PortalSharingListTeamsPayload;
  'portal.sharing.list_organizations': PortalSharingListOrganizationsPayload;
  'portal.mcp.list_servers': PortalMcpListServersPayload;
  'portal.mcp.get_server': PortalMcpGetServerPayload;
  'portal.mcp.set_config_enabled': PortalMcpSetConfigEnabledPayload;
  'portal.mcp.test_connection': PortalMcpGetServerPayload & {
    configId?: string;
  };
  'portal.mcp.delete_server': PortalMcpGetServerPayload;
  'portal.collections.list': PortalCollectionsListPayload;
  'portal.collections.get': PortalCollectionsGetPayload;
  'portal.collections.save': PortalCollectionsSavePayload;
  'portal.collections.apply_update': PortalCollectionsApplyUpdatePayload;
  'portal.installed_items.list_status': { projectId: string };
  'portal.installed_items.set_status': SetInstalledItemStatusRequest & {
    projectId: string;
  };
  'portal.installed_items.uninstall': UninstallInstalledItemRequest & {
    projectId: string;
  };
  'portal.provider_usage.refresh': PortalProviderUsageRefreshPayload;
}

// ---------------------------------------------------------------------------
// Feature event payloads
// ---------------------------------------------------------------------------

/**
 * Legacy flat chat-message payload retained for two reasons:
 *
 * 1. Backward-compatible ingestion of in-flight `portal.chat.event` frames
 *    emitted by older local Canopy builds before the wrapped
 *    {@link PortalChatEventPayload} contract.
 * 2. The DB-projected / browser-shell-state row shape — the cached
 *    `PortalChatMessage` table on the server and the `PortalChatMessageView`
 *    rows surfaced into the renderer panel state are flat and denormalize
 *    the routing fields per-message.
 *
 * Wire ingestion MUST also accept the canonical wrapped
 * {@link PortalChatEventPayload}; both shapes are normalized into the same
 * internal {@link NormalizedPortalChatMessage} shape before the row is
 * upserted.
 *
 * Normalization rules (kept in lockstep with
 * `repos/canopy/src/shared/types/portal.ts`):
 *
 * - If the inbound payload has `{ message }`, treat it as a wrapped
 *   {@link PortalChatEventPayload}; otherwise treat it as this flat shape.
 * - `localChatId    = wrapped.chatId   ?? wrapped.message.chatId   ?? flat.localChatId`
 * - `localMessageId = wrapped.message.messageId ?? flat.localMessageId`
 * - `content        = wrapped.message.text       ?? flat.content`
 * - `occurredAt     = new Date(wrapped.message.updatedAtMs ?? wrapped.message.createdAtMs ?? flat.occurredAt)`
 * - `parts          = wrapped.message.parts ?? flat.parts`
 * - `role           = wrapped.message.role  ?? flat.role`
 * - `status         = wrapped.message.status ?? flat.status`
 * - `scope          = (wrapped|flat).scope === 'standalone' ? 'STANDALONE' : (wrapped|flat).scope === 'app_advisor' ? 'APP_ADVISOR' : 'WORKTREE'`
 * - `workspaceLocalId / worktreeLocalId` are forwarded unchanged.
 */
export interface PortalChatMessagePayload {
  scope: PortalChatScope;
  localChatId: string;
  localMessageId: string;
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  status: 'pending' | 'streaming' | 'complete' | 'failed' | 'cancelled';
  content: string;
  parts?: unknown;
  occurredAt: string;
}

/**
 * Internal normalization shape consumed by backend ingestion (transport plan
 * Phase T3 / Phase T14). Inbound `portal.chat.event` payloads — both the
 * canonical wrapped {@link PortalChatEventPayload} and the legacy flat
 * {@link PortalChatMessagePayload} — are rewritten into this shape before any
 * Prisma upsert happens, so the upsert path has a single normalized input
 * shape.
 *
 * `parts` is typed as `JsonValue` so the normalized row can be
 * forwarded straight to `prisma.portalChatMessage.upsert(...)` without an
 * additional cast at the call site.
 */
export interface NormalizedPortalChatMessage {
  /** A user reply within the current turn, rather than a new turn boundary. */
  continuesTurn?: boolean;
  /** Internal scope discriminator (uppercase to match the Prisma enum). */
  scope: 'WORKTREE' | 'STANDALONE' | 'APP_ADVISOR';
  /** Local id of the owning chat thread. */
  localChatId: string;
  /** Local id of this individual message. */
  localMessageId: string;
  /** Owning workspace local id (worktree-scoped chats only). */
  workspaceLocalId?: string | null;
  /** Owning worktree local id (worktree-scoped chats only). */
  worktreeLocalId?: string | null;
  /** Sender role on this message. */
  role: 'user' | 'assistant' | 'system';
  /** Lifecycle of the message. */
  status: 'streaming' | 'complete' | 'failed' | 'cancelled';
  /** Plain-text content extracted from `text` (wrapped) / `content` (flat). */
  content: string;
  /** Optional rich-block payload, forwarded as protocol JSON. */
  parts?: JsonValue;
  /**
   * Wall-clock timestamp the message most-recently transitioned at; derived
   * from `updatedAtMs ?? createdAtMs` on the wrapped shape and `occurredAt`
   * on the legacy flat shape.
   */
  occurredAt: Date;
  /** Display-only files the user attached (user rows only). */
  attachments?: PortalChatMessageAttachment[];
  /**
   * Trusted marker on a user message another agent sent: a Canopy chat, or an
   * external MCP agent the desktop attaches only from a validated command
   * `origin` (provenance.md). Never includes hidden instructions. Absent on
   * ordinary messages.
   */
  agentSent?: AgentSentInfo;
}

export interface PortalChatMessageView {
  /** A user reply within the current turn, rather than a new turn boundary. */
  continuesTurn?: boolean;
  scope: PortalChatScope;
  localChatId: string;
  localMessageId: string;
  /** Authoritative transcript position when presentation order differs from time. */
  presentationOrder?: number;
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  role: string;
  status: string;
  content: string;
  /** Caller-owned idempotency key for reconciling optimistic user messages. */
  clientRequestId?: string;
  /** Author attribution for a shared cloud-chat user turn. */
  author?: { userId: string; name: string; image?: string };
  parts?: unknown;
  /**
   * Core's per-turn namespace for the message, when the runtime recorded one.
   * The stable turn identity the cloud client uses to prove a replayed
   * terminal frame IS this hydrated row rather than a distinct turn that
   * happens to repeat its text.
   */
  sourceKey?: string;
  occurredAt: string;
  /** Files the user attached to this message (user rows only). */
  attachments?: PortalChatMessageAttachment[];
  /**
   * Trusted marker on a user message another agent sent: a Canopy chat, or an
   * external MCP agent the desktop attaches only from a validated command
   * `origin` (provenance.md). Never includes hidden instructions. Absent on
   * ordinary messages.
   */
  agentSent?: AgentSentInfo;
}

/**
 * Streamed PTY output frame published as a `portal.terminal.output`
 * envelope. The server appends `chunk` to the rolling terminal buffer keyed
 * by `terminalLocalId`.
 */
export interface PortalTerminalOutputPayload {
  terminalLocalId: string;
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  chunk: string;
  /** Monotonic byte sequence emitted by the local PTY. */
  seq?: number;
}

/**
 * Generic command-result payload published alongside `portal.command.completed`
 * or `portal.command.failed`. `response` carries the IPC return value when the
 * command produced one; `error` is the human-readable reason on failure.
 *
 * @deprecated Prefer the dedicated `PortalCommandCompletedPayload` and
 * `PortalCommandFailedPayload` shapes for new emitters. This generic shape is
 * retained for legacy emitters that have not yet been migrated; consumers
 * tolerate either shape because `PortalEventEnvelope.type` already discriminates
 * completion vs. failure.
 */
export interface PortalCommandResultPayload<TResponse = unknown> {
  /** Mirror of `PortalEventEnvelope.commandId` for ergonomic consumers. */
  commandId?: string;
  status: 'completed' | 'failed';
  response?: TResponse;
  error?: string;
}

/**
 * Canonical payload for a `portal.command.completed` event. Unlike the legacy
 * `PortalCommandResultPayload`, the discriminator is implicit in the envelope
 * `type` so the payload only carries the terminal data the browser needs to
 * advance its UI:
 *
 * - `commandId` — UUID of the originating command (mirror of
 *   `PortalEventEnvelope.commandId`).
 * - `sequenceNumber` — `PortalCommand.id` cursor of the originating command,
 *   so the browser can drop completion events for commands it issued before
 *   the last reload.
 * - `result` — IPC return value of the command, when one was produced.
 * - `generatedAt` — ISO-8601 timestamp of when local Canopy finished handling
 *   the command. Drives "last activity" UI hints.
 */
export interface PortalCommandCompletedPayload<TResult = unknown> {
  commandId: string;
  sequenceNumber: number;
  result?: TResult;
  /** Local adapters may resolve a handled command failure without throwing. */
  errorCode?: string;
  errorDetails?: unknown;
  generatedAt: string;
}

/**
 * Canonical payload for a `portal.command.failed` event. The `error` object is
 * structured so the browser can route on `code` (e.g. show a permission denied
 * banner vs. an unknown failure toast) without parsing free-form strings.
 *
 * `retryable` indicates whether the browser may resubmit the same command. It
 * is a hint, not a guarantee — the server's queue still applies its own retry
 * limits.
 */
export interface PortalCommandFailedPayload {
  /** Typed script-action, collection-save or task-refs-list refusal retained by the waited RPC path. */
  response?: { code: string; message: string };
  commandId: string;
  sequenceNumber: number;
  error: {
    code: string;
    message: string;
    coworkFolderMissing?: CoworkFolderMissing;
  };
  /** Typed `portal.worktree.create` refusal; absent on other failures and older hosts. */
  refusal?: PortalWorktreeCreateRefusal;
  retryable?: boolean;
  generatedAt: string;
}

/**
 * Why a host refused `portal.worktree.create`. Each value is also the
 * failure's `error.code`.
 */
export const PORTAL_WORKTREE_CREATE_REFUSAL_REASONS = [
  'branch_not_found',
  'branch_checked_out',
  'base_not_found',
  'branch_name_in_use',
  'checkout_in_use',
  'invalid_branch_name',
  'invalid_selection',
  'invalid_repository_selection',
  'unsupported_project',
  'read_only_project',
  'base_task_detached',
  'pr_not_found',
  'pr_not_in_repository',
] as const;

export type PortalWorktreeCreateRefusalReason =
  (typeof PORTAL_WORKTREE_CREATE_REFUSAL_REASONS)[number];

/** Path-free refusal detail on a failed `portal.worktree.create`. */
export interface PortalWorktreeCreateRefusal {
  reason: PortalWorktreeCreateRefusalReason;
  /** The worktree that has the branch checked out, when the host manages it. */
  existingWorktreeId?: string;
}

/**
 * Discriminated payload for `portal.script.event` envelopes. Local Canopy
 * emits `kind: 'upsert'` with a full entity envelope when a script descriptor
 * or run row changes, and `kind: 'remove'` (entity reference only) when a row
 * is deleted server-side.
 */
export type PortalScriptEventPayload =
  | { kind: 'upsert'; entity: PortalEntityEnvelope }
  | {
      kind: 'remove';
      entityType: PortalEntityType;
      localId: string;
      parentLocalId?: string;
    };

/** Discriminated payload for `portal.hook.event` envelopes. */
export type PortalHookEventPayload =
  | { kind: 'upsert'; entity: PortalEntityEnvelope }
  | {
      kind: 'remove';
      entityType: PortalEntityType;
      localId: string;
      parentLocalId?: string;
    };

/** Discriminated payload for `portal.plan.event` envelopes. */
export type PortalPlanEventPayload =
  | { kind: 'upsert'; entity: PortalEntityEnvelope }
  | {
      kind: 'remove';
      entityType: PortalEntityType;
      localId: string;
      parentLocalId?: string;
    };

/** Discriminated payload for `portal.pipeline.event` envelopes. */
export type PortalPipelineEventPayload =
  | { kind: 'upsert'; entity: PortalEntityEnvelope }
  | {
      kind: 'remove';
      entityType: PortalEntityType;
      localId: string;
      parentLocalId?: string;
    };

/**
 * Sentinel `filePath` value used by `portal.diff.snapshot` payloads when the
 * snapshot represents the whole-worktree (combined) diff rather than a
 * single changed file. Both repos MUST import this constant rather than
 * hard-coding the literal so a future rename is reflected in both ends of
 * the wire (transport plan Phase T2.3).
 */
export const PORTAL_DIFF_COMBINED_FILE_PATH = '__combined__';

/**
 * File-snapshot payload published as a `portal.file.snapshot` envelope
 * (transport plan Phase T1.2).
 *
 * One snapshot type carries two flavors discriminated by which of `tree` or
 * `contents` is populated:
 *
 * - **Directory listing** — `tree` is set; `contents`/`modifiedAtMs`/
 *   `truncated`/`unsupported` are omitted.
 * - **File preview** — `contents` is set; `modifiedAtMs`, `truncated`, and
 *   `unsupported` describe the read.
 *
 * The cached preview row is keyed by the composite key
 * `${fileRootLocalId}:${filePath}` so two repos with the same relative
 * filename do not collide. Both `workspaceLocalId` and `worktreeLocalId`
 * accompany the row so the cache can scope-evict on worktree close.
 */
export interface PortalFileSnapshotPayload {
  /**
   * Local id of the file root the snapshot was resolved under. Required so
   * the cache key `${fileRootLocalId}:${filePath}` does not collide across
   * repos sharing relative paths.
   */
  fileRootLocalId: string;
  /** Workspace this snapshot belongs to; surfaced for scope-evict on close. */
  workspaceLocalId: string;
  /** Worktree this snapshot belongs to; surfaced for scope-evict on close. */
  worktreeLocalId: string;
  /**
   * Path relative to the resolved file root. Use `''` (empty string) for the
   * root itself in directory snapshots.
   */
  filePath: string;
  /** UTF-8 file body for preview frames; omitted on directory frames. */
  contents?: string;
  /** True when `contents` was clipped to fit the preview budget. */
  truncated?: boolean;
  /**
   * Last-known mtime (epoch ms) of the file at the moment the preview was
   * generated. Drives save-conflict checks: a `portal.file.save` command
   * rejects when its `expectedModifiedAtMs` mismatches the on-disk mtime.
   */
  modifiedAtMs?: number;
  /**
   * True when the file is binary or otherwise not previewable. The browser
   * shell renders an "unsupported file" placeholder in that case rather than
   * the empty `contents` string.
   */
  unsupported?: boolean;
  /**
   * Coarse-grained diff state. `'modified'` means the file has uncommitted
   * changes against the worktree's tracked base; `'unchanged'` means it
   * matches the base. Omitted when the local service hasn't computed a
   * diff for this file yet.
   */
  diffMode?: 'unchanged' | 'modified';
  /** Directory entries; populated only on directory frames. */
  tree?: Array<{ name: string; isDir: boolean }>;
}

/**
 * Diff snapshot payload published as a `portal.diff.snapshot` envelope
 * (transport plan Phase T2.3).
 *
 * `filePath` is non-empty: a single-file diff carries the relative path of
 * the changed file; a whole-worktree diff carries
 * {@link PORTAL_DIFF_COMBINED_FILE_PATH}. Both `workspaceLocalId` and
 * `worktreeLocalId` are required so cached rows can be scope-evicted on
 * worktree close. `files` always carries the diff's changed-file roster
 * (matching {@link PortalChangedFile}); `patch` is the unified-diff text.
 */
export interface PortalDiffSnapshotPayload {
  workspaceLocalId: string;
  worktreeLocalId: string;
  /** Owning repo id for a per-file diff in a multi-repo workspace. */
  repoId?: string;
  /** Relative path of the changed file, or {@link PORTAL_DIFF_COMBINED_FILE_PATH}. */
  filePath: string;
  /** Changed-file roster carried alongside the patch. */
  files: PortalChangedFile[];
  /** Unified-diff patch text. */
  patch: string;
  /** Optional human-readable range label (e.g. `"abc123..def456"`). */
  rangeLabel?: string;
  /** The roster was cut to fit the Portal event budget; absent when complete. */
  truncated?: boolean;
}

/**
 * Wire payload for the cached `changed_files` entity (transport plan Phase
 * T2.1). The browser shell stores one row per worktree keyed by
 * `worktreeLocalId`; both repos serialize the same canonical shape.
 */
export interface PortalChangedFilesPayload {
  workspaceLocalId: string;
  worktreeLocalId: string;
  uncommitted: PortalChangedFile[];
  committed: PortalChangedFile[];
  notices?: PortalChangedFilesNotice[];
  page?: PortalChangedFilesPage;
}

// ---------------------------------------------------------------------------
// Adapter failure codes (mirror of canopy/src/main/portal/adapters/types.ts)
// ---------------------------------------------------------------------------

/**
 * Stable error codes emitted by local Canopy Portal adapters via
 * `PortalAdapterContext.fail`. The browser may route on `error.code` rather
 * than parsing free-form messages.
 *
 * Mirrored verbatim from `repos/canopy/src/main/portal/adapters/types.ts` so
 * the cross-repo parity test can pin both unions to the same set:
 *
 * - `invalid_payload` — known feature command with bad payload
 * - `invalid_target` — known feature command with bad target
 * - `not_found` — local resource missing
 * - `execution_failed` — runtime error; `retryable: true` only for transient
 *   transport-level issues
 * - `unsupported_command` — command type not implemented (the dispatcher
 *   emits this for unmapped types)
 * - {@link PortalWorktreeCreateRefusalReason} values — a refused
 *   `portal.worktree.create`, with the same value in `refusal.reason`
 *
 * Adapters MAY emit codes outside this set (the wire field is `string` for
 * forward compatibility), but any new code added here MUST also be reflected
 * in the canopy-side mirror so the browser stays aware of it.
 */
export type PortalAdapterFailureCode =
  | 'invalid_payload'
  | 'invalid_target'
  | 'not_found'
  | 'conflict'
  | 'permission_denied'
  | 'not_found_or_firing'
  | 'forbidden'
  | 'execution_failed'
  | 'github_not_connected'
  | 'unsupported_command'
  | PortalWorktreeCreateRefusalReason;

/**
 * Frozen runtime list of every supported `PortalAdapterFailureCode`. Exposed
 * for the cross-repo parity test so the closed enum cannot drift between
 * repos.
 */
export const PORTAL_ADAPTER_FAILURE_CODES = [
  'invalid_payload',
  'invalid_target',
  'not_found',
  'conflict',
  'permission_denied',
  'not_found_or_firing',
  'forbidden',
  'execution_failed',
  'github_not_connected',
  'unsupported_command',
  ...PORTAL_WORKTREE_CREATE_REFUSAL_REASONS,
] as const satisfies readonly PortalAdapterFailureCode[];

// ---------------------------------------------------------------------------
// Domain payload types (transport plan Phase T11)
//
// These shapes are the request/response payload contracts for the local
// service-method signatures referenced by transport Phase T17. The transport
// plan is the authoritative location for these types so that the local
// service layer (canopy main process) and the server-side adapters / panels
// (canopy-server) read the same single source of truth.
// ---------------------------------------------------------------------------

/**
 * Directory listing returned by `listDirectory` (transport Phase T17).
 * The `entries` array carries one row per immediate child of `path` (under
 * the worktree root identified by `worktreeLocalId`), already sorted by the
 * service before being returned.
 */
export interface PortalDirectoryListing {
  workspaceLocalId: string;
  worktreeLocalId: string;
  /** Local id of the file root this listing was resolved under. */
  fileRootLocalId?: string;
  /** Path relative to the worktree root; empty string means the root. */
  path: string;
  /** Absolute path reported by a host when listing the root directory. */
  absolutePath?: string;
  entries: Array<{
    name: string;
    /** Path relative to the worktree root, including `name`. */
    path: string;
    type: 'file' | 'directory';
    /** File size in bytes (omitted for directories). */
    size?: number;
    /** ISO-8601 mtime; omitted when the underlying filesystem cannot report it. */
    modifiedAt?: string;
  }>;
  /** True when the host stopped at its bounded directory-entry limit. */
  truncated?: boolean;
}

/**
 * Preview of a single file returned by `readFile` (transport Phase T17).
 *
 * `version` is an opaque cookie the local service stamps on each preview
 * response. The browser passes the same cookie back via `expectedVersion` on
 * `saveFile`; the service rejects writes when the on-disk version has
 * advanced (a save-conflict check that does not depend on epoch-ms mtimes).
 */
export interface PortalFilePreview {
  workspaceLocalId: string;
  worktreeLocalId: string;
  /** Local id of the file root this preview was resolved under. */
  fileRootLocalId?: string;
  /** Path relative to the worktree root. */
  path: string;
  /** UTF-8 contents of the file (or the readable head, when truncated). */
  content: string;
  /**
   * Optional language hint inferred by the local service. The browser uses
   * this to pick a syntax highlighter without re-parsing the path.
   */
  language?: string;
  /** File size in bytes. */
  size: number;
  /** Opaque save-conflict version cookie. */
  version: string;
  /** True when `content` was truncated to fit the preview budget. */
  truncated: boolean;
  /** ISO-8601 mtime, when the local filesystem can report it. */
  modifiedAt?: string;
}

/**
 * Single changed-file row carried on the wire (transport plan Phase T2.1)
 * and returned by `listChangedFiles` (transport plan Phase T17).
 *
 * `filePath` is the canonical field name across both repos; the legacy
 * `path` spelling is intentionally not accepted so consumers cannot drift
 * back to a divergent name.
 */
export interface PortalChangedFile {
  /** Path relative to the worktree root. */
  filePath: string;
  /**
   * Git status normalised by the local service (for example, `'modified'`).
   * Both vocabularies are live: this snapshot path carries word statuses, while other producers still emit porcelain codes — consumers accept both.
   */
  status: string;
  /** Optional rename source path. */
  renamedFrom?: string;
  /** True when the change is staged. */
  staged?: boolean;
  /** Line insertions count for this file. */
  insertions?: number;
  /** Line deletions count for this file. */
  deletions?: number;
  /**
   * Previous path before a rename, when applicable. Distinct from
   * `renamedFrom` so consumers that want the unified "what was the previous
   * filename" answer have a single field to look at.
   */
  previousPath?: string;
  /**
   * Owning repo id in multi-repo worktrees. Hosts use it to resolve a row
   * back to the native file when two repos contain the same relative path.
   */
  repoId?: string;
  /** Human-readable owning repo name for multi-repo display. */
  repoName?: string;
  /**
   * True when the file is binary: its line counts are absent and it has no
   * text patch. Absent means the producer did not report it (REG-3024).
   */
  binary?: boolean;
}

export type PortalChangedFilesGroup = 'uncommitted' | 'committed';

export interface PortalChangedFilesGroupPage {
  readonly total: number;
  readonly nextCursor?: string;
}

export interface PortalChangedFilesPage {
  revision: string;
  uncommitted: PortalChangedFilesGroupPage;
  committed: PortalChangedFilesGroupPage;
}

export type PortalChangedFilesPageResult =
  | {
      changedFilesPage: {
        workspaceLocalId: string;
        worktreeLocalId: string;
        group: PortalChangedFilesGroup;
        revision: string;
        files: PortalChangedFile[];
        total: number;
        nextCursor?: string;
      };
    }
  | {
      changedFilesPage: {
        workspaceLocalId: string;
        worktreeLocalId: string;
        group: PortalChangedFilesGroup;
        cursor: string;
        error: 'stale_cursor' | 'invalid_cursor';
      };
    };

/**
 * Result of `readDiff` (transport Phase T17). When `filePath` is omitted on
 * the request, the response carries the combined diff for the worktree.
 */
export interface PortalDiffPayload {
  workspaceLocalId: string;
  worktreeLocalId: string;
  /**
   * Optional relative file path the diff was scoped to. Omit for the
   * combined diff.
   */
  filePath?: string;
  files: PortalChangedFile[];
  /** Unified-diff patch text. */
  patch?: string;
  /** Optional human-readable range label (e.g. `"abc123..WORKTREE"`). */
  rangeLabel?: string;
  /**
   * Bounded-response metadata (REG-3024). Every field is optional and
   * additive: absent means the producer did not bound or report it, which is
   * how desktop and older producers read.
   *
   * `truncated`: the `files` roster is incomplete (the producer hit its
   * listing bound).
   */
  truncated?: boolean;
  /** The patch was cut at the producer's size bound; `patch` is its beginning. */
  oversized?: boolean;
  /** The requested path is binary, so `patch` carries no text hunks. */
  binary?: boolean;
}

/**
 * Per-check status row carried inside {@link PortalPullRequestState.checkDetails}.
 * `name` is the check label (e.g. `'lint'`, `'tests'`) and `status` is the
 * normalised outcome surfaced as one of four well-known values so the
 * renderer can dispatch a colour/icon without parsing free-form labels.
 */
export interface PortalPullRequestCheckDetail {
  name: string;
  status: 'success' | 'failure' | 'pending' | 'neutral';
  /**
   * Browser URL of the check's details page (CI run, status target). Optional
   * and lenient-read: payloads from older builds omit it and renderers must
   * simply hide the link. (CAN-1528 L2.)
   */
  detailsUrl?: string | null;
  /**
   * The check's GitHub state, finer than {@link status}: queued and running
   * stay apart, as do cancelled and timed out, and skipped and action
   * required. Optional and lenient-read: older builds omit it, and emitters
   * omit it for a GitHub state they do not recognize. Readers fall back to
   * {@link status} when it is absent and must tolerate values added later.
   * (CAN-3618.)
   */
  executionState?: PortalPullRequestCheckExecutionState;
}

/**
 * Normalized GitHub merge queue entry phases carried on a queued PR's
 * `mergeQueue.phase`. `unknown` is an entry state this build does not
 * recognize; the PR is still queued.
 */
export const PORTAL_PR_MERGE_QUEUE_PHASES = [
  'queued',
  'awaiting_checks',
  'mergeable',
  'locked',
  'unmergeable',
  'unknown',
] as const;

export type PortalPrMergeQueuePhase =
  (typeof PORTAL_PR_MERGE_QUEUE_PHASES)[number];

const PORTAL_PR_MERGE_QUEUE_PHASE_SET: ReadonlySet<string> =
  /*#__PURE__*/ new Set(PORTAL_PR_MERGE_QUEUE_PHASES);

/**
 * Reads a relayed `mergeQueue.phase`. A phase only describes a queued PR; a
 * string from a newer desktop reads as `unknown`, and non-strings are absent.
 */
export function readPortalPrMergeQueuePhase(
  inQueue: boolean,
  value: unknown,
): PortalPrMergeQueuePhase | undefined {
  if (!inQueue || typeof value !== 'string') return undefined;
  return isPortalPrMergeQueuePhase(value) ? value : 'unknown';
}

export function isPortalPrMergeQueuePhase(
  value: string,
): value is PortalPrMergeQueuePhase {
  return PORTAL_PR_MERGE_QUEUE_PHASE_SET.has(value);
}

/** Detailed GitHub check states carried by {@link PortalPullRequestCheckDetail}. */
export const PORTAL_PULL_REQUEST_CHECK_EXECUTION_STATES = [
  'queued',
  'running',
  'success',
  'failure',
  'cancelled',
  'timed_out',
  'skipped',
  'action_required',
  'neutral',
] as const;

export type PortalPullRequestCheckExecutionState =
  (typeof PORTAL_PULL_REQUEST_CHECK_EXECUTION_STATES)[number];

/**
 * PR label surfaced on the portal projection. Mirrors the desktop `PrLabel`
 * minimal shape: only the fields the activity card renders. (CAN-1528 L2.)
 */
export interface PortalPullRequestLabel {
  name: string;
  /**
   * GitHub label color, normally a 6-digit hex string without the leading
   * `#`. Empty when GitHub did not return a usable color.
   */
  color: string;
  /** Optional label description surfaced as a tooltip. */
  description: string | null;
}

/**
 * Creation-step phase vocabulary for {@link PortalPrCreationProgress}.
 * Structural twin of the desktop `PrCreationPhase` in
 * `@canopy/desktop-shared/types/github`; the literals must stay aligned so
 * the desktop creation feed projects without translation. (CAN-1528 L2.)
 */
export type PortalPrCreationStepPhase =
  | 'gathering_changes'
  | 'summarizing'
  | 'pushing'
  | 'creating_pr'
  | 'skipped'
  | 'done'
  | 'error';

/** One step of the PR-creation feed. Mirrors the desktop `PrCreationStep`. */
export interface PortalPrCreationStep {
  phase: PortalPrCreationStepPhase;
  /** Present on per-repo steps in multi-repo creations. */
  repoName?: string;
  /** Present on `error` steps. */
  error?: string;
}

/**
 * Accumulated PR-creation feed mirroring the desktop `PrCreationProgress`
 * store shape. Additive alongside the legacy 4-value `creationPhase` field,
 * which older readers keep consuming untouched. (CAN-1528 L2.)
 */
export interface PortalPrCreationProgress {
  steps: PortalPrCreationStep[];
  currentPhase: PortalPrCreationStepPhase;
}

/**
 * Merge-step phase vocabulary for {@link PortalMergePrProgress}. Structural
 * twin of the desktop `MergePrPhase` in
 * `@canopy/desktop-shared/types/github`; the literals must stay aligned so the
 * desktop merge feed projects without translation.
 */
export type PortalMergePrPhase =
  | 'queued'
  | 'checking_mergeability'
  | 'waiting_mergeability'
  | 'merging'
  | 'refreshing_pr_status'
  | 'done'
  | 'error';

/** One step of the PR-merge feed. Mirrors the desktop `MergePrStep`. */
export interface PortalMergePrStep {
  phase: PortalMergePrPhase;
  /** Present on per-repo steps in multi-repo merges. */
  repoId?: string;
  repoName?: string;
  /** 1-based position while the merge waits behind other merges. */
  queuePosition?: number;
  queueLength?: number;
  /** Backoff before the next mergeability poll, in milliseconds. */
  retryDelayMs?: number;
  /** Present on `error` steps. */
  error?: string;
}

/**
 * Accumulated PR-merge feed mirroring the desktop `MergePrProgress` store
 * shape. Additive alongside the worktree entity's `mergingPr` /
 * `mergePrPhase`, which older readers keep consuming untouched.
 */
export interface PortalMergePrProgress {
  /** Monotonic merge attempt marker; absent on older desktop hosts. */
  generation?: number;
  steps: PortalMergePrStep[];
  currentPhase: PortalMergePrPhase;
}

/**
 * Flat per-repo PR status carried inside {@link PortalPrStatus.repos} /
 * {@link PortalPullRequestState.repos} for multi-repo grouping. Field-by-field
 * twin of the flat top-level PR fields, which stay populated from the primary
 * repo for back-compat readers. (CAN-1528 L2.)
 */
export interface PortalPullRequestRepoStatus {
  number?: number | null;
  url?: string | null;
  state?: string;
  /** Current pull-request base ref, refreshed from the hosting provider. */
  baseRefName?: string;
  title?: string;
  checkStatus?: 'passing' | 'failing' | 'pending' | 'neutral' | 'none';
  checkDetails?: PortalPullRequestCheckDetail[];
  reviewStatus?: 'approved' | 'changes-requested' | 'pending' | 'none';
  labels?: PortalPullRequestLabel[];
  hasConflicts?: boolean;
  commentCount?: number;
  unresolvedReviewThreadCount?: number;
  updatedAt?: string;
  /** Desktop-computed merge readiness; see {@link PortalPrStatus.mergeReady}. */
  mergeReady?: boolean;
}

/** Per-repo entry for multi-repo PR grouping. (CAN-1528 L2.) */
export interface PortalPullRequestRepo {
  repoId: string;
  repoName: string;
  /** `null`/absent when the repo has no PR yet. */
  status?: PortalPullRequestRepoStatus | null;
  /** True only when the desktop successfully verified PR state for this branch. */
  prLookupAvailable?: boolean;
}

/**
 * Closed enumeration of PR creation phases surfaced by the desktop creation
 * pipeline. Lets the renderer show progress copy ("Gathering changes…",
 * "Summarising…", etc.) while the create flow is in flight.
 */
export type PortalPrCreationPhase =
  | 'gathering'
  | 'summarizing'
  | 'pushing'
  | 'creating';

/** A repository mutation failure returned to a remote PR caller. */
export interface PortalPrRepoFailure {
  repoId?: string;
  repoName: string;
  error: string;
  status: 'failed';
  failureCode?: 'github_not_connected';
}

export interface PortalPrMutationResult {
  repos: Array<{ repoId?: string; repoName: string }>;
  failedRepos: PortalPrRepoFailure[];
}

/** Pull-request state surfaced by the PR service (transport Phase T17). */
export interface PortalPullRequestState {
  /** Per-repository outcomes when a remote mutation only partly succeeds. */
  mutationResult?: PortalPrMutationResult;
  workspaceLocalId: string;
  worktreeLocalId: string;
  /** Numeric PR id assigned by the host (GitHub, GitLab, ...). */
  number?: number | null;
  /** Browser URL of the PR, when one exists. */
  url?: string | null;
  /** Free-form lifecycle state (e.g. `'open'`, `'merged'`, `'closed'`). */
  state?: string;
  baseBranch?: string;
  headBranch?: string;
  title?: string;
  body?: string;
  /** True when the PR is in draft status. */
  draft?: boolean;
  /**
   * Aggregate CI check status across the PR. Mirrors the desktop
   * `CheckStatus` union; `'none'` indicates no checks are configured.
   */
  checkStatus?: 'passing' | 'failing' | 'pending' | 'neutral' | 'none';
  /**
   * Per-check breakdown. Surfaced alongside the aggregate `checkStatus` so
   * the portal can render an inline list of check rows with individual
   * status dots.
   */
  checkDetails?: PortalPullRequestCheckDetail[];
  /**
   * Aggregate review status across the PR. `'none'` means no reviews exist
   * (CAN-1528 L2 widening); older emitters collapse that case into an absent
   * field, so readers must treat absent and `'none'` the same.
   */
  reviewStatus?: 'approved' | 'changes-requested' | 'pending' | 'none';
  /** True when GitHub reports mergeability conflicts on the PR. */
  hasConflicts?: boolean;
  /** Total comment count across issue and review comment threads. */
  commentCount?: number;
  /** ISO-8601 timestamp of the latest activity on the PR. */
  updatedAt?: string;
  /**
   * Active creation phase, or `null` when no PR-create flow is in flight.
   * Drives the desktop "Creating PR…" progress feed; the portal renders the
   * same affordance when present.
   */
  creationPhase?: PortalPrCreationPhase | null;
  /** Labels on the primary repo's PR. (CAN-1528 L2, lenient-read.) */
  labels?: PortalPullRequestLabel[];
  /**
   * Merge readiness computed desktop-side with the shared `isPrReadyToMerge`
   * (which also weighs GitHub's `mergeable`/`mergeableState`, not carried on
   * this payload) so browser code never re-implements merge-readiness
   * semantics. (CAN-1528 L2, lenient-read.)
   */
  mergeReady?: boolean;
  /**
   * Per-repo PR statuses for multi-repo grouping — all repos, not just the
   * primary. The flat top-level fields stay populated from the primary repo
   * for back-compat readers. (CAN-1528 L2, lenient-read.)
   */
  repos?: PortalPullRequestRepo[];
  /**
   * Accumulated creation feed mirroring the desktop `PrCreationProgress`, or
   * null as an explicit clear tombstone. Additive alongside the legacy
   * `creationPhase`, which is left untouched.
   * (CAN-1528 L2, lenient-read.)
   */
  creationProgress?: PortalPrCreationProgress | null;
  /**
   * Accumulated merge feed mirroring the desktop `MergePrProgress`, or null as
   * an explicit clear tombstone. Additive alongside the worktree entity's
   * `mergingPr` / `mergePrPhase`, which stay authoritative for the "is
   * merging" flag. Readers prefer this when present.
   */
  mergeProgress?: PortalMergePrProgress | null;
}

/**
 * Lightweight summary of a script descriptor returned by `listScripts`
 * (transport Phase T17).
 *
 * Transport plan §1.2 makes `scriptKey` (the canonical executable key) the
 * authoritative identifier and keeps `scriptId` as a backward-compatibility
 * alias that MUST equal `scriptKey`. `scriptName` carries the raw config key
 * (e.g. `"launch"`) so adapters can re-execute the script without round-
 * tripping through the display label `name`. `target` and optional `repoId`
 * disambiguate workspace-root, workspace-repo, and project-scoped entries.
 */
export interface PortalScriptSummary {
  workspaceLocalId: string;
  worktreeLocalId: string;
  /** @deprecated Use {@link PortalScriptSummary.scriptKey}. Must equal `scriptKey`. */
  scriptId: string;
  /** Canonical executable key (matches `ScriptDescriptor.scriptKey`). */
  scriptKey: string;
  /** Raw config key used by the script source (e.g. `"launch"`). */
  scriptName: string;
  /** Display label only. */
  name: string;
  target: 'project' | 'workspace-root' | 'workspace-repo';
  repoId?: string;
  repoName?: string;
  description?: string;
  command?: string;
  source?: string;
  /**
   * Coarse-grained lifecycle bucket the script belongs to. `null` means the
   * script is not part of a lifecycle (e.g. an ad-hoc command). Mirrors the
   * desktop lifecycle grouping in `ScriptsSection`.
   */
  lifecycle?: 'before' | 'setup' | 'after' | 'teardown' | null;
}

/**
 * Canonical run-status union for script, hook, and pipeline runs (transport
 * plan Phase T4). The plan freezes the terminal vocabulary as
 * `running` / `success` / `failed` / `cancelled` / `timed_out`; `queued`
 * is the pre-execution holding state and `completed` is retained as a
 * compatibility alias for legacy emitters that have not yet migrated to
 * `success`.
 */
export type PortalRunStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

/**
 * Frozen runtime list of every supported {@link PortalRunStatus}. Exposed
 * for cross-repo contract tests so the closed enum cannot drift.
 */
export const PORTAL_RUN_STATUSES = [
  'queued',
  'running',
  'success',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
] as const satisfies readonly PortalRunStatus[];

/**
 * Lightweight script-run summary returned by `listScriptRuns` (transport
 * plan Phase T4.1). The wire row matches the cached `script_run` entity
 * payload.
 *
 * `localId` is the cached entity id (matches the executor's run id).
 * `outputTail` is the rolling tail of combined stdout/stderr appended on
 * each chunk. The deprecated `logTail` alias was dropped in the Frontend
 * Plan Phase 7 cleanup; emitters MUST populate `outputTail`.
 */
export interface PortalScriptRun {
  workspaceLocalId: string;
  worktreeLocalId: string;
  /** Local id of the run; matches the cached `script_run` entity localId. */
  localId: string;
  /** @deprecated Use {@link PortalScriptRun.localId}. Retained for compat. */
  runId?: string;
  /** @deprecated Use {@link PortalScriptRun.scriptKey}. Must equal `scriptKey`. */
  scriptId: string;
  /** Canonical executable key (matches `ScriptDescriptor.scriptKey`). */
  scriptKey: string;
  /** Raw config key used by the script source (e.g. `"launch"`). */
  scriptName: string;
  /** Display label only. */
  name: string;
  target: 'project' | 'workspace-root' | 'workspace-repo';
  repoId?: string;
  repoName?: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  /** Most recent stdout/stderr tail; appended on each chunk. */
  outputTail?: string;
  /**
   * Wall-clock duration of the run, when known. Lets the renderer show
   * "Ran in 3s" without parsing `startedAt` / `finishedAt`.
   */
  durationMs?: number;
  /**
   * Process exit code on completion. `0` is success; non-zero is failure.
   * Surfaced for the renderer's failure-detail tooltip.
   */
  exitCode?: number;
  /**
   * Coarse-grained lifecycle bucket the underlying script belongs to.
   * Mirrors {@link PortalScriptSummary.lifecycle}.
   */
  lifecycle?: 'before' | 'setup' | 'after' | 'teardown' | null;
}

/**
 * Lightweight summary of a hook descriptor (transport Phase T17).
 *
 * Transport plan §1.3 makes `hookKey` canonical and keeps `hookId` as a
 * compatibility alias that MUST equal `hookKey`. `triggerName` is the raw
 * trigger key from the hook source (e.g. `"pre_task"`). `target` /
 * `repoId` disambiguate workspace-root, workspace-repo, and project-scoped
 * hooks the same way as scripts.
 */
export interface PortalHookSummary {
  workspaceLocalId: string;
  worktreeLocalId: string;
  /** @deprecated Use {@link PortalHookSummary.hookKey}. Must equal `hookKey`. */
  hookId: string;
  /** Canonical executable key (matches `HookDescriptor.hookKey`). */
  hookKey: string;
  /** Display label only. */
  name: string;
  /** Raw trigger key from the hook source (e.g. `"pre_task"`). */
  triggerName: string;
  target: 'project' | 'workspace-root' | 'workspace-repo';
  repoId?: string;
  repoName?: string;
  description?: string;
  source?: string;
  /**
   * True when this hook descriptor key appears in the owning worktree's
   * `pausedHookKeys` list. Mirrored onto the descriptor so the renderer can
   * draw the paused state without cross-referencing the worktree row.
   */
  paused?: boolean;
  /**
   * Host-computed manual-run availability. Absent means runnable for rolling
   * compatibility with hosts that predate this field.
   */
  runDisabled?: boolean;
  /** Host-computed explanation for {@link PortalHookSummary.runDisabled}. */
  runDisabledReason?: string;
}

/**
 * Lightweight hook-run summary returned by `listHookRuns` (transport plan
 * Phase T4.2). `localId` matches the cached `hook_run` entity id;
 * `outputTail` is the rolling tail appended on each chunk.
 *
 * Transport plan §1.3: `hookKey` is canonical and `hookId` is retained as a
 * compatibility alias that MUST equal `hookKey`. `triggerName` carries the
 * raw trigger key from the hook source so re-runs are not derived from the
 * display label.
 */
export interface PortalHookRun {
  workspaceLocalId: string;
  worktreeLocalId: string;
  /** Local id of the run; matches the cached `hook_run` entity localId. */
  localId: string;
  /** @deprecated Use {@link PortalHookRun.localId}. Retained for compat. */
  runId?: string;
  /** @deprecated Use {@link PortalHookRun.hookKey}. Must equal `hookKey`. */
  hookId: string;
  /** Canonical executable key (matches `HookDescriptor.hookKey`). */
  hookKey: string;
  /** Display label only. */
  name: string;
  /** Raw trigger key from the hook source (e.g. `"pre_task"`). */
  triggerName: string;
  target: 'project' | 'workspace-root' | 'workspace-repo';
  repoId?: string;
  repoName?: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  outputTail?: string;
  /**
   * Wall-clock duration of the run, when known. Mirrors
   * {@link PortalScriptRun.durationMs}.
   */
  durationMs?: number;
  /** Process exit code on completion; mirrors {@link PortalScriptRun.exitCode}. */
  exitCode?: number;
  /** Zero-based index of the action currently executing, when known. */
  activeActionIndex?: number;
}

/** Plan summary returned by `listPlans` (transport Phase T17). */
export interface PortalPlanSummary {
  workspaceLocalId: string;
  worktreeLocalId: string;
  planId: string;
  title: string;
  status: string;
  source?: string;
  /**
   * Repo-relative path of the file an `imported` plan was copied from. Only
   * present for `source === 'imported'`; older desktops omit it.
   */
  sourceFilePath?: string;
  /** ISO-8601 timestamp; the local service may use mtime or last-edited time. */
  updatedAt?: string;
}

/**
 * Plan detail returned by `readPlan` (transport Phase T17).
 *
 * Transport plan §1.4: `content` is the canonical markdown body field and
 * `body` is retained for backward compatibility with pre-rollout payloads.
 * Emitters MUST populate `content`; consumers MAY fall back to `body` when
 * ingesting frames from older clients.
 */
export interface PortalPlanDetail extends PortalPlanSummary {
  /** Canonical markdown body of the plan file. */
  content: string;
  /** @deprecated Use {@link PortalPlanDetail.content}. */
  body?: string;
  reviewStatus?: string;
  approvedAt?: string | null;
  dismissedAt?: string | null;
  hidden?: boolean;
  /**
   * Mirrors `TrackedPlanData.latestRevisionNumber`. The web portal uses
   * this to render the revision badge ("v3") without re-deriving it from
   * the revisions list.
   */
  latestRevisionNumber?: number;
  /**
   * Revision of `content`. Equals `latestRevisionNumber` on unpinned reads;
   * a revision-specific read may return an older revision without changing
   * the current plan projection.
   */
  revisionNumber?: number;
}

/** Browser-safe projection of a task-ready pipeline input definition. */
export interface PortalPipelineInputDefinition {
  description?: string;
  required?: boolean;
  default?: string | number | boolean;
  type?: 'string' | 'boolean' | 'number' | 'choice';
  options?: string[];
  min?: number;
  max?: number;
  'hint-hide-ui-option'?: boolean;
}

/**
 * Where a pipeline came from, mirroring the desktop's `PipelineInfo['source']`
 * so the portal can label and filter a list the same way the desktop modal
 * does (CAN-3019).
 *
 * `'shared'` (cloud/org pipelines) joined in CAN-3021. The desktop, which is
 * already signed into Canopy Cloud, produces those rows into the same
 * per-worktree inventory document as bundled/user/project rows, so the browser
 * performs no access-scoped cloud read of its own. A desktop that predates
 * CAN-3021 simply reports no shared rows.
 *
 * NOTE: distinct from {@link PortalPipelineMetadata.source}, which has always
 * carried the pipeline's FILENAME. Renaming that field would break every
 * already-synced inventory document, so the origin gets its own name. A shared
 * pipeline has no file, so its `source` is empty.
 */
export type PortalPipelineOrigin = 'bundled' | 'user' | 'project' | 'shared';

/** Optional metadata shared by portal pipeline list and entity projections. */
export interface PortalPipelineMetadata {
  description?: string;
  /** The pipeline's filename, NOT its origin — see {@link PortalPipelineOrigin}. */
  source?: string;
  /** Absent on desktops that predate the field; treat as `'project'`. */
  origin?: PortalPipelineOrigin;
  triggerTypes?: Array<'dispatch' | 'plan_ready' | 'task_ready'>;
  scopes?: Array<'global' | 'directory' | 'worktree'>;
  /**
   * Audience of a local pipeline's own Cloud share, so the picker can show
   * that the row is shared. Absent when unshared or on older desktops.
   */
  shareScope?: 'private' | 'team' | 'organization';
  taskReadyInputs?: Record<string, PortalPipelineInputDefinition>;
  planReadyInputs?: Record<string, PortalPipelineInputDefinition>;
}

function isPortalMetadataRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function projectPortalPipelineInputs(
  value: unknown,
): Record<string, PortalPipelineInputDefinition> {
  const inputEntries: Array<[string, PortalPipelineInputDefinition]> = [];
  if (!isPortalMetadataRecord(value)) {
    return {};
  }
  for (const [name, candidate] of Object.entries(value)) {
    if (name.length === 0 || !isPortalMetadataRecord(candidate)) {
      continue;
    }
    const input = candidate;
    const type = input.type;
    const defaultValue = input.default;
    inputEntries.push([
      name,
      {
        ...(typeof input.description === 'string' &&
        input.description.length > 0
          ? { description: input.description }
          : {}),
        ...(typeof input.required === 'boolean'
          ? { required: input.required }
          : {}),
        ...(type === 'string' ||
        type === 'boolean' ||
        type === 'number' ||
        type === 'choice'
          ? { type }
          : {}),
        ...(Array.isArray(input.options)
          ? {
              options: input.options.filter(
                (option): option is string =>
                  typeof option === 'string' && option.length > 0,
              ),
            }
          : {}),
        ...(typeof input.min === 'number' && Number.isFinite(input.min)
          ? { min: input.min }
          : {}),
        ...(typeof input.max === 'number' && Number.isFinite(input.max)
          ? { max: input.max }
          : {}),
        ...(typeof input['hint-hide-ui-option'] === 'boolean'
          ? { 'hint-hide-ui-option': input['hint-hide-ui-option'] }
          : {}),
        ...(typeof defaultValue === 'string' ||
        typeof defaultValue === 'boolean' ||
        (typeof defaultValue === 'number' && Number.isFinite(defaultValue))
          ? { default: defaultValue }
          : {}),
      },
    ]);
  }
  return Object.fromEntries(inputEntries);
}

/** Why a pipeline cannot be dispatched from a phone or browser. */
export type PortalPipelineDispatchUnsupportedReason = 'json_input';

/**
 * Browser-safe dispatch inputs for `portal.pipeline.get` (CAN-3174).
 *
 * `json` inputs have no browser-safe shape. An optional one is dropped (the
 * executor applies its default or leaves it unset). A required one with no
 * default cannot be satisfied from a phone, so the pipeline is flagged
 * instead of offering a form the desktop would always reject.
 */
export function projectPortalPipelineDispatchInputs(
  value: unknown,
): Pick<
  PortalPipelineGetResult,
  'dispatchInputs' | 'dispatchUnsupportedReason'
> {
  if (!isPortalMetadataRecord(value)) return {};
  const kept: Record<string, unknown> = {};
  let unsupported = false;
  for (const [name, candidate] of Object.entries(value)) {
    if (isPortalMetadataRecord(candidate) && candidate.type === 'json') {
      if (candidate.required === true && candidate.default === undefined) {
        unsupported = true;
      }
      continue;
    }
    kept[name] = candidate;
  }
  const dispatchInputs = projectPortalPipelineInputs(kept);
  return {
    ...(Object.keys(dispatchInputs).length > 0 ? { dispatchInputs } : {}),
    ...(unsupported ? { dispatchUnsupportedReason: 'json_input' } : {}),
  };
}

/**
 * Narrow pipeline metadata received through cached JSON before it reaches
 * either the server snapshot or browser live-entity projection.
 */
export function projectPortalPipelineMetadata(
  value: unknown,
): PortalPipelineMetadata {
  if (!isPortalMetadataRecord(value)) {
    return {};
  }
  const raw = value;
  const description =
    typeof raw.description === 'string' && raw.description.length > 0
      ? raw.description
      : undefined;
  const source =
    typeof raw.source === 'string' && raw.source.length > 0
      ? raw.source
      : undefined;
  const origin =
    raw.origin === 'bundled' ||
    raw.origin === 'user' ||
    raw.origin === 'project' ||
    raw.origin === 'shared'
      ? raw.origin
      : undefined;
  const triggerTypes = Array.isArray(raw.triggerTypes)
    ? raw.triggerTypes.filter(
        (item): item is 'dispatch' | 'plan_ready' | 'task_ready' =>
          item === 'dispatch' || item === 'plan_ready' || item === 'task_ready',
      )
    : [];
  const scopes = Array.isArray(raw.scopes)
    ? raw.scopes.filter(
        (item): item is 'global' | 'directory' | 'worktree' =>
          item === 'global' || item === 'directory' || item === 'worktree',
      )
    : [];
  const shareScope =
    raw.shareScope === 'private' ||
    raw.shareScope === 'team' ||
    raw.shareScope === 'organization'
      ? raw.shareScope
      : undefined;
  const taskReadyInputs = projectPortalPipelineInputs(raw.taskReadyInputs);
  const planReadyInputs = projectPortalPipelineInputs(raw.planReadyInputs);
  return {
    ...(description ? { description } : {}),
    ...(source ? { source } : {}),
    ...(origin ? { origin } : {}),
    ...(triggerTypes.length > 0 ? { triggerTypes } : {}),
    ...(scopes.length > 0 ? { scopes } : {}),
    ...(shareScope ? { shareScope } : {}),
    ...(Object.keys(taskReadyInputs).length > 0 ? { taskReadyInputs } : {}),
    ...(Object.keys(planReadyInputs).length > 0 ? { planReadyInputs } : {}),
  };
}

/** Pipeline definition summary returned by `listPipelines` (transport Phase T17). */
export interface PortalPipelineSummary extends PortalPipelineMetadata {
  workspaceLocalId: string;
  worktreeLocalId: string;
  pipelineId: string;
  name: string;
  /** Declared step count, when the desktop loaded the definition. */
  stepCount?: number;
  /** Dispatch has a required input without a default; Portal cannot collect it. */
  hasRequiredInputs?: boolean;
  /**
   * True when the paired desktop can share this pipeline. Computed on the
   * desktop; absent means "not shareable" (including desktops that predate
   * this field).
   */
  shareable?: boolean;
  /** Author-side share id, for matching a positively owned shared pipeline. */
  shareRemoteId?: string;
  /**
   * True for a user pipeline a live desktop automation owns (CAN-4551): the
   * Portal lists it under that automation, not as a pipeline. The desktop
   * sets it only for an owner that still runs the pipeline.
   */
  ownedByAutomation?: true;
}

export interface PortalPipelineListResult {
  pipelines: PortalPipelineSummary[];
  /** Present when the inventory was prefix-cut to fit the portal result budget. */
  truncated?: boolean;
}

export interface PortalPipelineExecutionListResult {
  runs: PortalPipelineRun[];
  /** Present when the execution list was prefix-cut to fit the portal result budget. */
  truncated?: boolean;
}

/** Browser-safe, read-only projection of a pipeline definition. */
export interface PortalPipelineDefinitionStep {
  id: string;
  name: string;
  kind: 'action' | 'script' | 'incomplete';
  usesSummary: string;
}

/** Ordered job projection used by pipeline definition detail surfaces. */
export interface PortalPipelineDefinitionJob {
  id: string;
  name: string;
  dependencies: string[];
  steps: PortalPipelineDefinitionStep[];
}

/**
 * Neutral pipeline-definition view model shared by desktop and portal hosts.
 * This is a read contract only; it intentionally adds no portal command.
 */
export interface PortalPipelineDefinitionViewModel {
  name: string;
  description?: string;
  version?: string;
  icon?: string;
  triggerSummary: string;
  scopes: Array<'global' | 'directory' | 'worktree'>;
  jobs: PortalPipelineDefinitionJob[];
  canonicalYaml?: string;
  /** Present when canonical YAML was cut to fit the transfer body budget. */
  canonicalYamlTruncated?: boolean;
}

/** Pipeline definition safe to transmit across the desktop-to-portal boundary. */
export interface PortalPipelineDefinitionWireViewModel extends Omit<
  PortalPipelineDefinitionViewModel,
  'canonicalYaml' | 'canonicalYamlTruncated'
> {
  canonicalYaml?: never;
  canonicalYamlTruncated?: never;
}

/** Result returned by the small-RPC `portal.pipeline.get` command. */
export interface PortalPipelineGetResult {
  definition: PortalPipelineDefinitionWireViewModel;
  /**
   * The pipeline's declared `plan_ready` trigger inputs (CAN-3021).
   *
   * Shared/cloud pipelines carry no inputs on their list row — the list source
   * has no YAML to read them from — so the plan picker hydrates them here at
   * the moment of selection. Additive and optional: a desktop that predates
   * CAN-3021 simply omits it.
   */
  planReadyInputs?: Record<string, PortalPipelineInputDefinition>;
  /**
   * Set when {@link planReadyInputs} was dropped to fit the result budget
   * rather than because the pipeline declares none (CAN-3021).
   *
   * Without it the two cases are indistinguishable: both arrive as a
   * non-`error` result with the field absent, and a picker that treats any
   * non-`error` result as authoritative would hydrate to "no inputs" and arm
   * Run for a pipeline that actually declares required ones. `truncated`
   * cannot carry this, because the ordinary row cut also sets it for a
   * pipeline that genuinely has no inputs. A consumer that predates this field
   * is no worse off than before.
   */
  planReadyInputsOmitted?: boolean;
  /**
   * The pipeline's declared `dispatch` trigger inputs (CAN-3174), present only
   * for a pipeline whose `dispatch` trigger declares at least one input; absent
   * when it has no trigger or the trigger declares none. Gated by
   * {@link PORTAL_CAPABILITY_PIPELINE_DISPATCH}: on a desktop with it, an
   * absent field means "none"; on a desktop without it, "not projected", not
   * "declares none".
   */
  dispatchInputs?: Record<string, PortalPipelineInputDefinition>;
  /** As {@link planReadyInputsOmitted}, for {@link dispatchInputs}. */
  dispatchInputsOmitted?: boolean;
  /** Set when the pipeline needs input a phone or browser cannot provide. */
  dispatchUnsupportedReason?: PortalPipelineDispatchUnsupportedReason;
  /** Present when definition rows were prefix-cut to fit the result budget. */
  truncated?: boolean;
}

/**
 * Single step within a {@link PortalPipelineRunJob} (transport plan Phase
 * T4.3). The browser pipeline-log panel needs a `(executionId, jobId,
 * stepId)` triple to construct a {@link PortalPipelineLogRequestPayload};
 * surfacing the job/step skeleton on the run row is what makes that triple
 * derivable in the renderer.
 */
export interface PortalPipelineRunStep {
  /** Step id assigned by the executor. */
  stepId: string;
  /** Human-readable step name. */
  name: string;
  status: string;
  /** Retry counter for this step, when the executor surfaces one. */
  attempt?: number;
  /** Iteration counter for steps that repeat through `max_iterations`. */
  iteration?: number;
  /**
   * Last N bytes of this step's combined stdout/stderr, mirrored on every
   * chunk emitted by the executor. Capped at ≤2 KB at the contract level so
   * a noisy emitter cannot bloat the wire — bigger logs MUST be fetched on
   * demand via `portal.pipeline.log_request`.
   */
  outputTail?: string;
}

export interface PortalPipelineRunVariant {
  /** Physical job id assigned by the matrix materializer. */
  jobId: string;
  name: string;
  status: string;
  matrix: Record<string, JsonValue>;
  steps: PortalPipelineRunStep[];
}

/** Browser-safe status reason shown by the shared pipeline run rows. */
export interface PortalPipelineRunStatusReason {
  id: string;
  kind: string;
  code: string;
  provider?: string;
  resetsAt?: string;
}

export type PortalPipelinePauseInputType =
  | 'string'
  | 'boolean'
  | 'number'
  | 'choice';

/** Browser-safe input field for one paused pipeline checkpoint. */
export interface PortalPipelinePauseInputField {
  key: string;
  label: string;
  type: PortalPipelinePauseInputType;
  description?: string;
  required?: boolean;
  default?: string | number | boolean;
  options?: string[];
  min?: number;
  max?: number;
  multiline?: boolean;
}

export interface PortalPipelinePauseInputRequest {
  title?: string;
  message?: string;
  fields: PortalPipelinePauseInputField[];
}

/**
 * Exact paused checkpoint identity and optional input request needed to build
 * a safe {@link PortalPipelinePauseResponse} in the browser.
 */
export interface PortalPipelinePauseCheckpoint {
  id: string;
  kind: 'input' | 'action';
  jobId: string;
  logicalJobId: string;
  stepId: string;
  /** Why an input request cannot be answered through the portal. */
  requestUnavailableReason?: 'too_large';
  request?: PortalPipelinePauseInputRequest;
}

/**
 * Single job within a pipeline run (transport plan Phase T4.3). Jobs carry
 * a status + a list of {@link PortalPipelineRunStep} rows so the panel can
 * render a job-by-step status grid without issuing follow-up requests.
 */
export interface PortalPipelineRunJob {
  /** Job id assigned by the executor. */
  jobId: string;
  /** Human-readable job name. */
  name: string;
  status: string;
  /**
   * Ids of the jobs this one depends on (the pipeline's `needs`).
   *
   * Carries the run's dependency graph so clients can lay jobs out in
   * concurrency tiers instead of one flat row. Ids not present in the run's
   * own job list are tolerated (a dependency on a job that never expanded);
   * tier computation treats them as depth 0.
   *
   * **Omitted** means the connected desktop predates this field — clients must
   * fall back to a single tier rather than assuming no dependencies.
   */
  needs?: string[];
  steps: PortalPipelineRunStep[];
  variants?: PortalPipelineRunVariant[];
  expansion?: 'pending' | 'expanded' | 'failure';
  expansionError?: string;
}

/**
 * Canonical pipeline-run shape (transport plan Phase T4.3) used both as
 * the cached `pipeline_run` entity payload and as the `listPipelineRuns`
 * service-method return row.
 *
 * `localId` matches the executor's execution id so the browser can
 * correlate streamed step output against the cached row. Both
 * `workspaceLocalId` and `worktreeLocalId` are required so the cache can
 * scope-evict on worktree close.
 */
/**
 * Closed enumeration of pipeline-run trigger sources. Drives the icon the
 * renderer shows next to each run in the pipeline-runs section.
 */
export type PortalPipelineRunTriggerSource =
  | 'hook'
  | 'chat'
  | 'plan'
  | 'manual';

/**
 * One chat turn a pipeline run belongs to, as desktop attributes it. The
 * chat and user-message ids are scoped by the run's workspace/worktree.
 * `launched` covers runs the agent started, resumed or retried from that
 * turn; `watching` covers runs the chat watched and carried into that turn.
 * Observational only: it grants no control authority over the run.
 */
export interface PortalPipelineRunChatTurn {
  chatId: string;
  userMessageId: string;
  relation: 'launched' | 'watching';
}

export interface PortalPipelineRun {
  /** Unique pipeline run id; matches the executor's execution id. */
  localId: string;
  /** @deprecated Use {@link PortalPipelineRun.localId}. Retained for compat. */
  runId?: string;
  /** Descriptor id this run executes. */
  pipelineId: string;
  /**
   * Optional human-readable pipeline name carried for the panel header.
   * Not part of the canonical wire contract — derived from the descriptor.
   */
  pipelineName?: string;
  workspaceLocalId: string;
  worktreeLocalId: string;
  status: string;
  /** ISO 8601 start timestamp. */
  startedAt?: string;
  /** ISO 8601 timestamp set on terminal status. */
  finishedAt?: string;
  /** Parent execution when this run was launched by another pipeline run. */
  parentExecutionId?: string;
  /** Mirrors the desktop activity section's hidden-run grouping. */
  hidden?: boolean;
  /** True when detail fields were omitted to keep one live event deliverable. */
  truncated?: boolean;
  /** Last N bytes/lines of combined step output, appended on each chunk. */
  outputTail?: string;
  /**
   * What initiated this run. Lets the renderer pick the trigger-icon
   * (hook/chat/plan/manual). `undefined` falls back to the manual icon on
   * the renderer side.
   */
  triggerSource?: PortalPipelineRunTriggerSource;
  /**
   * Coarse progress counters across all jobs. The renderer can use this to
   * draw a single progress bar without walking the full `jobs[]` array.
   */
  progress?: { completedSteps: number; totalSteps: number };
  /** Recoverable pause and failure reasons, without desktop-only diagnostics. */
  statusReasons?: PortalPipelineRunStatusReason[];
  /** Exact checkpoints currently awaiting a portal resume response. */
  pendingPauses?: PortalPipelinePauseCheckpoint[];
  /**
   * Optional jobs/steps skeleton (transport plan Phase T4.3). When present,
   * the renderer can build a {@link PortalPipelineLogRequestPayload} from
   * `(localId, jobs[].jobId, jobs[].steps[].stepId)` without follow-up
   * requests. Per-step `outputTail` values are bounded individually by
   * {@link PortalPipelineRunStep.outputTail} (≤2 KB).
   */
  jobs?: PortalPipelineRunJob[];
  /**
   * Chat turns this run belongs to (CAN-3619), one entry per chat and user
   * message. Requires {@link PORTAL_CAPABILITY_PIPELINE_RUN_CHAT_LINKS}.
   * Absent means unknown (keep any previously received links); an explicit
   * empty array means the run has no links.
   */
  chatTurns?: PortalPipelineRunChatTurn[];
  /**
   * Which saved outputs a chat follow-up can review (CAN-3719). Requires
   * {@link PORTAL_CAPABILITY_PIPELINE_CHAT_FOLLOW_UP}. Absent means unknown
   * (keep any previously received value); explicit `false` values mean the
   * run has no such saved output. Never carries host paths.
   */
  chatFollowUp?: PortalPipelineRunChatFollowUp;
}

/** Saved-output availability on a {@link PortalPipelineRun} (CAN-3719). */
export interface PortalPipelineRunChatFollowUp {
  planAvailable: boolean;
  reportAvailable: boolean;
}

/**
 * Per-Work-Entry facts stamped on every cowork chat so the portal can group
 * and order its Chats section exactly like the desktop sidebar
 * (`orderWorkEntryRows`): pinned entries first in manual order, then the
 * unpinned tail by the owning workspace's `itemSortMode` — registry order when
 * `'manual'`, otherwise most recent activity first, where activity is the
 * newest of {@link workEntryLastMessageAt}, {@link workEntryLastTouchedAt} and
 * {@link workEntryCreatedAt}. Every field is optional so older desktop builds
 * and cached payloads keep parsing. Identity, order, pin and status are the
 * same on every chat of one entry; the activity timestamps come from the
 * chat's most recent projection, so read the newest across the entry's chats.
 */
export interface PortalStandaloneWorkEntryFields {
  /** Cowork container identity. */
  workEntryId?: string;
  /** Desktop-resolved Work Entry display title (rename override applied). */
  workEntryTitle?: string;
  /** ISO-8601 Work Entry creation time. */
  workEntryCreatedAt?: string;
  /** ISO-8601 latest message across every chat in the Work Entry. */
  workEntryLastMessageAt?: string;
  /**
   * ISO-8601 durable activity watermark (rename, status change, agent
   * activity). Part of the desktop's recency ordering; absent on legacy rows.
   */
  workEntryLastTouchedAt?: string;
  /**
   * Registry index: the desktop's persisted manual order within the workspace
   * (0 = top). Every create, delete, restore or reorder re-projects all of the
   * workspace's chats, so indices stay consistent across entries.
   */
  workEntryOrder?: number;
  /** Emitted only when the user pinned the Work Entry; absent means unpinned. */
  workEntryPinned?: boolean;
  /** Emitted only when the Work Entry is marked done; absent means active. */
  workEntryStatus?: 'done';
  /**
   * Server notification space id for this Work Entry (CAN-3615). Absent
   * until the desktop has registered the space.
   */
  workEntryNotificationSpaceId?: string;
}

/**
 * Standalone-chat summary returned by `listStandaloneChats` (transport Phase
 * T17). Mirrors the cached `standalone_chat` entity payload but flattened
 * for service-layer consumption.
 */
export interface PortalStandaloneChatSummary extends PortalStandaloneWorkEntryFields {
  usage?: PortalChatUsage;
  projectLocalId: string;
  projectId: string;
  chatId: string;
  title: string;
  /** User-owned chat name; absent on older desktop hosts. */
  customTitle?: string;
  modelLabel?: string;
  /** Absent means manual for compatibility with older projections. */
  modelSelectionMode?: 'auto';
  description?: string;
  /** ISO-8601 timestamp of the most recent message in the chat. */
  lastMessageAt?: string;
  /** Newest user/assistant message; absent when unknown on older hosts. */
  lastMessageRole?: 'user' | 'assistant';
  /** ISO-8601 timestamp of the chat creation. */
  createdAt?: string;
  /** True when the chat has been archived from the active list. */
  archived?: boolean;
  /** True while the chat has an in-flight turn or queued message. */
  hasActiveChat?: boolean;
  /**
   * The chat's background tasks (D11), sent whenever the desktop has
   * canonical turn state, zero included, so a delta clears it (turn-state
   * phase 41b). Omitted by older desktops.
   */
  backgroundTasks?: number;
  /** As {@link PortalChatSummaryEntity.awaitingApproval}. */
  awaitingApproval?: boolean;
  /** As {@link PortalChatSummaryEntity.scheduledMessages}. */
  scheduledMessages?: PortalChatScheduledMessages;
  /** True when the chat has output the user has not viewed. */
  hasUnread?: boolean;
  /** Provider that owns the chat session. */
  providerType?: AgentExecutionHarness;
  /** Desktop-authoritative harness captured for an existing session. */
  executionHarness?: AgentExecutionHarness;
  /** Whether persisted context or pending execution prevents changing harness. */
  modelHarnessLocked?: boolean;
  /**
   * Current model id (registry key), distinct from {@link modelLabel} which is
   * the human-readable display string. Lets the portal's standalone model
   * picker seed the exact selected model (CAN-1219).
   */
  model?: PortalChatModel;
  /**
   * The desktop's projected model catalog (CAN-1219), so the standalone/cowork
   * model picker offers the SAME models the connected desktop has. Omitted when
   * no portal session is active or the desktop has not hydrated its registry.
   */
  availableModels?: ModelCatalog;
  /**
   * Cheap desktop projection of native provider auth (CAN-1217 shape reused). A
   * `true`/`false` value reflects the last observed native login; an omitted
   * provider key means "unknown" and consumers treat it optimistically.
   */
  providerAvailability?: PortalChatProviderAvailability;
  /**
   * The chat's own plugin selections (CAN-3923). Absent when the desktop has
   * not projected them yet; an empty set means nothing is selected.
   */
  pluginSelectionsDetail?: PortalChatTabPluginSelections;
  /** Effective chat policy; absent on older hosts. */
  deferredToolsAllowed?: boolean;
  queuedMessages?: PortalQueuedMessage[];
  inputDelivery?: ChatInputDeliveryView[];
  /** Delegations whose request to this chat waits in its queue (ids only). */
  waitingDelegationIds?: string[];
  steeringCapabilities?: ChatSteeringCapabilities;
  /** True while a turn runs in this chat; absent on older hosts. */
  turnActive?: boolean;
  /** See {@link PortalChatSummaryEntity.lastTurnEnd}. */
  lastTurnEnd?: PortalChatTurnEnd;
  /**
   * The chat's projected AskUserQuestion state, shaped like
   * {@link PortalChatSummaryEntity.pendingQuestions}. Every payload for a chat
   * with a live session carries it, since an awaited question lives in that
   * session, and `[]` clears earlier state. Absent for chats with no session
   * and on older hosts, so consumers that replace payloads whole drop it then.
   */
  pendingQuestions?: PortalAskUserQuestionState[];
}

/** File-root summary returned by `listFileRoots` (transport Phase T17). */
export interface PortalFileRoot {
  workspaceLocalId: string;
  worktreeLocalId: string;
  fileRootLocalId: string;
  label: string;
  /** Stable catalog classification. Absent on older hosts; do not infer it from labels. */
  rootKind?: WorkerFilesystemRootsListResult['roots'][number]['kind'];
  /** Absolute path on the user's machine; surfaced read-only for context. */
  absolutePath: string;
}

/**
 * Single rich content block carried inside a {@link PortalChatMessage}'s
 * `parts` array. Tool calls, thinking blocks, and attachment frames are
 * surfaced here rather than concatenated into `text` so the renderer can
 * distinguish "model said X" from "model invoked tool Y" and so terminal
 * cancellation does not erase already-streamed prose (transport plan Phase
 * T3.2).
 *
 * The closed `kind` set is intentionally narrow; new block types MUST be
 * added here in lockstep with the projection layer.
 */
/**
 * Closed enumeration of tool families surfaced on `tool_use` chat parts.
 * Lets the renderer pick the right icon without a hard-coded switch on the
 * raw tool name. The local Canopy chat-transcript projector populates this
 * deterministically from the tool name string.
 */
export type PortalChatToolFamily =
  | 'read'
  | 'edit'
  | 'write'
  | 'plan'
  | 'bash'
  | 'grep'
  | 'glob'
  | 'todo'
  | 'web'
  | 'agent'
  | 'ask-user'
  | 'script-output'
  | 'skill'
  | 'monitor'
  | 'claude'
  | 'watcher'
  | 'canopy'
  | 'graph'
  | 'app-advisor'
  | 'pipeline-editor'
  | 'computer-use'
  | 'unknown';

/**
 * Agent-block payload data carried inside a {@link PortalChatPart} with
 * `kind: 'agent'`. Mirrors the desktop renderer's `AgentBlock` shape so the
 * portal can render the same header + usage stats + sub-blocks treatment.
 *
 * `subBlocks` is an array of nested `PortalChatPart` values so the renderer
 * can recurse without needing a separate transport.
 */
export interface PortalChatAgentBlockData {
  /** Harness that spawned the agent; absent means Claude. */
  provider?: 'claude' | 'codex';
  /** Spawn tool call id (Claude tool_use id, Codex collab call id). */
  toolUseId?: string;
  subagentType?: string;
  description?: string;
  runInBackground?: boolean;
  prompt?: string;
  result?: string;
  /** Drives the card spinner; absent means settled. */
  isRunning?: boolean;
  /** Destructive styling for a failed or lost agent. */
  isError?: boolean;
  /** Configured model and effort shown in the expanded card (Codex). */
  model?: string;
  reasoningEffort?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    toolUses?: number;
    apiCalls?: number;
    contextTokens?: number;
    contextWindow?: number;
    totalCostUsd?: number;
    durationMs?: number;
    model?: string;
  };
  subBlocks?: PortalChatPart[];
  /** Earlier child parts were dropped; see `omittedSubBlocks`. */
  subBlocksTruncated?: boolean;
  omittedSubBlocks?: number;
  /** Agent task this card represents, when the host knows it. */
  taskId?: string;
  taskStatus?: string;
  /** The task waits for a tool approval. */
  taskApprovalPending?: boolean;
  /** Who cancelled the task, when it was cancelled. */
  taskStopReason?: AgentTaskStopReason | null;
  /** The host can stop the task now (cloud: Core's `stoppable`, CAN-5205). */
  taskStoppable?: boolean;
  /** The task's failure message, when it failed. */
  taskErrorMessage?: string;
  /** Epoch ms the task was created; null when unknown. */
  createdAt?: number | null;
  /** Epoch ms the task started; null means it has not started. */
  startedAt?: number | null;
  /** Epoch ms the task settled; null means it has not settled. */
  completedAt?: number | null;
  /** Display label of the task's model. */
  modelLabel?: string;
  /** Codex display block id (`codex-agent-<callId>`). */
  agentBlockId?: string;
  /** Codex spawn call id. */
  callId?: string;
  /** Canonical Codex collab tool of the spawning card (`spawnAgent`). */
  tool?: string;
  /** Codex collab call status, distinct from `taskStatus`. */
  status?: string;
  /** Codex thread that issued the spawn. */
  senderThreadId?: string;
  /** Codex threads the spawn created. */
  receiverThreadIds?: string[];
  /** Codex card title derived from receiver identity. */
  displayName?: string;
  /** Latest known Codex state of each receiver thread. */
  agentsStates?: Record<string, { status: string; message?: string | null }>;
  /** Known identity and configuration of each receiver thread. */
  receiverAgents?: Record<
    string,
    {
      nickname?: string;
      role?: string;
      agentPath?: string;
      model?: string;
      reasoningEffort?: string;
    }
  >;
  /** The session's root Codex thread, when known. */
  codexRootThreadId?: string;
  /** When each receiver thread's own turns ran, in epoch ms. */
  receiverTimes?: Record<string, { startedAt?: number; settledAt?: number }>;
  /**
   * A multi-receiver Codex card's child parts by receiver thread; the card's
   * `subBlocks` hold every receiver's parts together.
   */
  receiverSubBlocks?: Record<string, PortalChatPart[]>;
}

/**
 * Payload data carried inside a {@link PortalChatPart} with
 * `kind: 'compaction'`: the agent harness compacted the session's context.
 * Append-only transcript evidence, mirroring the desktop transcript's
 * `compaction_info` block; the renderer never rewrites earlier content.
 */
export interface PortalChatCompactionData {
  /** Epoch ms when the compaction completed. */
  occurredAt: number;
  /** What caused it (`auto`, `manual`, or a harness-specific reason). */
  trigger?: string;
  /** Optional summary text produced by the provider. */
  summary?: string;
  /**
   * Provider that produced the compaction (`claude`, `codex`, ...), when
   * known. The renderer keys its headline off this so a Codex compaction is
   * not labelled as Claude's.
   */
  provider?: string;
  /**
   * UX surface that owned the chat at the time (`canopy`, `claude-code`,
   * `auto`), when known; distinguishes Claude Code terminal compactions.
   */
  interfaceMode?: string;
  /** Context size before the compaction, in tokens. */
  tokensBefore?: number;
  /** Context size after the compaction, in tokens. */
  tokensAfter?: number;
}

/**
 * Payload data carried inside a {@link PortalChatPart} with
 * `kind: 'account_switch'`: the account proxy moved the chat to another of
 * its accounts (CAN-4021). Mirrors the desktop transcript's
 * `account_proxy_switch` block. Labels are often emails.
 */
export interface PortalChatAccountSwitchData {
  /** Epoch ms when the new account first served the chat. */
  occurredAt: number;
  /** The account that now serves the chat. */
  account: string;
  /** The account that served it before, when known. */
  previousAccount?: string;
  /** The previous account was at a usage limit. */
  previousAtLimit?: boolean;
}

/**
 * Payload data carried inside a {@link PortalChatPart} with
 * `kind: 'mods_skipped'`: a Claude launch skipped plugins' Mods while Mod
 * admission was on. Mirrors the desktop transcript's `claude_mods_skipped`
 * block; path-free.
 */
export interface PortalChatModsSkippedData {
  /** Epoch ms when the launch started. */
  occurredAt: number;
  /** Each skipped plugin's Claude id and the launch decision's reason. */
  mods: { pluginId: string; reason: string }[];
}

/**
 * Auto-routing attribution carried on a `turn_timer` part's `data`, alongside
 * its timing fields: the model Auto picked for that turn. Producers stamp it
 * only on routed turns, so renderers show the "Picked by model routing" chip the
 * desktop transcript shows. Both fields are optional on the wire; older
 * producers omit them.
 */
export interface PortalTurnTimerAutoRoutedModel {
  /** Model id (desktop registry key or cloud model definition id). */
  autoRoutedModel: string;
  /** Display name resolved by the producer, which owns the model catalog. */
  autoRoutedModelLabel?: string;
}

/**
 * Why a turn ended abnormally, carried as the optional `endReason` field on a
 * completed `turn_timer` part's `data` (the row itself stays
 * `status: 'complete'`). Producers omit it for a normal completion, so a
 * consumer can render a completed timer without `endReason` normally. Its
 * absence is not positive execution-success evidence: older producers omit it.
 * Canonical desktop timers additionally carry optional `outcome` data
 * (`completed`, `cancelled`, `failed`), keyed by their exact `turnId`. Missing
 * outcome remains unknown even when the row is complete or has assistant text.
 */
export type PortalTurnTimerEndReason = 'cancelled' | 'failed' | 'interrupted';

/**
 * Read the Auto-routing attribution from a `turn_timer` part's free-form
 * `data`. Returns the display label (falling back to the model id), or
 * `undefined` when the turn was not routed by Auto.
 */
export function readTurnTimerAutoRoutedModelLabel(
  data: unknown,
): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const model =
    'autoRoutedModel' in data && typeof data.autoRoutedModel === 'string'
      ? data.autoRoutedModel.trim()
      : '';
  if (model.length === 0) return undefined;
  const label =
    'autoRoutedModelLabel' in data &&
    typeof data.autoRoutedModelLabel === 'string'
      ? data.autoRoutedModelLabel.trim()
      : '';
  return label.length > 0 ? label : model;
}

/** Structured success metadata survives truncation of the human-readable output. */
export interface PortalChatToolResultData {
  toolUseId?: string;
  output: string;
  isError: boolean;
  interruption?: ToolInterruption;
  agentArtifacts?: AgentArtifactReceiptV1[];
}

export interface PortalChatPart {
  kind:
    | 'mcp_activation'
    | 'text'
    | 'tool_use'
    | 'tool_result'
    | 'thinking'
    | 'attachment'
    | 'image'
    | 'agent'
    | 'turn_timer'
    | 'steering'
    | 'prompt_source'
    | 'compaction'
    | 'account_switch'
    | 'mods_skipped';
  /** Free-form per-part data; shape depends on `kind`. */
  data?: unknown;
  /**
   * For an unfolded `tool_result`, the original zero-based block position in
   * its persisted message. Omitted for the default folded projection.
   */
  blockOrdinal?: number;
  /**
   * For an unfolded `tool_result`, points to its stored output body when the
   * body is externalized or its inline preview is locally truncated. Omitted
   * for results whose output is already complete in `data`.
   */
  outputLocator?: {
    messageId: string;
    blockOrdinal: number;
    field: 'output';
  };
  /**
   * For an ordinary `tool_use` or `tool_result`, the canonical occurrence it
   * shows: its id stays the same across every later frame (a paired call keeps
   * it when its result arrives), and merges key the part by it, so a reused
   * provider tool id never takes another occurrence's locator. Validate with
   * `readPortalToolOccurrence`; see `tool-part-occurrence.ts`.
   */
  occurrence?: {
    id: string;
    revision: number;
  };
  /**
   * For `kind: 'tool_use'`, the canonical family the tool belongs to. The
   * desktop chat-transcript projector populates this deterministically from
   * the tool name string so the renderer can dispatch the right icon
   * without parsing free-form names.
   */
  toolFamily?: PortalChatToolFamily;
}

/**
 * Outcomes per counted logical step. All fields are safe non-negative integers.
 * Omission of the entire object by a producer means metadata is unavailable.
 */
export interface TurnOutcomeCounts {
  blocked: number;
  failed: number;
  interrupted: number;
}

/** Missing results are evidence only in a settled, fully available turn. */
export interface TurnOutcomeEvidence {
  settled: boolean;
  resultsComplete: boolean;
}

/** Exclusive classification shared by canonical and Portal transcript readers. */
export function classifyTurnStepOutcome(
  result: { isError: boolean; interruption?: ToolInterruption } | undefined,
  blocked: boolean,
  evidence?: TurnOutcomeEvidence,
): keyof TurnOutcomeCounts | undefined {
  if (blocked) return 'blocked';
  if (result?.interruption) return 'interrupted';
  if (result?.isError) return 'failed';
  if (!result && evidence?.settled && evidence.resultsComplete)
    return 'interrupted';
  return undefined;
}

/** Strict validation for derived caches; older cache versions must rebuild. */
export function isTurnOutcomeCounts(
  value: unknown,
): value is TurnOutcomeCounts {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'blocked' in value &&
    'failed' in value &&
    'interrupted' in value &&
    [value.blocked, value.failed, value.interrupted].every(
      (count) =>
        typeof count === 'number' && Number.isSafeInteger(count) && count >= 0,
    )
  );
}

/** Normalize legacy wire counts only; absence of metadata stays unavailable. */
export function readTurnOutcomeCounts(
  value: unknown,
): TurnOutcomeCounts | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('blocked' in value) ||
    !('failed' in value)
  )
    return undefined;
  const normalized = {
    blocked: value.blocked,
    failed: value.failed,
    interrupted: 'interrupted' in value ? value.interrupted : 0,
  };
  return isTurnOutcomeCounts(normalized) ? normalized : undefined;
}

/**
 * One blocked, errored or interrupted step of a turn, as the outcome tooltip
 * lists it. Hosts derive it from loaded rows only; it is never carried on the
 * wire or stored in the transcript index.
 *
 * `toolName` and `input` are what `getToolDisplayInfo` takes, so a host passes
 * the step's display call unchanged. `output` is the raw result text; the
 * shared UI derives the one-line reason from it.
 */
export interface TurnOutcomeStepDetail {
  toolUseId: string;
  outcome: keyof TurnOutcomeCounts;
  toolName: string;
  input: string;
  output?: string;
  interruption?: ToolInterruption;
}

/** How one turn ended, keyed by the user message that opened it. */
export interface PortalChatTurnEnd {
  userMessageId: string;
  outcome: 'completed' | 'failed' | 'cancelled';
  /** ISO-8601 time the turn ended. */
  endedAt: string;
}

/**
 * One entry in {@link PortalChatMessage.chatTurnGroups}. Groups a user turn
 * with the intermediate (collapsed-by-default) assistant blocks and the
 * final assistant blocks. Mirrors the desktop renderer's `TurnGroup`.
 */
export interface PortalChatTurnGroup {
  /** Optional untrusted file evidence; host adapters authorize file actions. */
  files?: TurnFileRecord[];
  /**
   * Message id of the user prompt that initiated this turn, or of a wake's
   * timer for an autonomous turn (see {@link wake}).
   */
  userMessageId: string;
  /**
   * Set on an autonomous (wake) turn, which a boundary row heads instead of a
   * prompt (turn-state phase 40e). The finished task's label, the prompt whose
   * turn started it and the tool call that started it, when the transcript
   * holds them; `event` when the task reported an event and keeps running;
   * `scheduled` when a scheduled prompt (a cron job) fired; `toolsLoaded`
   * when the agent continued after Canopy restarted it to load tools.
   */
  wake?: {
    taskLabel?: string;
    spawningUserMessageId?: string;
    spawningToolUseId?: string;
    event?: true;
    scheduled?: true;
    toolsLoaded?: true;
  };
  /** Assistant message ids the renderer collapses behind a summary chip. */
  intermediateMessageIds: string[];
  /** Assistant message ids the renderer always renders inline. */
  finalMessageIds: string[];
  /**
   * Assistant/system message ids in transcript order for an expanded turn.
   * Older producers may omit this; renderers then fall back to the two
   * collapsed-layout buckets above.
   */
  expandedMessageIds?: string[];
  /** Whether every message in this turn has reached a terminal state. */
  complete?: boolean;
  /** ISO-8601 timestamp set when the user reverted past this turn. */
  revertedAt?: string;
  /** Optional preview text shown alongside a reverted turn. */
  revertedPreview?: string;
  /**
   * Aggregate counts per tool family across the intermediate blocks. Lets
   * the renderer draw the "Bash 3 · Read 2 · Edit 1" chip without walking
   * the message list. Values omitted when zero. Undefined whenever
   * `intermediateMessageIds` is empty, for streaming and completed turns.
   */
  summary?: {
    thinkingCount?: number;
    messageCount?: number;
    bashCount?: number;
    readCount?: number;
    editCount?: number;
    writeCount?: number;
    planCount?: number;
    grepCount?: number;
    globCount?: number;
    todoCount?: number;
    webCount?: number;
    agentCount?: number;
    askUserCount?: number;
    scriptOutputCount?: number;
    claudeCount?: number;
    watcherCount?: number;
    canopyCount?: number;
    graphCount?: number;
    computerUseCount?: number;
    otherCount?: number;
  };
}

/**
 * Canonical chat message shape used by both the wire (`portal.chat.event`
 * `message` field, snapshot `chatMessages` arrays) and the local
 * service-method return values listed in transport Phase T17.
 *
 * Projection rules (mirrored in the chat backend implementation):
 *
 * - User messages → `role: 'user'`, `status: 'complete'`.
 * - Assistant messages → `role: 'assistant'`.
 * - Streaming runtime deltas → `status: 'streaming'`.
 * - Terminal completion / success → `status: 'complete'`.
 * - Error / cancel → `status: 'failed'` or `status: 'cancelled'`.
 * - Text blocks join with blank lines into `text`.
 * - Tool / thinking blocks land in `parts` and MUST NOT erase `text`.
 *
 * `createdAtMs` is epoch-ms (not an ISO string) so the renderer can sort
 * messages without parsing timestamps when no `presentationOrder` is supplied;
 * `updatedAtMs` is set on streaming frames after each delta merge so consumers
 * can derive "last activity".
 */
export interface PortalChatMessage {
  messageId: string;
  /** Host-owned provenance; legacy hosts may omit it. Never infer from text when present. */
  promptSource?: 'human' | 'automated';
  autoResume?: AutoResumeMetadata;
  /**
   * Host-owned marker for a user message a fired watcher posted. Absent on
   * every other message and from legacy hosts; read it with
   * {@link readChatWatcherFired} so cached history without it still works.
   */
  watcherFired?: ChatWatcherFiredInfo;
  /** Authoritative transcript position when presentation order differs from time. */
  presentationOrder?: number;
  /** Caller-owned idempotency key for reconciling optimistic user messages. */
  clientRequestId?: string;
  /** Author attribution for a shared cloud-chat user turn. */
  author?: { userId: string; name: string; image?: string };
  /** Exact Core turn namespace from message.start, when supplied. */
  sourceKey?: string;
  chatId: string;
  role: 'user' | 'assistant' | 'system';
  /**
   * Set on a user message that continues the current turn instead of starting
   * one, such as folded steering or an async question answer.
   */
  continuesTurn?: true;
  status: 'streaming' | 'complete' | 'failed' | 'cancelled';
  text: string;
  /** Machine-readable failure classification supplied by the runtime. */
  errorCode?: string;
  /** Raw runtime failure detail retained separately from user-safe `text`. */
  errorMessage?: string;
  /** Tool / thinking blocks; must not erase `text` content. */
  parts?: PortalChatPart[];
  createdAtMs: number;
  updatedAtMs?: number;
  /** Files the user attached to this message (user rows only). */
  attachments?: PortalChatMessageAttachment[];
  /**
   * Trusted marker on a user message another agent sent: a Canopy chat, or an
   * external MCP agent the desktop attaches only from a validated command
   * `origin` (provenance.md). Never includes hidden instructions. Absent on
   * ordinary messages.
   */
  agentSent?: AgentSentInfo;
}

/** Provenance also travels in parts so cached Portal history retains it. */
export function readChatPromptSource(
  message: Pick<PortalChatMessage, 'promptSource' | 'parts'>,
): 'human' | 'automated' | undefined {
  if (message.promptSource === 'human' || message.promptSource === 'automated')
    return message.promptSource;
  for (const part of message.parts ?? []) {
    const data = part.data;
    if (
      part.kind !== 'prompt_source' ||
      typeof data !== 'object' ||
      data === null ||
      !('source' in data)
    )
      continue;
    if (data.source === 'human' || data.source === 'automated')
      return data.source;
  }
  return undefined;
}

/** Watcher attribution also travels in the `prompt_source` part for cached history. */
export function readChatWatcherFired(
  message: Pick<PortalChatMessage, 'watcherFired' | 'parts'>,
): ChatWatcherFiredInfo | undefined {
  const topLevel = parseChatWatcherFiredInfo(message.watcherFired);
  if (topLevel) return topLevel;
  for (const part of message.parts ?? []) {
    const data = part.data;
    if (
      part.kind !== 'prompt_source' ||
      typeof data !== 'object' ||
      data === null ||
      !('watcherFired' in data)
    )
      continue;
    const watcherFired = parseChatWatcherFiredInfo(data.watcherFired);
    if (watcherFired) return watcherFired;
  }
  return undefined;
}

/**
 * Wire envelope for `portal.chat.event` (transport plan Phase T3.1). Each
 * envelope carries exactly one {@link PortalChatMessage}; the wrapper
 * propagates the routing context (worktree vs. standalone scope, owning
 * workspace/worktree, chat thread) so the server cache can attach the row
 * to the right slice without re-deriving it from the message body.
 */
export interface PortalChatEventPayload {
  scope: PortalChatScope;
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  /** Cowork workspace identity used by standalone chat projections. */
  projectLocalId?: string;
  /** Legacy alias retained for existing standalone event consumers. */
  projectId?: string;
  /** Owning cowork Work Entry; pairs with the workspace id for routing. */
  workEntryId?: string;
  chatId: string;
  /** Ordered main-owned commit identity (omitted by legacy runtime frames). */
  baseRevision?: number;
  revision?: number;
  message: PortalChatMessage;
}

/**
 * Wire envelope for `portal.app_advisor.event` (CAN-2562). Mirrors
 * {@link PortalChatEventPayload} without the scope/workspace routing — App
 * Advisor chats live under the desktop's sentinel App Advisor workspace, so
 * `chatId` alone identifies the tab.
 */
export interface PortalAppAdvisorChatEventPayload {
  chatId: string;
  message: PortalChatMessage;
}

/**
 * Projected payload for the `app_advisor_chat` cached entity (CAN-2562): one
 * row per App Advisor chat tab, mirroring {@link PortalChatSummaryEntity}
 * minus the worktree/standalone `scope` discriminant. `pendingQuestions`
 * carries the same {@link PortalAskUserQuestionState} lifecycle used by
 * worktree chats, so the browser overlay reuses the existing question cards.
 */
export interface PortalAppAdvisorChatSummary extends Omit<
  PortalChatSummaryEntity,
  'scope'
> {
  /** Owning App Advisor Work Entry (the desktop nav row). */
  workEntryId?: string;
  /** Desktop-derived Work Entry title shown in the App Advisor nav. */
  workEntryTitle?: string;
  /** Work Entry creation time, used as the legacy ordering fallback. */
  workEntryCreatedAt?: string;
  /** Latest activity across every sub-chat in the Work Entry. */
  workEntryLastMessageAt?: string;
  /** Registry index: the desktop's persisted manual sidebar order. */
  workEntryOrder?: number;
  /** True only for the chat selected in the desktop's current Work Entry. */
  desktopCurrent?: boolean;
  /**
   * Number of armed (status `active`) App Advisor watchers whose fired
   * message will be delivered into this chat (CAN-2569). Omitted when zero
   * or when the projecting desktop predates this field; consumers treat
   * omission as "no armed watchers".
   */
  armedWatcherCount?: number;
}

// ---------------------------------------------------------------------------
// Hybrid transcript ownership: historical-sync vs live-protocol (CAN-761)
// ---------------------------------------------------------------------------

/**
 * Worktree- vs standalone-scoped chat thread. Mirrors the `scope` discriminant
 * already carried inline on {@link PortalChatEventPayload} /
 * {@link PortalChatMessagePayload} and the Prisma `PortalChatScope` enum;
 * named here so the hybrid-transcript contract can reference it once.
 */
export type PortalChatScope = 'worktree' | 'standalone' | 'app_advisor';

/**
 * The historical/live ownership split is expressed *structurally*, not with a
 * per-message tag: the per-chat watermark ({@link
 * PortalChatTranscriptWindow.liveTailCursor}) is the boundary, the live tail
 * flows over the `chat.message` event channel, and the historical prefix is
 * pulled via the `chat.history` query. Provenance is therefore derivable from
 * which channel delivered a message and where it sits relative to the
 * watermark — no `segment` enum on individual messages is needed.
 *
 * Opaque, server-defined cursor addressing a turn boundary in a chat
 * transcript's turn stream. It encodes the ordering key of the anchoring user
 * message (its `occurredAt` plus the server's numeric database id as a stable
 * tiebreak) so
 * pagination survives concurrent inserts. This is a string cursor and is
 * intentionally distinct from the numeric sequence cursors used elsewhere in
 * this protocol (`commandCursor`, `eventCursor`, `nextCursor` on the long-poll
 * endpoints) — the two regimes are not interchangeable.
 *
 * Treat it as opaque on the browser: never parse, sort, or compare cursors —
 * store the value and pass it back verbatim to request the adjacent chunk.
 * A `null` cursor consistently means "no turns exist on that side" (e.g. start
 * of transcript reached, or no historical prefix yet).
 */
export type PortalTranscriptCursor = string;

/**
 * Per-chat description of the loaded transcript window: the boundary between the
 * live tail and the historical prefix, plus the cursor the browser needs to
 * lazily page older turns. Carried in
 * {@link PortalSessionShellState.chatTranscripts}, keyed by the composite
 * `"${scope}:${chatId}"` (see that field) — `chatId` alone is not unique across
 * scopes, so the key MUST be scope-qualified.
 *
 * Metadata only — the messages themselves live in
 * {@link PortalSessionShellState.chatMessages}. A window MAY be absent for a
 * chat, in which case the consumer falls back to the legacy behaviour of
 * treating every cached message as live with no scrollback available. This keeps
 * the field purely additive: pre-hybrid snapshots simply omit it.
 */
export interface PortalChatTranscriptWindow {
  /** Chat thread this window describes. */
  chatId: string;
  /** Worktree- vs standalone-scoped chat, mirroring the routing namespace. */
  scope: PortalChatScope;
  /**
   * The watermark: the cursor at which the live segment begins. Turns at or
   * after it are live-owned (streamed, upserted by id); turns strictly before
   * it are historical-owned (immutable, chunk-paginated). The live transport
   * advances this as recently-completed turns age out of the bounded live tail
   * (see {@link PORTAL_LIVE_TAIL_TURNS_DEFAULT}) into the historical store.
   *
   * `null` means the entire transcript is currently live-owned and there is no
   * historical prefix yet (e.g. a brand-new chat whose turns all fit inside the
   * live tail). Consumers MUST treat `null` as "no watermark / everything is
   * live", not as an empty-string cursor.
   */
  liveTailCursor: PortalTranscriptCursor | null;
  /**
   * Cursor for the next-older historical chunk — pass as
   * {@link PortalChatHistoryRequest.before}. `null` means the start of the
   * transcript is already loaded and there is no older history to fetch.
   *
   * Guard: consumers MUST check `historyCursor !== null` before issuing a
   * `chat.history` request and MUST NOT forward a `null` `historyCursor` as
   * `before` — `before: null` has the opposite meaning ("fetch the newest
   * historical page"), so passing it here would re-fetch already-loaded turns.
   */
  historyCursor: PortalTranscriptCursor | null;
}

/**
 * Arguments for a lazy scrollback fetch of one turn-aligned chunk of the
 * historical (synced) transcript prefix. This is the request half of the
 * contract the scrollback ticket (TS-05) implements against; TS-01 defines the
 * shape only — no transport is wired here.
 */
export interface PortalChatHistoryRequest {
  /**
   * Worktree- vs standalone-scoped chat. For `scope: 'worktree'` the request
   * MUST also carry `workspaceLocalId` and `worktreeLocalId` so the server can
   * resolve the owning worktree's transcript; the server rejects a
   * worktree-scoped request missing them. (The ids stay optional at the type
   * level to match the rest of the portal request/event contract, which
   * validates routing at runtime rather than via discriminated unions.)
   */
  scope: PortalChatScope;
  /** Chat thread to page. */
  chatId: string;
  /** Owning workspace local id (required for worktree-scoped chats). */
  workspaceLocalId?: string;
  /** Owning worktree local id (required for worktree-scoped chats). */
  worktreeLocalId?: string;
  /**
   * Fetch turns strictly older than this cursor — the window's
   * {@link PortalChatTranscriptWindow.historyCursor} or the previous chunk's
   * {@link PortalChatHistoryChunk.nextCursor}. `null` requests the newest
   * historical turns (the page immediately preceding the live tail). See the
   * guard on {@link PortalChatTranscriptWindow.historyCursor}: never forward a
   * null `historyCursor` here.
   */
  before: PortalTranscriptCursor | null;
  /**
   * Maximum number of whole turns to return. The server never splits a turn
   * across a chunk boundary, so a chunk may carry more messages than turns.
   * Omitted ⇒ the server default ({@link PORTAL_HISTORY_CHUNK_TURNS_DEFAULT}).
   * The server clamps this to `[1, {@link PORTAL_HISTORY_CHUNK_TURNS_MAX}]`, so
   * `0`/negative values do not stall pagination and a large value cannot pull
   * the whole transcript in one response. (A single very large turn can still
   * exceed the wire size caps; that is bounded by the existing per-message
   * limits, not by `limitTurns`.)
   */
  limitTurns?: number;
}

/** One display-ordered chunk returned by the transcript history contract. */
export interface PortalChatHistoryChunk {
  /** Chat thread these turns belong to. */
  chatId: string;
  /** Worktree- vs standalone-scoped chat. */
  scope: PortalChatScope;
  /**
   * Owning workspace local id, echoed for worktree-scoped chats. Mirrors the
   * routing envelope on {@link PortalChatEventPayload} so a consumer can attach
   * the chunk to the right `(scope, workspace, worktree, chat)` slice — and
   * stamp these onto each {@link PortalChatMessageView} it projects — without
   * retaining the originating request (important when multiple history fetches
   * are in flight concurrently).
   */
  workspaceLocalId?: string;
  /** Owning worktree local id, echoed for worktree-scoped chats. */
  worktreeLocalId?: string;
  /**
   * Always `historical`, including for protocol-v2 cloud chats whose delegate
   * returns the currently loaded transcript projection rather than a strict
   * historical page.
   */
  segment: 'historical';
  /**
   * Messages ordered for display. When present, `presentationOrder` is
   * authoritative over `createdAtMs` for relative order. A chunk may include
   * messages the client already holds; consumers merge by `messageId`.
   * `PortalChatMessage` carries no scope/routing of its own; use the chunk-level
   * routing fields when projecting rows.
   */
  messages: PortalChatMessage[];
  /**
   * Cursor for the next-older chunk, or `null` when the start of the transcript
   * has been reached. Merge returned messages by `messageId`; overlap with the
   * client's loaded transcript is permitted.
   */
  nextCursor: PortalTranscriptCursor | null;
}

/**
 * Default size of the live tail the remote-control protocol retains per chat:
 * the most recent N completed turns stay live-owned (re-streamed on the live
 * channel) before ageing into the historical store. A tuning knob revisited in
 * TS-04/TS-05; changing it does not alter the wire contract.
 */
export const PORTAL_LIVE_TAIL_TURNS_DEFAULT = 20;

/**
 * Default number of whole turns returned per lazy scrollback chunk when
 * {@link PortalChatHistoryRequest.limitTurns} is omitted. Independent of
 * {@link PORTAL_LIVE_TAIL_TURNS_DEFAULT} — the shared value of `20` is
 * coincidental and the two knobs may diverge; do not merge them.
 */
export const PORTAL_HISTORY_CHUNK_TURNS_DEFAULT = 20;

/**
 * Upper bound the server clamps {@link PortalChatHistoryRequest.limitTurns} to
 * (lower bound is `1`). Prevents a single scrollback request from pulling an
 * unbounded slice of the transcript and keeps chunk sizes predictable.
 */
export const PORTAL_HISTORY_CHUNK_TURNS_MAX = 100;

// ---------------------------------------------------------------------------
// Browser-side state projection
// ---------------------------------------------------------------------------

/**
 * Typed shell state returned by `GET /api/portal/sessions/[sessionId]/state`.
 *
 * The route projects raw `PortalCachedEntity` rows (and, where applicable,
 * `PortalChatMessage` rows) into this shape so the browser can render the
 * portal shell without parsing untyped protocol JSON. Empty arrays / records
 * are returned for sections that have not been hydrated yet.
 */
export interface PortalScriptDescriptor {
  localId?: string;
  name: string;
  scriptKey: string;
  source?: string;
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  scriptName?: string;
  target?: string;
  repoId?: string;
  repoName?: string;
  /** Frozen command and lifecycle, when supplied by the execution host. */
  command?: string;
  lifecycle?:
    | 'before'
    | 'setup'
    | 'after'
    | 'launch'
    | 'teardown'
    | 'custom'
    | null;
  /** Host refusal keeps the configured script visible without enabling Run. */
  runDisabled?: boolean;
}
/**
 * Browser-side projection of a cached `script_run` entity. Distinct from the
 * canonical {@link PortalScriptRun} (transport Phase T11) which is the
 * service-method response carried by `listScriptRuns`. The projection
 * carries the rolling cached state that `applyPortalEntity` writes into the
 * browser shell.
 */
export interface PortalScriptRunProjection {
  localId?: string;
  name: string;
  scriptKey: string;
  status: string;
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  scriptName?: string;
  target?: string;
  repoId?: string;
  repoName?: string;
  startedAt?: string;
  finishedAt?: string;
  outputTail?: string;
  command?: string;
  lifecycle?:
    | 'before'
    | 'setup'
    | 'after'
    | 'launch'
    | 'teardown'
    | 'custom'
    | null;
  durationMs?: number;
  exitCode?: number | null;
  timedOut?: boolean;
  /** Absent preserves older Remote Control hosts' cancellation support. */
  cancelable?: boolean;
  /** Confirmed refusal before a process started. */
  startError?: string;
}
export interface PortalHookDescriptor {
  localId?: string;
  name: string;
  hookKey: string;
  triggerName: string;
  source?: string;
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  target?: string;
  repoId?: string;
  repoName?: string;
  /** Host-projected pause state; paused hooks remain visible but cannot run. */
  paused?: boolean;
  /**
   * Host-computed manual-run availability. Absent means runnable for rolling
   * compatibility with older hosts.
   */
  runDisabled?: boolean;
  /** Host-computed explanation for {@link PortalHookDescriptor.runDisabled}. */
  runDisabledReason?: string;
}
/**
 * Browser-side projection of a cached `hook_run` entity. See
 * {@link PortalScriptRunProjection} for the rationale; the canonical
 * service-method response is {@link PortalHookRun} (transport Phase T11).
 */
export interface PortalHookRunProjection {
  localId?: string;
  name: string;
  hookKey: string;
  triggerName: string;
  status: string;
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  target?: string;
  repoId?: string;
  repoName?: string;
  startedAt?: string;
  finishedAt?: string;
  outputTail?: string;
  /** Zero-based index of the action currently executing, when known. */
  activeActionIndex?: number;
}

/**
 * View-only projection of one MCP server detected for the active chat in a
 * worktree. Deliberately excludes connection details, URLs, config values,
 * headers, tokens, and environment-variable values.
 */
export interface PortalMcpServerEntity {
  /** Stable detected-inventory key and cached entity local id. */
  localId: string;
  workspaceLocalId: string;
  worktreeLocalId: string;
  serverName: string;
  displayName: string;
  source: 'standalone' | 'collection' | 'bundle' | 'plugin';
  type: 'http' | 'command';
  enabled: boolean;
  authStatus:
    | 'not_configured'
    | 'not_connected'
    | 'connected'
    | 'expired'
    | 'error'
    | 'unsupported';
  authStatusLabel: string;
  canRefresh?: boolean;
  serverId?: string;
  configId?: string;
  configName?: string;
  collectionId?: string;
  bundleId?: string;
  marketplaceId?: string;
  pluginName?: string;
  pluginServerName?: string;
}

/**
 * View-only projection of a desktop agent background process. Output buffers,
 * filesystem locations, prompts, and provider diagnostics remain local.
 */
export interface PortalBackgroundProcessEntity {
  localId: string;
  workspaceLocalId: string;
  worktreeLocalId: string;
  chatId: string;
  toolUseId: string;
  taskId?: string;
  kind: 'agent' | 'bash' | 'task' | 'workflow';
  description: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: number;
  updatedAt: number;
  summary?: string;
  lastDescription?: string;
  canStop: boolean;
}

export interface PortalPlan {
  localId?: string;
  title: string;
  status: string;
  source?: string;
  /** See {@link PortalPlanSummary.sourceFilePath}. */
  sourceFilePath?: string;
  content?: string;
  reviewStatus?: string;
  approvedAt?: string | null;
  dismissedAt?: string | null;
  hidden?: boolean;
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  steps?: Array<{ id: string; label: string; status: string }>;
  /**
   * Monotonically increasing revision counter for the plan body. Mirrors
   * `TrackedPlanData.latestRevisionNumber` on the desktop side so the web
   * portal can surface "v1, v2, ..." badges without re-deriving the count
   * from the revisions list.
   */
  latestRevisionNumber?: number;
  /**
   * Convenience alias for {@link PortalPlan.latestRevisionNumber}. Surfaced
   * separately so renderers that just want the version counter can read it
   * under the shorter name.
   */
  revisionNumber?: number;
}
export interface PortalPipeline extends PortalPipelineMetadata {
  localId?: string;
  pipelineId?: string;
  name: string;
  workspaceLocalId?: string;
  worktreeLocalId?: string;
}
/**
 * Browser-side projection of a cached `pipeline_run` entity. See
 * {@link PortalScriptRunProjection} for the rationale; the canonical
 * service-method response is {@link PortalPipelineRun} (transport Phase T11).
 */
export interface PortalPipelineRunProjection {
  localId?: string;
  pipelineId?: string;
  pipelineLocalId?: string;
  pipelineName: string;
  status: string;
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  startedAt?: string;
  finishedAt?: string;
  parentExecutionId?: string;
  hidden?: boolean;
  outputTail?: string;
}
/**
 * Why a changed-files answer is incomplete (REG-3024). `truncated`: files are
 * missing because the producer hit its bound. `base_unavailable`: the base
 * branch or its merge base is missing (for example a shallow clone), so the
 * committed list could not be computed. `unavailable`: the repository could
 * not be read. `sleeping`: the sandbox is asleep, so the lists are the last
 * ones known (or empty when none were).
 */
export interface PortalChangedFilesNotice {
  kind: 'truncated' | 'base_unavailable' | 'unavailable' | 'sleeping';
  /** The repository the notice is about; absent for the whole worktree. */
  repoId?: string;
  repoName?: string;
}

export interface PortalChangedFiles {
  /** Relay-owned projection identity/version for stale diff cache matching. */
  revision?: string;
  localId?: string;
  workspaceLocalId?: string;
  worktreeLocalId: string;
  uncommitted: PortalChangedFile[];
  committed: PortalChangedFile[];
  /**
   * Additive (REG-3024): why these lists are incomplete. Absent or empty
   * means the producer reports them as complete.
   */
  notices?: PortalChangedFilesNotice[];
  page?: PortalChangedFilesPage;
}
export interface PortalDiffSnapshot {
  localId?: string;
  filePath: string;
  repoId?: string;
  patch: string;
  rangeLabel?: string;
  workspaceLocalId?: string;
  worktreeLocalId?: string;
}
export interface PortalPrStatus {
  localId?: string;
  workspaceLocalId?: string;
  worktreeLocalId: string;
  number?: number | null;
  url?: string;
  state?: string;
  baseBranch?: string;
  headBranch?: string;
  title?: string;
  /**
   * Aggregate CI check status across the PR. Mirrors the desktop
   * `CheckStatus` union; `'none'` indicates no checks are configured.
   */
  checkStatus?: 'passing' | 'failing' | 'pending' | 'neutral' | 'none';
  /**
   * Per-check detail; lets the renderer draw a list of named status dots
   * instead of just the aggregate.
   */
  checkDetails?: PortalPullRequestCheckDetail[];
  /**
   * Aggregate review status across the PR. `'none'` means no reviews exist
   * (CAN-1528 L2 widening); older emitters collapse that case into an absent
   * field, so readers must treat absent and `'none'` the same.
   */
  reviewStatus?: 'approved' | 'changes-requested' | 'pending' | 'none';
  /** True when GitHub reports mergeability conflicts on the PR. */
  hasConflicts?: boolean;
  /** Total comment count across issue and review comment threads. */
  commentCount?: number;
  /** ISO-8601 timestamp of the latest activity on the PR. */
  updatedAt?: string;
  /**
   * Active creation phase, or `null` when no PR-create flow is in flight.
   * Mirrors {@link PortalPullRequestState.creationPhase}.
   */
  creationPhase?: PortalPrCreationPhase | null;
  /** Mirrors {@link PortalPullRequestState.labels}. (CAN-1528 L2.) */
  labels?: PortalPullRequestLabel[];
  /** Mirrors {@link PortalPullRequestState.mergeReady}. (CAN-1528 L2.) */
  mergeReady?: boolean;
  /** Mirrors {@link PortalPullRequestState.repos}. (CAN-1528 L2.) */
  repos?: PortalPullRequestRepo[];
  /**
   * Mirrors {@link PortalPullRequestState.creationProgress}. (CAN-1528 L2.)
   */
  creationProgress?: PortalPrCreationProgress | null;
  /**
   * The latest refresh failed: fixed, allowlisted copy shown in place of
   * "No pull request", beside any earlier status (kept, but no longer
   * current). Absent once a refresh succeeds. (REG-3025.)
   */
  refreshError?: string;
}
/**
 * Browser-side projection of a cached `file_root` entity. See
 * {@link PortalScriptRunProjection} for the rationale; the canonical
 * service-method response is {@link PortalFileRoot} (transport Phase T11).
 */
export interface PortalFileRootProjection {
  localId?: string;
  workspaceLocalId?: string;
  worktreeLocalId: string;
  label: string;
  rootKind?: PortalFileRoot['rootKind'];
  absolutePath: string;
}
export interface PortalFileTreeNode {
  name: string;
  isDir: boolean;
  /** Exact root-relative locator when display name and read path differ. */
  relativePath?: string;
  /** This root folder is served from durable saved files while offline. */
  savedCopy?: true;
  /** The selected chat's own deliverables session folder. */
  currentSession?: true;
  /** Display-only context; never included in paths or keys. */
  secondaryLabel?: string;
}

/**
 * Browser-side projection of a cached `file_preview` entity. Distinct from
 * the canonical {@link PortalFilePreview} (transport Phase T11) which is the
 * service-method response carried by `readFile` / `saveFile`. The projection
 * carries the rolling cached state that `applyPortalEntity` writes into the
 * browser shell.
 */
export interface PortalFilePreviewProjection {
  localId?: string;
  fileRootLocalId?: string;
  filePath: string;
  contents: string;
  truncated: boolean;
  modifiedAtMs?: number;
  unsupported?: boolean;
  /**
   * Coarse-grained diff state mirrored from
   * {@link PortalFileSnapshotPayload.diffMode}.
   */
  diffMode?: 'unchanged' | 'modified';
}

/**
 * Canonical wire payload for a cached `terminal_session` entity (transport
 * plan §1.5). Surfaces the structured terminal metadata the browser shell
 * uses to render the terminal panel, alongside the rolling `buffer` that
 * replaces ad-hoc lookups into the legacy `terminalBuffers` map. Emitters
 * MUST populate `localId` (the cached entity id) and `terminalLocalId`
 * (the PTY identifier the renderer uses for `portal.terminal.*` commands);
 * the two values are usually identical but the field is split so consumers
 * cannot conflate the two semantics.
 */
export interface PortalTerminalSessionEntity {
  /** Local id of the cached `terminal_session` entity. */
  localId: string;
  /** PTY identifier used by `portal.terminal.*` command payloads. */
  terminalLocalId: string;
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  title?: string;
  cwd?: string;
  running?: boolean;
  exited?: boolean;
  exitCode?: number | null;
  signal?: string | null;
  /** Rolling stdout/stderr buffer; mirrors {@link PortalSessionShellState.terminalBuffers}. */
  buffer?: string;
}

/**
 * Canonical wire payload for a cached `chat_summary` entity (transport plan
 * §1.6). The `chat_summary` entity already exists in the closed
 * {@link PortalEntityType} set; this type pins the canonical fields the
 * server's `applyPortalEntity` projection consumes when ingesting summary
 * upserts over the existing `portal.state.delta` event channel. Per the
 * transport plan, no `portal.chat.summary.event` event type is added;
 * summary updates flow over `portal.state.delta` exclusively.
 */
/**
 * Compact projection of a chat tab's plugin/collection selections
 * (CAN-1217). The full {@link PortalChatTabPluginSelections} shape is
 * carried on `portal.chat.send`; the summary only surfaces the selected
 * collection ids plus counts so a composer chip can render "N active"
 * without walking the full selection graph. The richer selector state is
 * projected by the plugins-selector work (CAN-1219).
 */
export interface PortalChatSummaryPluginSelections {
  collectionIds: string[];
  skillCount: number;
  pluginCount: number;
  mcpServerCount: number;
}

/**
 * Cheap desktop projection of native provider auth (CAN-1217). Each value is
 * the last observed native-login state from the desktop's TTL cache; an omitted
 * key means the cache is cold ("unknown"). Ollama is local and always usable.
 */
export interface PortalChatProviderAvailability {
  claude?: boolean;
  codex?: boolean;
  ollama?: boolean;
  /**
   * Managed Cursor runtime: supported, enabled, and installed on the desktop.
   * Omitted until the desktop has checked the runtime at least once.
   */
  cursor?: boolean;
  /** Connected Copilot account with a verified, enabled managed runtime. */
  copilot?: boolean;
  opencode?: boolean;
}

/** Providers whose plan limits the `provider_usage` projection carries. */
export type PortalProviderUsageProvider = 'claude' | 'codex' | 'copilot';

export const PORTAL_PROVIDER_USAGE_PROVIDERS = [
  'claude',
  'codex',
  'copilot',
] as const satisfies readonly PortalProviderUsageProvider[];

export function isPortalProviderUsageProvider(
  value: unknown,
): value is PortalProviderUsageProvider {
  return value === 'claude' || value === 'codex' || value === 'copilot';
}

/** `localId` of the account-level `provider_usage` singleton entity. */
export const PORTAL_PROVIDER_USAGE_LOCAL_ID = 'overview';

/**
 * Sign-in state of one provider. `error` means the last usage fetch failed;
 * the entry's `error` field then explains it.
 */
export type PortalProviderUsageAuthState =
  | 'authenticated'
  | 'unauthenticated'
  | 'unknown'
  | 'error';

/** Broad category of a failed usage fetch; mirrors the desktop's kinds. */
export type PortalProviderUsageErrorKind =
  | 'auth'
  | 'network'
  | 'service'
  | 'unsupported'
  | 'unknown';

/** Classified fetch failure with user-safe copy; never raw provider text. */
export interface PortalProviderUsageError {
  kind: PortalProviderUsageErrorKind;
  message: string;
}

/**
 * `usd` amounts are dollars (Claude Extra usage). `credits` amounts are a
 * count of provider credits (the Codex balance), not money.
 */
export type PortalProviderUsageCreditUnit = 'usd' | 'credits';

/** Credits for one window. Absent amounts were not reported. */
export interface PortalProviderUsageCredits {
  unit: PortalProviderUsageCreditUnit;
  spent?: number;
  remaining?: number;
  total?: number;
}

/** Billing-period spend and cap in major currency units, not wallet credits. */
export interface PortalProviderUsageSpend {
  currency?: string;
  used?: number;
  /** Omitted when no reliable cap is reported; null only for a known uncapped cap. */
  limit?: number | null;
  isEnabled?: boolean;
}

/**
 * One plan limit window, normalized on the desktop. `id` stays stable across
 * refreshes and reordering; `label` is display copy such as `5-hour window`,
 * `7-day Opus` or `Extra usage`.
 */
export interface PortalProviderUsageWindow {
  id: string;
  label: string;
  /** Explicitly unlimited; absent usage alone does not imply this. */
  unlimited?: boolean;
  usedPercent?: number;
  /** ISO timestamp of the next reset. */
  resetsAt?: string;
  windowDurationMs?: number;
  credits?: PortalProviderUsageCredits;
  /** Optional for compatibility with older paired clients. */
  spend?: PortalProviderUsageSpend;
}

/** Most account-proxy accounts one `provider_usage` entry carries. */
export const PORTAL_PROVIDER_USAGE_MAX_ACCOUNTS = 50;

/** Most limit windows one account-proxy account carries. */
export const PORTAL_PROVIDER_USAGE_MAX_ACCOUNT_WINDOWS = 20;

/**
 * Longest account-proxy account `label` or `planLabel` on the wire. The
 * desktop truncates longer text; it keeps the full text in its own views.
 */
export const PORTAL_PROVIDER_USAGE_MAX_ACCOUNT_LABEL_LENGTH = 320;

/** Whether an account-proxy account can serve requests now, and why not. */
export type PortalProviderUsageAccountStatus =
  | 'active'
  | 'cooling'
  | 'error'
  | 'disabled'
  | 'refreshing'
  | 'pending';

/**
 * Where an account's limits came from: `live` is the desktop's own quota
 * read; `passive` is what the account proxy last reported from its traffic.
 */
export type PortalProviderUsageAccountSource = 'live' | 'passive';

/**
 * One account the multi-account proxy shares for a provider. Display fields
 * only: no credential file names, proxy messages, connection ids or URLs.
 * Absent `usageSource` with no windows means usage is unavailable, never 0%.
 */
export interface PortalProviderUsageAccount {
  /** Opaque id, unique within its entry and stable across refreshes. */
  id: string;
  /** Email or account name; hosts block it from session replay. */
  label?: string;
  /** Plan display label, e.g. `Claude Max 20x`, or `API key`. */
  planLabel?: string;
  status: PortalProviderUsageAccountStatus;
  /**
   * The proxy can no longer renew this account's sign-in; sent with status
   * `error`, which older hosts show. Sign in again in proxy settings.
   */
  signInRequired?: true;
  /** ISO timestamp when a cooling account can serve again. */
  availableAt?: string;
  usageSource?: PortalProviderUsageAccountSource;
  /** ISO timestamp of the last successful usage read for this account. */
  lastUpdatedAt?: string;
  /** The latest failed read; `windows` keep the last known values. */
  error?: PortalProviderUsageError;
  /** ISO timestamp before which the desktop will not ask again. */
  retryAt?: string;
  windows: PortalProviderUsageWindow[];
}

/** Current-account usage of one provider. */
export interface PortalProviderUsageEntry {
  provider: PortalProviderUsageProvider;
  authState: PortalProviderUsageAuthState;
  accountEmail?: string;
  /** Non-email account identity, such as a GitHub login. */
  accountLabel?: string;
  /** Plan display label, e.g. `Claude Max 20x` or `ChatGPT Pro`. */
  planLabel?: string;
  /** ISO timestamp of the desktop's last usage read for this provider. */
  lastUpdatedAt?: string;
  error?: PortalProviderUsageError;
  windows: PortalProviderUsageWindow[];
  /**
   * Present only while the desktop's multi-account proxy serves this
   * provider: its accounts, in place of the native sign-in, whose limits no
   * longer apply. An empty list means the proxy has no account for it.
   * Older desktops omit it.
   */
  accounts?: PortalProviderUsageAccount[];
}

/**
 * Payload of the account-level `provider_usage` singleton entity (CAN-3635),
 * whose `localId` is `overview` in overview snapshots and deltas. Carries
 * exactly one entry each for Claude and Codex. Copilot is included only when
 * the host publishes its gated account-usage summary. No host paths, credentials
 * or raw provider responses cross this boundary.
 */
export interface PortalProviderUsageProjection {
  /** Optional metadata, separate from quotas so older peers can ignore it. */
  openCodeAccounts?: OpenCodeAccountSnapshot;
  updatedAt: string;
  providers: PortalProviderUsageEntry[];
}

/** Payload for `portal.provider_usage.refresh`. */
export type PortalProviderUsageRefreshProvider =
  | 'claude'
  | 'codex'
  | 'copilot'
  | 'opencode';

export function isPortalProviderUsageRefreshProvider(
  value: unknown,
): value is PortalProviderUsageRefreshProvider {
  return value === 'opencode' || isPortalProviderUsageProvider(value);
}

export interface PortalProviderUsageRefreshPayload {
  provider: PortalProviderUsageRefreshProvider;
}

/**
 * Result of `portal.provider_usage.refresh`: the refresh started or joined
 * one already running. New values arrive as a `provider_usage` delta.
 */
export interface PortalProviderUsageRefreshResult {
  provider: PortalProviderUsageRefreshProvider;
  accepted: true;
}

/**
 * Chat-level provider usage-limit banner state, mirrored from the desktop
 * tab's persisted `LlmProviderUsageLimitBannerState` (CAN-2601).
 */
/**
 * Running usage for one chat, as the composer's context meter renders it.
 * Cumulative counters are session totals; `contextTokens` is the size of the
 * context the runtime sent on its last call (and drops after a compaction).
 * Every field is optional: a runtime reports what it knows, and the meter
 * hides the rows it cannot fill rather than showing zeros.
 */
export interface PortalChatUsage {
  /** Latest native turn/context report; null explicitly clears a previous report. */
  opencodeReportedUsage?: OpenCodeReportedUsage | null;
  contextTokens?: number;
  /** Resolved context window in tokens; absent when no source knows it. */
  contextWindow?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Cumulative cost in USD; absent when the runtime cannot price the chat. */
  totalCostUsd?: number;
  numTurns?: number;
  /** Cumulative wall-clock duration of observed turns, in milliseconds. */
  durationMs?: number;
  /** Model id that produced the latest answer. */
  model?: string;
}

/**
 * A transient phase of the in-flight turn. Rendered in the working indicator
 * while set; cleared by the next delta or the finish.
 *
 * - `compacting` is reported by the runtime mid-turn.
 * - `continuing` is projected by the host before the turn reaches the runtime
 *   at all: the chat's session had ended, so a replacement is being created
 *   for the message the user just sent. No runtime reports it, so nothing
 *   parses it off the wire.
 */
export type PortalChatStreamingStatus = 'compacting' | 'continuing';

export interface PortalChatUsageLimit {
  provider: 'claude' | 'codex';
  /** Human-readable limit message parsed by the desktop, when available. */
  message?: string;
  /** Provider-reported reset time (ms since epoch), when available. */
  resetsAt?: number;
  /**
   * Stable de-dupe key from the desktop banner: a later limit event carries a
   * different key, letting consumers re-show a banner dismissed locally.
   */
  dismissKey: string;
}

/** Browser-safe projection of one host-owned queued chat message. */
export interface PortalQueuedMessage {
  id: string;
  /** Same provenance as the eventual transcript prompt. */
  promptSource?: 'human' | 'automated';
  autoResume?: AutoResumeMetadata;
  text: string;
  origin: 'desktop' | 'portal';
  enqueuedAtMs: number;
  turnPhase?: ChatTurnPhase;
  /** Agent-sender display attribution; never includes hidden instructions. */
  agentSent?: AgentSentInfo;
  /** Host-owned marker for a queued message a fired watcher posted. */
  watcherFired?: ChatWatcherFiredInfo;
  lastErrorMessage?: string;
  /**
   * This row's local delivery failed or is uncertain, so its force action
   * retries the send instead of interrupting a running turn.
   */
  retryable?: boolean;
  /** Transient: the host must confirm credits before an explicit retry can send. */
  retryBlockedReason?: QueuedMessageRetryBlockedReason;
  editLocked?: boolean;
  /** Explicit force-action lock; absent hosts retain the edit-lock behavior. */
  forceLocked?: boolean;
  hasAttachments?: boolean;
  /** The host retains non-text send fields when applying a text-only edit. */
  attachmentEditsPreservePayload?: boolean;
  /**
   * The host cannot hold this row while it is edited; only the save is
   * checked against the current queue. Explicit Edit stays available, but the
   * bubble does not open the editor on double-click.
   */
  editLockAdvisory?: boolean;
  /** Host-authoritative eligibility for moving this row into the active turn. */
  canSteer?: boolean;
  /** Steer cannot apply this row's capability changes to the active turn. */
  steerBlockedByCapabilityChange?: boolean;
  /** Transient: why the host is holding this row. Absent on older hosts. */
  waitingReason?: QueuedMessageWaitingReason;
  /**
   * Transient: sending this row now would wait for background work, because
   * these settings differ from the ones it runs with; empty when the host
   * cannot name them. Absent when it would not wait or the host cannot tell.
   */
  restartHeldChanges?: readonly SettingsHeldChange[];
  /**
   * Host user-message id this accepted queue row stands for (REG-2981).
   *
   * A tab that minted an optimistic transcript bubble for the same send binds
   * that bubble to this id (`bindOptimisticSend`), so the row can retract
   * exactly that bubble instead of rendering the prompt twice. Absent on
   * rows the host has not accepted yet — an in-flight outbox row keeps
   * rendering normally, since nothing has superseded it.
   */
  supersedesUserMessageId?: string;
  /**
   * The host is delivering this message to an idle agent now (nothing runs or
   * waits ahead of it), so it renders as sent rather than as queued until the
   * transcript carries it. Absent on hosts that never set it.
   */
  delivering?: boolean;
}

/** Pending scheduled sends to one chat. */
export interface PortalChatScheduledMessages {
  count: number;
  /** ISO-8601 time of the earliest pending send; absent when `count` is 0. */
  nextAt?: string;
}

export interface PortalChatSummaryEntity {
  /** Desktop-owned unread flag; absent on older hosts. */
  hasUnread?: boolean;
  /** Cached entity localId; matches `chatId`. */
  localId: string;
  /** Local id of the chat thread this summary describes. */
  chatId: string;
  scope: PortalChatScope;
  /** Host-authoritative queued messages, in FIFO order. */
  queuedMessages?: PortalQueuedMessage[];
  inputDelivery?: ChatInputDeliveryView[];
  /** Delegations whose request to this chat waits in its queue (ids only). */
  waitingDelegationIds?: string[];
  steeringCapabilities?: ChatSteeringCapabilities;
  /** Owning workspace local id (worktree-scoped chats only). */
  workspaceLocalId?: string;
  /** Owning worktree local id (worktree-scoped chats only). */
  worktreeLocalId?: string;
  title: string;
  /** User-owned chat name; absent on older desktop hosts. */
  customTitle?: string;
  description?: string;
  /**
   * Stable position of this chat tab within the worktree's chat-tab list (0-based
   * index among chat-kind tabs). This is the authoritative portal tab-bar
   * ordering key — it mirrors the desktop's exact tab order, including manual
   * drag-reorders, and never changes on chat activity. Falls back to
   * {@link createdAt} then `chatId` when a projecting desktop predates this field.
   */
  order?: number;
  /**
   * ISO-8601 timestamp of the chat's creation. Secondary tab-bar ordering key
   * (used when {@link order} is absent). Distinct from {@link lastMessageAt},
   * which tracks recency and must never reorder tabs.
   */
  createdAt?: string;
  /** ISO-8601 timestamp of the most recent message in the chat. */
  lastMessageAt?: string;
  /** Newest user/assistant message; absent when unknown on older hosts. */
  lastMessageRole?: 'user' | 'assistant';
  /** Number of persisted transcript messages known to the desktop. */
  messageCount?: number;
  modelLabel?: string;
  /** Absent means manual for compatibility with older hosts. */
  modelSelectionMode?: 'auto';
  /** Newer paired desktops advertise support without making the browser route. */
  modelRoutingSupported?: true;
  providerType?: string;
  /** Desktop-authoritative harness captured for an existing session. */
  executionHarness?: AgentExecutionHarness;
  /** Whether persisted context or pending execution prevents changing harness. */
  modelHarnessLocked?: boolean;
  /** For multi-repo workspaces, the currently selected repo for this chat. */
  selectedRepoId?: string;
  /** True when this is the active chat for its scope (e.g. drives sidebar selection). */
  active?: boolean;
  /**
   * True while this chat has an in-flight agent turn in the desktop's session
   * manager (CAN-2525).
   *
   * The browser otherwise learns a turn is running ONLY from a live
   * `turn_timer` frame, which exists only for turns that start while the portal
   * session is connected -- and only for portal-initiated turns, since
   * desktop-initiated turns are timed by the desktop renderer. So a portal that
   * attaches to an already-running chat saw it as idle: no working indicator,
   * no end-of-turn timer, and a mid-turn send double-rendered because the panel
   * believed it was starting a fresh turn.
   *
   * Omitted by desktops that predate this field; consumers must treat
   * `undefined` as "unknown", not as `false`.
   */
  turnActive?: boolean;
  /**
   * Elapsed milliseconds for the active turn when this summary was projected.
   * Consumers can anchor this duration to their own clock and keep counting,
   * avoiding both a zero reset on reconnect and cross-device clock skew.
   * Omitted when the turn is idle or the desktop predates this field.
   */
  turnElapsedMs?: number;
  /**
   * The chat's canonical turn phase (turn-state phase 41a). `background`
   * means only background work runs: no turn, so the composer is open and
   * there's no Stop. Omitted when the desktop has no canonical turn state.
   */
  turnPhase?: ChatTurnPhase;
  /**
   * The chat's background tasks (D11): delegations plus every provider
   * background task. Sent whenever the desktop has canonical turn state, zero
   * included, so a delta clears it; omitted by older desktops.
   */
  backgroundTasks?: number;
  /**
   * The queued and live managed delegations among `backgroundTasks`, for the
   * Portal background tray's delegates row (turn-state phase 41e). Sent with
   * `backgroundTasks`.
   */
  backgroundDelegations?: number;
  /**
   * True while a tool-approval prompt in this chat waits for an answer. Sent
   * with `backgroundTasks`, `false` included, so a delta clears it; omitted
   * by older desktops.
   */
  awaitingApproval?: boolean;
  /** The chat's pending scheduled sends; sent with `backgroundTasks`. */
  scheduledMessages?: PortalChatScheduledMessages;
  /**
   * Present while this chat's provider quota is exhausted and the desktop is
   * showing its composer usage-limit banner (CAN-2601). The portal renders
   * the same banner above its composer instead of transcript rows — the raw
   * limit frames are deliberately never projected as messages. Cleared (field
   * omitted) once the desktop banner is dismissed or superseded. Omitted by
   * desktops that predate this field.
   */
  usageLimit?: PortalChatUsageLimit;
  /**
   * Running token/cost/turn usage for the composer's context meter
   * (REG-2943). Projected by the cloud web adapter; omitted by hosts that
   * do not report usage on the summary.
   */
  usage?: PortalChatUsage;
  /**
   * Transient phase the turn is in (the harness is compacting context, or the
   * host is waking an ended session for the message just sent). Omitted
   * whenever the turn is doing ordinary work. See
   * {@link PortalChatStreamingStatus} for which values a runtime reports and
   * which the host projects.
   */
  streamingStatus?: PortalChatStreamingStatus;
  /**
   * Projected composer state (CAN-1217). These mirror the desktop chat tab's
   * live composer controls so the portal chips can seed from and reconcile
   * against the desktop, giving two-way parity. All optional: omitted when the
   * desktop has no explicit value for the tab.
   */
  /** Whether plan mode is engaged for this chat. */
  planMode?: boolean;
  /** Null clears a previous review; omission supports older paired desktops. */
  planReview?: PortalChatPlanReview | null;
  /** Context disclosure for the destination fork. Null clears; omission preserves older hosts. */
  forkContext?: 'fresh' | 'visible-transcript' | null;
  /** Current thinking level. */
  thinkingLevel?: PortalChatThinkingLevel;
  /**
   * Legacy projection of {@link speed}: true only for Fast (Codex provider
   * only). Never true for Ultra fast.
   */
  fastMode?: boolean;
  /**
   * Exact requested Codex speed (Codex provider only). A portal surface that
   * cannot render `ultrafast` must show a desktop-managed state instead of a
   * Regular/Fast indicator derived from {@link fastMode}.
   */
  speed?: CodexSpeed;
  /**
   * Current model id (registry key), distinct from {@link modelLabel} which is
   * the human-readable display string. Lets the portal model picker (CAN-1218)
   * seed the exact selected model.
   */
  model?: PortalChatModel;
  /** Summary of the chat's plugin/collection selections. */
  pluginSelections?: PortalChatSummaryPluginSelections;
  /**
   * Full plugin/collection/skill/MCP selection refs for the chat (CAN-1219), so
   * the portal plugins selector can seed its checkboxes with the exact current
   * selection rather than the compact {@link pluginSelections} counts. Omitted
   * when the tab has no selections.
   */
  pluginSelectionsDetail?: PortalChatTabPluginSelections;
  /** Effective chat policy; absent on older hosts. */
  deferredToolsAllowed?: boolean;
  /**
   * Hosted-cloud capability bundle state (REG-2782), projected by the cloud
   * web adapter only; desktop projections omit it. A `pendingDigest` differing
   * from `activeDigest` means a new bundle is staged and applies at the next
   * turn boundary; `warnings` carries the producer's non-fatal degradation
   * notes for the staged (else active) bundle, for debugging only.
   * `unavailable` is the same bundle's structured record of selected
   * capabilities it could not fully carry (REG-3042), which the picker renders
   * as rows with a status and a Remove action.
   */
  capabilityBundles?: {
    activeDigest?: string;
    pendingDigest?: string;
    warnings?: string[];
    unavailable?: CapabilityUnavailable[];
  };
  /**
   * Provider availability the desktop can cheaply project from its cached
   * native-auth status (never spawns a probe). A `true`/`false` value reflects
   * the last observed native login; an omitted provider key means "unknown"
   * (cache cold) and consumers should treat it optimistically. AI-credit
   * eligibility is renderer/cloud-derived and intentionally not projected here.
   */
  providerAvailability?: PortalChatProviderAvailability;
  /**
   * The desktop's projected model catalog (CAN-1218): the flat list of every
   * model + custom Agent the connected desktop can currently offer, so the
   * portal model picker shows the SAME models the desktop has (its package.json
   * pins, live Ollama models, LaunchDarkly-gated entries, and custom Agents).
   * Omitted when the desktop has not yet hydrated its model registry;
   * per-provider selectability is gated by {@link providerAvailability}.
   */
  availableModels?: ModelCatalog;
  /**
   * Optional turn-group skeleton for this chat. One entry per user-message
   * turn, in chronological order. Renderers can use this to collapse
   * intermediate assistant messages behind a summary chip while keeping
   * final messages inline. Omitted when the desktop has not yet computed
   * groups (e.g. older persisted chats).
   */
  chatTurnGroups?: PortalChatTurnGroup[];
  /**
   * How the chat's latest turn ended: its latest accepted turn, or a later
   * prompt that ended before any provider accepted it. Absent while the
   * accepted turn runs, before any turn ends, and on older hosts.
   */
  lastTurnEnd?: PortalChatTurnEnd;
  /**
   * Projected AskUserQuestion state for this chat, so the browser can render an
   * interactive question card (with the same choices desktop shows) instead of
   * raw JSON. Chat-scoped array that MAY contain answered entries as well as
   * awaiting ones. Semantics:
   *
   * - **Omission** means an older desktop producer or an unavailable projection
   *   (partial/streaming delta); consumers MUST preserve prior cached question
   *   state on omission rather than clearing it.
   * - **`[]`** explicitly clears previously cached question state for this chat.
   *
   * Dismissed/expired questions are removed from the array (never kept as an
   * answered entry). Optional for backward compatibility: older web clients
   * ignore this field and fall back to the generic tool-call rendering.
   */
  pendingQuestions?: PortalAskUserQuestionState[];
}

export interface PortalTodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * Per-chat TODO projection. The entity envelope uses `localId = chatId` and
 * `parentLocalId = worktreeScopedParentLocalId(workspaceLocalId, worktreeLocalId)`.
 */
export interface PortalChatTodoProjection {
  localId: string;
  workspaceLocalId: string;
  worktreeLocalId: string;
  chatId: string;
  items: PortalTodoItem[];
}

/**
 * Closed enumeration of worktree pipeline-row badge states surfaced on the
 * sidebar. Mirrors the desktop's `WorktreePipelineStatus` union.
 */
export type PortalWorktreePipelineStatus =
  | 'running'
  | 'unseen'
  | 'unseen-failure'
  | 'paused';

/**
 * Closed enumeration of worktree terminal-row badge states surfaced on the
 * sidebar. Mirrors the desktop's `WorktreeTerminalStatus` union.
 */
export type PortalWorktreeTerminalStatus =
  | 'running'
  | 'unseen'
  | 'unseen-failure';

/**
 * Closed enumeration of worktree script-row badge states surfaced on the
 * sidebar. Mirrors the desktop sidebar's "Scripts running" badge.
 */
export type PortalWorktreeScriptStatus = 'running';

/**
 * Closed enumeration of worktree hook-row badge states surfaced on the
 * sidebar. Mirrors the desktop sidebar's hook-running badge.
 */
export type PortalWorktreeHookStatus = 'running';

/**
 * Main-owned Split PR runtime phase projected onto a neutral worktree.
 * Renderer-only modal/session state is intentionally not part of this model.
 */
export type PortalWorktreeSplitPrStatus =
  | 'preparing'
  | 'running'
  | 'ready'
  | 'completed'
  | 'failed';

/**
 * Coarse-grained setup phase of a worktree. `'idle'` is the default
 * (worktree has no setup activity in flight); the remaining values mirror
 * the desktop UI's progress copy.
 */
export type PortalWorktreeSetupPhase =
  | 'idle'
  | 'git-pending'
  | 'running-setup'
  | 'running-teardown'
  /**
   * A server-run archive that saves the worktree's changes before it stops
   * (cloud repository worktrees, REG-3022). Shown like teardown, as archiving.
   */
  | 'running-archive';

/**
 * Closed enumeration of workspace warning states surfaced on the workspace
 * header. `null` means the workspace has no warning to display.
 */
export type PortalWorkspaceWarningState = 'missing-scripts' | 'mismatch' | null;

/**
 * Portal-level view mode. Persisted server-side per portal session so the
 * browser can pick up the user's last-active mode on reload.
 */
export type PortalViewMode = 'worktrees' | 'standalone-chats';

/**
 * Where a sidebar row's work actually executes. Deliberately NOT a member of
 * the workspace `type` union: `type` says WHAT a workspace is, while backend
 * is a property of an individual row. A git-backed workspace may later run some
 * worktrees under remote control and others in the cloud, so the two axes are
 * kept separate and the header treatment is derived from the rows.
 *
 * Its other job is to keep shared UI from sniffing the `cloud:` local-id prefix
 * — that is composite-client-internal knowledge, and encoding it in a shared
 * package is the platform-knowledge-in-shared-code anti-pattern
 * `packages/app-core/src/gating/capability-gating.ts` forbids.
 *
 * Backend has exactly ONE job: the sidebar row's device-vs-cloud pip. It must
 * never be folded into `type` or `layout`, and no placement predicate may read
 * it — patching placement with `cowork && backend !== 'cloud'` is the smeared
 * reclassification REG-2819 exists to retire.
 */
// Catalog placeholders use 'desktop' before a local instance exists.
export type PortalRowBackend = 'remote-control' | 'cloud' | 'desktop';

/**
 * How a workspace's rows lay out in the sidebar — the third axis, independent
 * of both `type` (what a workspace IS) and `backend` (where its work RUNS).
 *
 * `'tree'` renders a worktree tree under the workspace header; `'flat'` renders
 * the standalone-chats projection. The combination matters: desktop cowork is
 * repoless AND flat, cloud is repoless AND tree, repo-backed is tree. Nothing
 * in `type` alone can express that, which is why cloud previously had to lie
 * and emit `type: 'single-repo'` to avoid being routed to the flat projection
 * (where it reads `standaloneChats`, and every cloud chat vanishes).
 *
 * EVERY placement decision branches on this field. `type` is pure
 * classification — it drives the kind badge and nothing else.
 */
export type PortalWorkspaceLayout = 'tree' | 'flat';

/**
 * Resolve a workspace's layout, defaulting the pre-REG-2819 wire shape.
 *
 * This is the single sanctioned place where `type` informs placement, and it
 * exists only so version-skewed producers keep working: a desktop build that
 * predates `layout`, or a `PortalCachedEntity` row written before it, carries
 * no field, and `type === 'cowork' ? 'flat' : 'tree'` reproduces exactly what
 * those rows used to do. Call it at ingestion boundaries so everything
 * downstream reads a concrete `layout` — do NOT call it inside a placement
 * predicate.
 */
export function resolveWorkspaceLayout(workspace: {
  readonly type?: 'single-repo' | 'multi-repo' | 'cowork';
  readonly layout?: PortalWorkspaceLayout;
}): PortalWorkspaceLayout {
  if (workspace.layout !== undefined) return workspace.layout;
  return workspace.type === 'cowork' ? 'flat' : 'tree';
}

const GITHUB_AVATAR_HOSTS: ReadonlySet<string> = new Set([
  'github.com',
  'avatars.githubusercontent.com',
]);

/**
 * Accept a workspace `avatarUrl` from the wire only when it is an HTTPS
 * GitHub avatar, the one kind of image the producer ever projects there, so a
 * consumer never renders an arbitrary URL from the payload.
 */
export function readPortalWorkspaceAvatarUrl(
  value: unknown,
): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && GITHUB_AVATAR_HOSTS.has(url.hostname)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

export interface PortalSessionShellState {
  /** Read-only recovery presentation from the paired computer. */
  w5Recovery?: W5RecoveryStatus;
  /** Current provider account quotas, when the selected host publishes them. */
  providerUsage?: PortalProviderUsageProjection;
  workspaces: Array<{
    /** Catalog-only row; never a filesystem workspace or selectable worktree. */
    placeholder?: { projectId: string; state: OrgProjectPlaceholderState };
    localId: string;
    name: string;
    rootPath?: string;
    /**
     * Mirrors the desktop's `WorkspaceType`. PURE CLASSIFICATION — what the
     * workspace IS (repo-backed, or repoless), never how it lays out. It drives
     * the kind badge; placement reads `layout` instead. `'cowork'` workspaces
     * have no repos; producers/consumers that only distinguish repo layouts
     * should treat `'cowork'` like a workspace with zero repos rather than
     * defaulting it away.
     */
    type: 'single-repo' | 'multi-repo' | 'cowork';
    /**
     * How this workspace's rows lay out. Optional on the wire for
     * back-compatibility: an older desktop build emits no `layout`, and cached
     * payloads written before REG-2819 have none either. Both ingestion
     * boundaries resolve the absent case to `type === 'cowork' ? 'flat' :
     * 'tree'` — which is precisely the pre-REG-2819 behavior — so consumers
     * downstream of them always see a concrete value.
     *
     * That legacy default is the ONLY place `type` may inform placement.
     */
    layout?: PortalWorkspaceLayout;
    /**
     * Backend that owns this workspace record. Consumers rendering a header
     * treatment should derive it from the workspace's rows when it has any and
     * fall back to this field only for a workspace with none, so a future
     * mixed-backend workspace renders correctly with no schema change.
     */
    backend?: PortalRowBackend;
    color?: string;
    /**
     * GitHub owner avatar (`https://github.com/<owner>.png?size=32`) for a
     * GitHub-backed single-repo workspace, derived from its `origin` remote
     * and drawn over the kind badge on project headers. Absent for every
     * other workspace, and until the producer has resolved the remote.
     */
    avatarUrl?: string;
    /**
     * The root repository's GitHub identity from its `origin` remote
     * (`project_repository_identity_v1`). Absent when the remote is unknown
     * or not on GitHub, and on older desktops.
     */
    repositoryIdentity?: PortalRepositoryIdentity;
    /**
     * True for temporary (adhoc-combine) multi-repo workspaces; rendered
     * with the desktop's neutral gray badge instead of the assigned color.
     */
    temporary?: boolean;
    /** User's explicit hide toggle from the desktop sidebar filter. */
    hidden?: boolean;
    /** Synthetic recipient-only shared-chat group; never a command destination. */
    sharedFrom?: true;
    /**
     * The automatic default cloud workspace (CAN-3898): eligible to own the
     * sidebar's Chats section, subject to navigation context and a flat
     * catch-all's precedence. A presentation hint; it never grants access.
     */
    chatsHome?: true;
    /**
     * Who owns this workspace for context scoping (CAN-2954). Absent means
     * Personal; an organization owner names the org project this local
     * checkout materializes. `cloud-organization` (CAN-3458) is a cloud
     * workspace owned by an organization, with no org project behind it.
     * Navigation only: it never grants access.
     */
    owner?:
      | { type: 'personal' }
      | { type: 'organization'; organizationId: string; projectId: string }
      | { type: 'cloud-organization'; organizationId: string };
    /**
     * Desktop sidebar visibility model: `false` marks workspaces (e.g.
     * temporary ones) that only surface while they have at least one
     * visible worktree.
     */
    alwaysShow?: boolean;
    order?: number;
    /** Sidebar section collapse state for the workspace header. */
    collapsed?: boolean;
    /**
     * Ordering mode for this workspace's child rows, including Work Entry
     * rows in cowork projects. New desktops emit both modes explicitly.
     * Older desktop snapshots omit the mode and retain manual order; cloud
     * rows without a mode retain recency order. Pinned rows lead in manual
     * order under either mode.
     */
    itemSortMode?: 'manual' | 'last-updated';
    /** Optional membership projection; absence preserves older flat snapshots. */
    itemGroups?: SidebarItemGroup[];
    /**
     * Persisted ordering of activity sections, mirrors
     * `WorkspaceIndexEntry.activitySectionOrder` on the desktop.
     */
    activitySectionOrder?: string[];
    /**
     * Drives the workspace-header settings-warning treatment. `null`
     * indicates no warning; missing values inherit the desktop default.
     */
    warningState?: PortalWorkspaceWarningState;
    /** Configured inactivity window; absent/null means Auto Delete is off. */
    autoArchiveDays?: number | null;
    /**
     * Resolved deletion-retention window, independent of Auto Delete. Absence
     * means the desktop did not supply it.
     */
    archiveRetentionDays?: number;
    /**
     * Multi-repo only: child repos that participate in this workspace.
     * Single-repo workspaces emit an empty array or omit the field.
     */
    repos?: Array<{ id: string; name: string; repoPath: string }>;
  }>;
  worktrees: Array<{
    localId: string;
    workspaceLocalId: string;
    branch: string;
    label?: string;
    /**
     * Backend this row's work executes on. This is the authoritative value —
     * the workspace-level field only covers a workspace with no rows.
     */
    backend?: PortalRowBackend;
    /** Mirrors the desktop sidebar's hidden-worktree flag. */
    hidden?: boolean;
    /**
     * Mirrors the desktop sidebar's pinned-worktree flag: pinned rows lead
     * their workspace section. Absent on hosts without pinning.
     */
    pinned?: boolean;
    /** Sidebar position of the worktree within its workspace. */
    order?: number;
    /**
     * Persisted visual parent for sidebar branch grouping. Mirrors
     * `WorktreeData.branchGroupingParentWorktreeId` on the desktop.
     */
    branchGroupingParentWorktreeId?: string;
    /**
     * Base branch this worktree tracks. Mirrors
     * `WorktreeData.trackedBaseBranch` on the desktop.
     *
     * Distinct from a PR's base branch: a worktree tracks a base from the
     * moment it is created, whereas PR state only exists once a PR is opened.
     * Clients that show a `branch › base` summary need this, or the base half
     * silently disappears for every worktree without a PR.
     */
    trackedBaseBranch?: string | null;
    status?: string;
    busy?: boolean;
    createdAt?: string;
    /**
     * Hook descriptor keys the user has paused in this worktree. Mirrors
     * `WorktreeData.pausedHookKeys` on the desktop side.
     */
    pausedHookKeys?: string[];
    /**
     * Server notification space id for this worktree (CAN-3615). Clients
     * read and change the viewer's notification choice for the space with
     * it. Absent until the desktop has registered the space.
     */
    notificationSpaceId?: string;
    /**
     * Sidebar pipeline-row badge state, when applicable. Mirrors the
     * desktop's `WorktreePipelineStatus` union and drives the small
     * pipeline indicator badge in the worktree row.
     */
    pipelineStatus?: PortalWorktreePipelineStatus;
    /**
     * Sidebar terminal-row badge state, when applicable. Mirrors the
     * desktop's `WorktreeTerminalStatus` union.
     */
    terminalStatus?: PortalWorktreeTerminalStatus;
    /**
     * Mirrors the desktop sidebar's script-running badge (aria label
     * "Scripts running"). Omitted when no tracked script is running for
     * the worktree.
     */
    scriptStatus?: PortalWorktreeScriptStatus;
    /**
     * Mirrors the desktop sidebar's hook-running badge. Omitted when no
     * started hook run is active for the worktree (queued hooks excluded).
     */
    hookStatus?: PortalWorktreeHookStatus;
    /** Current main-owned Split PR phase, when a workflow exists. */
    splitPrStatus?: PortalWorktreeSplitPrStatus;
    /** Human-readable phase detail matching the desktop row subtitle. */
    splitPrStatusMessage?: string;
    /** Authoritative main-process worktree mutation lock. */
    splitPrLocked?: boolean;
    /** True when an agent turn is actively streaming for this worktree. */
    isStreaming?: boolean;
    /**
     * The worktree's background tasks (D11): its chats' delegations and live
     * provider tasks. Omitted when none run (turn-state phase 41f).
     */
    backgroundTasks?: number;
    /** True when a pipeline run is currently executing in this worktree. */
    isRunningRun?: boolean;
    /** True when desktop is mid-discovery (e.g. SDK probing) for this worktree. */
    isDiscovering?: boolean;
    /** Coarse-grained setup-script phase. Defaults to `'idle'` when omitted. */
    setupPhase?: PortalWorktreeSetupPhase;
    /** True when a persisted chat plan is awaiting the user's approval. */
    awaitingApproval?: boolean;
    /** True when the worktree has at least one unread chat update. */
    hasUnread?: boolean;
    /**
     * Persisted marker for worktrees that cannot currently be read as valid
     * Git worktrees. Mirrors `WorktreeData.healthIssue`.
     */
    healthIssue?: { status: 'broken' | 'mismatch'; reason?: string };
    /**
     * ISO-8601 timestamp of the most recent aggregate worktree activity.
     * Chat activity is the initial contributor; pipeline, script, and hook
     * contributors may be added later. Drives "last active" row copy.
     */
    lastActivityAt?: string;
    /**
     * Latest aggregate diff stats (insertions/deletions) for the worktree,
     * sourced from the same desktop diff-stat batch (`getWorktreeStats`) the
     * desktop uses. Available to diff detail and safety surfaces.
     * Absent until the desktop projects a value.
     */
    diffStats?: { insertions: number; deletions: number };
    /** Live merge activity. Optional for compatibility with older desktops. */
    mergingPr?: boolean;
    /** Cleared explicitly after the request settles, including failure/cancellation. */
    mergePrPhase?:
      | 'queued'
      | 'checking_mergeability'
      | 'waiting_mergeability'
      | 'merging'
      | 'refreshing_pr_status'
      | null;
    /**
     * Structural copy of the most recently observed PR status snapshot.
     * Lets the portal render a PR badge without round-tripping a separate
     * `pr.refresh` command. Inlined here to keep the protocol package
     * environment-neutral (it intentionally does not import desktop types).
     */
    lastKnownPrStatus?: {
      repos: Array<{
        repoId: string;
        repoName: string;
        status: {
          prNumber: number;
          prUrl: string;
          state: 'open' | 'merged' | 'closed' | 'draft';
          title: string;
          checkStatus: 'passing' | 'failing' | 'pending' | 'neutral' | 'none';
          reviewStatus: 'approved' | 'changes_requested' | 'pending' | 'none';
          hasConflicts: boolean;
          commentCount: number;
          unresolvedReviewThreadCount?: number;
          /**
           * Present when the PR is open and its merge queue state is known.
           * `inQueue` covers every merge queue entry state.
           */
          mergeQueue?: {
            inQueue: boolean;
            /** 1-based queue position, when GitHub reports one. */
            position?: number | null;
            /**
             * Normalized merge queue entry phase while queued. Older desktops
             * omit it; `unknown` is an unrecognized GitHub entry state.
             */
            phase?: PortalPrMergeQueuePhase;
          };
          updatedAt: string;
        } | null;
      }>;
      lastCheckedAt: string;
    } | null;
  }>;
  chatProjects: Array<{ localId: string; name: string; createdAt?: string }>;
  /**
   * Cowork chats. The {@link PortalStandaloneWorkEntryFields} carry the owning
   * Work Entry's identity, order, pin and status for Chats-section grouping.
   */
  standaloneChats: Array<
    PortalStandaloneWorkEntryFields & {
      usage?: PortalChatUsage;
      queuedMessages?: PortalQueuedMessage[];
      inputDelivery?: ChatInputDeliveryView[];
      /** Delegations whose request to this chat waits in its queue (ids only). */
      waitingDelegationIds?: string[];
      steeringCapabilities?: ChatSteeringCapabilities;
      localId: string;
      projectLocalId: string;
      title: string;
      /** User-owned chat name; absent on older desktop hosts. */
      customTitle?: string;
      description?: string;
      modelLabel?: string;
      lastMessageAt?: string;
      /** Newest user/assistant message; absent when unknown on older hosts. */
      lastMessageRole?: 'user' | 'assistant';
      /** ISO-8601 timestamp of the chat creation. */
      createdAt?: string;
      /** True when the chat has been archived from the active list. */
      archived?: boolean;
      /**
       * Mirrors the desktop cowork entry row's thinking indicator, falling
       * back to `CoworkWorkEntryMeta.hasActiveChat`. Undefined until projected.
       */
      hasActiveChat?: boolean;
      /**
       * The chat's background tasks (D11), zero included, for the Chats row's
       * background spinner (turn-state phase 41b). Undefined until projected.
       */
      backgroundTasks?: number;
      /** As {@link PortalChatSummaryEntity.awaitingApproval}. */
      awaitingApproval?: boolean;
      /** As {@link PortalChatSummaryEntity.scheduledMessages}. */
      scheduledMessages?: PortalChatScheduledMessages;
      /**
       * Mirrors the desktop cowork entry row's unread indicator, falling back
       * to `CoworkWorkEntryMeta.unreadChats`. Undefined until projected.
       */
      hasUnread?: boolean;
      /** Provider that owns the chat session. */
      providerType?: AgentExecutionHarness;
      executionHarness?: AgentExecutionHarness;
      /** Whether persisted context or pending execution prevents changing harness. */
      modelHarnessLocked?: boolean;
      /**
       * Current model id (registry key), distinct from {@link modelLabel} which
       * is the human-readable display string. Lets the standalone/cowork model
       * picker seed the exact selected model (CAN-1219).
       */
      model?: PortalChatModel;
      /**
       * The desktop's projected model catalog (CAN-1219), so the standalone model
       * picker offers the SAME models the connected desktop has. Omitted when the
       * desktop has not hydrated its model registry.
       */
      availableModels?: ModelCatalog;
      /**
       * Cheap desktop projection of native provider auth (CAN-1217 shape reused).
       * A `true`/`false` value reflects the last observed native login; an omitted
       * provider key means "unknown" and consumers treat it optimistically.
       */
      providerAvailability?: PortalChatProviderAvailability;
      /** See {@link PortalStandaloneChatSummary.pluginSelectionsDetail}. */
      pluginSelectionsDetail?: PortalChatTabPluginSelections;
      /** Effective chat policy; absent on older hosts. */
      deferredToolsAllowed?: boolean;
      /** See {@link PortalStandaloneChatSummary.turnActive}. */
      turnActive?: boolean;
      /** See {@link PortalChatSummaryEntity.lastTurnEnd}. */
      lastTurnEnd?: PortalChatTurnEnd;
      /** See {@link PortalStandaloneChatSummary.pendingQuestions}. */
      pendingQuestions?: PortalAskUserQuestionState[];
    }
  >;
  scriptDescriptors: PortalScriptDescriptor[];
  scriptRuns: PortalScriptRunProjection[];
  hookDescriptors: PortalHookDescriptor[];
  hookRuns: PortalHookRunProjection[];
  mcpServers?: PortalMcpServerEntity[];
  plans: PortalPlan[];
  pipelines: PortalPipeline[];
  pipelineRuns: PortalPipelineRunProjection[];
  chatMessages: PortalChatMessageView[];
  /**
   * Per-chat transcript windows (hybrid data model, CAN-761), keyed by the
   * composite `"${scope}:${chatId}"`. The key MUST be scope-qualified because
   * worktree and standalone chat ids are minted from independent namespaces and
   * are not guaranteed unique across scopes; a bare-`chatId` key would let a
   * worktree and a standalone chat collide. Each entry marks the watermark
   * between the live tail and the historical prefix and carries the cursor for
   * lazy scrollback. Optional and purely additive: pre-hybrid snapshots omit it,
   * and a consumer without a window for a given chat treats its cached
   * {@link chatMessages} as live with no scrollback (legacy behaviour).
   * Populated by the historical-from-sync hydration path (TS-04); consumed by
   * scrollback (TS-05).
   */
  chatTranscripts?: Record<string, PortalChatTranscriptWindow>;
  chatSummaries: PortalChatSummaryEntity[];
  /**
   * Canonical projection of cached `app_advisor_chat` entity rows
   * (CAN-2562): one row per App Advisor chat tab on the paired desktop.
   * Optional and purely additive — pre-App-Advisor snapshots omit it.
   */
  appAdvisorChats?: PortalAppAdvisorChatSummary[];
  /** App Advisor scope membership, independent of the workspace scopes. */
  appAdvisorItemGroups?: SidebarItemGroup[];
  todoLists?: PortalChatTodoProjection[];
  /**
   * Cached `background_process` rows: each worktree chat's background tasks
   * for the Portal background tray (turn-state phase 41e). Optional and
   * additive.
   */
  backgroundProcesses?: PortalBackgroundProcessEntity[];
  /** Watchers scoped to their subscribing chat, gated by chat_watchers. */
  watchers?: PortalWatcherEntity[];
  /**
   * Canonical projection of cached `terminal_session` entity rows
   * (transport plan §1.5). Surfaces the structured terminal metadata
   * `applyPortalEntity` builds when ingesting a `terminal_session` upsert.
   */
  terminalSessions: PortalTerminalSessionEntity[];
  /**
   * Legacy compatibility map keyed by `terminalLocalId`. Retained alongside
   * {@link PortalSessionShellState.terminalSessions} so older renderer code
   * paths and ingestion handlers continue to function during rollout.
   */
  terminalBuffers: Record<string, string>;
  changedFiles: Record<string, PortalChangedFiles>;
  diffSnapshots: Record<string, PortalDiffSnapshot>;
  prStatuses: Record<string, PortalPrStatus>;
  fileRoots: PortalFileRootProjection[];
  fileTree: Record<string, PortalFileTreeNode[]>;
  /** Truncation bit for each composite file-tree cache key. */
  fileTreeTruncated?: Record<string, boolean>;
  /** Monotonic invalidation revision keyed by file-root local id. */
  fileTreeRevisionByRoot?: Record<string, number>;
  filePreviews: Record<string, PortalFilePreviewProjection>;
  /**
   * Canonical projection of cached `worktree_summary` entity rows. Mirrors
   * `WorktreeSummaryData` on the desktop side; the renderer can use this
   * to draw the per-worktree title + description card without round-
   * tripping a separate service call.
   */
  worktreeSummaries?: PortalWorktreeSummaryEntity[];
  /**
   * Current portal view mode for this session. Persisted server-side per
   * portal session so the browser shows the same mode after reload.
   */
  viewMode?: PortalViewMode;
  /**
   * Session-level model catalog, used as the fallback when nothing chat-scoped
   * carries one.
   *
   * `availableModels` is otherwise attached to chat summaries only, so a
   * catalog exists only once a chat does. A brand-new account, or a workspace
   * whose first chat has not been created yet, therefore has no summary to read
   * a catalog from and the composer's model picker renders empty on the exact
   * first run. Optional and purely additive: a producer that projects
   * chat-scoped catalogs only (the desktop today) simply omits it.
   */
  availableModels?: ModelCatalog;
  /**
   * Session-level provider availability paired with {@link availableModels},
   * gating per-provider selectability whenever that fallback catalog is the one
   * being offered. Omitted by producers that project availability per chat.
   */
  providerAvailability?: PortalChatProviderAvailability;
  refreshing: boolean;
  connectionStatus: PortalConnectionStatus;
}

/**
 * Canonical wire payload for a cached `worktree_summary` entity. Mirrors
 * the desktop `WorktreeSummaryData` shape. The summary entity flows over
 * the existing `portal.state.delta` channel; no dedicated event type is
 * added at this time.
 */
export interface PortalWorktreeSummaryEntity {
  /** Cached entity localId; matches the worktree localId. */
  localId: string;
  /** Owning workspace local id. */
  workspaceLocalId?: string;
  /** Owning worktree local id. */
  worktreeLocalId: string;
  title: string;
  description: string;
  highlights?: string[];
  repos?: Array<{ name: string; description: string }>;
  /** ISO-8601 timestamp the summary was last generated at. */
  generatedAt?: string;
  /** ISO-8601 timestamp of the most recent full summary regeneration. */
  lastFullRefreshAt?: string;
  /** True while a summary regeneration is in flight on the desktop side. */
  generating?: boolean;
}

export type PortalShellState = PortalSessionShellState;

export * from './sync-safe-pipeline-summary';
export * from './selected-mcp-servers';
export * from './catalog-entry-availability';
export * from './pairing-link';
export * from './transcript-reads';
export * from './tool-part-occurrence';

/** Review/preferences only; this does not grant interactive terminal access. */
export const PORTAL_CAPABILITY_SCRIPT_ACTIONS = 'script_actions_v1';

/** Paired-desktop suggestion preference reads and updates (CAN-4343). */
export const PORTAL_CAPABILITY_SUGGESTIONS = 'suggestions_v1';

/**
 * The paired desktop reads and writes onboarding tip dismissals (CAN-4904)
 * through `portal.onboarding_tips.get` and `portal.onboarding_tips.update`.
 */
export const PORTAL_CAPABILITY_ONBOARDING_TIPS = 'onboarding_tips_v1';

/**
 * The paired desktop reads and changes Claude Mod admission (allowed Mods and
 * the "turn off every Mod" switch) through `portal.claude_mods.get` and
 * `portal.claude_mods.update`. Older desktops lack it, so browsers show no Mod
 * controls.
 */
export const PORTAL_CAPABILITY_CLAUDE_MOD_ADMISSION = 'claude_mod_admission_v1';

/**
 * `portal.onboarding_tips.get` takes no arguments; both commands complete
 * with an {@link OnboardingTipsState}.
 */
export type PortalOnboardingTipsGetPayload = Record<string, never>;
export interface PortalInstalledItemResults {
  list_status: InstalledItemSnapshot;
  set_status: InstalledItemMutationResult;
  uninstall: InstalledItemMutationResult;
}

export type {
  AgentSentInfo,
  ExternalAgentSender,
  ManagedDelegateSender,
  ToolMessageSender,
} from './external-agent-sender';
