import { useCallback, useEffect, useRef, useState } from 'react';
import {
  linkRecordedError,
  recordedErrorOf,
  recordSurfacedError,
  type UnifiedPluginEntry,
} from '@canopy/ui-shared/lib';

/** Page-scoped checks and successful mutations are separate from list freshness. */
export function useCustomizeSkillUpdates(refresh: () => Promise<void>): {
  project: (entry: UnifiedPluginEntry) => UnifiedPluginEntry;
  update: (entry: UnifiedPluginEntry) => Promise<void>;
  error: string | null;
  /** Main already recorded the failures `error` shows, so its banner records nothing. */
  errorRecorded: boolean;
  reportFailures: (failures: readonly { error: unknown }[]) => void;
} {
  const [checked, setChecked] = useState<Readonly<Record<string, boolean>>>({});
  const completed = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const [errorRecorded, setErrorRecorded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    // This is deliberately nonblocking and runs once per page mount.
    void window.skills
      .checkUpdates()
      .then((result) => {
        if (!cancelled && result.success && result.data)
          setChecked(result.data);
      })
      .catch(() => undefined);
    return (): void => {
      cancelled = true;
    };
  }, []);
  const project = useCallback(
    (entry: UnifiedPluginEntry): UnifiedPluginEntry => {
      if (entry.ref.type !== 'skill') return entry;
      const key = `${entry.ref.sourceId}/${entry.ref.skillName}`;
      return {
        ...entry,
        updateAvailable:
          !entry.builtIn &&
          !entry.custom &&
          !completed.current.has(key) &&
          (checked[key] ?? entry.updateAvailable) === true,
      };
    },
    [checked],
  );
  const update = useCallback(
    async (entry: UnifiedPluginEntry): Promise<void> => {
      if (entry.ref.type !== 'skill' || entry.builtIn || entry.custom) return;
      const { sourceId, skillName } = entry.ref;
      const key = `${sourceId}/${skillName}`;
      if (completed.current.has(key)) return;
      setError(null);
      setErrorRecorded(false);
      const result = await window.skills.updateSkill(sourceId, skillName);
      if (!result.success)
        throw Object.assign(
          new Error(result.error || `Couldn’t update ${entry.name}.`),
          { appError: result.appError },
        );
      // Keep the successful marker through stale lists and a late check, even
      // if refreshing fails. A new page mount may discover a subsequent version.
      completed.current.add(key);
      setChecked((previous) => ({ ...previous, [key]: false }));
      try {
        await refresh();
      } catch {
        setErrorRecorded(false);
        setError(
          'Updated the skill, but couldn’t refresh installed items. Try again.',
        );
      }
    },
    [refresh],
  );
  const reportFailures = useCallback(
    (failures: readonly { error: unknown }[]): void => {
      // A failure main recorded is linked to this session, not recorded again.
      // With one among them the banner records nothing, so the others are
      // recorded here instead.
      const recorded = failures.some(({ error: failure }) =>
        recordedErrorOf(failure),
      );
      if (recorded)
        for (const { error: failure } of failures) {
          if (recordedErrorOf(failure))
            linkRecordedError(failure, 'plugins-page-skill-updates');
          else
            recordSurfacedError({
              chokePoint: 'notice',
              surface: 'inline',
              identifier: 'plugins-page-skill-updates',
              error: failure,
            });
        }
      setErrorRecorded(recorded);
      setError(
        failures
          .map(({ error: failure }) =>
            failure instanceof Error ? failure.message : String(failure),
          )
          .join('\n'),
      );
    },
    [],
  );
  return { project, update, error, errorRecorded, reportFailures };
}
