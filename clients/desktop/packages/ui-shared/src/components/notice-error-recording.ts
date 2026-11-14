import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import type { AppError, AppErrorCode } from '@canopy/protocol/app-errors';
import { recordSurfacedError } from '../lib/surfaced-error-port';
import { REPLAY_BLOCK_CLASS, REPLAY_MASK_CLASS } from '../lib/replay-privacy';

/** Which shared surface a destructive notice reports as. */
export type NoticeErrorChokePoint = 'notice' | 'banner';

const REPLAY_HIDDEN_SELECTOR = `.${REPLAY_BLOCK_CLASS}, .${REPLAY_MASK_CLASS}`;

function recordSighting(
  copy: Element,
  chokePoint: NoticeErrorChokePoint,
  identifier: string,
  displayErrorCode: AppErrorCode | undefined,
): void {
  recordSurfacedError({
    chokePoint,
    identifier,
    surface: chokePoint === 'banner' ? 'banner' : 'inline',
    ...(displayErrorCode === undefined ? {} : { displayErrorCode }),
    // Committed text, so a component child counts as what the user read.
    text: copy.textContent ?? '',
    // Text hidden from replay is not cleared for export by being on screen.
    textIsSensitive:
      copy.closest(REPLAY_HIDDEN_SELECTOR) !== null ||
      copy.querySelector(REPLAY_HIDDEN_SELECTOR) !== null,
  });
}

/**
 * Records a sighting of a notice's error after commit, returning the ref for
 * its copy element. `textKey` is what re-sights it: an update inside a child
 * component that the parent's text cannot see is not a new sighting.
 */
export function useNoticeErrorRecording({
  enabled,
  chokePoint,
  identifier,
  textKey,
  displayErrorCode,
}: {
  enabled: boolean;
  chokePoint: NoticeErrorChokePoint;
  identifier: string | undefined;
  textKey: string;
  displayErrorCode: AppErrorCode | undefined;
}): RefObject<HTMLDivElement | null> {
  const copyRef = useRef<HTMLDivElement>(null);
  const lastSighting = useRef<string | null>(null);
  useEffect(() => {
    const copy = copyRef.current;
    if (!enabled || !copy || !identifier) {
      lastSighting.current = null;
      return;
    }
    // StrictMode replays this effect with the same values and the same ref.
    const sighting = `${chokePoint}\u0000${identifier}\u0000${displayErrorCode ?? ''}\u0000${textKey}`;
    if (lastSighting.current === sighting) return;
    lastSighting.current = sighting;
    recordSighting(copy, chokePoint, identifier, displayErrorCode);
  }, [enabled, chokePoint, identifier, textKey, displayErrorCode]);
  return copyRef;
}

/**
 * Reference IDs this window already submitted, so remounting a banner for the
 * same failure (navigating away and back) is not a new sighting. Each maps to
 * the reference the host recorded it under: a repeat the host folded into an
 * earlier occurrence keeps that occurrence's reference, so a remounted banner
 * shows it again. Bounded; the oldest falls out first.
 */
const RECORDED_REFERENCES = new Map<string, string>();
const MAX_RECORDED_REFERENCES = 256;
/** Banners showing an error, told when one learns a canonical reference. */
const CANONICAL_LISTENERS = new Set<() => void>();

function subscribeCanonicalReferences(listener: () => void): () => void {
  CANONICAL_LISTENERS.add(listener);
  return (): void => {
    CANONICAL_LISTENERS.delete(listener);
  };
}

/** Test-only: forget submitted references between cases. */
export function resetAppErrorRecordingForTests(): void {
  RECORDED_REFERENCES.clear();
}

/**
 * Submits a structured error shown by a banner once per failure, after commit,
 * and returns the reference to show for it (`null` without an error). A repeat
 * inside the host handler's dedupe window shows the first occurrence's
 * reference, the one support finds in the error tracker (CAN-5956); anything
 * else shows the error's own. Recording runs after commit, so a repeat's first
 * paint shows its own reference and switches on the next render; a layout
 * effect would run before the web root installs its recorder. The text
 * recorder stays off for these: the error's own code and reference describe
 * it. Input errors and errors a handler already recorded are skipped here and
 * again by the handler; a new failure carries a new reference.
 */
export function useAppErrorRecording(
  error: AppError | null,
  {
    enabled,
    chokePoint,
    identifier,
  }: {
    enabled: boolean;
    chokePoint: NoticeErrorChokePoint;
    /** Stable source supplied by the caller. */
    identifier: string;
  },
): string | null {
  const own = error?.referenceId ?? null;
  // Every banner for this error, recording or not, re-renders when one learns
  // the canonical reference.
  const mapped = useSyncExternalStore(
    subscribeCanonicalReferences,
    () => (own === null ? undefined : RECORDED_REFERENCES.get(own)),
    () => undefined,
  );
  // Survives the map evicting this error's entry while the banner is shown.
  const [learned, setLearned] = useState<{
    readonly own: string;
    readonly canonical: string;
  } | null>(null);
  useEffect(() => {
    if (own === null || mapped === undefined || mapped === own) return;
    setLearned((prev) =>
      prev?.own === own && prev.canonical === mapped
        ? prev
        : { own, canonical: mapped },
    );
  }, [own, mapped]);
  useEffect(() => {
    if (!enabled || !error || !identifier) return;
    if (error.kind === 'input' || error.recordedBy !== undefined) return;
    // A remount, a StrictMode replay or another banner already recorded it.
    if (RECORDED_REFERENCES.has(error.referenceId)) return;
    if (RECORDED_REFERENCES.size >= MAX_RECORDED_REFERENCES) {
      const oldest = RECORDED_REFERENCES.keys().next();
      if (!oldest.done) RECORDED_REFERENCES.delete(oldest.value);
    }
    // Set before recording, so a replayed or re-entrant sighting is not new.
    RECORDED_REFERENCES.set(error.referenceId, error.referenceId);
    const report = recordSurfacedError({
      chokePoint,
      surface: chokePoint === 'banner' ? 'banner' : 'inline',
      identifier,
      error,
    });
    const canonical = report?.error.referenceId;
    if (canonical !== undefined && canonical !== error.referenceId) {
      RECORDED_REFERENCES.set(error.referenceId, canonical);
      for (const listener of CANONICAL_LISTENERS) listener();
    }
  }, [enabled, error, chokePoint, identifier]);
  if (own === null) return null;
  // The map wins while it has the entry; `learned` covers its eviction, and
  // `own` keeps a previous error's canonical reference off a new one.
  return mapped ?? (learned?.own === own ? learned.canonical : own);
}
