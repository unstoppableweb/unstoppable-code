import { z } from 'zod';
import {
  EARLY_ACCESS_EXPERIMENT_ID,
  isLabsExperimentId,
  isLabsExperimentAvailability,
  LABS_EXPERIMENT_AVAILABILITIES,
  LABS_EXPERIMENT_AVAILABILITY_SOURCES,
  labsExperimentIdSchema,
  resolveLabsExperiment,
} from '@canopy/protocol/experiments';
import {
  CLIENT_FEATURE_FLAGS,
  isLabsExperimentFlagKey,
} from '@canopy/protocol/feature-flags';
import { SIDEBAR_NAV_ITEM_KEYS } from '@canopy/protocol/sidebar';
import { NAVIGATION_PAGE_MAP, type NavigationPage } from '../types';

export interface LabsExperiment {
  id: string;
  name: string;
  description: string;
  pages: readonly NavigationPage[];
  sidebarKeys: readonly string[];
  flagKey: string;
  /** When true the experiment is listed and enabled only while Early access is on. */
  requiresEarlyAccess: boolean;
  fixtureAvailability?: (typeof LABS_EXPERIMENT_AVAILABILITIES)[number];
}

/**
 * Next prompt suggestions: after a completed turn the provider predicts the
 * person's next message, and the empty composer offers it for Tab. Main reads
 * it before asking a provider for one; the composer before offering one.
 */
export const PROMPT_SUGGESTIONS_EXPERIMENT_ID = 'prompt-suggestions';
export const LABS_EXPERIMENTS: readonly LabsExperiment[] = [
  {
    id: EARLY_ACCESS_EXPERIMENT_ID,
    name: 'Early access',
    description:
      'Turn on features that are still being built. They may be unfinished or change without notice.',
    pages: [],
    sidebarKeys: [],
    flagKey: CLIENT_FEATURE_FLAGS.canopyDesktopLabsEarlyAccess.key,
    requiresEarlyAccess: false,
  },

  {
    id: 'sidebar',
    name: 'Sidebar',
    description:
      'Use compact sidebar rows, focused status indicators, chat titles and activity ages.',
    pages: [],
    sidebarKeys: [],
    flagKey: CLIENT_FEATURE_FLAGS.canopyDesktopLabsSidebar.key,
    requiresEarlyAccess: false,
  },

  {
    id: 'activity-card',
    name: 'Chat activity card',
    description:
      'Show Activity beside the chat and keep new chats in the main chat group.',
    pages: [],
    sidebarKeys: [],
    flagKey: CLIENT_FEATURE_FLAGS.canopyDesktopLabsActivityCard.key,
    requiresEarlyAccess: false,
  },
  {
    // Desktop only, so not in WEB_LABS_EXPERIMENTS.
    id: 'orchestrator-page',
    name: 'Orchestrator page',
    description:
      'Open the Orchestrator as a page beside the sidebar, like other chats, with its chats under its sidebar row.',
    pages: [],
    sidebarKeys: [],
    flagKey: CLIENT_FEATURE_FLAGS.canopyDesktopLabsOrchestratorPage.key,
    requiresEarlyAccess: false,
  },
  {
    // Desktop only, so not in WEB_LABS_EXPERIMENTS.
    id: PROMPT_SUGGESTIONS_EXPERIMENT_ID,
    name: 'Next prompt suggestions',
    description:
      'After a Claude or Codex turn, show a likely next message in the empty composer. Press Tab to use it. Each suggestion is a small extra request.',
    pages: [],
    sidebarKeys: [],
    flagKey: CLIENT_FEATURE_FLAGS.canopyDesktopLabsPromptSuggestions.key,
    requiresEarlyAccess: false,
  },

  {
    id: 'overview-page',
    name: 'Overview',
    description: 'Every project and worktree at a glance.',
    pages: ['overview'],
    sidebarKeys: ['overview'],
    flagKey: CLIENT_FEATURE_FLAGS.canopyDesktopLabsOverviewPage.key,
    requiresEarlyAccess: false,
  },
  {
    id: 'kanban-page',
    name: 'Kanban',
    description: 'A board of your worktrees.',
    pages: ['kanban'],
    sidebarKeys: ['kanban'],
    flagKey: CLIENT_FEATURE_FLAGS.canopyDesktopLabsKanbanPage.key,
    requiresEarlyAccess: false,
  },
  {
    id: 'statistics-page',
    name: 'Statistics',
    description: 'Token, cost and tool charts from this computer.',
    pages: ['statistics'],
    sidebarKeys: ['statistics'],
    flagKey: CLIENT_FEATURE_FLAGS.canopyDesktopLabsStatisticsPage.key,
    requiresEarlyAccess: false,
  },
  {
    id: 'audit-trail-page',
    // Matches the sidebar row label for `audit`.
    name: 'Audit trail',
    description: 'A log of what agents did.',
    pages: ['audit'],
    sidebarKeys: ['audit'],
    flagKey: CLIENT_FEATURE_FLAGS.canopyDesktopLabsAuditTrailPage.key,
    requiresEarlyAccess: false,
  },
];

export function validateLabsExperiments(
  entries: readonly LabsExperiment[],
  allowFixtures = false,
): void {
  const ids = new Set<string>();
  const flags = new Set<string>();
  const pages = new Set<string>();
  const keys = new Set<string>();
  for (const entry of entries) {
    if (
      !isLabsExperimentId(entry.id) ||
      ids.has(entry.id) ||
      flags.has(entry.flagKey) ||
      !entry.name.trim() ||
      !entry.description.trim()
    )
      throw new Error('Invalid or duplicate experiment metadata.');
    ids.add(entry.id);
    flags.add(entry.flagKey);
    const flag = Object.values(CLIENT_FEATURE_FLAGS).find(
      (flag) => flag.key === entry.flagKey,
    );
    if (entry.fixtureAvailability !== undefined) {
      if (
        !allowFixtures ||
        !isLabsExperimentAvailability(entry.fixtureAvailability)
      )
        throw new Error('Invalid fixture availability.');
    } else if (
      !flag ||
      // Main and preload validate a flag's values as availabilities only
      // when it is in `LABS_EXPERIMENT_FLAG_KEYS`.
      !isLabsExperimentFlagKey(entry.flagKey) ||
      !isLabsExperimentAvailability(flag.launchDarklyDisabledDefaultValue) ||
      !isLabsExperimentAvailability(flag.launchDarklyEnabledUnavailableValue)
    )
      throw new Error('Invalid experiment flag defaults.');
    if (
      entry.id === EARLY_ACCESS_EXPERIMENT_ID &&
      (entry.pages.length || entry.sidebarKeys.length)
    )
      throw new Error('Early access cannot own navigation.');
    if (entry.id === EARLY_ACCESS_EXPERIMENT_ID && entry.requiresEarlyAccess)
      throw new Error('Early access cannot require itself.');
    for (const page of entry.pages) {
      if (
        !Object.prototype.hasOwnProperty.call(NAVIGATION_PAGE_MAP, page) ||
        pages.has(page)
      )
        throw new Error('Invalid or duplicate experiment page.');
      pages.add(page);
    }
    for (const key of entry.sidebarKeys) {
      if (!SIDEBAR_NAV_ITEM_KEYS.includes(key) || keys.has(key))
        throw new Error('Invalid or duplicate experiment sidebar key.');
      keys.add(key);
    }
  }
}
validateLabsExperiments(LABS_EXPERIMENTS);
export function findLabsExperimentForPage(
  page: NavigationPage,
  entries: readonly LabsExperiment[] = LABS_EXPERIMENTS,
): LabsExperiment | undefined {
  return entries.find((entry) => entry.pages.includes(page));
}

const experimentMetadataSchema = z.strictObject({
  id: labsExperimentIdSchema,
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  pages: z.array(
    z.custom<NavigationPage>(
      (value) =>
        typeof value === 'string' &&
        Object.prototype.hasOwnProperty.call(NAVIGATION_PAGE_MAP, value),
    ),
  ),
  sidebarKeys: z.array(
    z.string().refine((key) => SIDEBAR_NAV_ITEM_KEYS.includes(key)),
  ),
  flagKey: z.string().min(1).max(200),
  requiresEarlyAccess: z.boolean(),
  fixtureAvailability: z.enum(LABS_EXPERIMENT_AVAILABILITIES).optional(),
});
export const labsExperimentsSnapshotSchema = z
  .strictObject({
    generation: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    scope: z.string(),
    ready: z.boolean(),
    choicesReady: z.boolean(),
    earlyAccessEnabled: z.boolean(),
    updatedAt: z.iso.datetime(),
    experiments: z
      .array(
        experimentMetadataSchema.extend({
          availability: z.enum(LABS_EXPERIMENT_AVAILABILITIES),
          // Older snapshots lack provenance; main always emits it now.
          availabilitySource: z
            .enum(LABS_EXPERIMENT_AVAILABILITY_SOURCES)
            .optional(),
          choice: z.boolean().nullable(),
          listed: z.boolean(),
          enabled: z.boolean(),
        }),
      )
      .max(100),
  })
  .superRefine((snapshot, context): void => {
    try {
      validateLabsExperiments(snapshot.experiments, true);
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Invalid experiment registry.',
      });
    }
    const early = snapshot.experiments.find(
      (entry) => entry.id === EARLY_ACCESS_EXPERIMENT_ID,
    );
    if (!early || snapshot.earlyAccessEnabled !== early.enabled)
      context.addIssue({
        code: 'custom',
        message: 'Invalid Early access projection.',
      });
    for (const entry of snapshot.experiments) {
      const resolved = snapshot.ready
        ? resolveLabsExperiment({
            availability: entry.availability,
            choice: entry.choice,
            earlyAccessEnabled: snapshot.earlyAccessEnabled,
            requiresEarlyAccess: entry.requiresEarlyAccess,
          })
        : { listed: false, enabled: false };
      if (
        entry.listed !== resolved.listed ||
        entry.enabled !== resolved.enabled
      )
        context.addIssue({
          code: 'custom',
          message: 'Invalid effective experiment state.',
        });
    }
  });
export type LabsExperimentsSnapshot = z.output<
  typeof labsExperimentsSnapshotSchema
>;
export function hiddenLabsSidebarKeys(
  snapshot: LabsExperimentsSnapshot | null,
  entries: readonly LabsExperiment[] = LABS_EXPERIMENTS,
): string[] {
  return entries
    .filter(
      (entry) =>
        !snapshot?.ready ||
        !snapshot.experiments.find((state) => state.id === entry.id)?.enabled,
    )
    .flatMap((entry) => [...entry.sidebarKeys]);
}

/**
 * Every sidebar key an experiment in `entries` owns, once each, in registry
 * order. The sidebar marks these rows with the Labs marker. Enabled state does
 * not matter: a key whose experiment is off is hidden and never renders, and a
 * key whose experiment leaves the registry stops being owned.
 */
export function labsOwnedSidebarKeys(
  entries: readonly LabsExperiment[] = LABS_EXPERIMENTS,
): string[] {
  return Array.from(
    new Set(entries.flatMap((entry) => [...entry.sidebarKeys])),
  );
}
export function parseLabsExperimentFixtures(value: unknown): LabsExperiment[] {
  const entries = z
    .array(
      experimentMetadataSchema.extend({
        // Fixtures predate independent experiments, so they stay gated by
        // Early access unless they opt out.
        requiresEarlyAccess: z.boolean().default(true),
        fixtureAvailability: z.enum(LABS_EXPERIMENT_AVAILABILITIES),
      }),
    )
    // Registry plus fixtures must fit the snapshot's 100-entry cap.
    .max(100 - LABS_EXPERIMENTS.length)
    .parse(value);
  validateLabsExperiments([...LABS_EXPERIMENTS, ...entries], true);
  return entries;
}
