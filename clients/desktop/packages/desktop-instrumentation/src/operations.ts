import { validateAcquisitionContextValue } from './acquisition-context';
import type {
  DesktopInstrumentationContext,
  DesktopInstrumentationFailureReason,
  DesktopInstrumentationOperationOptions,
} from './types';

/**
 * A product operation also becomes one PostHog event when it finishes.
 * `posthogEvent` is a fixed `category:object_action` name; the variable part
 * of the operation (its `action`, `outcome`, ...) stays in property values.
 */
interface ProductOperationPolicy {
  readonly kind: 'product';
  readonly posthogEvent: string;
  readonly contextKeys: readonly string[];
  /** Narrows the operation to the contexts the event describes. */
  readonly includes?: (context: DesktopInstrumentationContext) => boolean;
  /** Fixed renames for context keys that collide with operation properties. */
  readonly renamedContextKeys?: Readonly<Record<string, string>>;
}

const PIPELINE_DEFINITION_CHANGES: ReadonlySet<unknown> = new Set([
  'create',
  'update',
  'delete',
  'duplicate',
  'shared_create',
  'shared_update',
  'shared_delete',
]);

const AUDIT_CONTEXT_KEYS = [
  'event_type',
  'provider',
  'model',
  'has_transcript',
  'is_ai_credits_routed',
  'tool_use_count',
  'sub_agent_count',
  'message_count',
  'total_cost_usd',
];
const GIT_SHIPPING_CONTEXT_KEYS = [
  'source',
  'workspace_type',
  'is_install_first',
  'flow',
  'repo_count',
];
const WORKSPACE_CONTEXT_KEYS = [
  'action',
  'source',
  'workspace_total',
  'single_repo_workspace_total',
  'multi_repo_workspace_total',
  'temporary_workspace_total',
  'worktree_total',
  'workspace_worktree_total',
  'workspace_repo_total',
  'workspace_type',
  'workspace_is_temporary',
];
const STANDALONE_CONTEXT_KEYS = [
  'action',
  'chat_disposition',
  'standalone_project_total',
  'standalone_chat_total',
  'standalone_archived_chat_total',
  'standalone_note_total',
  'standalone_prompt_total',
  'standalone_attachment_total',
  'project_chat_total',
  'project_archived_chat_total',
  'project_note_total',
  'project_prompt_total',
  'project_attachment_total',
];

/**
 * Every custom operation the desktop app records. Operation APIs accept only
 * these names, so a new operation cannot compile until it declares the
 * PostHog event and context keys it reports.
 * Errors are not operations; they go through error capture.
 */
export const DESKTOP_OPERATIONS = {
  'canopy.first_run_import_view': {
    kind: 'product',
    posthogEvent: 'onboarding:first_run_import_view',
    contextKeys: ['claude_connection', 'codex_connection'],
  },
  'canopy.first_run_import': {
    kind: 'product',
    posthogEvent: 'onboarding:first_run_import_end',
    contextKeys: [
      'outcome',
      'scan_outcome',
      'claude_data_detected',
      'codex_data_detected',
      'claude_connection',
      'codex_connection',
      'credits_offered',
      'found_count',
      'imported_count',
      'submission_count',
      'failed_submission_count',
      'picked_folder',
    ],
  },
  'canopy.project_import': {
    kind: 'product',
    posthogEvent: 'projects:import_end',
    contextKeys: [
      'source',
      'modal_entry',
      'scan_outcome',
      'claude_data_detected',
      'codex_data_detected',
      'claude_connection',
      'codex_connection',
      'found_count',
      'found_claude_count',
      'found_codex_count',
      'selected_count',
      'imported_count',
      'imported_claude_count',
      'imported_codex_count',
      'failed_count',
      'chats_imported_count',
      'picked_folder',
      'outcome',
    ],
  },
  'canopy.invite_send': {
    kind: 'product',
    posthogEvent: 'sharing:invite_send',
    contextKeys: [
      'invite_type',
      'invite_ref',
      'grant_ref',
      'recipient_kind',
      'share_audience',
      'container_type',
      'send_surface',
      'delivery',
    ],
  },
  'canopy.invite_accept': {
    kind: 'product',
    posthogEvent: 'sharing:invite_accept',
    contextKeys: [
      'invite_type',
      'invite_ref',
      'accept_surface',
      'container_type',
      'is_first_accept_on_install',
      'install_age_days',
    ],
  },
  'canopy.organization_create': {
    kind: 'product',
    posthogEvent: 'organization:create',
    contextKeys: ['creation_method', 'invite_included', 'project_count'],
  },
  'canopy.remote_pairing_start': {
    kind: 'product',
    posthogEvent: 'remote:pairing_start',
    contextKeys: [
      'pairing_kind',
      'pairing_entry',
      'peer_platform',
      'is_additional_device',
    ],
  },
  'canopy.remote_pairing': {
    kind: 'product',
    posthogEvent: 'remote:pairing_end',
    contextKeys: [
      'pairing_kind',
      'pairing_entry',
      'peer_platform',
      'is_additional_device',
      'outcome',
    ],
  },
  // Remote Control host events (CAN-5985): bounded kinds and reasons only.
  'canopy.remote_control_device_add': {
    kind: 'product',
    posthogEvent: 'remote_control:device_add',
    contextKeys: ['device_kind', 'pair_method'],
  },
  'canopy.remote_control_pairing_fail': {
    kind: 'product',
    posthogEvent: 'remote_control:pairing_fail',
    contextKeys: ['device_kind', 'pair_method', 'failure_reason'],
  },
  'canopy.remote_control_session_start': {
    kind: 'product',
    posthogEvent: 'remote_control:session_start',
    contextKeys: ['device_kind', 'is_delegated'],
  },
  'canopy.remote_control_session_end': {
    kind: 'product',
    posthogEvent: 'remote_control:session_end',
    contextKeys: ['device_kind', 'end_reason'],
  },
  'canopy.remote_control_device_remove': {
    kind: 'product',
    posthogEvent: 'remote_control:device_remove',
    contextKeys: ['device_kind'],
  },

  'canopy.git_commit': {
    kind: 'product',
    posthogEvent: 'git:commit_create',
    contextKeys: GIT_SHIPPING_CONTEXT_KEYS,
  },
  'canopy.pull_request_open': {
    kind: 'product',
    posthogEvent: 'git:pull_request_open',
    contextKeys: GIT_SHIPPING_CONTEXT_KEYS,
  },
  'canopy.pull_request_merge': {
    kind: 'product',
    posthogEvent: 'git:pull_request_merge',
    contextKeys: GIT_SHIPPING_CONTEXT_KEYS,
  },
  'canopy.home_onboarding_suggestions': {
    kind: 'product',
    posthogEvent: 'home:onboarding_suggestion_update',
    contextKeys: [
      'action',
      'entry',
      'step',
      'reason',
      'role',
      'count',
      'surface',
      'fallback',
    ],
    renamedContextKeys: { surface: 'composer_surface' },
  },
  'canopy.model_recovery': {
    kind: 'product',
    posthogEvent: 'billing:model_recovery_view',
    contextKeys: ['recovery_source', 'model_id', 'library_access'],
  },
  'canopy.model_access': {
    kind: 'product',
    posthogEvent: 'billing:model_access_update',
    contextKeys: ['recovery_source', 'model_id', 'library_access'],
  },
  'canopy.daily_credit_grant': {
    kind: 'product',
    posthogEvent: 'billing:daily_credit_grant_update',
    // The server's grant outcome only (CAN-4633); never balances or account
    // details.
    contextKeys: [
      'grant_status',
      'grant_blocked_reason',
      'grant_amount',
      'grant_source',
    ],
  },
  'canopy.credits_recovery': {
    kind: 'product',
    posthogEvent: 'billing:credits_recovery_view',
    contextKeys: ['recovery_surface', 'recovery_trigger'],
  },
  'canopy.credits_recovery_action': {
    kind: 'product',
    posthogEvent: 'billing:credits_recovery_click',
    contextKeys: ['recovery_surface', 'recovery_action'],
  },
  'canopy.share_dialog': {
    kind: 'product',
    posthogEvent: 'sharing:dialog_open',
    contextKeys: ['resource_kind', 'source'],
  },
  'canopy.add_project_dialog': {
    kind: 'product',
    posthogEvent: 'workspace:add_project_dialog_open',
    contextKeys: [],
  },
  'canopy.add_project_method': {
    kind: 'product',
    posthogEvent: 'workspace:add_project_method_click',
    contextKeys: ['project_method'],
  },
  'canopy.add_project_dialog_cancel': {
    kind: 'product',
    posthogEvent: 'workspace:add_project_dialog_cancel',
    contextKeys: ['project_method'],
  },
  'canopy.chat_turn': {
    kind: 'product',
    posthogEvent: 'chat:turn_end',
    // Fixed values only: why a turn or one of its sub-agents failed, and who
    // started it (CAN-4629).
    contextKeys: [
      ...AUDIT_CONTEXT_KEYS,
      'failure_category',
      'failure_detail',
      'sub_agent_failure_category',
      'trigger_type',
      // The daily-drip outcome main last saw, on `no_credits` failures only
      // (CAN-4633).
      'daily_credit_grant_status',
      // The selection the turn started with; `model` is the one that served
      // it (CAN-5233). May be an Agent id, like `chat:message_send.model`.
      'requested_model',
    ],
  },
  'canopy.chat_message_send': {
    kind: 'product',
    posthogEvent: 'chat:message_send',
    // Fired when the user submits, before dispatch, so a send that fails
    // before its turn starts is still counted. Never message content.
    contextKeys: [
      'chat_surface',
      'composer_mode',
      'is_suggested_prompt',
      'provider',
      'model',
      'is_ai_credits_billed',
      'is_first_message',
    ],
  },
  'canopy.portal_chat_visual_read': {
    kind: 'product',
    posthogEvent: 'chat:visual_view',
    contextKeys: ['page_count', 'size_bytes', 'transport_type'],
  },
  'canopy.agent_task': {
    kind: 'product',
    posthogEvent: 'agent:task_end',
    contextKeys: AUDIT_CONTEXT_KEYS,
  },
  'canopy.pipeline_execution': {
    kind: 'product',
    posthogEvent: 'pipeline:run_end',
    contextKeys: [
      'trigger_type',
      'pipeline_source',
      'job_count',
      'step_count',
      'plugin_collection_count',
      'has_project_context',
      'has_parent_execution',
      'is_rerun',
      'paused_job_count',
      'failed_job_count',
      'cancelled_job_count',
      'skipped_job_count',
    ],
  },
  'canopy.pipeline_crud': {
    kind: 'product',
    posthogEvent: 'pipeline:definition_update',
    contextKeys: [
      'action',
      'source',
      'result_count',
      'trigger_type',
      'share_scope',
      'has_pipeline_id',
      'has_project_context',
      'has_search_query',
    ],
    // Reads (list, get, discover) fire on ordinary page loads; only changes
    // to a pipeline definition are product activity.
    includes: (context) => PIPELINE_DEFINITION_CHANGES.has(context.action),
  },
  'canopy.workspace_crud': {
    kind: 'product',
    posthogEvent: 'workspace:project_update',
    contextKeys: WORKSPACE_CONTEXT_KEYS,
    renamedContextKeys: { workspace_is_temporary: 'is_workspace_temporary' },
  },
  'canopy.worktree_crud': {
    kind: 'product',
    posthogEvent: 'workspace:worktree_update',
    contextKeys: WORKSPACE_CONTEXT_KEYS,
    renamedContextKeys: { workspace_is_temporary: 'is_workspace_temporary' },
  },
  'canopy.standalone_chat_project_crud': {
    kind: 'product',
    posthogEvent: 'cowork:project_update',
    contextKeys: STANDALONE_CONTEXT_KEYS,
  },
  'canopy.standalone_chat_project_feature': {
    kind: 'product',
    posthogEvent: 'cowork:project_feature_update',
    contextKeys: [
      ...STANDALONE_CONTEXT_KEYS,
      'item_kind',
      'item_count',
      'was_update',
    ],
    renamedContextKeys: { was_update: 'is_update' },
  },
  'canopy.onboarding_profile': {
    kind: 'product',
    posthogEvent: 'onboarding:profile_update',
    contextKeys: ['attribution_source', 'profile_role'],
  },
  'canopy.activation_campaign': {
    kind: 'product',
    posthogEvent: 'activation:campaign_update',
    contextKeys: ['campaign_id', 'item_id', 'outcome', 'reason', 'destination'],
  },
  'canopy.suggested_prompt': {
    kind: 'product',
    posthogEvent: 'chat:suggested_prompt_update',
    contextKeys: [
      'action',
      'surface',
      'suggestion_count',
      'suggestion_ids',
      'suggestion_id',
      'suggestion_index',
      'mcp_keys',
      'mcp_key',
    ],
    // Its home/chat/cowork placement would otherwise be replaced by the
    // window surface every renderer event carries.
    renamedContextKeys: { surface: 'prompt_surface' },
  },
  'canopy.provider_account_connect': {
    kind: 'product',
    posthogEvent: 'provider:account_connect',
    // Never account details: no email, label, plan, or org.
    contextKeys: [
      'provider',
      'connect_source',
      'connection_method',
      'is_first_connection',
      'first_connected_provider',
    ],
  },
  'canopy.provider_account_connect_fail': {
    kind: 'product',
    posthogEvent: 'provider:account_connect_fail',
    contextKeys: [
      'provider',
      'connect_source',
      'connection_method',
      'failure_reason',
    ],
  },
  'canopy.skill_suggestion': {
    kind: 'product',
    posthogEvent: 'chat:skill_suggestion_update',
    // Counts and outcomes only; never prompts, titles or skill names.
    contextKeys: ['action', 'occurrence_count', 'outcome', 'candidate_count'],
  },
  // Phase 4 daemon route outcomes (CAN-5093): fixed family, host and reason codes only.
  'canopy.daemon_route': {
    kind: 'product',
    posthogEvent: 'daemon:route_select',
    contextKeys: ['route_family', 'route_host', 'route_reason'],
  },
  'canopy.chat_storage_format4': {
    kind: 'product',
    posthogEvent: 'chat:storage_format4_update',
    contextKeys: [
      'format4_event',
      'format4_reason',
      'format4_attempt',
      'format4_duration_bucket',
    ],
  },
  // The chat automation migration (CAN-5479): one event per run with
  // candidates, counts only; never an automation's name, prompt, ID or error.
  'canopy.chat_automation_migration': {
    kind: 'product',
    posthogEvent: 'automation:chat_migration_end',
    contextKeys: [
      'converted_count',
      'failed_count',
      'skipped_count',
      'failed_activity_running_count',
      'failed_not_found_count',
      'failed_not_a_chat_action_count',
      'failed_native_send_count',
      'failed_agent_route_count',
      'failed_agent_settings_count',
      'failed_target_requirement_count',
      'failed_pipeline_save_count',
      'failed_owner_not_recorded_count',
      'failed_settings_not_recorded_count',
      'failed_plugins_not_recorded_count',
      'failed_automations_write_count',
      'failed_unknown_count',
      'remaining_native_count',
      'remaining_native_send_count',
      'remaining_agent_route_count',
      'remaining_agent_settings_count',
      'remaining_target_requirement_count',
    ],
  },
} as const satisfies Record<string, ProductOperationPolicy>;

export type DesktopOperationName = keyof typeof DESKTOP_OPERATIONS;

const postHogOperationEvents = new Set<string>();
for (const policy of Object.values(DESKTOP_OPERATIONS)) {
  postHogOperationEvents.add(policy.posthogEvent);
}

export function isDesktopPostHogOperationEvent(event: string): boolean {
  return postHogOperationEvents.has(event);
}

export type DesktopOperationSurface = 'background' | 'main' | 'app-advisor';

export type DesktopOperationOutcome =
  | { status: 'success' }
  | { status: 'failure'; failureReason: DesktopInstrumentationFailureReason };

export interface PostHogOperationEvent {
  event: string;
  properties: DesktopInstrumentationContext;
}

export interface PostHogOperationTracker {
  start: (
    name: DesktopOperationName,
    options?: DesktopInstrumentationOperationOptions,
    captureEligible?: boolean,
  ) => void;
  discardAcquisitionStarts: () => void;
  finish: (
    name: DesktopOperationName,
    outcome: DesktopOperationOutcome,
    surface: DesktopOperationSurface,
    options?: DesktopInstrumentationOperationOptions,
  ) => PostHogOperationEvent | undefined;
}

/** Bounds start times for operations that never finish. */
const MAX_TRACKED_OPERATION_STARTS = 500;
const ACQUISITION_LIFECYCLES: ReadonlySet<string> = new Set([
  'canopy.first_run_import',
  'canopy.project_import',
  'canopy.remote_pairing',
]);

function projectContextKeys(
  context: DesktopInstrumentationContext,
  approved: readonly string[],
  renamed: Readonly<Record<string, string>> | undefined,
  name: DesktopOperationName,
): DesktopInstrumentationContext {
  const projected: DesktopInstrumentationContext = {};
  for (const key of approved) {
    const value = context[key];
    if (
      value !== undefined &&
      validateAcquisitionContextValue(name, key, value)
    )
      projected[renamed?.[key] ?? key] = value;
  }
  return projected;
}

/**
 * Operations that measure their own working time keep it; wall-clock time
 * between start and finish is the fallback.
 */
function resolveDurationMs(
  context: DesktopInstrumentationContext,
  started: number | undefined,
  now: () => number,
): number | undefined {
  const measured = context.duration_ms;
  if (typeof measured === 'number' && Number.isFinite(measured)) {
    return measured;
  }
  if (started === undefined) return undefined;
  return Math.max(0, now() - started);
}

export interface PostHogOperationTrackerOptions {
  /** Bundled release version stamped as `app_version`; omitted when unset. */
  appVersion?: string;
  now?: () => number;
}

/**
 * Turns operation start/finish pairs into one PostHog event per finished
 * product operation.
 */
export function createPostHogOperationTracker({
  appVersion,
  now = (): number => Date.now(),
}: PostHogOperationTrackerOptions = {}): PostHogOperationTracker {
  const startedAt = new Map<string, number>();
  const keyOf = (
    name: DesktopOperationName,
    options: DesktopInstrumentationOperationOptions | undefined,
  ): string => `${name}\u0000${options?.operationKey ?? ''}`;

  return {
    start: (name, options, captureEligible = true): void => {
      if (ACQUISITION_LIFECYCLES.has(name) && !captureEligible) return;
      const policy: ProductOperationPolicy = DESKTOP_OPERATIONS[name];
      if (policy.includes && !policy.includes(options?.context ?? {})) return;
      const key = keyOf(name, options);
      // Re-insert so the map stays ordered oldest-first for eviction.
      startedAt.delete(key);
      startedAt.set(key, now());
      if (startedAt.size > MAX_TRACKED_OPERATION_STARTS) {
        const oldest = startedAt.keys().next();
        if (!oldest.done) startedAt.delete(oldest.value);
      }
    },
    discardAcquisitionStarts: (): void => {
      for (const key of Array.from(startedAt.keys())) {
        if (ACQUISITION_LIFECYCLES.has(key.slice(0, key.indexOf('\u0000'))))
          startedAt.delete(key);
      }
    },
    finish: (
      name,
      outcome,
      surface,
      options,
    ): PostHogOperationEvent | undefined => {
      const policy: ProductOperationPolicy = DESKTOP_OPERATIONS[name];
      const key = keyOf(name, options);
      const started = startedAt.get(key);
      startedAt.delete(key);
      if (ACQUISITION_LIFECYCLES.has(name) && started === undefined)
        return undefined;
      const context = options?.context ?? {};
      if (policy.includes && !policy.includes(context)) return undefined;
      const durationMs = resolveDurationMs(context, started, now);
      return {
        event: policy.posthogEvent,
        properties: {
          ...projectContextKeys(
            context,
            policy.contextKeys,
            policy.renamedContextKeys,
            name,
          ),
          status: outcome.status,
          ...(outcome.status === 'failure'
            ? { failure_reason: outcome.failureReason }
            : {}),
          ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
          surface,
          ...(appVersion === undefined ? {} : { app_version: appVersion }),
        },
      };
    },
  };
}
