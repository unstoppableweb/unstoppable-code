import { z } from 'zod';

import { CanopyRequestMetadataSchema } from '../../common';
import { CanopyJsonValueSchema } from '../../errors';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import {
  inherentOperationErrorSchema,
  keyedOperationErrorSchema,
} from '../shared';
import { CONFIG_GRANTS } from './operations';

/*
 * The whole preferences document (CAN-7926, slice P of CAN-5722). Contracts
 * only: no core registers a handler and no client calls them, and the
 * runtime profiles keep config writes out of their access modes. They stay
 * out of the composed registries, whose dispatchers need a handler for every
 * definition. The web core never serves them: the document is the desktop's
 * own `preferences.json` (desktop-only by decision, as the per-namespace
 * writes are). The per-namespace `core.config.get` and `.update` are
 * unchanged.
 *
 * Grants (Mike, 2026-11-25, q-3): whole-document writes are open to every
 * interface principal through `core.config.document.update`, and the core
 * runs the preference save rules before it writes. Those rules are the ones
 * Electron's preferences save applies today, extracted into a shared module
 * and reused, never reimplemented (slice K). The owner path,
 * `core.config.document.ownerUpdate`, runs none of the refuse, drop or shape
 * rules: only the owning connection holds its grant, and its host runs its own
 * preconditions first. Both paths merge `usageData` per key inside the commit.
 */

/**
 * The document's content revision: `sha256:` and the lowercase hex SHA-256 of
 * the UTF-8 `stableStringify` (`lib/stable-stringify`) of the persisted
 * preferences record alone, as loaded and normalized (the defaults before a
 * first save). Sorted keys keep it host-independent. The generation stamp and
 * the envelope around the record never enter it, so stamping a generation
 * never changes it and never conflicts with a save. Equal content, equal
 * revision; compare for equality only.
 */
export const ConfigDocumentRevisionSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/);
export type ConfigDocumentRevision = z.output<
  typeof ConfigDocumentRevisionSchema
>;

/** A top-level preference key: the stored record's own keys only. */
export const ConfigDocumentKeySchema = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9]{0,127}$/);

/** Bounds a patch, a key list or a value record. */
export const CONFIG_DOCUMENT_MAX_KEYS = 1024;

/**
 * Keys `core.config.document.update` refuses (rule 1): the whole patch fails
 * with `invalid_argument` and code `core.config.protectedKey`. Each has its
 * own typed owner, and `accountProxyConnection` matters most: a redirected
 * proxy URL reroutes provider credentials.
 */
export const CONFIG_DOCUMENT_REFUSED_KEYS = [
  'approvalDefaults',
  'claudeModAdmissions',
  'claudeModsDisabled',
  'accountProxyConnection',
  'copilotAccount',
] as const;

/**
 * Keys `core.config.document.update` always drops (rule 2) and reports in
 * `dropped`: main-owned records a client snapshot may hold an old copy of.
 */
export const CONFIG_DOCUMENT_DROPPED_KEYS = [
  'suggestions',
  'copilotEnabled',
  'copilotVaultSelection',
  'disabledInstalledItems',
  'parkedCodexPlugins',
  'pendingInstalledItemUninstalls',
  'nativeProviderAccounts',
  'globalApprovalRules',
  'accountProxyLocalRoutingStrategy',
  'terminalSettingsRevision',
] as const;

/**
 * Keys no caller can change through `core.config.document.update`; only the
 * owner path writes them. Rule 3's shape intents are not listed: those keys
 * change only through their exact one-key or two-key save, and a wider patch
 * drops them into `dropped`.
 */
export const CONFIG_DOCUMENT_PROTECTED_KEYS = [
  ...CONFIG_DOCUMENT_REFUSED_KEYS,
  ...CONFIG_DOCUMENT_DROPPED_KEYS,
] as const;
export type ConfigDocumentProtectedKey =
  (typeof CONFIG_DOCUMENT_PROTECTED_KEYS)[number];

/** Not every key fits a JSON Schema property pattern; the refinement checks them. */
const keysAreBounded = (value: object): boolean => {
  const keys = Object.keys(value);
  return (
    keys.length <= CONFIG_DOCUMENT_MAX_KEYS &&
    keys.every((key) => ConfigDocumentKeySchema.safeParse(key).success)
  );
};

/** A record of top-level preference keys and their JSON values. */
const PreferenceRecordSchema = z
  .object({})
  .catchall(CanopyJsonValueSchema)
  .refine(keysAreBounded, 'Preference keys are camelCase names.');

/**
 * Top-level keys and the values that replace them. `usageData` merges per
 * key with the stored copy, so a partial patch never turns an omitted flow
 * back on; every other key is replaced whole.
 */
export const ConfigDocumentPatchSchema = PreferenceRecordSchema.refine(
  (patch) => Object.keys(patch).length > 0,
  'A patch changes at least one setting.',
);

/** Path-free: a host projects its own file paths for the recovery notice. */
export const ConfigDocumentLoadErrorSchema = z
  .object({
    /** When the failed load happened; `loadError.acknowledge` names it. */
    timestamp: z.iso.datetime({ offset: true }),
    reason: z.enum(['read', 'parse', 'version']),
    /** The unreadable document was copied aside before anything replaced it. */
    backedUp: z.boolean(),
    /** The last-good copy was restored in its place. */
    restored: z.boolean(),
    /** The file system's error code, such as `EACCES`. */
    code: z.string().min(1).max(64).optional(),
    expectedVersion: z.number().int().min(0).optional(),
    actualVersion: CanopyJsonValueSchema.optional(),
  })
  .catchall(CanopyJsonValueSchema);
export type ConfigDocumentLoadError = z.output<
  typeof ConfigDocumentLoadErrorSchema
>;

export const ConfigDocumentGetParamsSchema = z.strictObject({});

export const ConfigDocumentGetResultSchema = z
  .object({
    revision: ConfigDocumentRevisionSchema,
    /** The runtime projection of the stored record. Holds no secret. */
    value: PreferenceRecordSchema,
    /** Keys an organization enforces; a write to one keeps the enforced value. */
    enforcedPaths: z.array(z.string()).max(CONFIG_DOCUMENT_MAX_KEYS),
    /** The load failure whose notice nobody has acknowledged yet. */
    loadError: ConfigDocumentLoadErrorSchema.nullable(),
  })
  .catchall(CanopyJsonValueSchema);
export type ConfigDocumentGetResult = z.output<
  typeof ConfigDocumentGetResultSchema
>;

const KEYED_META = CanopyRequestMetadataSchema.extend({
  idempotencyKey: z.string().min(1).max(512),
});

const DOCUMENT_UPDATE_FIELDS = {
  patch: ConfigDocumentPatchSchema,
  /**
   * The revision the caller read. Omitted for a blind patch, which applies
   * to whatever is stored; a client's updater that read the document sends
   * it and retries a bounded number of times on conflict.
   */
  expectedRevision: ConfigDocumentRevisionSchema.optional(),
  _meta: KEYED_META,
};

/**
 * The open write. The patch is sent as the caller built it; the core applies
 * the shared save rules inside the serialized commit, then checks
 * `expectedRevision` against what is stored.
 */
export const ConfigDocumentUpdateParamsSchema = z.strictObject(
  DOCUMENT_UPDATE_FIELDS,
);
export type ConfigDocumentUpdateParams = z.output<
  typeof ConfigDocumentUpdateParamsSchema
>;

export const ConfigDocumentUpdateResultSchema =
  ConfigDocumentGetResultSchema.extend({
    /** Patch keys the save rules dropped without writing; empty when none. */
    dropped: z.array(ConfigDocumentKeySchema).max(CONFIG_DOCUMENT_MAX_KEYS),
  });
export type ConfigDocumentUpdateResult = z.output<
  typeof ConfigDocumentUpdateResultSchema
>;

/**
 * The owner path: the same patch, written as sent, protected keys included.
 * Approval writes use this path only.
 */
export const ConfigDocumentOwnerUpdateParamsSchema = z.strictObject(
  DOCUMENT_UPDATE_FIELDS,
);
export type ConfigDocumentOwnerUpdateParams = z.output<
  typeof ConfigDocumentOwnerUpdateParamsSchema
>;

export const ConfigDocumentOwnerUpdateResultSchema =
  ConfigDocumentGetResultSchema;

export const ConfigLegacyClientLocalGetParamsSchema = z.strictObject({});

/**
 * The client-local values the preferences document still holds a frozen copy
 * of (CAN-4472), by the document's own recovery verdict: `read` when its load
 * accepted the document, `missing` when there is none, and `pending` when
 * recovery is latched or the document is unreadable or of an unsupported
 * version. `pending` values serve this session only and must not be
 * persisted. Not a namespace.
 */
export const ConfigLegacyClientLocalGetResultSchema = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({ kind: z.literal('read'), values: PreferenceRecordSchema }),
    z.strictObject({ kind: z.literal('missing') }),
    z.strictObject({
      kind: z.literal('pending'),
      served: PreferenceRecordSchema,
    }),
  ],
);
export type ConfigLegacyClientLocalGetResult = z.output<
  typeof ConfigLegacyClientLocalGetResultSchema
>;

/** Clears the recovery notice the person saw, never a newer one. */
export const ConfigLoadErrorAcknowledgeParamsSchema = z.strictObject({
  timestamp: z.iso.datetime({ offset: true }),
});

export const ConfigLoadErrorAcknowledgeResultSchema = z
  .object({
    /** False when no load error is pending or it is not the one named. */
    acknowledged: z.boolean(),
    /** The load error still pending afterwards, if any. */
    loadError: ConfigDocumentLoadErrorSchema.nullable(),
  })
  .catchall(CanopyJsonValueSchema);

const document = {
  plane: 'core',
  domain: 'config',
  version: 1,
  placement: 'core-only',
} as const;

const DOCUMENT_ERROR_CODES = [
  'core.config.invalidState',
  'core.config.revisionConflict',
] as const;

/** Document reads (CAN-7926); not served yet, outside the composed registries. */
export const CORE_CONFIG_DOCUMENT_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'core',
  {
    'core.config.document.get': defineCanopyQuery({
      ...document,
      idempotency: 'inherent',
      requiredGrants: [CONFIG_GRANTS.read],
      params: ConfigDocumentGetParamsSchema,
      result: ConfigDocumentGetResultSchema,
      error: inherentOperationErrorSchema(['core.config.invalidState']),
    }),
    'core.config.legacyClientLocal.get': defineCanopyQuery({
      ...document,
      idempotency: 'inherent',
      requiredGrants: [CONFIG_GRANTS.read],
      params: ConfigLegacyClientLocalGetParamsSchema,
      result: ConfigLegacyClientLocalGetResultSchema,
      error: inherentOperationErrorSchema(['core.config.invalidState']),
    }),
  },
);

/** Document writes (CAN-7926); not served yet, outside the composed registries. */
export const CORE_CONFIG_DOCUMENT_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.config.document.update': defineCanopyInstruction({
      ...document,
      idempotency: 'keyed',
      requiredGrants: [CONFIG_GRANTS.documentWrite],
      params: ConfigDocumentUpdateParamsSchema,
      result: ConfigDocumentUpdateResultSchema,
      error: keyedOperationErrorSchema([
        ...DOCUMENT_ERROR_CODES,
        'core.config.protectedKey',
      ]),
    }),
    'core.config.document.ownerUpdate': defineCanopyInstruction({
      ...document,
      idempotency: 'keyed',
      requiredGrants: [CONFIG_GRANTS.documentOwn],
      params: ConfigDocumentOwnerUpdateParamsSchema,
      result: ConfigDocumentOwnerUpdateResultSchema,
      error: keyedOperationErrorSchema(DOCUMENT_ERROR_CODES),
    }),
    // The owner path (T29): the notice belongs to the app shell.
    'core.config.loadError.acknowledge': defineCanopyInstruction({
      ...document,
      idempotency: 'inherent',
      requiredGrants: [CONFIG_GRANTS.documentOwn],
      params: ConfigLoadErrorAcknowledgeParamsSchema,
      result: ConfigLoadErrorAcknowledgeResultSchema,
      error: inherentOperationErrorSchema(['core.config.invalidState']),
    }),
  });

/*
 * Preference commit events, served on `core.events.subscribe` in the
 * `core.config` family once a core writes the document; none emits them yet.
 * They follow the workspace commit events (`core/workspace/events.ts`).
 * Scope is always `{}`: the document is machine-wide. Payloads may gain
 * optional fields; subscribers ignore fields and names they do not know.
 */

export const CORE_CONFIG_EVENT_FAMILY = 'core.config';
/**
 * Exactly once per applied write that changed the content revision, in
 * commit order. Never for a refused write, a replay, an unchanged document or
 * a generation stamp alone.
 */
export const CORE_CONFIG_COMMITTED_EVENT = 'core.config.committed';
/** Never a success: an uncertain outcome or a recovery that may have replaced the document. */
export const CORE_CONFIG_INVALIDATED_EVENT = 'core.config.invalidated';

export const CORE_CONFIG_EVENT_NAMES = [
  CORE_CONFIG_COMMITTED_EVENT,
  CORE_CONFIG_INVALIDATED_EVENT,
] as const;

/** An opaque commit reference. */
const commit = z.string().min(1).max(128);

export const CoreConfigCommittedPayloadSchema = z
  .object({
    commit,
    /** The document's revision before and after the write. */
    previousRevision: ConfigDocumentRevisionSchema,
    revision: ConfigDocumentRevisionSchema,
    /** Top-level keys whose stored value changed; values are re-read, never sent. */
    keys: z.array(ConfigDocumentKeySchema).max(CONFIG_DOCUMENT_MAX_KEYS),
    /** The client instance whose attributed call made the commit. */
    publishedBy: z.string().min(1).max(512).optional(),
  })
  .catchall(CanopyJsonValueSchema);
export type CoreConfigCommittedPayload = z.output<
  typeof CoreConfigCommittedPayloadSchema
>;

export const CORE_CONFIG_INVALIDATION_REASONS = [
  'uncertain',
  'recovered',
] as const;

export const CoreConfigInvalidatedPayloadSchema = z
  .object({
    reason: z.enum(CORE_CONFIG_INVALIDATION_REASONS),
    /** Commits known to be involved, when the core knows them. */
    commits: z.array(commit).max(1024).optional(),
  })
  .catchall(CanopyJsonValueSchema);
export type CoreConfigInvalidatedPayload = z.output<
  typeof CoreConfigInvalidatedPayloadSchema
>;
