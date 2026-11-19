import { z } from 'zod';
// Type-only: Node loads this module directly in the Electron mock server.
import type { ClientFeatureFlagKey } from '../feature-flags/index';

export const LABS_EXPERIMENT_AVAILABILITIES = [
  'hidden',
  'offered',
  'on',
] as const;
export type LabsExperimentAvailability =
  (typeof LABS_EXPERIMENT_AVAILABILITIES)[number];
export const LABS_EXPERIMENT_AVAILABILITY_SOURCES = [
  'fixture',
  'live',
  'cache',
  'policy_fallback',
  'registered_fallback',
] as const;
export type LabsExperimentAvailabilitySource =
  (typeof LABS_EXPERIMENT_AVAILABILITY_SOURCES)[number];
export const LABS_EXPERIMENT_HIDDEN = 'hidden';
export const LABS_EXPERIMENT_OFFERED = 'offered';
export const LABS_EXPERIMENT_ON = 'on';
export const EARLY_ACCESS_EXPERIMENT_ID = 'early-access';
export const ORCHESTRATOR_PAGE_EXPERIMENT_ID = 'orchestrator-page';
export const BOTS_EXPERIMENT_ID = 'bots';
export const LABS_EXPERIMENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const LABS_EXPERIMENT_CHOICE_LIMIT = 100;
export const LABS_EXPERIMENTS_VERSION_HEADER = 'x-labs-experiments-version';
export const STACKED_NOTIFICATIONS_EXPERIMENT_ID = 'stacked-notifications';
/** Historic extraction IDs retain reserved storage slots, including graduated
 * features. Older clients still read/write these inert preferences. */
export const EXTRACTED_EARLY_ACCESS_EXPERIMENT_IDS: readonly string[] = [
  STACKED_NOTIFICATIONS_EXPERIMENT_ID,
  'sidebar',
  'compact-tool-calls',
  'user-messages',
  'collapsible-prompts',
  'compact-composer',
  'deferred-branch-picker',
  'compact-settings',
  'inset-layout',
  'panel-tabs',
  'activity-card',
  'minimal-layout',
  'panel-layout-controls',
  'archived-chat-tabs',
  'browser-toolbar',
  'browser-warm-views',
  'floating-advisor',
  'short-summaries',
  'comet-spinners',
  'pointer-menus',
  'single-tooltips',
  'loading-spinners',
  'updated-icons',
  'sentence-case-titles',
  'launch-shimmer',
  'usage-indicators',
  'plugin-error-notices',
];

/** Freeze the legacy preference once; explicit extracted choices always win. */
export function migrateExtractedLabsChoices(
  choices: Readonly<Record<string, boolean>>,
): Record<string, boolean> {
  const migrated = { ...choices };
  for (const id of EXTRACTED_EARLY_ACCESS_EXPERIMENT_IDS) {
    if (!Object.prototype.hasOwnProperty.call(migrated, id))
      migrated[id] =
        Object.prototype.hasOwnProperty.call(
          choices,
          EARLY_ACCESS_EXPERIMENT_ID,
        ) && choices[EARLY_ACCESS_EXPERIMENT_ID] === true;
  }
  return migrated;
}
export const labsExperimentIdSchema = z
  .string()
  .regex(LABS_EXPERIMENT_ID_PATTERN);
export const labsExperimentChoiceRequestSchema = z.strictObject({
  experimentId: labsExperimentIdSchema,
  enabled: z.boolean(),
});
export const labsExperimentChoiceBodySchema = z.strictObject({
  enabled: z.boolean(),
});
export const labsExperimentChoicesSchema = z
  .record(labsExperimentIdSchema, z.boolean())
  .refine(
    (choices) =>
      Object.keys(choices).filter(
        (id) => !EXTRACTED_EARLY_ACCESS_EXPERIMENT_IDS.includes(id),
      ).length <= LABS_EXPERIMENT_CHOICE_LIMIT,
  );
export const labsExperimentChoiceResultSchema = z.strictObject({
  experimentId: labsExperimentIdSchema,
  enabled: z.boolean(),
  updatedAt: z.iso.datetime(),
  /** Version-2 PUTs return the complete choice map at the same commit. */
  choices: labsExperimentChoicesSchema.optional(),
});
export type LabsExperimentChoiceRequest = z.output<
  typeof labsExperimentChoiceRequestSchema
>;
export type LabsExperimentChoiceResult = z.output<
  typeof labsExperimentChoiceResultSchema
>;

export function isLabsExperimentId(value: unknown): value is string {
  return typeof value === 'string' && LABS_EXPERIMENT_ID_PATTERN.test(value);
}
export function isLabsExperimentAvailability(
  value: unknown,
): value is LabsExperimentAvailability {
  return value === 'hidden' || value === 'offered' || value === 'on';
}
export function parseLabsExperimentAvailability(
  value: unknown,
  fallback: LabsExperimentAvailability,
): LabsExperimentAvailability {
  return isLabsExperimentAvailability(value) ? value : fallback;
}
export function resolveLabsExperiment(input: {
  availability: LabsExperimentAvailability;
  choice: boolean | null;
  earlyAccessEnabled: boolean;
  requiresEarlyAccess: boolean;
  prerequisiteEnabled?: boolean;
}): { listed: boolean; enabled: boolean } {
  if (
    input.availability === 'hidden' ||
    (input.requiresEarlyAccess && !input.earlyAccessEnabled)
  )
    return { listed: false, enabled: false };
  return {
    listed: true,
    enabled:
      (input.availability === 'on'
        ? input.choice !== false
        : input.choice === true) && input.prerequisiteEnabled !== false,
  };
}

/** A Labs experiment both apps list, with its Labs row text. */
export interface SharedLabsExperiment {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** The experiment's `CLIENT_FEATURE_FLAGS` key. */
  readonly flagKey: ClientFeatureFlagKey;
}

export const COMPACT_QUEUE_EXPERIMENT: SharedLabsExperiment = {
  id: 'compact-queue',
  name: 'Compact queue',
  description:
    'Show queued messages as a short list above the composer that you can reorder.',
  // `CLIENT_FEATURE_FLAGS.canopyDesktopLabsCompactQueue.key`, checked in tests.
  flagKey: 'canopy-desktop-labs-compact-queue',
};

export const SMOOTH_STREAMING_EXPERIMENT: SharedLabsExperiment = {
  id: 'smooth-streaming',
  name: 'Smooth streaming',
  description:
    'Replies appear word by word at a steady pace as they stream in.',
  // `CLIENT_FEATURE_FLAGS.canopyDesktopLabsSmoothStreaming.key`, checked in tests.
  flagKey: 'canopy-desktop-labs-smooth-streaming',
};

/**
 * New Customize (CAN-6809): five tabs and one filter menu. Desktop lists it
 * in Settings → Labs; Portal follows the account's choice without listing it
 * (see {@link WEB_FOLLOWED_LABS_EXPERIMENTS}).
 */
export const CUSTOMIZE_DISCOVERY_EXPERIMENT: SharedLabsExperiment = {
  id: 'customize-discovery',
  name: 'New Customize',
  description: 'Simpler Customize with fewer tabs and one filter menu.',
  // `CLIENT_FEATURE_FLAGS.canopyDesktopLabsCustomizeDiscovery.key`.
  flagKey: 'canopy-desktop-labs-customize-discovery',
};

/**
 * Experiments web reads but does not list under account Labs: the account
 * switches them on from desktop Settings → Labs, and web follows that choice.
 * They never make web's Labs navigation visible.
 */
export const WEB_FOLLOWED_LABS_EXPERIMENTS: readonly SharedLabsExperiment[] = [
  CUSTOMIZE_DISCOVERY_EXPERIMENT,
];

/**
 * The experiments web lists under account Labs: the ones that change
 * something on web. Desktop lists its whole registry, which includes these.
 */
export const WEB_LABS_EXPERIMENTS: readonly SharedLabsExperiment[] = [];

/** One experiment account Labs lists, as the server resolved it. */
export const accountLabsExperimentSchema = z.strictObject({
  id: labsExperimentIdSchema,
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  enabled: z.boolean(),
});
/** `GET` and `PUT /api/account/labs`: the listed experiments, in order. */
export const accountLabsResponseSchema = z.strictObject({
  experiments: z.array(accountLabsExperimentSchema).max(100),
});
export type AccountLabsExperiment = z.output<
  typeof accountLabsExperimentSchema
>;
export type AccountLabsResponse = z.output<typeof accountLabsResponseSchema>;
