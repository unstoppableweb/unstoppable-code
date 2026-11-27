import { createHash } from 'node:crypto';
import {
  CORE_CONFIG_COMMITTED_EVENT,
  CORE_CONFIG_INVALIDATED_EVENT,
  CoreConfigCommittedPayloadSchema,
  CoreConfigInvalidatedPayloadSchema,
  type ConfigDocumentRevision,
  type CoreConfigInvalidatedPayload,
} from '@canopy/protocol/canopy-core/core';
import { stableStringify } from '@canopy/protocol/plans';
import type { CoreEventRecord } from '../../kernel/core-events-module';
import {
  createEventJournal,
  type EventJournal,
} from '../../kernel/event-journal';
import type {
  PreferencesChange,
  PreferencesRepositoryHooks,
} from './repository';

/*
 * The preference commit events (CAN-7956), served on `core.events.subscribe`
 * in the `core.config` family once a core serves the document. One
 * `core.config.committed` per applied write that changed the content
 * revision, appended in the repository's commit callback, so journal order
 * is commit order; `core.config.invalidated` when a save's outcome is
 * unknown or a recovery restored last-good over the document.
 */

/** The content revision of a persisted preferences record (`ConfigDocumentRevisionSchema`). */
export function configDocumentRevision(record: object): ConfigDocumentRevision {
  const digest = createHash('sha256')
    .update(stableStringify(record), 'utf8')
    .digest('hex');
  return `sha256:${digest}`;
}

/** Top-level keys whose value differs between two records, sorted. */
export function changedConfigKeys(previous: object, next: object): string[] {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return [...keys]
    .filter(
      (key) =>
        stableStringify(Reflect.get(previous, key)) !==
        stableStringify(Reflect.get(next, key)),
    )
    .sort();
}

export interface ConfigCommitEventsOptions {
  /** The runtime's `daemonEpoch`. */
  readonly epoch: string;
  readonly maxEntries?: number;
  readonly now?: () => Date;
}

export interface ConfigCommitEvents {
  /** Serve with `createCoreEventsModule`; its epoch is the runtime's. */
  readonly journal: EventJournal<CoreEventRecord>;
  /** Call in the repository's commit callback; skips an unchanged revision. */
  committed(change: PreferencesChange<object>, publishedBy?: string): void;
  invalidated(
    reason: CoreConfigInvalidatedPayload['reason'],
    commits?: readonly string[],
  ): void;
  /** Repository hooks that invalidate; compose them into the repository. */
  readonly hooks: Pick<
    PreferencesRepositoryHooks<object>,
    'onSaveOutcomeUnknown' | 'onRecovered'
  >;
}

export function createConfigCommitEvents(
  options: ConfigCommitEventsOptions,
): ConfigCommitEvents {
  const now = options.now ?? ((): Date => new Date());
  const journal = createEventJournal<CoreEventRecord>({
    epoch: options.epoch,
    maxEntries: options.maxEntries,
  });
  let sequence = 0;
  const invalidated: ConfigCommitEvents['invalidated'] = (reason, commits) => {
    journal.append({
      name: CORE_CONFIG_INVALIDATED_EVENT,
      scope: {},
      occurredAt: now().toISOString(),
      payload: CoreConfigInvalidatedPayloadSchema.parse({
        reason,
        ...(commits && commits.length > 0 && { commits: [...commits] }),
      }),
    });
  };
  return {
    journal,
    committed({ previous, next }, publishedBy): void {
      const previousRevision = configDocumentRevision(previous);
      const revision = configDocumentRevision(next);
      if (previousRevision === revision) return;
      sequence += 1;
      const commit = `config:${sequence}`;
      const payload = CoreConfigCommittedPayloadSchema.safeParse({
        commit,
        previousRevision,
        revision,
        keys: changedConfigKeys(previous, next),
        ...(publishedBy !== undefined && { publishedBy }),
      });
      if (!payload.success) {
        invalidated('uncertain', [commit]);
        return;
      }
      journal.append({
        name: CORE_CONFIG_COMMITTED_EVENT,
        scope: {},
        occurredAt: now().toISOString(),
        payload: payload.data,
      });
    },
    invalidated,
    hooks: {
      onSaveOutcomeUnknown: (): void => invalidated('uncertain'),
      onRecovered: (): void => invalidated('recovered'),
    },
  };
}
