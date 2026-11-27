import { isRecord } from '../w5/commit-log/is-record';
import type { PreferencesDocument } from './document';

/*
 * The usage-data consent journal around a preferences document (CAN-7956):
 * the write-ahead record of revoked usage-data flows, so a revocation holds
 * through a failed save and a last-good recovery. Electron main keeps its own
 * copy (`usage-data-consent-document.ts`) until the owner flip; the usage-data
 * keys are injected because their list lives in execution-engine.
 */

export interface ConsentJournal<K extends string> {
  /** Denied keys; an unreadable journal denies every key. */
  read(): Promise<readonly K[]>;
  write(denied: readonly K[]): Promise<void>;
  /** Applies denials to the live usage-data policy before anything is written. */
  deny(denied: readonly K[]): void;
}

function deniedKeys<K extends string>(
  usageDataKeys: readonly K[],
  usage: unknown,
): K[] {
  return usageDataKeys.filter((key) => isRecord(usage) && usage[key] === false);
}

/** Records revocations before any primary-save bookkeeping can fail. */
export async function recordUsageDataRevocations<K extends string>(
  journal: ConsentJournal<K>,
  usageDataKeys: readonly K[],
  usage: unknown,
): Promise<readonly K[]> {
  const denied = deniedKeys(usageDataKeys, usage);
  const prior = await journal.read();
  const pending = [...new Set([...prior, ...denied])];
  if (pending.length) {
    journal.deny(pending);
    if (denied.some((key) => !prior.includes(key)))
      await journal.write(pending);
  }
  return pending;
}

function parseDocument(
  text: string,
): Record<string, unknown> & { preferences: Record<string, unknown> } {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || !isRecord(parsed.preferences))
    throw new Error('Invalid preferences consent document');
  return { ...parsed, preferences: parsed.preferences };
}

/** `document` with journaled revocations applied to every read and save. */
export function withUsageDataConsentJournal<K extends string>(
  document: PreferencesDocument,
  journal: ConsentJournal<K>,
  usageDataKeys: readonly K[],
): PreferencesDocument {
  return {
    ...document,
    async readText(slot): Promise<string> {
      const text = await document
        .readText(slot)
        .catch(async (error: unknown): Promise<string> => {
          // A retained revocation is existing consent state, not a fresh profile.
          if (
            slot === 'primary' &&
            isRecord(error) &&
            error.code === 'ENOENT' &&
            (await journal.read()).length &&
            !(await document.exists('lastGood'))
          )
            throw new Error(
              'Preferences missing while usage-data revocations remain',
            );
          throw error;
        });
      if (slot === 'generation') return text;
      const denied = await journal.read();
      if (!denied.length) return text;
      // Malformed bytes stay a parse failure the repository recovers from.
      let parsed: ReturnType<typeof parseDocument>;
      try {
        parsed = parseDocument(text);
      } catch {
        return text;
      }
      const preferences = parsed.preferences;
      parsed.preferences = {
        ...preferences,
        usageData: {
          ...(isRecord(preferences.usageData) ? preferences.usageData : {}),
          ...Object.fromEntries(denied.map((key) => [key, false])),
        },
      };
      return JSON.stringify(parsed);
    },
    async install(slot, content): Promise<void> {
      if (slot !== 'primary') return document.install(slot, content);
      const preferences = parseDocument(content).preferences;
      const denied = deniedKeys(usageDataKeys, preferences.usageData);
      const pending = await recordUsageDataRevocations(
        journal,
        usageDataKeys,
        preferences.usageData,
      );
      await document.install(slot, content);
      // Never lift a revocation before the allowing primary is durable.
      if (pending.some((key) => !denied.includes(key)))
        await journal.write(denied);
    },
  };
}
