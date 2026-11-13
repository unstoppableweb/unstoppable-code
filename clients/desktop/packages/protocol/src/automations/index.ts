import { MARKETPLACE_PUBLIC_SHARE_PREFIXES } from '../marketplace';
import type { ResourceOwner } from '../resource-owner';
import type { PublicShareVersion } from '../sharing';
// ---------------------------------------------------------------------------
// Shared Automation API contracts (CAN-1581).
//
// These wire shapes are consumed by:
//   - The web Canopy Server route handlers for team-shared automations.
//   - The desktop main process when proxying automation share/install
//     operations through a configured Canopy Server.
//   - The desktop renderer (via the automations preload bridge) for
//     browsing/previewing/installing automations shared by teammates.
//
// Like a shared custom Agent (and unlike a shared Skill or Pipeline), an
// automation has no single canonical source file: the local
// `ScheduledActivity` record is a runtime object riddled with machine-local
// identifiers. The canonical shared form is therefore the structured
// {@link SharedAutomationDocument} — a portable snapshot with every
// machine-specific, secret-bearing, or run-history field removed at the
// boundary. Validation is deliberately STRICT: unknown fields anywhere in the
// document are rejected (not dropped) so a non-portable value can never ride
// along silently, and so future additive fields require an intentional
// validator update.
//
// Local trigger/action enums are duplicated here rather than imported because
// the protocol package is the boundary and may not depend on desktop-shared
// or agent-transcript.
//
// This module must remain pure: no Node, Electron, React, Prisma, or app
// imports. It runs in the renderer, the main process, and the web app.
// ---------------------------------------------------------------------------

import {
  getShareablePluginRefKey,
  normalizeShareablePluginRef,
  type ShareablePluginRef,
} from '../plugins';
import { AGENT_MODEL_ID_PREFIX, serializedByteLength } from '../agents';
import {
  PIPELINE_PACKAGE_MAX_FILE_BYTES,
  isPipelineContentHash,
  isPipelinePackageDigest,
  isPipelinePackageIdentifier,
  type PipelinePackageRef,
  type PipelineShareInstallPin,
} from '../pipelines/package';
import { THINKING_LEVELS, type ThinkingLevel } from '../thinking';
import {
  isValidatedConfiguredPromptReferences,
  validateConfiguredPromptReferences,
  type ConfiguredPromptReference,
} from '../configured-prompt-references';

function validateSharedPromptReferences(
  prompt: string,
  references: unknown,
  plugins: ShareablePluginRef[],
):
  | { ok: true; value: ConfiguredPromptReference[] }
  | { ok: false; error: string } {
  if (
    !isValidatedConfiguredPromptReferences(prompt, references, {
      portableOnly: true,
    })
  ) {
    return {
      ok: false,
      error:
        validateConfiguredPromptReferences(prompt, references, {
          portableOnly: true,
        }) ?? 'Automation prompt references are invalid.',
    };
  }
  const reviewedPlugins = new Set(plugins.map(getShareablePluginRefKey));
  for (const reference of references) {
    if (
      reference.kind === 'plugin' &&
      reference.plugin.kind === 'portable' &&
      !reviewedPlugins.has(getShareablePluginRefKey(reference.plugin.ref))
    ) {
      return {
        ok: false,
        error:
          'A plugin mentioned in the prompt must also be listed for install review.',
      };
    }
  }
  return { ok: true, value: references };
}

/**
 * Where an automation's schedule fires and its runs execute (CAN-6183,
 * cloud pipelines decisions P3 and P6). `local` is this desktop; `cloud`
 * means the schedule is stored and fired server-side and the desktop keeps a
 * stub. Absent means `local`. A reader must keep a record or run whose
 * location it doesn't know, and must never fire such a record locally.
 */
export const AUTOMATION_EXECUTION_LOCATIONS = ['local', 'cloud'] as const;
export type AutomationExecutionLocation =
  (typeof AUTOMATION_EXECUTION_LOCATIONS)[number];

export function isAutomationExecutionLocation(
  value: unknown,
): value is AutomationExecutionLocation {
  return AUTOMATION_EXECUTION_LOCATIONS.some((location) => location === value);
}

/**
 * Wire version of the shared-Automation API. Bump only on breaking shape
 * changes (including any new shareable action kind or document field).
 */
export const SHARED_AUTOMATION_API_VERSION = 1;
/** New configured-reference shares require a reader that understands their spans. */
export const SHARED_AUTOMATION_REFERENCES_API_VERSION = 2;
/** Readers must retain declared execution restrictions. */
export const SHARED_AUTOMATION_TARGET_REQUIREMENT_API_VERSION = 3;
export const SHARED_AUTOMATION_TARGET_REQUIREMENT_CAPABILITY =
  'automations-target-requirements-v3';
/** Readers must accept an author-included run-condition command. */
export const SHARED_AUTOMATION_RUN_CONDITION_API_VERSION = 4;
export const SHARED_AUTOMATION_RUN_CONDITION_CAPABILITY =
  'automations-run-condition-v4';
/**
 * Readers must accept `packaged` pipeline refs and prompt-action
 * `pipelineDependencies` whose YAML travels in the capability package.
 */
export const SHARED_AUTOMATION_PIPELINE_DEPENDENCIES_API_VERSION = 5;
export const SHARED_AUTOMATION_PIPELINE_DEPENDENCIES_CAPABILITY =
  'automations-pipeline-dependencies-v5';
/** Key of a `worktree_pipeline` action's own packaged pipeline. */
export const SHARED_AUTOMATION_ACTION_PIPELINE_KEY = 'action';
/**
 * Mirrors desktop-shared `MAX_AUTOMATION_IF_COMMAND_CHARS`; protocol cannot
 * import desktop-shared, so a desktop-shared test pins the two together.
 */
export const MAX_SHARED_AUTOMATION_RUN_CONDITION_CHARS = 20_000;
/**
 * Readers must retain pipeline destination kinds other than `workspace`, and
 * accept everything version 5 does.
 */
export const SHARED_AUTOMATION_PIPELINE_TARGET_API_VERSION = 6;
export const SHARED_AUTOMATION_PIPELINE_TARGET_CAPABILITY =
  'automations-pipeline-targets-v6';

/** Where a pipeline automation runs; local and portable forms share these kinds. */
export const AUTOMATION_PIPELINE_TARGET_KINDS = [
  'global',
  'new_worktree',
  'task',
  'project',
] as const;
export type AutomationPipelineTargetKind =
  (typeof AUTOMATION_PIPELINE_TARGET_KINDS)[number];

export function isAutomationPipelineTargetKind(
  value: unknown,
): value is AutomationPipelineTargetKind {
  return AUTOMATION_PIPELINE_TARGET_KINDS.some((kind) => kind === value);
}

export const TARGET_CONTEXTS = ['cowork', 'worktree', 'app_advisor'] as const;
export type TargetContext = (typeof TARGET_CONTEXTS)[number];

export interface SharedAutomationTargetRequirement {
  contexts: TargetContext[];
}

export function impliedTargetContexts(
  action: SharedAutomationActionType,
): TargetContext[] {
  switch (action) {
    case 'app_advisor_prompt':
      return ['app_advisor'];
    case 'standalone_prompt':
      return ['cowork'];
    case 'worktree_prompt':
      return ['worktree'];
    case 'worktree_pipeline':
      return ['cowork', 'worktree'];
  }
}

export function intersectTargetContexts(
  ...sets: readonly (readonly TargetContext[])[]
): TargetContext[] {
  return TARGET_CONTEXTS.filter((context) =>
    sets.every((set) => set.includes(context)),
  );
}

/** Unknown or missing project kinds never authorize a target. */
export function projectKindToTargetContext(
  kind: unknown,
): TargetContext | null {
  switch (kind) {
    case 'cowork':
      return 'cowork';
    case 'single-repo':
    case 'multi-repo':
      return 'worktree';
    case 'app_advisor':
      return 'app_advisor';
    default:
      return null;
  }
}

export type TargetRequirementValidationResult =
  | { ok: true; requirement: SharedAutomationTargetRequirement }
  | { ok: false; error: string };

/** Also used for canonical local records; action constraints are optional. */
export function validateSharedAutomationTargetRequirement(
  value: unknown,
  action?: SharedAutomationActionType,
): TargetRequirementValidationResult {
  const requirement = asRecord(value);
  if (
    !requirement ||
    Object.keys(requirement).some((key) => key !== 'contexts') ||
    !Array.isArray(requirement.contexts) ||
    requirement.contexts.length === 0
  ) {
    return {
      ok: false,
      error:
        'Automation targetRequirement must contain a nonempty contexts array only.',
    };
  }
  const contexts: TargetContext[] = [];
  for (const value of requirement.contexts) {
    const context = TARGET_CONTEXTS.find((known) => known === value);
    if (!context || contexts.includes(context)) {
      return {
        ok: false,
        error: 'Automation target contexts must be unique known contexts.',
      };
    }
    contexts.push(context);
  }
  if (
    action &&
    contexts.some((context) => !impliedTargetContexts(action).includes(context))
  ) {
    return {
      ok: false,
      error: 'Automation target requirement contradicts its action.',
    };
  }
  return {
    ok: true,
    requirement: { contexts: intersectTargetContexts(contexts) },
  };
}

/**
 * Canonical public share path for automations (CAN-1582). `/s/*` is
 * storefront-owned; see `docs/web-reserved-paths.md`.
 */
export const AUTOMATION_SHARE_PATH_PREFIX =
  MARKETPLACE_PUBLIC_SHARE_PREFIXES.automation;

export function automationSharePath(externalId: string): string {
  return `${AUTOMATION_SHARE_PATH_PREFIX}/${encodeURIComponent(externalId)}`;
}

/** Owner-visible state of an automation's public share (agent parity). */
export interface SharedAutomationPublicShareInfo {
  externalId: string;
  pinnedContentHash: string;
  /** False once the live document's hash diverges from the pinned hash. */
  upToDate: boolean;
  sharePath: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Visibility scope for a shared automation. Mirrors the shared-Agent scopes.
 *
 * - `private` — visible to the author only.
 * - `team` — visible to every member of the owning team.
 * - `organization` — visible to every member of the owning organization.
 */
export const AUTOMATION_SHARE_SCOPES = [
  'private',
  'team',
  'organization',
] as const;

export type AutomationShareScope = (typeof AUTOMATION_SHARE_SCOPES)[number];

/**
 * Maximum number of serialized bytes accepted for a single shared automation
 * document. Sized to match `MAX_SHARED_AGENT_BYTES` — the structured form is
 * small; the cap only guards against runaway plugin lists.
 */
export const MAX_SHARED_AUTOMATION_BYTES = 256 * 1024;

/** Maximum length (characters) of a shared automation's name. */
export const MAX_SHARED_AUTOMATION_NAME_LENGTH = 200;

/** Maximum UTF-8 byte length of a shared automation's description. */
export const MAX_SHARED_AUTOMATION_DESCRIPTION_BYTES = 4 * 1024;

/** Maximum UTF-8 byte length of a prompt carried by a shared automation. */
export const MAX_SHARED_AUTOMATION_PROMPT_BYTES = 64 * 1024;

const SHARED_AUTOMATION_CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

export function isSharedAutomationContentHash(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    SHARED_AUTOMATION_CONTENT_HASH_PATTERN.test(value)
  );
}

/** Canonical protocol thinking levels accepted by shared automations. */
export const SHARED_AUTOMATION_THINKING_LEVELS = THINKING_LEVELS;

export type SharedAutomationThinkingLevel = ThinkingLevel;

/**
 * Canonical Codex inference speeds. `standard` is the product's "Regular"
 * speed. This is the single wire vocabulary; desktop-shared re-exports it.
 * The legacy `fastMode` boolean is a projection (`speed === 'fast'`) and is
 * never `true` for `ultrafast`.
 */
export const CODEX_SPEEDS = ['standard', 'fast', 'ultrafast'] as const;

export type CodexSpeed = (typeof CODEX_SPEEDS)[number];

export function isCodexSpeed(value: unknown): value is CodexSpeed {
  return CODEX_SPEEDS.some((speed) => speed === value);
}

/**
 * Portable chat-interface modes. Duplicated from agent-transcript's
 * `ChatInterfaceMode` (protocol may not depend on agent-transcript).
 */
export const SHARED_AUTOMATION_INTERFACE_MODES = [
  'canopy',
  'claude-code',
  'auto',
] as const;

export type SharedAutomationInterfaceMode =
  (typeof SHARED_AUTOMATION_INTERFACE_MODES)[number];

// ---------------------------------------------------------------------------
// Canonical shared automation document.
// ---------------------------------------------------------------------------

/**
 * Trigger snapshot. `timezone` is pinned to the literal `'local'` exactly as
 * in the desktop model: the schedule always runs in the *recipient's* local
 * timezone, which is the portable interpretation of a shared schedule. The
 * install flow re-confirms the schedule before the copy can be enabled.
 */
export type SharedAutomationTrigger =
  | { kind: 'cron'; expression: string; timezone: 'local' }
  | { kind: 'one_time'; runAt: string; timezone: 'local' };

export type SharedAutomationTriggerKind = SharedAutomationTrigger['kind'];

/**
 * Portable model tuning. `model` must be a provider model id — a value with
 * the `agent_model_` prefix references a local custom Agent and is rejected.
 */
export interface SharedAutomationModelConfig {
  model?: string;
  thinkingLevel?: SharedAutomationThinkingLevel;
  /** Requested Codex speed. Takes precedence over the legacy `fastMode`. */
  speed?: CodexSpeed;
  /** Legacy projection: always `speed === 'fast'` when `speed` is present. */
  fastMode?: boolean;
}

/**
 * Portable pipeline reference. Newly shared pipelines carry an immutable
 * install pin, while legacy v1 documents without one remain readable and fail
 * closed when installation is attempted. Curated pipelines use their stable
 * catalog key, and machine-local pipelines travel either inline (older
 * shares) or, from version 5, as a `packaged` reference to an
 * `automation_pipeline` resource in the document's capability package.
 * Unresolved refs let the recipient rebind one of their own pipelines.
 */
export type SharedAutomationPipelineRef =
  | { source: 'bundled'; pipelineId: string; name?: string }
  | {
      source: 'packaged';
      /** `pipelineKey` of the `automation_pipeline` package resource. */
      key: string;
      pipelineContentHash: string;
      name?: string;
    }
  | {
      source: 'inline';
      name?: string;
      rawPipeline: string;
      pipelineContentHash: string;
      /** Provenance when the author's pipeline was itself a team share. */
      origin?: { remoteId: string; installPin: PipelineShareInstallPin };
    }
  | {
      source: 'shared';
      /** Server-side shared pipeline UUID on the same Canopy Server. */
      remoteId: string;
      name?: string;
      /** @deprecated Legacy v1 documents used this field before install pins. */
      contentHash?: string;
      installPin?: PipelineShareInstallPin;
    }
  | { source: 'curated'; curatedKey: string; name?: string }
  | { source: 'unresolved'; name?: string };

/**
 * Abstract rebind target. The document never carries the author's
 * workspace/worktree ids; the installer chooses a workspace of their own and
 * the confirm-before-enable flow binds it locally.
 */
export interface SharedAutomationWorkspaceTarget {
  kind: 'workspace';
}

export interface SharedAutomationCoworkTarget {
  kind: 'cowork';
}

/**
 * Portable pipeline destination. `workspace` keeps the legacy behavior (a new
 * worktree on a code project, the project folder on a cowork project); the
 * other kinds need version 6. No kind carries local project or task ids.
 */
export type SharedAutomationPipelineTarget =
  | SharedAutomationWorkspaceTarget
  | { kind: AutomationPipelineTargetKind };

/**
 * Where a packaged pipeline's local id appears in the prompt. `textStart` is
 * a UTF-16 code-unit offset into the canonical prompt
 * ({@link canonicalizeSharedAutomationPrompt}); `text` is the exact slice the
 * installer replaces with the recipient's local pipeline id.
 */
export interface SharedAutomationPromptSpan {
  textStart: number;
  text: string;
}

/**
 * A pipeline a prompt action uses. A `packaged` pipeline's key equals the
 * dependency key; bundled, curated, and shared pipelines are plain references
 * and carry no prompt spans.
 */
export interface SharedAutomationPipelineDependency {
  key: string;
  pipeline: SharedAutomationPipelineRef;
  promptSpans: SharedAutomationPromptSpan[];
}

/**
 * The one prompt normalization the share builder and every reader apply
 * before prompt spans are computed or validated. Prompts travel verbatim
 * (no trimming, no line-ending rewrite) so existing `promptReferences`
 * offsets and stored document hashes stay valid; keeping the rule in one
 * function lets both sides change it together if that ever changes.
 */
export function canonicalizeSharedAutomationPrompt(prompt: string): string {
  return prompt;
}

/**
 * Portable action snapshot. Five of the six local `AutomationAction` variants
 * are shareable in v1. Machine-bound session prompts are downgraded to an
 * abstract workspace prompt before reaching this wire contract, while Cowork
 * prompts carry an abstract project target. `pipeline_execution_resume` is
 * the sole action that cannot travel because it names a local execution.
 *
 * `ShareablePluginRef[]` is the ONLY representable plugin form — local-only
 * plugin selections that do not map to a shareable ref are blocked at the
 * share boundary rather than silently omitted (shared-Agent doctrine).
 */
export type SharedAutomationAction =
  | {
      type: 'app_advisor_prompt';
      prompt: string;
      promptReferences?: ConfiguredPromptReference[];
      /** Version 5 only. */
      pipelineDependencies?: SharedAutomationPipelineDependency[];
      modelConfig?: SharedAutomationModelConfig;
      plugins: ShareablePluginRef[];
    }
  | {
      type: 'standalone_prompt';
      target: SharedAutomationCoworkTarget;
      prompt: string;
      promptReferences?: ConfiguredPromptReference[];
      /** Version 5 only. */
      pipelineDependencies?: SharedAutomationPipelineDependency[];
      modelConfig?: SharedAutomationModelConfig;
      plugins: ShareablePluginRef[];
    }
  | {
      type: 'worktree_prompt';
      target: SharedAutomationWorkspaceTarget;
      /**
       * Branch-name suggestion. Repo-scoped rather than machine-scoped, so it
       * is meaningful to a team sharing the same repositories; the installer
       * confirms or clears it during rebind.
       */
      existingBranch?: string;
      prompt: string;
      promptReferences?: ConfiguredPromptReference[];
      /** Version 5 only. */
      pipelineDependencies?: SharedAutomationPipelineDependency[];
      modelConfig?: SharedAutomationModelConfig;
      plugins: ShareablePluginRef[];
      planMode?: boolean;
      interfaceMode?: SharedAutomationInterfaceMode;
    }
  | {
      type: 'worktree_pipeline';
      target: SharedAutomationPipelineTarget;
      pipeline: SharedAutomationPipelineRef;
      /**
       * Names of the pipeline inputs the author had configured, sorted and
       * deduplicated. Values are never representable — free-form input values
       * are a secret-paste vector; recipients supply their own during the
       * install flow.
       */
      inputKeys: string[];
    };

export type SharedAutomationActionType = SharedAutomationAction['type'];

export interface SharedAutomationRunCondition {
  command: string;
}

export interface SharedAutomationDocument {
  version: 1 | 2 | 3 | 4 | 5 | 6;
  targetRequirement?: SharedAutomationTargetRequirement;
  name: string;
  /** Authored in the share flow; may be empty. */
  description: string;
  trigger: SharedAutomationTrigger;
  action: SharedAutomationAction;
  capabilityPackage?: PipelinePackageRef;
  /**
   * True whenever the source automation had an `ifCommand` run-condition
   * gate, whether or not the command itself travels in `runCondition`.
   */
  hasRunCondition: boolean;
  /**
   * The source's run-condition command. Present only on version 4 or later, only when
   * the author chose to include it, and only when `hasRunCondition` is true.
   * A version 4 or later document without it is valid (the author declined). Install
   * code never stores it directly: a recipient must review and approve it.
   */
  runCondition?: SharedAutomationRunCondition;
}

// ---------------------------------------------------------------------------
// Owner / actor metadata (mirrors the Skills/Agents convention).
// ---------------------------------------------------------------------------

export type AutomationShareOwner = ResourceOwner;

export interface AutomationShareActor {
  id: string;
  name: string | null;
  email: string | null;
}

// ---------------------------------------------------------------------------
// Response DTOs.
// ---------------------------------------------------------------------------

export interface SharedAutomationSummary {
  /** Server-side shared resource UUID (the `[automationId]` route param). */
  id: string;
  name: string;
  description: string;
  triggerKind: SharedAutomationTriggerKind;
  actionType: SharedAutomationActionType;
  /**
   * Stable content hash of the shared automation document, computed by the
   * server over the canonical JSON form before storage. Clients compare it
   * against locally recorded install/share metadata to detect remote changes.
   */
  contentHash: string;
  shareScope: AutomationShareScope;
  owner: AutomationShareOwner;
  createdAt: string;
  updatedAt: string;
  createdBy: AutomationShareActor;
  canUpdate: boolean;
  canDelete: boolean;
  /** Fork lineage: the shared automation this one was saved from, if any. */
  savedFrom?: {
    automationId: string;
    contentHash: string;
  };
  /**
   * Public link state (CAN-1582). Omitted by servers that predate public
   * automation shares; `null` when no public snapshot exists.
   */
  publicShare?: SharedAutomationPublicShareInfo | null;
}

export interface SharedAutomationDetail extends SharedAutomationSummary {
  /** The full portable automation document. Installs consume this verbatim. */
  automation: SharedAutomationDocument;
}

export type SharedAutomationInstallSource = Pick<
  SharedAutomationDetail,
  'id' | 'contentHash' | 'automation'
>;

// ---------------------------------------------------------------------------
// Request DTOs (desktop/web → Canopy Server; carry `serverId`).
// ---------------------------------------------------------------------------

export interface ListSharedAutomationsRequest {
  serverId: string;
  limit?: number;
  cursor?: string;
  query?: string;
  createdBy?: 'me' | 'anyone';
}

export interface ListSharedAutomationsResponse {
  automations: SharedAutomationSummary[];
  nextCursor?: string;
}

export interface GetSharedAutomationRequest {
  serverId: string;
  /** Server-side shared resource UUID. */
  automationId: string;
}

export interface CreateSharedAutomationRequest {
  serverId: string;
  automation: SharedAutomationDocument;
  shareScope?: AutomationShareScope;
  teamId?: string;
  organizationId?: string;
  /** Committed capability-package upload referenced by the document. */
  committedPackageUploadId?: string;
  /** Fork lineage: the shared automation this copy was installed from. */
  savedFrom?: {
    remoteId: string;
    contentHash: string;
  };
}

export interface UpdateSharedAutomationRequest {
  serverId: string;
  /** Server-side shared resource UUID. */
  automationId: string;
  automation: SharedAutomationDocument;
  expectedContentHash?: string;
  shareScope?: AutomationShareScope;
  teamId?: string;
  organizationId?: string;
  /** Committed capability-package upload referenced by the document. */
  committedPackageUploadId?: string;
  revokePublicShare?: PublicShareVersion;
}

export interface DeleteSharedAutomationRequest {
  serverId: string;
  /** Server-side shared resource UUID. */
  automationId: string;
}

// ---------------------------------------------------------------------------
// Validation (part of the protocol contract).
//
// The document is the wire boundary between desktop and Canopy Cloud and the
// enforcement point of the redaction guarantees, so its invariants live here
// rather than duplicated per consumer.
// ---------------------------------------------------------------------------

export type SharedAutomationValidationResult =
  | { ok: true; document: SharedAutomationDocument }
  | { ok: false; error: string };

/**
 * Local `AutomationAction` types that can never travel in a shared document.
 * Listed explicitly so the error names the reason instead of falling through
 * to a generic unknown-type message.
 */
const BLOCKED_AUTOMATION_ACTION_TYPES: Record<string, string> = {
  pipeline_execution_resume:
    'Usage-limit resume automations cannot be shared; they are bound to a pipeline execution on this machine.',
};

/** UTF-8 byte length of a raw string (no JSON quoting overhead). */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function unexpectedFieldError(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  context: string,
): string | null {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      return `Unexpected field "${key}" in ${context}.`;
    }
  }
  return null;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecordValue(value) ? value : null;
}

type PartResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Five-field cron grammar, mirroring desktop-shared `parseFiveFieldCron`
 * (numeric-only tokens: `*`, `N`, `A-B` with A ≤ B, optional `/step`, comma
 * lists; day-of-week accepts 0–7 with 7 ≡ Sunday). Duplicated because the
 * protocol package may not depend on desktop-shared. Deliberately validates
 * grammar only — never "does this fire in the future": stored documents are
 * re-validated long after creation, so a clock-dependent check would rot.
 */
const CRON_FIELD_SPECS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
] as const;

function cronFieldGrammarError(
  fieldSource: string,
  spec: (typeof CRON_FIELD_SPECS)[number],
): string | null {
  for (const segment of fieldSource.split(',')) {
    if (segment.length === 0) {
      return 'empty segment';
    }
    let body = segment;
    const slashIndex = segment.indexOf('/');
    if (slashIndex !== -1) {
      body = segment.slice(0, slashIndex);
      const stepText = segment.slice(slashIndex + 1);
      const parsedStep = Number.parseInt(stepText, 10);
      if (
        !/^[0-9]+$/.test(stepText) ||
        !Number.isInteger(parsedStep) ||
        parsedStep <= 0
      ) {
        return `step "${stepText}" must be a positive integer`;
      }
      if (body !== '*' && !body.includes('-')) {
        return 'step syntax is only supported for wildcard or range segments';
      }
    }
    let rangeStart: number;
    let rangeEnd: number;
    if (body === '*') {
      rangeStart = spec.min;
      rangeEnd = spec.max;
    } else if (body.includes('-')) {
      const dashIndex = body.indexOf('-');
      const startText = body.slice(0, dashIndex);
      const endText = body.slice(dashIndex + 1);
      if (!/^[0-9]+$/.test(startText) || !/^[0-9]+$/.test(endText)) {
        return `range "${body}" must use numeric bounds`;
      }
      rangeStart = Number.parseInt(startText, 10);
      rangeEnd = Number.parseInt(endText, 10);
      if (rangeStart > rangeEnd) {
        return `range "${body}" must have start ≤ end`;
      }
    } else {
      if (!/^[0-9]+$/.test(body)) {
        return `value "${body}" must be numeric`;
      }
      rangeStart = Number.parseInt(body, 10);
      rangeEnd = rangeStart;
    }
    if (rangeStart < spec.min || rangeEnd > spec.max) {
      return `values must fall within ${spec.min}..${spec.max}`;
    }
  }
  return null;
}

const CRON_FIELD_COUNT_ERROR =
  'Automation cron expression must have exactly five whitespace-separated fields.';

/**
 * Why a five-field cron expression is malformed, or null when its grammar is
 * valid. Shared triggers and cloud workflow schedules (CAN-6183) accept the
 * same grammar the desktop scheduler parses.
 */
export function automationCronExpressionError(
  expression: string,
): string | null {
  const fields = expression.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5) return CRON_FIELD_COUNT_ERROR;
  for (let index = 0; index < CRON_FIELD_SPECS.length; index++) {
    const spec = CRON_FIELD_SPECS[index];
    const grammarError = cronFieldGrammarError(fields[index], spec);
    if (grammarError)
      return `Invalid cron ${spec.name} field "${fields[index]}": ${grammarError}.`;
  }
  return null;
}

function validateTrigger(value: unknown): PartResult<SharedAutomationTrigger> {
  const trigger = asRecord(value);
  if (!trigger) {
    return { ok: false, error: 'Automation trigger must be an object.' };
  }
  if (trigger.timezone !== 'local') {
    return {
      ok: false,
      error: 'Automation trigger timezone must be the literal "local".',
    };
  }
  if (trigger.kind === 'cron') {
    const unexpected = unexpectedFieldError(
      trigger,
      ['kind', 'expression', 'timezone'],
      'the automation trigger',
    );
    if (unexpected) {
      return { ok: false, error: unexpected };
    }
    const expression = trigger.expression;
    const cronError =
      typeof expression === 'string'
        ? automationCronExpressionError(expression)
        : CRON_FIELD_COUNT_ERROR;
    if (typeof expression !== 'string' || cronError !== null) {
      return { ok: false, error: cronError ?? CRON_FIELD_COUNT_ERROR };
    }
    return {
      ok: true,
      value: { kind: 'cron', expression, timezone: 'local' },
    };
  }
  if (trigger.kind === 'one_time') {
    const unexpected = unexpectedFieldError(
      trigger,
      ['kind', 'runAt', 'timezone'],
      'the automation trigger',
    );
    if (unexpected) {
      return { ok: false, error: unexpected };
    }
    const runAt = trigger.runAt;
    if (typeof runAt !== 'string' || Number.isNaN(Date.parse(runAt))) {
      return {
        ok: false,
        error: 'Automation one_time runAt must be a parseable timestamp.',
      };
    }
    return { ok: true, value: { kind: 'one_time', runAt, timezone: 'local' } };
  }
  return { ok: false, error: 'Unknown automation trigger kind.' };
}

function validateModelConfig(
  value: unknown,
): PartResult<SharedAutomationModelConfig | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  const config = asRecord(value);
  if (!config) {
    return { ok: false, error: 'Automation modelConfig must be an object.' };
  }
  const unexpected = unexpectedFieldError(
    config,
    ['model', 'thinkingLevel', 'speed', 'fastMode'],
    'the automation modelConfig',
  );
  if (unexpected) {
    return { ok: false, error: unexpected };
  }
  const result: SharedAutomationModelConfig = {};
  if (config.model !== undefined) {
    if (typeof config.model !== 'string' || config.model.trim().length === 0) {
      return {
        ok: false,
        error: 'Automation model must be a non-empty string.',
      };
    }
    if (config.model.startsWith(AGENT_MODEL_ID_PREFIX)) {
      return {
        ok: false,
        error:
          'Automation model must be a provider model, not a local custom Agent.',
      };
    }
    result.model = config.model;
  }
  if (config.thinkingLevel !== undefined) {
    const level = SHARED_AUTOMATION_THINKING_LEVELS.find(
      (candidate) => candidate === config.thinkingLevel,
    );
    if (!level) {
      return {
        ok: false,
        error: 'Automation thinkingLevel is not a recognized level.',
      };
    }
    result.thinkingLevel = level;
  }
  if (config.fastMode !== undefined) {
    if (typeof config.fastMode !== 'boolean') {
      return { ok: false, error: 'Automation fastMode must be a boolean.' };
    }
    result.fastMode = config.fastMode;
  }
  if (config.speed !== undefined) {
    if (!isCodexSpeed(config.speed)) {
      return {
        ok: false,
        error: 'Automation speed must be standard, fast, or ultrafast.',
      };
    }
    const derivedFastMode = config.speed === 'fast';
    if (result.fastMode !== undefined && result.fastMode !== derivedFastMode) {
      return {
        ok: false,
        error: 'Automation fastMode must match its speed.',
      };
    }
    result.speed = config.speed;
    result.fastMode = derivedFastMode;
  }
  return { ok: true, value: result };
}

function validateWorkspaceTarget(
  value: unknown,
): PartResult<SharedAutomationWorkspaceTarget> {
  const target = asRecord(value);
  if (!target || target.kind !== 'workspace') {
    return {
      ok: false,
      error: 'Automation action target must be { kind: "workspace" }.',
    };
  }
  const unexpected = unexpectedFieldError(
    target,
    ['kind'],
    'the automation action target',
  );
  if (unexpected) {
    return { ok: false, error: unexpected };
  }
  return { ok: true, value: { kind: 'workspace' } };
}

function validatePipelineTarget(
  value: unknown,
  version: SharedAutomationDocument['version'],
): PartResult<SharedAutomationPipelineTarget> {
  const target = asRecord(value);
  if (target?.kind === 'workspace') {
    return validateWorkspaceTarget(value);
  }
  if (
    !target ||
    version < SHARED_AUTOMATION_PIPELINE_TARGET_API_VERSION ||
    !isAutomationPipelineTargetKind(target.kind)
  ) {
    return {
      ok: false,
      error:
        version < SHARED_AUTOMATION_PIPELINE_TARGET_API_VERSION
          ? 'Automation action target must be { kind: "workspace" }.'
          : 'Automation pipeline target kind must be workspace, global, new_worktree, task, or project.',
    };
  }
  const unexpected = unexpectedFieldError(
    target,
    ['kind'],
    'the automation action target',
  );
  if (unexpected) {
    return { ok: false, error: unexpected };
  }
  return { ok: true, value: { kind: target.kind } };
}

function validateCoworkTarget(
  value: unknown,
): PartResult<SharedAutomationCoworkTarget> {
  const target = asRecord(value);
  if (!target || target.kind !== 'cowork') {
    return {
      ok: false,
      error: 'Automation action target must be { kind: "cowork" }.',
    };
  }
  const unexpected = unexpectedFieldError(
    target,
    ['kind'],
    'the automation action target',
  );
  if (unexpected) {
    return { ok: false, error: unexpected };
  }
  return { ok: true, value: { kind: 'cowork' } };
}

function validatePrompt(value: unknown): PartResult<string> {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, error: 'Automation prompt is required.' };
  }
  if (utf8ByteLength(value) > MAX_SHARED_AUTOMATION_PROMPT_BYTES) {
    return {
      ok: false,
      error: `Automation prompt exceeds ${MAX_SHARED_AUTOMATION_PROMPT_BYTES} bytes.`,
    };
  }
  return { ok: true, value };
}

function validatePlugins(value: unknown): PartResult<ShareablePluginRef[]> {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      error: 'Automation plugins must all be shareable plugin refs.',
    };
  }
  // Rebuild every ref through normalization so unknown fields on a
  // structurally valid ref (tokens, local paths, machine ids) are stripped
  // instead of riding along into the stored document.
  const rawRefs: unknown[] = value;
  const plugins: ShareablePluginRef[] = [];
  for (const ref of rawRefs) {
    try {
      plugins.push(normalizeShareablePluginRef(ref));
    } catch {
      return {
        ok: false,
        error: 'Automation plugins must all be shareable plugin refs.',
      };
    }
  }
  return { ok: true, value: plugins };
}

/** Document facts a nested validator needs before the document is rebuilt. */
interface SharedAutomationValidationContext {
  version: SharedAutomationDocument['version'];
  hasCapabilityPackage: boolean;
}

function validatePipelineRef(
  value: unknown,
  context: SharedAutomationValidationContext,
): PartResult<SharedAutomationPipelineRef> {
  const ref = asRecord(value);
  if (!ref) {
    return { ok: false, error: 'Automation pipeline ref must be an object.' };
  }
  if (ref.source === 'user' || ref.source === 'project') {
    return {
      ok: false,
      error:
        'A local pipeline must travel inside the shared automation, as an inline or packaged pipeline, not as a local reference.',
    };
  }
  if (ref.name !== undefined && typeof ref.name !== 'string') {
    return { ok: false, error: 'Automation pipeline name must be a string.' };
  }
  if (ref.source === 'packaged') {
    if (context.version < SHARED_AUTOMATION_PIPELINE_DEPENDENCIES_API_VERSION) {
      return {
        ok: false,
        error: `Automation packaged pipeline refs require version ${SHARED_AUTOMATION_PIPELINE_DEPENDENCIES_API_VERSION}.`,
      };
    }
    if (!context.hasCapabilityPackage) {
      return {
        ok: false,
        error:
          'Automation packaged pipeline refs require the document to carry a capability package.',
      };
    }
    const unexpected = unexpectedFieldError(
      ref,
      ['source', 'key', 'pipelineContentHash', 'name'],
      'the automation pipeline ref',
    );
    if (unexpected) {
      return { ok: false, error: unexpected };
    }
    if (!isPipelinePackageIdentifier(ref.key)) {
      return {
        ok: false,
        error: 'Automation packaged pipeline ref has an invalid key.',
      };
    }
    if (!isPipelineContentHash(ref.pipelineContentHash)) {
      return {
        ok: false,
        error: 'Automation packaged pipeline ref has an invalid content hash.',
      };
    }
    const value_: SharedAutomationPipelineRef = {
      source: 'packaged',
      key: ref.key,
      pipelineContentHash: ref.pipelineContentHash,
    };
    if (typeof ref.name === 'string') {
      value_.name = ref.name;
    }
    return { ok: true, value: value_ };
  }
  if (ref.source === 'bundled') {
    const unexpected = unexpectedFieldError(
      ref,
      ['source', 'pipelineId', 'name'],
      'the automation pipeline ref',
    );
    if (unexpected) {
      return { ok: false, error: unexpected };
    }
    if (typeof ref.pipelineId !== 'string' || ref.pipelineId.length === 0) {
      return {
        ok: false,
        error: 'Automation bundled pipeline ref requires a pipelineId.',
      };
    }
    const value_: SharedAutomationPipelineRef = {
      source: 'bundled',
      pipelineId: ref.pipelineId,
    };
    if (typeof ref.name === 'string') {
      value_.name = ref.name;
    }
    return { ok: true, value: value_ };
  }
  if (ref.source === 'inline') {
    const unexpected = unexpectedFieldError(
      ref,
      ['source', 'name', 'rawPipeline', 'pipelineContentHash', 'origin'],
      'the automation pipeline ref',
    );
    if (unexpected) {
      return { ok: false, error: unexpected };
    }
    if (
      typeof ref.rawPipeline !== 'string' ||
      ref.rawPipeline.trim().length === 0
    ) {
      return {
        ok: false,
        error: 'Automation inline pipeline ref requires a raw pipeline.',
      };
    }
    if (utf8ByteLength(ref.rawPipeline) > PIPELINE_PACKAGE_MAX_FILE_BYTES) {
      return {
        ok: false,
        error: `Automation inline pipeline exceeds ${PIPELINE_PACKAGE_MAX_FILE_BYTES} bytes.`,
      };
    }
    if (!isPipelineContentHash(ref.pipelineContentHash)) {
      return {
        ok: false,
        error: 'Automation inline pipeline ref has an invalid content hash.',
      };
    }
    const value_: SharedAutomationPipelineRef = {
      source: 'inline',
      rawPipeline: ref.rawPipeline,
      pipelineContentHash: ref.pipelineContentHash,
    };
    if (typeof ref.name === 'string') {
      value_.name = ref.name;
    }
    if (ref.origin !== undefined) {
      const origin = asRecord(ref.origin);
      if (!origin) {
        return {
          ok: false,
          error: 'Automation inline pipeline origin must be an object.',
        };
      }
      const originUnexpected = unexpectedFieldError(
        origin,
        ['remoteId', 'installPin'],
        'the automation inline pipeline origin',
      );
      if (originUnexpected) {
        return { ok: false, error: originUnexpected };
      }
      if (typeof origin.remoteId !== 'string' || origin.remoteId.length === 0) {
        return {
          ok: false,
          error: 'Automation inline pipeline origin requires a remoteId.',
        };
      }
      const installPin = validatePipelineInstallPin(origin.installPin);
      if (!installPin.ok) {
        return installPin;
      }
      value_.origin = {
        remoteId: origin.remoteId,
        installPin: installPin.value,
      };
    }
    return { ok: true, value: value_ };
  }
  if (ref.source === 'shared') {
    const unexpected = unexpectedFieldError(
      ref,
      ['source', 'remoteId', 'name', 'contentHash', 'installPin'],
      'the automation pipeline ref',
    );
    if (unexpected) {
      return { ok: false, error: unexpected };
    }
    if (typeof ref.remoteId !== 'string' || ref.remoteId.length === 0) {
      return {
        ok: false,
        error: 'Automation shared pipeline ref requires a remoteId.',
      };
    }
    if (
      ref.contentHash !== undefined &&
      (typeof ref.contentHash !== 'string' || ref.contentHash.length === 0)
    ) {
      return {
        ok: false,
        error: 'Automation shared pipeline ref has an invalid content hash.',
      };
    }
    const value_: SharedAutomationPipelineRef = {
      source: 'shared',
      remoteId: ref.remoteId,
    };
    if (typeof ref.name === 'string') {
      value_.name = ref.name;
    }
    if (typeof ref.contentHash === 'string') {
      value_.contentHash = ref.contentHash;
    }
    if (ref.installPin !== undefined) {
      const installPin = validatePipelineInstallPin(ref.installPin);
      if (!installPin.ok) {
        return installPin;
      }
      value_.installPin = installPin.value;
    }
    return { ok: true, value: value_ };
  }
  if (ref.source === 'curated') {
    const unexpected = unexpectedFieldError(
      ref,
      ['source', 'curatedKey', 'name'],
      'the automation pipeline ref',
    );
    if (unexpected) {
      return { ok: false, error: unexpected };
    }
    if (
      typeof ref.curatedKey !== 'string' ||
      ref.curatedKey.trim().length === 0
    ) {
      return {
        ok: false,
        error: 'Automation curated pipeline ref requires a curatedKey.',
      };
    }
    const value_: SharedAutomationPipelineRef = {
      source: 'curated',
      curatedKey: ref.curatedKey,
    };
    if (typeof ref.name === 'string') {
      value_.name = ref.name;
    }
    return { ok: true, value: value_ };
  }
  if (ref.source === 'unresolved') {
    const unexpected = unexpectedFieldError(
      ref,
      ['source', 'name'],
      'the automation pipeline ref',
    );
    if (unexpected) {
      return { ok: false, error: unexpected };
    }
    const value_: SharedAutomationPipelineRef = { source: 'unresolved' };
    if (typeof ref.name === 'string') {
      value_.name = ref.name;
    }
    return { ok: true, value: value_ };
  }
  return { ok: false, error: 'Unknown automation pipeline ref source.' };
}

/**
 * Semantic check of `pipelineDependencies` prompt spans against the canonical
 * prompt ({@link canonicalizeSharedAutomationPrompt}). Every span must lie
 * inside the prompt, match its slice exactly, and not overlap any other span
 * of any dependency; only `packaged` dependencies carry spans. Readers that
 * re-canonicalize a document run this again after canonicalizing the prompt
 * and reject on a mismatch rather than shifting offsets.
 */
export function sharedAutomationPromptSpansError(
  canonicalPrompt: string,
  dependencies: readonly SharedAutomationPipelineDependency[],
): string | null {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const dependency of dependencies) {
    if (
      dependency.pipeline.source !== 'packaged' &&
      dependency.promptSpans.length > 0
    ) {
      return 'Only packaged automation pipeline dependencies may carry prompt spans.';
    }
    for (const span of dependency.promptSpans) {
      const end = span.textStart + span.text.length;
      if (
        !Number.isSafeInteger(span.textStart) ||
        span.textStart < 0 ||
        span.text.length === 0 ||
        end > canonicalPrompt.length
      ) {
        return 'Automation pipeline dependency prompt span is outside the prompt.';
      }
      if (canonicalPrompt.slice(span.textStart, end) !== span.text) {
        return 'Automation pipeline dependency prompt span text does not match the prompt.';
      }
      ranges.push({ start: span.textStart, end });
    }
  }
  ranges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index++) {
    if (ranges[index].start < ranges[index - 1].end) {
      return 'Automation pipeline dependency prompt spans must not overlap.';
    }
  }
  return null;
}

function validatePromptSpans(
  value: unknown,
): PartResult<SharedAutomationPromptSpan[]> {
  const invalid: PartResult<SharedAutomationPromptSpan[]> = {
    ok: false,
    error:
      'Automation pipeline dependency promptSpans must be { textStart, text } objects.',
  };
  if (!Array.isArray(value)) {
    return invalid;
  }
  const rawSpans: unknown[] = value;
  const spans: SharedAutomationPromptSpan[] = [];
  for (const rawSpan of rawSpans) {
    const span = asRecord(rawSpan);
    if (!span) {
      return invalid;
    }
    const unexpected = unexpectedFieldError(
      span,
      ['textStart', 'text'],
      'the automation pipeline dependency prompt span',
    );
    if (unexpected) {
      return { ok: false, error: unexpected };
    }
    if (typeof span.textStart !== 'number' || typeof span.text !== 'string') {
      return invalid;
    }
    spans.push({ textStart: span.textStart, text: span.text });
  }
  return { ok: true, value: spans };
}

function validatePipelineDependencies(
  value: unknown,
  prompt: string,
  context: SharedAutomationValidationContext,
): PartResult<SharedAutomationPipelineDependency[]> {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      error: 'Automation pipelineDependencies must be an array.',
    };
  }
  const rawDependencies: unknown[] = value;
  const dependencies: SharedAutomationPipelineDependency[] = [];
  const keys = new Set<string>();
  for (const rawDependency of rawDependencies) {
    const dependency = asRecord(rawDependency);
    if (!dependency) {
      return {
        ok: false,
        error: 'Automation pipeline dependency must be an object.',
      };
    }
    const unexpected = unexpectedFieldError(
      dependency,
      ['key', 'pipeline', 'promptSpans'],
      'the automation pipeline dependency',
    );
    if (unexpected) {
      return { ok: false, error: unexpected };
    }
    if (
      !isPipelinePackageIdentifier(dependency.key) ||
      dependency.key === SHARED_AUTOMATION_ACTION_PIPELINE_KEY
    ) {
      return {
        ok: false,
        error: 'Automation pipeline dependency has an invalid key.',
      };
    }
    if (keys.has(dependency.key)) {
      return {
        ok: false,
        error: `Duplicate automation pipeline dependency key: ${dependency.key}.`,
      };
    }
    keys.add(dependency.key);
    const pipeline = validatePipelineRef(dependency.pipeline, context);
    if (!pipeline.ok) {
      return pipeline;
    }
    if (pipeline.value.source === 'packaged') {
      if (pipeline.value.key !== dependency.key) {
        return {
          ok: false,
          error:
            'Automation packaged pipeline dependency key must equal its pipeline key.',
        };
      }
    } else if (
      pipeline.value.source !== 'bundled' &&
      pipeline.value.source !== 'curated' &&
      pipeline.value.source !== 'shared'
    ) {
      return {
        ok: false,
        error:
          'Automation pipeline dependencies must be packaged, bundled, curated, or shared pipelines.',
      };
    }
    const promptSpans = validatePromptSpans(dependency.promptSpans);
    if (!promptSpans.ok) {
      return promptSpans;
    }
    dependencies.push({
      key: dependency.key,
      pipeline: pipeline.value,
      promptSpans: promptSpans.value,
    });
  }
  const spansError = sharedAutomationPromptSpansError(
    canonicalizeSharedAutomationPrompt(prompt),
    dependencies,
  );
  if (spansError) {
    return { ok: false, error: spansError };
  }
  return { ok: true, value: dependencies };
}

function validatePipelineInstallPin(
  value: unknown,
): PartResult<PipelineShareInstallPin> {
  const pin = asRecord(value);
  if (!pin) {
    return {
      ok: false,
      error: 'Automation shared pipeline ref requires an install pin.',
    };
  }
  const unexpected = unexpectedFieldError(
    pin,
    ['pipelineContentHash', 'distributionMode', 'packageDigest'],
    'the automation pipeline install pin',
  );
  if (unexpected) {
    return { ok: false, error: unexpected };
  }
  if (!isPipelineContentHash(pin.pipelineContentHash)) {
    return {
      ok: false,
      error:
        'Automation shared pipeline install pin has an invalid content hash.',
    };
  }
  if (
    pin.distributionMode !== 'package' &&
    pin.distributionMode !== 'definition_only'
  ) {
    return {
      ok: false,
      error:
        'Automation shared pipeline install pin has an invalid distribution mode.',
    };
  }
  if (
    (pin.distributionMode === 'package' &&
      !isPipelinePackageDigest(pin.packageDigest)) ||
    (pin.distributionMode === 'definition_only' &&
      pin.packageDigest !== undefined)
  ) {
    return {
      ok: false,
      error:
        'Automation shared pipeline install pin has an invalid package digest.',
    };
  }
  const result: PipelineShareInstallPin = {
    pipelineContentHash: pin.pipelineContentHash,
    distributionMode: pin.distributionMode,
  };
  if (typeof pin.packageDigest === 'string') {
    result.packageDigest = pin.packageDigest;
  }
  return { ok: true, value: result };
}

function validateCapabilityPackageRef(
  value: unknown,
): PartResult<PipelinePackageRef | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  const ref = asRecord(value);
  if (!ref) {
    return {
      ok: false,
      error: 'Automation capability package ref must be an object.',
    };
  }
  const unexpected = unexpectedFieldError(
    ref,
    ['version', 'digest'],
    'the automation capability package ref',
  );
  if (unexpected) {
    return { ok: false, error: unexpected };
  }
  if (ref.version !== 1 || !isPipelinePackageDigest(ref.digest)) {
    return {
      ok: false,
      error: 'Automation capability package ref is invalid.',
    };
  }
  return { ok: true, value: { version: 1, digest: ref.digest } };
}

// Characters that render invisibly, reorder text, or draw as a line break the
// shell doesn't see, so the command a recipient reviews could differ from the
// one that runs: C0/C1 controls other than tab and CRLF/LF line breaks, a
// bare CR, DEL, the soft hyphen and other default-ignorable or filler
// characters, bidi marks, overrides and isolates, line and paragraph
// separators, invisible operators, variation selectors, and tag characters.
const HIDDEN_RUN_CONDITION_CHARACTERS =
  // eslint-disable-next-line no-control-regex, no-misleading-character-class -- matching these is the point
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u2028-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB]|\uDB40[\uDC00-\uDC7F\uDD00-\uDDEF]|\r(?!\n)/;

/**
 * Whether a run-condition command contains characters v4 validation rejects,
 * so a share dialog can keep it private instead of failing to build.
 */
export function sharedRunConditionHasHiddenCharacters(
  command: string,
): boolean {
  return HIDDEN_RUN_CONDITION_CHARACTERS.test(command);
}

function validateRunCondition(
  value: unknown,
  hasRunCondition: boolean,
): PartResult<SharedAutomationRunCondition> {
  const record = asRecord(value);
  if (!record) {
    return { ok: false, error: 'Automation runCondition must be an object.' };
  }
  const unexpected = unexpectedFieldError(
    record,
    ['command'],
    'the run condition',
  );
  if (unexpected) {
    return { ok: false, error: unexpected };
  }
  if (typeof record.command !== 'string' || !record.command.trim()) {
    return {
      ok: false,
      error: 'Automation runCondition command must be a nonempty string.',
    };
  }
  if (record.command.length > MAX_SHARED_AUTOMATION_RUN_CONDITION_CHARS) {
    return {
      ok: false,
      error: `Automation runCondition command exceeds ${MAX_SHARED_AUTOMATION_RUN_CONDITION_CHARS} characters.`,
    };
  }
  if (HIDDEN_RUN_CONDITION_CHARACTERS.test(record.command)) {
    return {
      ok: false,
      error:
        'Automation runCondition command contains invisible or control characters.',
    };
  }
  if (!hasRunCondition) {
    return {
      ok: false,
      error: 'Automation runCondition requires hasRunCondition to be true.',
    };
  }
  return { ok: true, value: { command: record.command } };
}

function validateOptionalPipelineDependencies(
  value: unknown,
  prompt: string,
  context: SharedAutomationValidationContext,
): PartResult<SharedAutomationPipelineDependency[] | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  return validatePipelineDependencies(value, prompt, context);
}

function validateAction(
  value: unknown,
  context: SharedAutomationValidationContext,
): PartResult<SharedAutomationAction> {
  const { version } = context;
  const promptActionVersionedKeys = [
    ...(version >= SHARED_AUTOMATION_REFERENCES_API_VERSION
      ? ['promptReferences']
      : []),
    ...(version >= SHARED_AUTOMATION_PIPELINE_DEPENDENCIES_API_VERSION
      ? ['pipelineDependencies']
      : []),
  ];
  const action = asRecord(value);
  if (!action || typeof action.type !== 'string') {
    return { ok: false, error: 'Automation action must be an object.' };
  }
  // Own-property check: a bare index would walk the prototype chain, so an
  // untrusted type like "toString" would yield a non-string "error".
  if (
    Object.prototype.hasOwnProperty.call(
      BLOCKED_AUTOMATION_ACTION_TYPES,
      action.type,
    )
  ) {
    return { ok: false, error: BLOCKED_AUTOMATION_ACTION_TYPES[action.type] };
  }
  if (action.type === 'app_advisor_prompt') {
    const unexpected = unexpectedFieldError(
      action,
      [
        'type',
        'prompt',
        'modelConfig',
        'plugins',
        ...promptActionVersionedKeys,
      ],
      'the automation action',
    );
    if (unexpected) {
      return { ok: false, error: unexpected };
    }
    const prompt = validatePrompt(action.prompt);
    if (!prompt.ok) {
      return prompt;
    }
    const modelConfig = validateModelConfig(action.modelConfig);
    if (!modelConfig.ok) {
      return modelConfig;
    }
    const plugins = validatePlugins(action.plugins);
    if (!plugins.ok) {
      return plugins;
    }
    const result: SharedAutomationAction = {
      type: 'app_advisor_prompt',
      prompt: prompt.value,
      plugins: plugins.value,
    };
    if (action.promptReferences !== undefined) {
      const references = validateSharedPromptReferences(
        prompt.value,
        action.promptReferences,
        plugins.value,
      );
      if (!references.ok) return references;
      result.promptReferences = references.value;
    }
    const pipelineDependencies = validateOptionalPipelineDependencies(
      action.pipelineDependencies,
      prompt.value,
      context,
    );
    if (!pipelineDependencies.ok) return pipelineDependencies;
    if (pipelineDependencies.value !== undefined) {
      result.pipelineDependencies = pipelineDependencies.value;
    }
    if (modelConfig.value !== undefined) {
      result.modelConfig = modelConfig.value;
    }
    return { ok: true, value: result };
  }
  if (action.type === 'standalone_prompt') {
    const unexpected = unexpectedFieldError(
      action,
      [
        'type',
        'target',
        'prompt',
        'modelConfig',
        'plugins',
        ...promptActionVersionedKeys,
      ],
      'the automation action',
    );
    if (unexpected) {
      return { ok: false, error: unexpected };
    }
    const target = validateCoworkTarget(action.target);
    if (!target.ok) {
      return target;
    }
    const prompt = validatePrompt(action.prompt);
    if (!prompt.ok) {
      return prompt;
    }
    const modelConfig = validateModelConfig(action.modelConfig);
    if (!modelConfig.ok) {
      return modelConfig;
    }
    const plugins = validatePlugins(action.plugins);
    if (!plugins.ok) {
      return plugins;
    }
    const result: SharedAutomationAction = {
      type: 'standalone_prompt',
      target: target.value,
      prompt: prompt.value,
      plugins: plugins.value,
    };
    if (action.promptReferences !== undefined) {
      const references = validateSharedPromptReferences(
        prompt.value,
        action.promptReferences,
        plugins.value,
      );
      if (!references.ok) return references;
      result.promptReferences = references.value;
    }
    const pipelineDependencies = validateOptionalPipelineDependencies(
      action.pipelineDependencies,
      prompt.value,
      context,
    );
    if (!pipelineDependencies.ok) return pipelineDependencies;
    if (pipelineDependencies.value !== undefined) {
      result.pipelineDependencies = pipelineDependencies.value;
    }
    if (modelConfig.value !== undefined) {
      result.modelConfig = modelConfig.value;
    }
    return { ok: true, value: result };
  }
  if (action.type === 'worktree_prompt') {
    const unexpected = unexpectedFieldError(
      action,
      [
        'type',
        'target',
        'existingBranch',
        'prompt',
        'modelConfig',
        'plugins',
        'planMode',
        'interfaceMode',
        ...promptActionVersionedKeys,
      ],
      'the automation action',
    );
    if (unexpected) {
      return { ok: false, error: unexpected };
    }
    const target = validateWorkspaceTarget(action.target);
    if (!target.ok) {
      return target;
    }
    if (
      action.existingBranch !== undefined &&
      (typeof action.existingBranch !== 'string' ||
        action.existingBranch.trim().length === 0)
    ) {
      return {
        ok: false,
        error: 'Automation existingBranch must be a non-empty string.',
      };
    }
    const prompt = validatePrompt(action.prompt);
    if (!prompt.ok) {
      return prompt;
    }
    const modelConfig = validateModelConfig(action.modelConfig);
    if (!modelConfig.ok) {
      return modelConfig;
    }
    const plugins = validatePlugins(action.plugins);
    if (!plugins.ok) {
      return plugins;
    }
    if (action.planMode !== undefined && typeof action.planMode !== 'boolean') {
      return { ok: false, error: 'Automation planMode must be a boolean.' };
    }
    let interfaceMode: SharedAutomationInterfaceMode | undefined;
    if (action.interfaceMode !== undefined) {
      interfaceMode = SHARED_AUTOMATION_INTERFACE_MODES.find(
        (candidate) => candidate === action.interfaceMode,
      );
      if (!interfaceMode) {
        return {
          ok: false,
          error: 'Automation interfaceMode is not a recognized mode.',
        };
      }
    }
    const result: SharedAutomationAction = {
      type: 'worktree_prompt',
      target: target.value,
      prompt: prompt.value,
      plugins: plugins.value,
    };
    if (action.promptReferences !== undefined) {
      const references = validateSharedPromptReferences(
        prompt.value,
        action.promptReferences,
        plugins.value,
      );
      if (!references.ok) return references;
      result.promptReferences = references.value;
    }
    const pipelineDependencies = validateOptionalPipelineDependencies(
      action.pipelineDependencies,
      prompt.value,
      context,
    );
    if (!pipelineDependencies.ok) return pipelineDependencies;
    if (pipelineDependencies.value !== undefined) {
      result.pipelineDependencies = pipelineDependencies.value;
    }
    if (typeof action.existingBranch === 'string') {
      result.existingBranch = action.existingBranch;
    }
    if (modelConfig.value !== undefined) {
      result.modelConfig = modelConfig.value;
    }
    if (typeof action.planMode === 'boolean') {
      result.planMode = action.planMode;
    }
    if (interfaceMode !== undefined) {
      result.interfaceMode = interfaceMode;
    }
    return { ok: true, value: result };
  }
  if (action.type === 'worktree_pipeline') {
    const unexpected = unexpectedFieldError(
      action,
      ['type', 'target', 'pipeline', 'inputKeys'],
      'the automation action',
    );
    if (unexpected) {
      return { ok: false, error: unexpected };
    }
    const target = validatePipelineTarget(action.target, version);
    if (!target.ok) {
      return target;
    }
    const pipeline = validatePipelineRef(action.pipeline, context);
    if (!pipeline.ok) {
      return pipeline;
    }
    if (
      pipeline.value.source === 'packaged' &&
      pipeline.value.key !== SHARED_AUTOMATION_ACTION_PIPELINE_KEY
    ) {
      return {
        ok: false,
        error: `Automation packaged action pipeline must use the key "${SHARED_AUTOMATION_ACTION_PIPELINE_KEY}".`,
      };
    }
    if (!Array.isArray(action.inputKeys)) {
      return {
        ok: false,
        error: 'Automation inputKeys must be non-empty strings.',
      };
    }
    const rawInputKeys: unknown[] = action.inputKeys;
    const inputKeys: string[] = [];
    for (const key of rawInputKeys) {
      if (typeof key !== 'string' || key.length === 0) {
        return {
          ok: false,
          error: 'Automation inputKeys must be non-empty strings.',
        };
      }
      inputKeys.push(key);
    }
    return {
      ok: true,
      value: {
        type: 'worktree_pipeline',
        target: target.value,
        pipeline: pipeline.value,
        inputKeys: Array.from(new Set(inputKeys)).sort(),
      },
    };
  }
  return { ok: false, error: 'Unknown automation action type.' };
}

/**
 * Validate an untrusted value as a {@link SharedAutomationDocument}. Returns
 * a discriminated result rather than throwing so route handlers and the share
 * / install flows can surface an actionable error message. The returned
 * document is rebuilt field-by-field: unknown fields are rejected, and
 * `inputKeys` come back sorted and deduplicated.
 */
export function validateSharedAutomationDocument(
  value: unknown,
): SharedAutomationValidationResult {
  const doc = asRecord(value);
  if (!doc) {
    return { ok: false, error: 'Automation document must be an object.' };
  }
  if (
    doc.version !== SHARED_AUTOMATION_API_VERSION &&
    doc.version !== SHARED_AUTOMATION_REFERENCES_API_VERSION &&
    doc.version !== SHARED_AUTOMATION_TARGET_REQUIREMENT_API_VERSION &&
    doc.version !== SHARED_AUTOMATION_RUN_CONDITION_API_VERSION &&
    doc.version !== SHARED_AUTOMATION_PIPELINE_DEPENDENCIES_API_VERSION &&
    doc.version !== SHARED_AUTOMATION_PIPELINE_TARGET_API_VERSION
  ) {
    return {
      ok: false,
      error: `Unsupported shared Automation version; expected ${SHARED_AUTOMATION_API_VERSION} through ${SHARED_AUTOMATION_PIPELINE_TARGET_API_VERSION}.`,
    };
  }
  const unexpected = unexpectedFieldError(
    doc,
    [
      'version',
      'name',
      'description',
      'trigger',
      'action',
      'capabilityPackage',
      'hasRunCondition',
      ...(doc.version >= SHARED_AUTOMATION_TARGET_REQUIREMENT_API_VERSION
        ? ['targetRequirement']
        : []),
      ...(doc.version >= SHARED_AUTOMATION_RUN_CONDITION_API_VERSION
        ? ['runCondition']
        : []),
    ],
    'the automation document',
  );
  if (unexpected) {
    return { ok: false, error: unexpected };
  }
  if (typeof doc.name !== 'string' || doc.name.trim().length === 0) {
    return { ok: false, error: 'Automation name is required.' };
  }
  if (doc.name.length > MAX_SHARED_AUTOMATION_NAME_LENGTH) {
    return {
      ok: false,
      error: `Automation name exceeds ${MAX_SHARED_AUTOMATION_NAME_LENGTH} characters.`,
    };
  }
  if (typeof doc.description !== 'string') {
    return { ok: false, error: 'Automation description must be a string.' };
  }
  if (
    utf8ByteLength(doc.description) > MAX_SHARED_AUTOMATION_DESCRIPTION_BYTES
  ) {
    return {
      ok: false,
      error: `Automation description exceeds ${MAX_SHARED_AUTOMATION_DESCRIPTION_BYTES} bytes.`,
    };
  }
  const trigger = validateTrigger(doc.trigger);
  if (!trigger.ok) {
    return trigger;
  }
  const action = validateAction(doc.action, {
    version: doc.version,
    hasCapabilityPackage: doc.capabilityPackage !== undefined,
  });
  if (!action.ok) {
    return action;
  }
  const targetRequirement =
    doc.targetRequirement === undefined
      ? undefined
      : validateSharedAutomationTargetRequirement(
          doc.targetRequirement,
          action.value.type,
        );
  if (targetRequirement && !targetRequirement.ok) return targetRequirement;
  if (
    targetRequirement &&
    action.value.type === 'worktree_pipeline' &&
    action.value.target.kind === 'global'
  ) {
    return {
      ok: false,
      error:
        'A pipeline automation with no project cannot declare targetRequirement.',
    };
  }
  const capabilityPackage = validateCapabilityPackageRef(doc.capabilityPackage);
  if (!capabilityPackage.ok) {
    return capabilityPackage;
  }
  if (typeof doc.hasRunCondition !== 'boolean') {
    return {
      ok: false,
      error: 'Automation hasRunCondition must be a boolean.',
    };
  }
  const runCondition =
    doc.runCondition === undefined
      ? undefined
      : validateRunCondition(doc.runCondition, doc.hasRunCondition);
  if (runCondition && !runCondition.ok) return runCondition;

  const document: SharedAutomationDocument = {
    version: doc.version,
    name: doc.name,
    description: doc.description,
    trigger: trigger.value,
    action: action.value,
    hasRunCondition: doc.hasRunCondition,
    ...(targetRequirement?.ok
      ? { targetRequirement: targetRequirement.requirement }
      : {}),
    ...(runCondition?.ok ? { runCondition: runCondition.value } : {}),
  };
  if (capabilityPackage.value !== undefined) {
    document.capabilityPackage = capabilityPackage.value;
  }

  if (serializedByteLength(document) > MAX_SHARED_AUTOMATION_BYTES) {
    return {
      ok: false,
      error: `Shared Automation document exceeds ${MAX_SHARED_AUTOMATION_BYTES} bytes.`,
    };
  }

  return { ok: true, document };
}

/** Non-throwing type guard for {@link SharedAutomationDocument}. */
export function isSharedAutomationDocument(
  value: unknown,
): value is SharedAutomationDocument {
  return validateSharedAutomationDocument(value).ok;
}
