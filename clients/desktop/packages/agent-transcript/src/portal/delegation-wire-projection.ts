import {
  isAgentDelegationCardData,
  isAgentDelegationPhase,
  isAgentDelegationQueueState,
  isDelegationCapabilitySummary,
} from '@canopy/protocol/delegation';
import { isThinkingLevel } from '@canopy/protocol/thinking';
import {
  sanitizeStorableJson,
  sanitizeStorableString,
  type PortalChatPart,
  type PortalChatToolFamily,
} from '@canopy/protocol/portal';

/** Maximum serialized UTF-8 bytes for one managed delegation Portal part. */
export const PORTAL_DELEGATION_PART_MAX_BYTES = 24 * 1024;

/** Target and hard ceiling for the whitelisted delegation snapshot/card data. */
export const PORTAL_DELEGATION_SNAPSHOT_MAX_BYTES = 12 * 1024;

/** Hard ceiling for serialized child parts, including the array delimiters. */
export const PORTAL_DELEGATION_SUB_BLOCKS_MAX_BYTES = 10 * 1024;

/** Maximum number of most-recent child Portal parts retained on one card. */
export const PORTAL_DELEGATION_SUB_BLOCKS_MAX_COUNT = 24;

/** Maximum generic string leaf length, matching the Portal outbox compactor. */
export const PORTAL_DELEGATION_CHILD_TEXT_MAX_CHARS = 4_000;

/** Original Portal outbox limits applied to generic child tool data. */
export const PORTAL_DELEGATION_CHILD_JSON_MAX_DEPTH = 3;
export const PORTAL_DELEGATION_CHILD_JSON_MAX_KEYS = 24;
export const PORTAL_DELEGATION_CHILD_JSON_MAX_ARRAY_ITEMS = 24;

const CARD_TEXT_MAX_CHARS = 2_000;
const SNAPSHOT_TEXT_MAX_CHARS = 1_000;
const SNAPSHOT_COLLECTION_MAX_ITEMS = 8;
const SNAPSHOT_COLLECTION_TEXT_MAX_CHARS = 128;
const CAPABILITY_SUMMARY_MAX_ITEMS = 8;
const APPLY_ISSUE_MAX_ITEMS = 4;
const ROUTE_ARRAY_MAX_ITEMS = 8;
const NESTED_DELEGATION_DEPTH_LIMIT = 1;

const DELEGATION_STATUSES = [
  'pending',
  'running',
  'interrupted',
  'completed',
  'failed',
  'cancelled',
  'deadline_exceeded',
] as const;
const STOP_REASONS = [
  'parent_cancelled',
  'user_cancelled',
  'deadline_exceeded',
  'shutdown',
  'policy_revoked',
  'stopped_by_parent',
  'ancestor_stopped',
] as const;
const NESTING_STATES = ['enabled', 'not_enabled', 'depth_limit'] as const;
const CONTROL_OPERATIONS = [
  'follow_up',
  'resume',
  'steer',
  'interrupt',
  'apply',
  'discard',
] as const;
const COMMAND_STATUSES = ['accepted', 'completed', 'failed'] as const;
const DELIVERY_KINDS = ['accepted', 'rejected', 'unknown'] as const;
const APPLY_FAILURE_REASONS = [
  'conflict',
  'approval_denied',
  'write_failed',
  'cancelled',
  'interrupted',
  'unavailable',
] as const;
const APPLY_ISSUE_REASONS = [
  'parent_changed',
  'too_large',
  'not_text',
  'not_regular_file',
  'protected_path',
  'outside_write_grant',
  'unreconciled',
  'approval_denied',
  'write_failed',
  'not_restored',
] as const;
const PART_KINDS = [
  'text',
  'tool_use',
  'tool_result',
  'thinking',
  'attachment',
  'image',
  'agent',
  'turn_timer',
  'steering',
  'compaction',
] as const;
const TOOL_FAMILIES = [
  'read',
  'edit',
  'write',
  'plan',
  'bash',
  'grep',
  'glob',
  'todo',
  'web',
  'agent',
  'ask-user',
  'script-output',
  'skill',
  'monitor',
  'claude',
  'watcher',
  'canopy',
  'graph',
  'app-advisor',
  'pipeline-editor',
  'computer-use',
  'unknown',
] as const satisfies readonly PortalChatToolFamily[];
const TRANSCRIPT_STORES = ['chat-log-v1', 'chat-stream-v2'] as const;
const ENUM_FIELDS = new Set([
  'transcriptStore',
  'type',
  'status',
  'executionMode',
  'nestedDelegation',
  'stopReason',
  'phase',
  'operation',
  'waitingFor',
  'requestedThinkingLevel',
  'effectiveThinkingLevel',
  'supportedThinkingLevels',
  'kind',
  'source',
  'fallback',
  'consistency',
  'dirtyParentChangesIncluded',
]);
const LABEL_FIELDS = new Set([
  'id',
  'delegationId',
  'childDelegationIds',
  'agentBlockId',
  'targetHarnessId',
  'parentHarnessId',
  'parentTurnId',
  'parentToolCallId',
  'parentDelegationId',
  'requestedModelId',
  'nativeSessionId',
  'selectedModelId',
  'runtimeModelId',
  'harnessId',
  'selectedModelLabel',
  'runtimeModelLabel',
  'code',
  'operationId',
  'attemptId',
  'providerTurnId',
  'name',
  'childDelegationIds',
  'writePaths',
  'path',
  'routeId',
  'agentDefinitionId',
  'agentDefinitionRevision',
  'agentDefinitionHash',
  'pluginProjectionHash',
  'runtimeKind',
  'runnerRegistrationId',
  'runtimeVersion',
  'adapterVersion',
  'modelSource',
  'providerType',
  'assignmentRevision',
  'billingAuthority',
  'capabilitySnapshotHash',
  'policyRevision',
  'capabilities',
]);

interface ProjectionContext {
  truncated: boolean;
}

interface ProjectedChildren {
  parts: PortalChatPart[];
  omitted: number;
}

const projectedPartCache = new WeakMap<object, PortalChatPart>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isMemberOf<const Values extends readonly string[]>(
  values: Values,
  value: unknown,
): value is Values[number] {
  return (
    typeof value === 'string' && values.some((candidate) => candidate === value)
  );
}

function truncatePortalString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const suffix = `\n\n[truncated ${value.length - maxChars} chars]`;
  let sliceEnd = Math.max(0, maxChars - suffix.length);
  const lastRetainedCodeUnit = value.charCodeAt(sliceEnd - 1);
  const firstDroppedCodeUnit = value.charCodeAt(sliceEnd);
  if (
    lastRetainedCodeUnit >= 0xd800 &&
    lastRetainedCodeUnit <= 0xdbff &&
    firstDroppedCodeUnit >= 0xdc00 &&
    firstDroppedCodeUnit <= 0xdfff
  ) {
    sliceEnd -= 1;
  }
  return `${value.slice(0, sliceEnd)}${suffix}`;
}

function truncateLabel(value: string, maxChars: number): string {
  const sanitized = sanitizeStorableString(value);
  if (sanitized.length <= maxChars) return sanitized;
  let sliceEnd = Math.max(0, maxChars - 1);
  const lastRetainedCodeUnit = sanitized.charCodeAt(sliceEnd - 1);
  const firstDroppedCodeUnit = sanitized.charCodeAt(sliceEnd);
  if (
    lastRetainedCodeUnit >= 0xd800 &&
    lastRetainedCodeUnit <= 0xdbff &&
    firstDroppedCodeUnit >= 0xdc00 &&
    firstDroppedCodeUnit <= 0xdfff
  ) {
    sliceEnd -= 1;
  }
  return `${sanitized.slice(0, sliceEnd)}…`;
}

function summarizePortalJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return truncatePortalString(
      typeof serialized === 'string' ? serialized : String(value),
      PORTAL_DELEGATION_CHILD_TEXT_MAX_CHARS,
    );
  } catch {
    return truncatePortalString(
      String(value),
      PORTAL_DELEGATION_CHILD_TEXT_MAX_CHARS,
    );
  }
}

/** Mirrors the Portal outbox's generic depth-three JSON compaction. */
function compactPortalJson(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return truncatePortalString(value, PORTAL_DELEGATION_CHILD_TEXT_MAX_CHARS);
  }
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (depth >= PORTAL_DELEGATION_CHILD_JSON_MAX_DEPTH) {
    return summarizePortalJson(value);
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, PORTAL_DELEGATION_CHILD_JSON_MAX_ARRAY_ITEMS)
      .map((item) => compactPortalJson(item, depth + 1));
    if (value.length > PORTAL_DELEGATION_CHILD_JSON_MAX_ARRAY_ITEMS) {
      items.push(
        `[truncated ${value.length - PORTAL_DELEGATION_CHILD_JSON_MAX_ARRAY_ITEMS} items]`,
      );
    }
    return items;
  }
  if (isRecord(value)) {
    const compacted: Record<string, unknown> = {};
    const entries = Object.entries(value);
    for (const [key, fieldValue] of entries.slice(
      0,
      PORTAL_DELEGATION_CHILD_JSON_MAX_KEYS,
    )) {
      compacted[key] = compactPortalJson(fieldValue, depth + 1);
    }
    if (entries.length > PORTAL_DELEGATION_CHILD_JSON_MAX_KEYS) {
      compacted._truncatedKeys =
        entries.length - PORTAL_DELEGATION_CHILD_JSON_MAX_KEYS;
    }
    return compacted;
  }
  return summarizePortalJson(value);
}

function serializedBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function copyString(
  source: Record<string, unknown>,
  key: string,
  target: Record<string, unknown>,
  maxChars: number,
  context: ProjectionContext,
): void {
  const value = source[key];
  if (typeof value !== 'string') return;
  const sanitized = sanitizeStorableString(value);
  const projected = truncatePortalString(sanitized, maxChars);
  if (projected.length !== sanitized.length) context.truncated = true;
  target[key] = projected;
}

function copyLabel(
  source: Record<string, unknown>,
  key: string,
  target: Record<string, unknown>,
  maxChars: number,
  context: ProjectionContext,
  required = false,
): boolean {
  const value = source[key];
  if (typeof value !== 'string') return !required;
  const sanitized = sanitizeStorableString(value);
  if (sanitized.length === 0 || /[\0\r\n]/.test(sanitized)) return !required;
  const projected = truncateLabel(sanitized, maxChars);
  if (projected.length !== sanitized.length) context.truncated = true;
  target[key] = projected;
  return true;
}

function copyBoolean(
  source: Record<string, unknown>,
  key: string,
  target: Record<string, unknown>,
): void {
  const value = source[key];
  if (typeof value === 'boolean') target[key] = value;
}

function copySafeCount(
  source: Record<string, unknown>,
  key: string,
  target: Record<string, unknown>,
  minimum = 0,
): void {
  const value = source[key];
  if (isFiniteNonNegativeInteger(value) && value >= minimum) {
    target[key] = value;
  }
}

function boundedStringArray(
  values: unknown,
  maximumItems: number,
  maximumChars: number,
  context: ProjectionContext,
  keepMostRecent: boolean,
): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const strings = values.filter(
    (value): value is string => typeof value === 'string',
  );
  if (strings.length !== values.length) context.truncated = true;
  const selected = keepMostRecent
    ? strings.slice(-maximumItems)
    : strings.slice(0, maximumItems);
  if (selected.length !== strings.length) context.truncated = true;
  return selected.map((value) => {
    const sanitized = sanitizeStorableString(value);
    const projected = truncatePortalString(sanitized, maximumChars);
    if (projected.length !== sanitized.length) context.truncated = true;
    return projected;
  });
}

function isRelativeWritePath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length >= 4_096 ||
    value.startsWith('/') ||
    value.includes('\\')
  ) {
    return false;
  }
  if (value === '.') return true;
  const path = value.replace(/\/+$/, '');
  return path
    .split('/')
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        !/[\\:*?]/.test(segment) &&
        Array.from(segment).every((character) => character.charCodeAt(0) >= 32),
    );
}

function projectPermissions(
  value: unknown,
  context: ProjectionContext,
): Record<string, unknown> | undefined {
  if (!isRecord(value) || !Array.isArray(value.writePaths)) return undefined;
  const validPaths = value.writePaths.filter(isRelativeWritePath);
  if (validPaths.length !== value.writePaths.length) context.truncated = true;
  const paths = validPaths.slice(-SNAPSHOT_COLLECTION_MAX_ITEMS).map((path) => {
    const projected = truncatePortalString(
      sanitizeStorableString(path),
      SNAPSHOT_COLLECTION_TEXT_MAX_CHARS,
    );
    if (projected.length !== path.length) context.truncated = true;
    return projected;
  });
  if (paths.length !== validPaths.length) context.truncated = true;
  return { writePaths: paths };
}

function projectRouteSnapshot(
  value: unknown,
  context: ProjectionContext,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const route: Record<string, unknown> = {};
  for (const key of ['selectedModelId', 'runtimeModelId', 'harnessId']) {
    if (!copyLabel(value, key, route, 512, context, true)) return undefined;
  }
  for (const key of ['selectedModelLabel', 'runtimeModelLabel']) {
    copyLabel(value, key, route, 512, context);
  }
  for (const key of [
    'runtimeKind',
    'runnerRegistrationId',
    'runtimeVersion',
    'adapterVersion',
    'modelSource',
    'providerType',
    'assignmentRevision',
    'routeId',
    'billingAuthority',
    'capabilitySnapshotHash',
    'policyRevision',
  ]) {
    copyString(value, key, route, SNAPSHOT_COLLECTION_TEXT_MAX_CHARS, context);
  }
  copyBoolean(value, 'aiCreditsRouted', route);
  for (const key of ['requestedThinkingLevel', 'effectiveThinkingLevel']) {
    if (isThinkingLevel(value[key])) route[key] = value[key];
  }
  const capabilities = boundedStringArray(
    value.capabilities,
    ROUTE_ARRAY_MAX_ITEMS,
    SNAPSHOT_COLLECTION_TEXT_MAX_CHARS,
    context,
    false,
  );
  if (capabilities !== undefined) route.capabilities = capabilities;
  const supportedThinkingLevels = boundedStringArray(
    value.supportedThinkingLevels,
    ROUTE_ARRAY_MAX_ITEMS,
    64,
    context,
    false,
  );
  if (supportedThinkingLevels !== undefined) {
    const validLevels = supportedThinkingLevels.filter(isThinkingLevel);
    if (validLevels.length !== supportedThinkingLevels.length) {
      context.truncated = true;
    }
    route.supportedThinkingLevels = validLevels;
  }
  copySafeCount(value, 'capabilityGeneration', route);
  const overlay = value.agentOverlay;
  if (isRecord(overlay)) {
    const projectedOverlay: Record<string, unknown> = {};
    for (const key of [
      'agentDefinitionId',
      'agentDefinitionRevision',
      'agentDefinitionHash',
      'pluginProjectionHash',
    ]) {
      copyString(
        overlay,
        key,
        projectedOverlay,
        SNAPSHOT_COLLECTION_TEXT_MAX_CHARS,
        context,
      );
    }
    if (Object.keys(projectedOverlay).length > 0) {
      route.agentOverlay = projectedOverlay;
    }
  }
  return route;
}

function projectCapabilities(
  value: unknown,
  context: ProjectionContext,
): Record<string, unknown> | undefined {
  if (
    !isRecord(value) ||
    typeof value.inherit !== 'boolean' ||
    typeof value.discovery !== 'boolean' ||
    !Array.isArray(value.items) ||
    !Array.isArray(value.skipped)
  ) {
    return undefined;
  }
  const items: Record<string, unknown>[] = [];
  for (const item of value.items) {
    if (!isRecord(item)) {
      context.truncated = true;
      continue;
    }
    const projected: Record<string, unknown> = {};
    if (
      isMemberOf(['skill', 'plugin', 'mcp'] as const, item.kind) &&
      isMemberOf(
        ['agent', 'inherited', 'explicit', 'loaded'] as const,
        item.source,
      ) &&
      typeof item.name === 'string'
    ) {
      projected.kind = item.kind;
      projected.source = item.source;
      if (!copyLabel(item, 'name', projected, 200, context, true)) {
        context.truncated = true;
        continue;
      }
      if (
        isDelegationCapabilitySummary({
          inherit: value.inherit,
          discovery: value.discovery,
          items: [projected],
          skipped: [],
        })
      ) {
        items.push(projected);
      } else {
        context.truncated = true;
      }
    } else {
      context.truncated = true;
    }
  }
  const skipped: Record<string, unknown>[] = [];
  for (const item of value.skipped) {
    if (!isRecord(item)) {
      context.truncated = true;
      continue;
    }
    const projected: Record<string, unknown> = {};
    if (
      isMemberOf(['skill', 'plugin', 'mcp'] as const, item.kind) &&
      isMemberOf(
        [
          'missing_selection',
          'unsupported_capability',
          'unsupported_hooks',
          'unsupported_lsp',
          'unsupported_skill_execution',
          'unavailable_asset',
        ] as const,
        item.reason,
      ) &&
      typeof item.name === 'string'
    ) {
      projected.kind = item.kind;
      projected.reason = item.reason;
      if (!copyLabel(item, 'name', projected, 200, context, true)) {
        context.truncated = true;
        continue;
      }
      if (
        isDelegationCapabilitySummary({
          inherit: value.inherit,
          discovery: value.discovery,
          items: [],
          skipped: [projected],
        })
      ) {
        skipped.push(projected);
      } else {
        context.truncated = true;
      }
    } else {
      context.truncated = true;
    }
  }
  const retainedItems = items.slice(-CAPABILITY_SUMMARY_MAX_ITEMS);
  const retainedSkipped = skipped.slice(-CAPABILITY_SUMMARY_MAX_ITEMS);
  if (
    retainedItems.length !== items.length ||
    retainedSkipped.length !== skipped.length
  ) {
    context.truncated = true;
  }
  const projected: Record<string, unknown> = {
    inherit: value.inherit,
    discovery: value.discovery,
    items: retainedItems,
    skipped: retainedSkipped,
  };
  const priorOmittedItems = value.omittedItems;
  if (isFiniteNonNegativeInteger(priorOmittedItems)) {
    projected.omittedItems =
      priorOmittedItems +
      Math.max(0, value.items.length - retainedItems.length);
  } else if (value.items.length > retainedItems.length) {
    projected.omittedItems = value.items.length - retainedItems.length;
  }
  const priorOmittedSkipped = value.omittedSkipped;
  if (isFiniteNonNegativeInteger(priorOmittedSkipped)) {
    projected.omittedSkipped =
      priorOmittedSkipped +
      Math.max(0, value.skipped.length - retainedSkipped.length);
  } else if (value.skipped.length > retainedSkipped.length) {
    projected.omittedSkipped = value.skipped.length - retainedSkipped.length;
  }
  return isDelegationCapabilitySummary(projected) ? projected : undefined;
}

function isRelativePath(value: unknown): value is string {
  return isRelativeWritePath(value);
}

function projectApplyFailure(
  value: unknown,
  context: ProjectionContext,
): Record<string, unknown> | undefined {
  if (
    !isRecord(value) ||
    !isMemberOf(APPLY_FAILURE_REASONS, value.reason) ||
    !Array.isArray(value.issues) ||
    typeof value.guidance !== 'string'
  ) {
    return undefined;
  }
  const issues: Record<string, unknown>[] = [];
  for (const issue of value.issues) {
    if (
      !isRecord(issue) ||
      !isRelativePath(issue.path) ||
      !isMemberOf(APPLY_ISSUE_REASONS, issue.reason)
    ) {
      context.truncated = true;
      continue;
    }
    const projected: Record<string, unknown> = {
      path: truncatePortalString(
        sanitizeStorableString(issue.path),
        SNAPSHOT_COLLECTION_TEXT_MAX_CHARS,
      ),
      reason: issue.reason,
    };
    if (typeof issue.parentDiff === 'string') {
      copyString(issue, 'parentDiff', projected, 512, context);
    }
    copyBoolean(issue, 'parentDiffTruncated', projected);
    issues.push(projected);
  }
  const retainedIssues = issues.slice(-APPLY_ISSUE_MAX_ITEMS);
  if (retainedIssues.length !== issues.length) context.truncated = true;
  const projected: Record<string, unknown> = {
    reason: value.reason,
    issues: retainedIssues,
    guidance: truncatePortalString(
      sanitizeStorableString(value.guidance),
      1_024,
    ),
  };
  const priorOmitted = value.omittedIssues;
  if (isFiniteNonNegativeInteger(priorOmitted)) {
    projected.omittedIssues =
      priorOmitted + Math.max(0, value.issues.length - retainedIssues.length);
  } else if (value.issues.length > retainedIssues.length) {
    projected.omittedIssues = value.issues.length - retainedIssues.length;
  }
  return projected;
}

function projectControl(
  value: unknown,
  context: ProjectionContext,
  isControl: boolean,
): Record<string, unknown> | undefined {
  if (
    !isRecord(value) ||
    typeof value.operationId !== 'string' ||
    !copyLabel(value, 'operationId', {}, 512, context, true) ||
    !isMemberOf(COMMAND_STATUSES, value.status)
  ) {
    return undefined;
  }
  const projected: Record<string, unknown> = {
    operationId: truncateLabel(sanitizeStorableString(value.operationId), 512),
    status: value.status,
  };
  if (isControl) {
    if (!isMemberOf(CONTROL_OPERATIONS, value.operation)) return undefined;
    projected.operation = value.operation;
  }
  if (typeof value.error === 'string') {
    copyString(value, 'error', projected, 512, context);
  }
  if (isControl && isRecord(value.steeringDelivery)) {
    const source = value.steeringDelivery;
    const delivery: Record<string, unknown> = {};
    if (
      isMemberOf(DELIVERY_KINDS, source.kind) &&
      copyLabel(source, 'attemptId', delivery, 512, context, true)
    ) {
      delivery.kind = source.kind;
      if (copyLabel(source, 'providerTurnId', delivery, 512, context)) {
        // Optional provider turn identity retained for route correlation.
      }
      if (typeof source.reason === 'string') {
        copyString(source, 'reason', delivery, 512, context);
      }
      if (source.fallback === 'ordinary') delivery.fallback = source.fallback;
      if (source.kind === 'accepted' || typeof delivery.reason === 'string') {
        projected.steeringDelivery = delivery;
      }
    }
  }
  if (isControl && value.applyFailure !== undefined) {
    const applyFailure = projectApplyFailure(value.applyFailure, context);
    if (applyFailure !== undefined) projected.applyFailure = applyFailure;
  }
  return projected;
}

function projectStoppedBy(value: unknown, context: ProjectionContext): unknown {
  if (!isRecord(value)) return undefined;
  if (value.kind === 'user') return { kind: 'user' };
  if (value.kind !== 'agent' || !isFiniteNonNegativeInteger(value.depth)) {
    return undefined;
  }
  const projected: Record<string, unknown> = {
    kind: 'agent',
    depth: value.depth,
  };
  copyLabel(value, 'delegationId', projected, 512, context);
  copyString(value, 'description', projected, 200, context);
  return projected;
}

function projectError(
  value: unknown,
  context: ProjectionContext,
): Record<string, unknown> | undefined {
  if (
    !isRecord(value) ||
    typeof value.code !== 'string' ||
    !copyLabel(value, 'code', {}, 512, context, true) ||
    typeof value.message !== 'string' ||
    typeof value.retryable !== 'boolean'
  ) {
    return undefined;
  }
  const projected: Record<string, unknown> = {
    code: truncateLabel(sanitizeStorableString(value.code), 512),
    message: truncatePortalString(
      sanitizeStorableString(value.message),
      SNAPSHOT_TEXT_MAX_CHARS,
    ),
    retryable: value.retryable,
  };
  if (projected.message !== value.message) context.truncated = true;
  if (value.apply !== undefined) {
    const apply = projectApplyFailure(value.apply, context);
    if (apply !== undefined) projected.apply = apply;
  }
  return projected;
}

function projectWorkspaceObservation(
  value: unknown,
  context: ProjectionContext,
): Record<string, unknown> | undefined {
  if (
    !isRecord(value) ||
    value.consistency !== 'live_shared_worktree' ||
    (typeof value.headRevision !== 'string' && value.headRevision !== null) ||
    (typeof value.dirty !== 'boolean' && value.dirty !== null) ||
    !isFiniteNonNegativeInteger(value.observedAt)
  ) {
    return undefined;
  }
  const headRevision =
    typeof value.headRevision === 'string'
      ? truncatePortalString(
          sanitizeStorableString(value.headRevision),
          SNAPSHOT_COLLECTION_TEXT_MAX_CHARS,
        )
      : null;
  if (
    typeof value.headRevision === 'string' &&
    headRevision !== value.headRevision
  ) {
    context.truncated = true;
  }
  return {
    consistency: 'live_shared_worktree',
    headRevision,
    dirty: value.dirty,
    observedAt: value.observedAt,
  };
}

function projectIsolatedWorkspace(
  value: unknown,
): Record<string, unknown> | undefined {
  if (
    !isRecord(value) ||
    typeof value.revision !== 'string' ||
    value.revision.length > 64 ||
    value.dirtyParentChangesIncluded !== false
  ) {
    return undefined;
  }
  return {
    revision: truncatePortalString(sanitizeStorableString(value.revision), 64),
    dirtyParentChangesIncluded: false,
  };
}

function projectUsage(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const projected: Record<string, unknown> = {};
  for (const key of [
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
    'cacheCreationInputTokens',
    'costUsd',
  ]) {
    const number = value[key];
    if (typeof number === 'number' && Number.isFinite(number) && number >= 0) {
      projected[key] = number;
    }
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectDelegationCard(
  source: Record<string, unknown>,
  context: ProjectionContext,
): Record<string, unknown> | null {
  if (
    !copyLabel(source, 'delegationId', {}, 512, context, true) ||
    !copyLabel(source, 'parentHarnessId', {}, 512, context, true) ||
    typeof source.delegationId !== 'string' ||
    typeof source.parentHarnessId !== 'string' ||
    typeof source.description !== 'string' ||
    typeof source.prompt !== 'string' ||
    !isMemberOf(['foreground', 'background'] as const, source.executionMode) ||
    !isMemberOf(DELEGATION_STATUSES, source.status) ||
    typeof source.outputTruncated !== 'boolean'
  ) {
    return null;
  }

  const card: Record<string, unknown> = {
    delegationId: truncateLabel(
      sanitizeStorableString(source.delegationId),
      512,
    ),
    parentHarnessId: truncateLabel(
      sanitizeStorableString(source.parentHarnessId),
      512,
    ),
    description: truncatePortalString(
      sanitizeStorableString(source.description),
      200,
    ),
    prompt: truncatePortalString(
      sanitizeStorableString(source.prompt),
      CARD_TEXT_MAX_CHARS,
    ),
    executionMode: source.executionMode,
    status: source.status,
    outputTruncated: source.outputTruncated,
  };
  if (
    card.description !== source.description ||
    card.prompt !== source.prompt
  ) {
    context.truncated = true;
  }

  for (const key of [
    'parentTurnId',
    'parentToolCallId',
    'parentDelegationId',
    'requestedModelId',
    'nativeSessionId',
  ]) {
    copyLabel(source, key, card, 512, context);
  }
  for (const key of [
    'agentBlockId',
    'selectedModelId',
    'runtimeModelId',
    'targetHarnessId',
  ]) {
    copyLabel(source, key, card, 512, context);
  }
  if (isMemberOf(TRANSCRIPT_STORES, source.transcriptStore)) {
    card.transcriptStore = source.transcriptStore;
  }
  if (source.type === 'delegated_agent_call') card.type = source.type;
  if (isPositiveSafeInteger(source.runGeneration)) {
    card.runGeneration = source.runGeneration;
  }
  copySafeCount(source, 'sequence', card);
  copySafeCount(source, 'streamRevision', card);
  copySafeCount(source, 'createdAt', card);

  copySafeCount(source, 'depth', card, 1);
  if (isMemberOf(NESTING_STATES, source.nestedDelegation)) {
    card.nestedDelegation = source.nestedDelegation;
  }
  copyString(source, 'parentDescription', card, 200, context);
  copyBoolean(source, 'workspaceDiscarded', card);
  copySafeCount(source, 'resultIndex', card, 1);
  copyBoolean(source, 'approvalPending', card);
  copyString(source, 'partialText', card, SNAPSHOT_TEXT_MAX_CHARS, context);
  copyString(source, 'finalText', card, SNAPSHOT_TEXT_MAX_CHARS, context);
  copyBoolean(source, 'cancelledByUser', card);
  if (isMemberOf(STOP_REASONS, source.stopReason)) {
    card.stopReason = source.stopReason;
  }
  const stoppedBy = projectStoppedBy(source.stoppedBy, context);
  if (stoppedBy !== undefined) card.stoppedBy = stoppedBy;

  const routeSnapshot = projectRouteSnapshot(source.routeSnapshot, context);
  if (routeSnapshot !== undefined) card.routeSnapshot = routeSnapshot;
  else if (source.routeSnapshot !== undefined) return null;
  if (routeSnapshot !== undefined) {
    const selectedModelId = routeSnapshot.selectedModelId;
    const runtimeModelId = routeSnapshot.runtimeModelId;
    const targetHarnessId = routeSnapshot.harnessId;
    if (
      typeof selectedModelId === 'string' &&
      typeof runtimeModelId === 'string' &&
      typeof targetHarnessId === 'string'
    ) {
      card.selectedModelId = selectedModelId;
      card.runtimeModelId = runtimeModelId;
      card.targetHarnessId = targetHarnessId;
    }
  } else if (typeof card.requestedModelId === 'string') {
    card.selectedModelId = card.requestedModelId;
  }
  if (isThinkingLevel(source.requestedThinkingLevel)) {
    card.requestedThinkingLevel = source.requestedThinkingLevel;
  }
  if (isThinkingLevel(source.effectiveThinkingLevel)) {
    card.effectiveThinkingLevel = source.effectiveThinkingLevel;
  }

  const permissions = projectPermissions(source.permissions, context);
  if (permissions !== undefined) card.permissions = permissions;
  const control = projectControl(source.control, context, true);
  if (control !== undefined) card.control = control;
  const stopRequested = projectControl(source.stopRequested, context, false);
  if (stopRequested !== undefined) card.stopRequested = stopRequested;
  const isolatedWorkspace = projectIsolatedWorkspace(source.isolatedWorkspace);
  if (isolatedWorkspace !== undefined) {
    card.isolatedWorkspace = isolatedWorkspace;
  }
  const workspaceObservation = projectWorkspaceObservation(
    source.workspaceObservation,
    context,
  );
  if (workspaceObservation !== undefined) {
    card.workspaceObservation = workspaceObservation;
  }
  const error = projectError(source.error, context);
  if (error !== undefined) card.error = error;
  const usage = projectUsage(source.usage);
  if (usage !== undefined) card.usage = usage;

  if (Array.isArray(source.childDelegationIds)) {
    const labels: string[] = [];
    for (const childId of source.childDelegationIds) {
      if (typeof childId !== 'string') {
        context.truncated = true;
        continue;
      }
      const sanitized = sanitizeStorableString(childId);
      if (sanitized.length === 0 || /[\r\n]/.test(sanitized)) {
        context.truncated = true;
        continue;
      }
      labels.push(truncateLabel(sanitized, SNAPSHOT_COLLECTION_TEXT_MAX_CHARS));
    }
    const retained = labels.slice(-SNAPSHOT_COLLECTION_MAX_ITEMS);
    if (retained.length !== labels.length) context.truncated = true;
    card.childDelegationIds = retained;
  }
  const capabilities = projectCapabilities(source.capabilities, context);
  if (capabilities !== undefined) card.capabilities = capabilities;
  if (isAgentDelegationPhase(source.phase)) card.phase = source.phase;
  const queue = projectQueueState(source.queue, context);
  if (queue !== undefined) card.queue = queue;

  const sanitized = sanitizeStorableJson(card);
  if (!isAgentDelegationCardData(sanitized)) return null;
  return sanitized;
}

function truncateNestedStrings(
  value: unknown,
  maxChars: number,
  maxItems: number,
  depth = 0,
  fieldName = '',
): unknown {
  if (typeof value === 'string') {
    if (ENUM_FIELDS.has(fieldName)) return value;
    return LABEL_FIELDS.has(fieldName)
      ? truncateLabel(value, maxChars)
      : truncatePortalString(value, maxChars);
  }
  if (Array.isArray(value)) {
    const selected = value.slice(-maxItems);
    return selected.map((item) =>
      truncateNestedStrings(item, maxChars, maxItems, depth + 1, fieldName),
    );
  }
  if (!isRecord(value) || depth >= 8) return value;
  const projected: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    projected[key] = truncateNestedStrings(
      field,
      maxChars,
      maxItems,
      depth + 1,
      key,
    );
  }
  return projected;
}

function projectQueueState(
  value: unknown,
  context: ProjectionContext,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const queue: Record<string, unknown> = {};
  if (
    !copyLabel(value, 'id', queue, 256, context, true) ||
    !copyLabel(value, 'name', queue, 64, context, true)
  ) {
    return undefined;
  }
  copySafeCount(value, 'position', queue, 1);
  if (value.waitingFor === 'queue' || value.waitingFor === 'app') {
    queue.waitingFor = value.waitingFor;
  }
  copySafeCount(value, 'running', queue);
  copySafeCount(value, 'waiting', queue);
  copySafeCount(value, 'limit', queue, 1);
  if (!isAgentDelegationQueueState(queue)) return undefined;
  const projected: Record<string, unknown> = { ...queue };
  return projected;
}

function cardByteSize(card: Record<string, unknown>): number {
  return serializedBytes(card);
}

function shrinkCardForSnapshotBudget(
  card: Record<string, unknown>,
  context: ProjectionContext,
): void {
  if (cardByteSize(card) <= PORTAL_DELEGATION_SNAPSHOT_MAX_BYTES) return;
  const medium = truncateNestedStrings(card, 96, 4);
  if (isRecord(medium)) {
    for (const [key, value] of Object.entries(medium)) card[key] = value;
  }
  context.truncated = true;
  if (cardByteSize(card) <= PORTAL_DELEGATION_SNAPSHOT_MAX_BYTES) return;
  const small = truncateNestedStrings(card, 32, 1);
  if (isRecord(small)) {
    for (const [key, value] of Object.entries(small)) card[key] = value;
  }
}

function freezeDeep(value: unknown, visited = new WeakSet<object>()): void {
  if (typeof value !== 'object' || value === null || visited.has(value)) return;
  visited.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) freezeDeep(child, visited);
  Object.freeze(value);
}

function projectToolUseDataResult(
  source: Record<string, unknown>,
  compacted: unknown,
): unknown {
  if (
    !isRecord(compacted) ||
    !Object.prototype.hasOwnProperty.call(source, 'result')
  ) {
    return compacted;
  }
  const sourceResult = source.result;
  const result = isRecord(sourceResult)
    ? sourceResult
    : { output: sourceResult };
  const safeResult = sanitizeStorableJson(result);
  const outputValue = isRecord(safeResult) ? safeResult.output : undefined;
  const output =
    typeof outputValue === 'string'
      ? truncatePortalString(
          outputValue,
          PORTAL_DELEGATION_CHILD_TEXT_MAX_CHARS,
        )
      : summarizePortalJson(outputValue);
  const isError =
    isRecord(safeResult) && typeof safeResult.isError === 'boolean'
      ? safeResult.isError
      : false;
  const projected = { ...compacted, result: { output, isError } };
  return sanitizeStorableJson(projected);
}

function projectChildPart(
  value: unknown,
  context: ProjectionContext,
  delegationDepth: number,
): PortalChatPart | null {
  if (!isRecord(value) || !isMemberOf(PART_KINDS, value.kind)) return null;
  if (value.kind === 'agent' && isRecord(value.data)) {
    const delegation = value.data.delegation;
    if (isRecord(delegation)) {
      return projectPortalDelegationPartAtDepth(
        value,
        context,
        delegationDepth + 1,
      );
    }
  }
  const partData = value.data;
  if (partData === undefined) return { kind: value.kind };
  const sanitized = sanitizeStorableJson(partData);
  let compacted = compactPortalJson(sanitized, 2);
  if (value.kind === 'tool_use' && isRecord(sanitized)) {
    compacted = projectToolUseDataResult(sanitized, compacted);
  }
  const result: PortalChatPart = {
    kind: value.kind,
    data: compacted,
    ...(isMemberOf(TOOL_FAMILIES, value.toolFamily)
      ? { toolFamily: value.toolFamily }
      : {}),
  };
  return sanitizeStorableJson(result);
}

function inheritedOmittedCount(data: Record<string, unknown>): number {
  return isFiniteNonNegativeInteger(data.omittedSubBlocks)
    ? data.omittedSubBlocks
    : 0;
}

function projectChildren(
  value: unknown,
  data: Record<string, unknown>,
  context: ProjectionContext,
  delegationDepth: number,
): ProjectedChildren {
  if (!Array.isArray(value)) {
    return {
      parts: [],
      omitted: inheritedOmittedCount(data),
    };
  }
  if (delegationDepth >= NESTED_DELEGATION_DEPTH_LIMIT) {
    const prior = inheritedOmittedCount(data);
    const omitted = prior + value.length;
    return { parts: [], omitted };
  }
  const start = Math.max(
    0,
    value.length - PORTAL_DELEGATION_SUB_BLOCKS_MAX_COUNT,
  );
  const omittedByCount = start;
  const candidates: PortalChatPart[] = [];
  let omittedInvalid = 0;
  for (let index = start; index < value.length; index += 1) {
    const projected = projectChildPart(value[index], context, delegationDepth);
    if (projected === null) {
      omittedInvalid += 1;
      continue;
    }
    candidates.push(projected);
  }
  let retained: PortalChatPart[] = [];
  let truncatedByBytes = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (candidate === undefined) continue;
    const proposed = [candidate, ...retained];
    if (serializedBytes(proposed) > PORTAL_DELEGATION_SUB_BLOCKS_MAX_BYTES) {
      truncatedByBytes += index + 1;
      break;
    }
    retained = proposed;
  }
  const inherited = inheritedOmittedCount(data);
  const omitted =
    inherited + omittedByCount + omittedInvalid + truncatedByBytes;
  if (omitted > inherited || data.subBlocksTruncated === true) {
    context.truncated ||= omitted > inherited;
  }
  return { parts: retained, omitted };
}

/** Count suppressed children without visiting stale stream-backed payloads. */
function omittedChildren(data: Record<string, unknown>): ProjectedChildren {
  return {
    parts: [],
    omitted: Math.min(
      Number.MAX_SAFE_INTEGER,
      inheritedOmittedCount(data) +
        (Array.isArray(data.subBlocks) ? data.subBlocks.length : 0),
    ),
  };
}

/** No actionable identity survives a card that cannot be represented safely. */
function unavailableDelegationPart(
  data: Record<string, unknown>,
  source: Record<string, unknown>,
): PortalChatPart {
  const delegation: Record<string, unknown> = {};
  if (isMemberOf(TRANSCRIPT_STORES, source.transcriptStore)) {
    delegation.transcriptStore = source.transcriptStore;
  }
  const result: PortalChatPart = {
    kind: 'agent',
    data: {
      delegation,
      subBlocks: [],
      snapshotTruncated: true,
      subBlocksTruncated: true,
      omittedSubBlocks: omittedChildren(data).omitted,
    },
  };
  freezeDeep(result);
  return result;
}

function projectPortalDelegationPartAtDepth(
  value: unknown,
  context: ProjectionContext,
  delegationDepth: number,
): PortalChatPart | null {
  if (!isRecord(value) || value.kind !== 'agent' || !isRecord(value.data)) {
    return null;
  }
  const data = value.data;
  if (!isRecord(data.delegation)) return null;
  const source = data.delegation;
  const cardContext: ProjectionContext = {
    truncated:
      source.transcriptStore !== undefined &&
      !isMemberOf(TRANSCRIPT_STORES, source.transcriptStore),
  };
  const card = projectDelegationCard(source, cardContext);
  if (card === null) return unavailableDelegationPart(data, source);
  shrinkCardForSnapshotBudget(card, cardContext);
  const sanitizedCard = sanitizeStorableJson(card);
  if (
    serializedBytes(sanitizedCard) > PORTAL_DELEGATION_SNAPSHOT_MAX_BYTES ||
    !isAgentDelegationCardData(sanitizedCard) ||
    (source.transcriptStore === 'chat-stream-v2' &&
      (sanitizedCard.delegationId !== source.delegationId ||
        sanitizedCard.agentBlockId !== source.agentBlockId))
  ) {
    return unavailableDelegationPart(data, source);
  }

  const children =
    source.transcriptStore !== undefined &&
    source.transcriptStore !== 'chat-log-v1'
      ? omittedChildren(data)
      : projectChildren(data.subBlocks, data, context, delegationDepth);
  const resultData: Record<string, unknown> = {
    delegation: sanitizedCard,
    subBlocks: children.parts,
  };
  if (data.subagentType !== undefined) {
    copyString(data, 'subagentType', resultData, 128, context);
  }
  const alreadySnapshotTruncated = data.snapshotTruncated === true;
  if (cardContext.truncated || alreadySnapshotTruncated) {
    resultData.snapshotTruncated = true;
  }
  if (children.omitted > 0 || data.subBlocksTruncated === true) {
    resultData.subBlocksTruncated = true;
    resultData.omittedSubBlocks = children.omitted;
  }
  const result: PortalChatPart = { kind: 'agent', data: resultData };
  const sanitizedResult = sanitizeStorableJson(result);
  if (serializedBytes(sanitizedResult) > PORTAL_DELEGATION_PART_MAX_BYTES) {
    return unavailableDelegationPart(data, source);
  }
  freezeDeep(sanitizedResult);
  return sanitizedResult;
}

/**
 * Project only a managed delegation card to a bounded browser-safe Portal
 * part. Only non-managed parts return `null`; invalid managed cards return
 * bounded omission-only data without a usable read identity. Unknown markers
 * retain the validated card, but never inline children.
 */
export function projectPortalDelegationPart(
  part: unknown,
): PortalChatPart | null {
  if (!isRecord(part)) return null;
  const cached = projectedPartCache.get(part);
  if (cached !== undefined) return cached;
  const result = projectPortalDelegationPartAtDepth(
    part,
    { truncated: false },
    0,
  );
  if (result !== null) projectedPartCache.set(result, result);
  return result;
}
