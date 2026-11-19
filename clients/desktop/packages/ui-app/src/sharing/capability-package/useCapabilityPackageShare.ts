'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  PipelinePackageAnalysisSummary,
  PipelinePackageInvocationDismissal,
  PipelinePackageManifestV1,
  PipelinePackageProgressEvent,
  PipelinePackageReferenceDismissal,
} from '@canopy/protocol/pipelines';
import {
  sameInvocationSet,
  sameReferenceSet,
} from './capability-package-blockers';

/**
 * How the share dialog reaches a host's dependency analysis. The desktop
 * binds IPC; a host without local analysis (the web portal today) passes no
 * port and the dialog renders the "dependencies are not included" note.
 *
 * The port's identity is the analysis key: a host memoizes it over what it
 * analyzes (the pipeline document, the skill folder) and a new port re-runs
 * the analysis. An unstable port re-analyzes on every render.
 */
export interface CapabilityPackageSharePort {
  readonly analyze: (request: {
    dismissedInvocations?: readonly PipelinePackageInvocationDismissal[];
    /** Pipeline references the author marked as not dependencies. */
    dismissedReferences?: readonly PipelinePackageReferenceDismissal[];
    /**
     * Keys of the optional (name-matched) pipelines the author selected.
     * Absent until the author changes one; the host then sends none.
     */
    pipelineSelections?: readonly string[];
  }) => Promise<PipelinePackageAnalysisSummary>;
  /** Releases a main-side analysis record the dialog no longer needs. */
  readonly cancel?: (analysisId: string) => Promise<void>;
  /** Stage/count progress while the host's `share()` commits the package. */
  readonly subscribeProgress?: (
    listener: (event: PipelinePackageProgressEvent) => void,
  ) => () => void;
  /**
   * Whether the manifest carries anything beyond the subject itself. Defaults
   * to "any resource or environment requirement". A skill passes its own
   * rule because its analysis always binds its own SKILL.md.
   */
  readonly hasContent?: (
    manifest: PipelinePackageManifestV1 | undefined,
  ) => boolean;
}

/**
 * Rejected by a port's `analyze()` to say why the analysis failed. The dialog
 * shows the message beneath its generic failure copy. Any other rejection
 * shows the generic copy alone, so a host opts in only with a message worth
 * showing the author.
 */
export class CapabilityPackageAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityPackageAnalysisError';
  }
}

/** What the host's `share()` commits; `null` when there is nothing to package. */
export interface CapabilityPackageSelection {
  readonly analysisId: string;
  readonly selectedOptionalResourceIds: readonly string[];
  /** The reviewed analysis, so the host can check what it is committing. */
  readonly analysis: PipelinePackageAnalysisSummary;
}

export interface UseCapabilityPackageShareOptions {
  port: CapabilityPackageSharePort | null;
  /** False until the account is ready; nothing is analyzed before then. */
  enabled: boolean;
}

export interface CapabilityPackageShareState {
  readonly active: boolean;
  readonly analysis: PipelinePackageAnalysisSummary | null;
  readonly analyzing: boolean;
  readonly failed: boolean;
  /** Why the last analysis failed, when the host said; otherwise null. */
  readonly failureReason: string | null;
  readonly progress: PipelinePackageProgressEvent | null;
  readonly selectedOptionalResourceIds: readonly string[];
  readonly dismissedInvocations: readonly PipelinePackageInvocationDismissal[];
  readonly dismissedReferences: readonly PipelinePackageReferenceDismissal[];
  /** Keys of the optional packaged pipelines that ship with the share. */
  readonly selectedPipelineKeys: readonly string[];
  /** True when the review has something to disclose and should render. */
  readonly relevant: boolean;
  /** True when the analysis found files or requirements to carry. */
  readonly hasContent: boolean;
  /** True while Share must wait: analyzing, failed, or blocked. */
  readonly blocked: boolean;
  /** Not blocked. Pressing Share is the publication decision. */
  readonly ready: boolean;
  readonly toggleOptionalResource: (resourceId: string) => void;
  readonly dismissInvocation: (
    dismissal: PipelinePackageInvocationDismissal,
  ) => void;
  readonly restoreInvocation: (
    dismissal: PipelinePackageInvocationDismissal,
  ) => void;
  readonly dismissReference: (
    dismissal: PipelinePackageReferenceDismissal,
  ) => void;
  readonly restoreReference: (
    dismissal: PipelinePackageReferenceDismissal,
  ) => void;
  /** Includes or leaves out an optional pipeline; re-runs the analysis. */
  readonly togglePipeline: (key: string) => void;
  readonly retry: () => void;
  readonly resetProgress: () => void;
  /** The selection to commit, or null when there is nothing to package. */
  readonly selection: () => CapabilityPackageSelection | null;
}

function defaultHasContent(
  manifest: PipelinePackageManifestV1 | undefined,
): boolean {
  if (!manifest) return false;
  return (
    manifest.resources.length > 0 || manifest.environmentRequirements.length > 0
  );
}

function sameDismissal(
  a: PipelinePackageInvocationDismissal,
  b: PipelinePackageInvocationDismissal,
): boolean {
  return a.provider === b.provider && a.token === b.token;
}

function sameReference(
  a: PipelinePackageReferenceDismissal,
  b: PipelinePackageReferenceDismissal,
): boolean {
  return a.kind === b.kind && a.token === b.token;
}

/** Optional pipelines the analysis packaged, so the ones that ship. */
function shippedOptionalPipelineKeys(
  summary: PipelinePackageAnalysisSummary | null,
): string[] {
  const resources = summary?.manifest?.resources ?? [];
  return (summary?.packagedPipelines ?? [])
    .filter(
      (pipeline) =>
        pipeline.optional &&
        resources.some((resource) => resource.id === pipeline.resourceId),
    )
    .map((pipeline) => pipeline.key);
}

/**
 * The dependency-review state every share dialog uses, in one canonical
 * version: analysis with late-result cancellation, pending vs echoed
 * dismissals, optional-resource pruning after re-analysis, blocked/ready
 * gating, retry, and commit progress.
 *
 * Commit stays with the host's `share()` (a pipeline commits and creates in
 * one call); this hook only hands it {@link CapabilityPackageShareState.selection}.
 */
export function useCapabilityPackageShare({
  port,
  enabled,
}: UseCapabilityPackageShareOptions): CapabilityPackageShareState {
  const active = port !== null && enabled;
  const [analysis, setAnalysis] =
    useState<PipelinePackageAnalysisSummary | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [failureReason, setFailureReason] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selectedOptionalResourceIds, setSelectedOptionalResourceIds] =
    useState<string[]>([]);
  const [progress, setProgress] = useState<PipelinePackageProgressEvent | null>(
    null,
  );
  // Tokens the author marked as not commands. `pending` is what the next
  // analysis sends; `echoed` is what main reported it actually suppressed.
  // Main is authoritative, so a dismissal never fabricates readiness.
  const [pendingDismissals, setPendingDismissals] = useState<
    PipelinePackageInvocationDismissal[] | null
  >(null);
  const [echoedDismissals, setEchoedDismissals] = useState<
    PipelinePackageInvocationDismissal[]
  >([]);
  const echoedRef = useRef(echoedDismissals);
  echoedRef.current = echoedDismissals;
  // The same pending/echoed pair for pipeline references.
  const [pendingReferences, setPendingReferences] = useState<
    PipelinePackageReferenceDismissal[] | null
  >(null);
  const [echoedReferences, setEchoedReferences] = useState<
    PipelinePackageReferenceDismissal[]
  >([]);
  const echoedReferencesRef = useRef(echoedReferences);
  echoedReferencesRef.current = echoedReferences;
  // Null until the author changes an optional pipeline; then the next
  // analysis packages exactly these keys.
  const [pendingPipelineKeys, setPendingPipelineKeys] = useState<
    string[] | null
  >(null);
  const [shippedPipelineKeys, setShippedPipelineKeys] = useState<string[]>([]);
  const shippedPipelineKeysRef = useRef(shippedPipelineKeys);
  shippedPipelineKeysRef.current = shippedPipelineKeys;
  const previousPortRef = useRef(port);
  const portChanged = previousPortRef.current !== port;
  const analysisDismissals = portChanged ? null : pendingDismissals;
  const analysisReferences = portChanged ? null : pendingReferences;
  const analysisPipelineKeys = portChanged ? null : pendingPipelineKeys;
  previousPortRef.current = port;

  useEffect(() => {
    setSelectedOptionalResourceIds([]);
    setPendingDismissals(null);
    setEchoedDismissals([]);
    setPendingReferences(null);
    setEchoedReferences([]);
    setPendingPipelineKeys(null);
    setShippedPipelineKeys([]);
  }, [port]);

  useEffect(() => {
    if (!active || port === null) {
      setAnalysis(null);
      setAnalyzing(false);
      setFailed(false);
      setFailureReason(null);
      return undefined;
    }
    let cancelled = false;
    let startedAnalysisId: string | null = null;
    setAnalyzing(true);
    setFailed(false);
    setFailureReason(null);
    void port
      .analyze({
        ...(analysisDismissals !== null
          ? { dismissedInvocations: analysisDismissals }
          : {}),
        ...(analysisReferences !== null
          ? { dismissedReferences: analysisReferences }
          : {}),
        ...(analysisPipelineKeys !== null
          ? { pipelineSelections: analysisPipelineKeys }
          : {}),
      })
      .then((summary) => {
        if (cancelled) {
          // Cleanup already ran before this analysis existed, so it could not
          // cancel it. Release the main-side record here instead.
          void port.cancel?.(summary.analysisId).catch(() => {});
          return;
        }
        startedAnalysisId = summary.analysisId;
        setAnalysis(summary);
        setFailed(false);
        // Optional ids belong to the analysis that produced them.
        setSelectedOptionalResourceIds((current) =>
          current.length === 0
            ? current
            : current.filter((id) =>
                summary.manifest?.resources.some(
                  (resource) => resource.id === id,
                ),
              ),
        );
        const echoed = summary.dismissedInvocations ?? [];
        setEchoedDismissals(echoed);
        setPendingDismissals((current) =>
          current === null || sameInvocationSet(current, echoed)
            ? current
            : echoed,
        );
        const echoedRefs = summary.dismissedReferences ?? [];
        setEchoedReferences(echoedRefs);
        setPendingReferences((current) =>
          current === null || sameReferenceSet(current, echoedRefs)
            ? current
            : echoedRefs,
        );
        // Main is authoritative here too: a key it could not package (the
        // pipeline vanished) is not reported as shipping.
        setShippedPipelineKeys(shippedOptionalPipelineKeys(summary));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // Main may have refused the dismissals this request carried; resending
        // them would fail the same way. Fall back to the last set main
        // accepted, which re-runs the analysis without them.
        setPendingDismissals((current) =>
          current === null || sameInvocationSet(current, echoedRef.current)
            ? current
            : null,
        );
        setPendingReferences((current) =>
          current === null ||
          sameReferenceSet(current, echoedReferencesRef.current)
            ? current
            : null,
        );
        setAnalysis(null);
        setFailed(true);
        setFailureReason(
          error instanceof CapabilityPackageAnalysisError &&
            error.message.trim()
            ? error.message.trim()
            : null,
        );
      })
      .finally(() => {
        if (!cancelled) setAnalyzing(false);
      });
    return (): void => {
      cancelled = true;
      if (startedAnalysisId !== null) {
        void port.cancel?.(startedAnalysisId).catch(() => {});
      }
    };
  }, [
    active,
    analysisDismissals,
    analysisPipelineKeys,
    analysisReferences,
    attempt,
    port,
  ]);

  useEffect(() => {
    if (!active || port?.subscribeProgress === undefined) return undefined;
    return port.subscribeProgress(setProgress);
  }, [active, port]);

  const manifest = analysis?.manifest;
  const hasContentFn = port?.hasContent ?? defaultHasContent;
  const hasContent = active && hasContentFn(manifest);
  const dismissedInvocations = pendingDismissals ?? echoedDismissals;
  const dismissedReferences = pendingReferences ?? echoedReferences;
  const selectedPipelineKeys = pendingPipelineKeys ?? shippedPipelineKeys;
  const relevant =
    active &&
    (analyzing ||
      failed ||
      analysis !== null ||
      dismissedInvocations.length > 0 ||
      dismissedReferences.length > 0);
  const blocked =
    active &&
    (analyzing ||
      failed ||
      analysis === null ||
      analysis.state !== 'ready' ||
      analysis.blockers.length > 0);
  const ready = !blocked;

  const toggleOptionalResource = useCallback((resourceId: string): void => {
    setSelectedOptionalResourceIds((current) =>
      current.includes(resourceId)
        ? current.filter((id) => id !== resourceId)
        : [...current, resourceId],
    );
  }, []);

  const dismissInvocation = useCallback(
    (dismissal: PipelinePackageInvocationDismissal): void => {
      setPendingDismissals((current) => {
        const base = current ?? echoedRef.current;
        // Returning `base` for a null `current` would still flip null to an
        // array and restart a live analysis for a no-op.
        if (base.some((entry) => sameDismissal(entry, dismissal))) {
          return current;
        }
        return [...base, dismissal];
      });
    },
    [],
  );

  const restoreInvocation = useCallback(
    (dismissal: PipelinePackageInvocationDismissal): void => {
      setPendingDismissals((current) => {
        const base = current ?? echoedRef.current;
        const next = base.filter((entry) => !sameDismissal(entry, dismissal));
        return next.length === base.length ? current : next;
      });
    },
    [],
  );

  const dismissReference = useCallback(
    (dismissal: PipelinePackageReferenceDismissal): void => {
      setPendingReferences((current) => {
        const base = current ?? echoedReferencesRef.current;
        if (base.some((entry) => sameReference(entry, dismissal))) {
          return current;
        }
        return [...base, dismissal];
      });
    },
    [],
  );

  const restoreReference = useCallback(
    (dismissal: PipelinePackageReferenceDismissal): void => {
      setPendingReferences((current) => {
        const base = current ?? echoedReferencesRef.current;
        const next = base.filter((entry) => !sameReference(entry, dismissal));
        return next.length === base.length ? current : next;
      });
    },
    [],
  );

  const togglePipeline = useCallback((key: string): void => {
    setPendingPipelineKeys((current) => {
      const base = current ?? shippedPipelineKeysRef.current;
      return base.includes(key)
        ? base.filter((entry) => entry !== key)
        : [...base, key];
    });
  }, []);

  const retry = useCallback((): void => {
    setAttempt((value) => value + 1);
  }, []);

  const resetProgress = useCallback((): void => {
    setProgress(null);
  }, []);

  const selection = useCallback((): CapabilityPackageSelection | null => {
    if (!active || analysis === null || analysis.state !== 'ready') {
      return null;
    }
    if (!hasContent) return null;
    return {
      analysisId: analysis.analysisId,
      selectedOptionalResourceIds,
      analysis,
    };
  }, [active, analysis, hasContent, selectedOptionalResourceIds]);

  return {
    active,
    analysis,
    analyzing,
    failed,
    failureReason,
    progress,
    selectedOptionalResourceIds,
    dismissedInvocations,
    dismissedReferences,
    selectedPipelineKeys,
    relevant,
    hasContent,
    blocked,
    ready,
    toggleOptionalResource,
    dismissInvocation,
    restoreInvocation,
    dismissReference,
    restoreReference,
    togglePipeline,
    retry,
    resetProgress,
    selection,
  };
}
