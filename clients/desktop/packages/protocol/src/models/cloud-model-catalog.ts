// ---------------------------------------------------------------------------
// The hosted model catalog -> the composer's `ModelCatalog` (CAN-6753).
//
// One projection for every surface that lists a cloud chat's models: the web's
// signed-in bootstrap, its pre-session guest composer and the desktop's cloud
// composer all read the rows `GET /api/cloud/models` sends (over the route, or
// as `core.catalog.snapshot.get` revision 2's `cloudModels`) and project them
// here, so their pickers group, tag and badge the same rows the same way. A
// second hand-rolled copy is how the desktop came to file every row under
// "Other models".
//
// Pure and environment-neutral: protocol types and guards only.
// ---------------------------------------------------------------------------

import type { AiGatewayHarness } from '../ai-gateway-models/index';
import { isCoreThinkingLevel } from '../thinking/index';
import type { ModelCatalog, ModelCatalogOption } from './index';

/**
 * The slice of a cloud model row the projection reads.
 *
 * Deliberately the DEFENSIVE shape rather than the server response type: the
 * row is read off the wire, so every field a route version could legitimately
 * omit is optional here. The server's own model row is structurally
 * assignable to it, which is what lets every entry point share one
 * projection.
 */
export interface ProjectableCloudModelOption {
  readonly id: string;
  readonly label: string;
  /** Optional row summary for the picker menu (CAN-2539). */
  readonly description?: string;
  readonly showMoreOnly?: boolean;
  readonly contextWindow?: number;
  /** Core's provider: the model's vendor, never its harness. */
  readonly provider: string | null;
  /** Effective AI SDK adapter. Older route versions omit it. */
  readonly harness?: AiGatewayHarness;
  readonly fastGatewayId?: string | null;
  readonly fastModeSupported?: boolean;
  /**
   * Tri-state (CAN-2339 §9 A2): ABSENT = legacy/unknown (provider fallback),
   * `[]` = explicitly non-thinking, non-empty = the exact declared set.
   */
  readonly thinkingLevels?: readonly string[];
  readonly family: string | null;
  readonly familyLabel?: string | null;
  /** Owner-scoped library eligibility. Older route versions omit it. */
  readonly libraryEligibility?: 'available' | 'locked';
  /**
   * Served by the work owner's own AI gateway (CAN-5811), or by the person's
   * own Anthropic or OpenAI key (`provider-key`). A reader that predates a
   * value drops it, so the row reads as an ordinary credits model.
   */
  readonly funding?: 'org-gateway' | 'provider-key';
  /** The preset gateway serving an `org-gateway` row (CAN-6444). */
  readonly gatewayPresetId?: string;
}

/**
 * `GET /api/cloud/models` query parameter (`=1`) by which a client opts in to
 * the caller's own-key `byok/` rows. Without it the rows are omitted.
 */
export const CLOUD_MODELS_PROVIDER_KEY_PARAM = 'providerKeyModels';

/**
 * Core model definitions → the picker's `ModelCatalog`. The option id IS the
 * core modelDefinitionId.
 */
export function toModelCatalog(
  models: readonly ProjectableCloudModelOption[],
  defaultModelId: string | null,
): ModelCatalog {
  return models.map((model): ModelCatalogOption => {
    // A model vendor does not determine its AI SDK adapter. Fail-open catalog
    // responses can legitimately omit curation-derived harness metadata; keep
    // that state explicit rather than silently routing one vendor through
    // one harness and every other vendor through the other.
    const provider = model.harness ?? 'unknown';
    return {
      id: model.id,
      label: model.label,
      // Truthy, not `!== undefined`: an empty string must stay absent rather
      // than render as a blank description line in the picker (CAN-2539).
      ...(model.description ? { description: model.description } : {}),
      ...(model.showMoreOnly ? { showMoreOnly: true } : {}),
      ...(model.contextWindow !== undefined
        ? { contextWindow: model.contextWindow }
        : {}),
      provider,
      source: 'ai-gateway',
      ...(model.harness !== undefined ? { harness: model.harness } : {}),
      supportsFastMode:
        model.fastModeSupported ??
        (model.fastGatewayId !== null && model.fastGatewayId !== undefined),
      kind: 'model',
      available: true,
      family: model.family ?? undefined,
      // Older cloud-model routes do not carry Core's family display name. Use
      // the identifier as a stable family-specific fallback, never the provider
      // label that would collapse distinct families into duplicate headings.
      familyLabel: model.familyLabel ?? model.family ?? undefined,
      vendor: model.provider?.toLowerCase(),
      // Core's declared level set rides verbatim — including the explicit empty
      // "thinking unsupported" set. An ABSENT declaration (an older route, or a
      // legacy Core definition) stays absent so
      // `resolveModelCatalogThinkingLevels` falls back to the provider cycle
      // instead of hiding the thinking control. Filtered with the Core-specific
      // guard so the catalog never offers a level (`ultra`) the cloud create
      // and message routes reject.
      ...(model.thinkingLevels !== undefined
        ? {
            supportedThinkingLevels:
              model.thinkingLevels.filter(isCoreThinkingLevel),
          }
        : {}),
      // This is also the dispatch fallback for an unpicked chat, so capability
      // checks and the executed model resolve to the same catalog default.
      ...(defaultModelId !== null && model.id === defaultModelId
        ? { isDefault: true }
        : {}),
      // Compared rather than spread: this is read off the wire, and an
      // unknown value must stay absent instead of reaching the picker.
      ...(model.libraryEligibility === 'locked' ||
      model.libraryEligibility === 'available'
        ? { libraryEligibility: model.libraryEligibility }
        : {}),
      ...(model.funding === 'org-gateway' || model.funding === 'provider-key'
        ? { funding: model.funding }
        : {}),
      ...(model.funding === 'org-gateway' &&
      typeof model.gatewayPresetId === 'string'
        ? { gatewayPresetId: model.gatewayPresetId }
        : {}),
    };
  });
}

const isHarness = (value: unknown): value is AiGatewayHarness =>
  value === 'claude' || value === 'codex';

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

/**
 * One hosted catalog row as the projection reads it, from a value read off
 * the wire (`core.catalog.snapshot.get` revision 2's `cloudModels.models`,
 * whose fields beyond the required ones pass as sent). A field of the wrong
 * type is dropped, as an older route's missing field is; a row without an id
 * or a label is `null`.
 */
export function readProjectableCloudModel(
  row: unknown,
): ProjectableCloudModelOption | null {
  if (typeof row !== 'object' || row === null || Array.isArray(row))
    return null;
  const field = (key: string): unknown =>
    Object.prototype.hasOwnProperty.call(row, key)
      ? Reflect.get(row, key)
      : undefined;
  const id = field('id');
  const label = field('label');
  if (typeof id !== 'string' || typeof label !== 'string') return null;
  const description = field('description');
  const showMoreOnly = field('showMoreOnly');
  const contextWindow = field('contextWindow');
  const harness = field('harness');
  const fastGatewayId = field('fastGatewayId');
  const fastModeSupported = field('fastModeSupported');
  const thinkingLevels = field('thinkingLevels');
  const familyLabel = field('familyLabel');
  const libraryEligibility = field('libraryEligibility');
  const funding = field('funding');
  const gatewayPresetId = field('gatewayPresetId');
  return {
    id,
    label,
    provider: stringOrNull(field('provider')),
    family: stringOrNull(field('family')),
    ...(typeof description === 'string' ? { description } : {}),
    ...(typeof showMoreOnly === 'boolean' ? { showMoreOnly } : {}),
    ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
    ...(isHarness(harness) ? { harness } : {}),
    ...(typeof fastGatewayId === 'string' || fastGatewayId === null
      ? { fastGatewayId }
      : {}),
    ...(typeof fastModeSupported === 'boolean' ? { fastModeSupported } : {}),
    ...(Array.isArray(thinkingLevels)
      ? {
          thinkingLevels: thinkingLevels.filter(
            (level): level is string => typeof level === 'string',
          ),
        }
      : {}),
    ...(typeof familyLabel === 'string' || familyLabel === null
      ? { familyLabel }
      : {}),
    ...(libraryEligibility === 'available' || libraryEligibility === 'locked'
      ? { libraryEligibility }
      : {}),
    ...(funding === 'org-gateway' || funding === 'provider-key'
      ? { funding }
      : {}),
    ...(typeof gatewayPresetId === 'string' ? { gatewayPresetId } : {}),
  };
}
