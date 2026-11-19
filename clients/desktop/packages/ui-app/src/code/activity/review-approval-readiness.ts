'use client';

// ---------------------------------------------------------------------------
// Review approval readiness and the "Link GitHub" action (CAN-7162).
//
// Reads go through `CanopyClient.reviewApprovals`, present only where the host
// reports `capabilities.reviewApprovalReadiness`. Shared UI never asks which
// host it is on: it reads the capability and the port's outcomes.
//
// Cache (module level, so the PR section, the launch dialog and every
// repository share one read):
// - keyed by the port instance, run owner and lowercased `owner/name`; 60 s;
//   in-flight reads dedupe; errors are never cached. A web host builds a new
//   port for each signed-in user; a port that outlives a sign-in (desktop)
//   reports account changes through `subscribeAccountChange`, which clears
//   the cache;
// - invalidation clears everything and notifies every mounted hook, so all
//   notices update together after a link.
//
// A hook returns `null` (render nothing) while loading, on error, without the
// capability, for a personal run owner (no request) and for any state this
// build doesn't know.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from 'react';
import type { ReviewApprovalsClient } from '@canopy/app-core';
import { useOptionalCanopyClient } from '@canopy/app-state';
import {
  isReviewApprovalReadinessState,
  type ReviewApprovalReadiness,
  type ReviewApprovalReadinessInput,
} from '@canopy/protocol/settings/github-review-approvals';

export const REVIEW_APPROVAL_LINK_FAILED_COPY =
  "Couldn't link GitHub. Try again.";

const READINESS_TTL_MS = 60_000;

interface CacheEntry {
  readonly value: ReviewApprovalReadiness | null;
  readonly at: number;
}

const portIds = new WeakMap<ReviewApprovalsClient, number>();
let nextPortId = 1;
const entries = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ReviewApprovalReadiness | null>>();
const listeners = new Set<() => void>();
let generation = 0;

function portId(port: ReviewApprovalsClient): number {
  let id = portIds.get(port);
  if (id === undefined) {
    id = nextPortId;
    nextPortId += 1;
    portIds.set(port, id);
    // A port that outlives a sign-in (desktop) says when its account changes;
    // its answers belonged to the previous person. Kept for the port's life.
    port.subscribeAccountChange?.(invalidateReviewApprovalReadiness);
  }
  return id;
}

function inputKey(input: ReviewApprovalReadinessInput): string {
  return `${input.runOwner}|${input.repoOwner.toLowerCase()}/${input.repoName.toLowerCase()}`;
}

function cacheKey(
  port: ReviewApprovalsClient,
  input: ReviewApprovalReadinessInput,
): string {
  return `${portId(port)}|${inputKey(input)}`;
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** Drops every cached read and re-reads in every mounted hook. */
export function invalidateReviewApprovalReadiness(): void {
  generation += 1;
  entries.clear();
  inflight.clear();
  notify();
}

/** A state this build knows, or `null` (show nothing). */
function known(result: {
  state: string;
  organizationName: string | null;
}): ReviewApprovalReadiness | null {
  return isReviewApprovalReadinessState(result.state)
    ? { state: result.state, organizationName: result.organizationName }
    : null;
}

function readReadiness(
  port: ReviewApprovalsClient,
  input: ReviewApprovalReadinessInput,
  force: boolean,
): Promise<ReviewApprovalReadiness | null> {
  const key = cacheKey(port, input);
  const pending = inflight.get(key);
  if (pending !== undefined) return pending;
  const hit = entries.get(key);
  if (!force && hit !== undefined && Date.now() - hit.at < READINESS_TTL_MS) {
    return Promise.resolve(hit.value);
  }
  const started = generation;
  const read = port.readiness(input).then((result) => {
    const value = known(result);
    if (started === generation) {
      const previous = entries.get(key);
      entries.set(key, { value, at: Date.now() });
      // A forced refresh that changed the answer reaches every other hook.
      if (force && previous?.value?.state !== value?.state) notify();
    }
    return value;
  });
  const settled = read.finally(() => {
    if (inflight.get(key) === settled) inflight.delete(key);
  });
  inflight.set(key, settled);
  return settled;
}

function needsLink(value: ReviewApprovalReadiness | null): boolean {
  return (
    value?.state === 'connect_github' || value?.state === 'reconnect_github'
  );
}

/** The port, when this host serves readiness (none outside a provider). */
function useReviewApprovalsPort(): ReviewApprovalsClient | null {
  const client = useOptionalCanopyClient();
  return client?.capabilities.reviewApprovalReadiness === true
    ? (client.reviewApprovals ?? null)
    : null;
}

interface Tracked {
  readonly signature: string;
  readonly inputs: readonly ReviewApprovalReadinessInput[];
}

interface Answers {
  readonly signature: string;
  readonly values: readonly (ReviewApprovalReadiness | null)[];
}

const NO_ANSWERS: readonly (ReviewApprovalReadiness | null)[] = [];
const NO_INPUTS: readonly ReviewApprovalReadinessInput[] = [];

/**
 * Readiness for several repositories under run owners, in input order. Inputs
 * with a personal run owner are skipped without a request. The result is
 * empty until the reads land, and stays empty without the capability.
 */
export function useReviewApprovalReadinessList(
  inputs: readonly ReviewApprovalReadinessInput[],
): readonly (ReviewApprovalReadiness | null)[] {
  const port = useReviewApprovalsPort();
  const usable = inputs.filter((input) => input.runOwner !== 'personal');
  const signature = usable.map(inputKey).join('\n');
  const [tracked, setTracked] = useState<Tracked>({
    signature,
    inputs: usable,
  });
  if (tracked.signature !== signature) {
    setTracked({ signature, inputs: usable });
  }
  const [answers, setAnswers] = useState<Answers>({
    signature: '',
    values: NO_ANSWERS,
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const listener = (): void => setTick((value) => value + 1);
    listeners.add(listener);
    return (): void => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (port === null || tracked.inputs.length === 0) return undefined;
    let current = true;
    void Promise.all(
      tracked.inputs.map((input) =>
        readReadiness(port, input, false).catch(() => null),
      ),
    ).then((values) => {
      // A response for inputs that have since changed is discarded.
      if (current) setAnswers({ signature: tracked.signature, values });
    });
    return (): void => {
      current = false;
    };
  }, [port, tracked, tick]);

  // Back from linking elsewhere (the browser): re-read only what asked for it.
  const awaitingLink =
    answers.signature === tracked.signature && answers.values.some(needsLink);
  useEffect(() => {
    if (port === null || !awaitingLink) return undefined;
    const onFocus = (): void => {
      tracked.inputs.forEach((input, index) => {
        if (needsLink(answers.values[index] ?? null)) {
          void readReadiness(port, input, true).catch(() => null);
        }
      });
    };
    window.addEventListener('focus', onFocus);
    return (): void => {
      window.removeEventListener('focus', onFocus);
    };
  }, [port, awaitingLink, tracked, answers]);

  if (port === null || answers.signature !== tracked.signature) {
    return NO_ANSWERS;
  }
  return answers.values;
}

/** Readiness for one repository, or `null` (render nothing). */
export function useReviewApprovalReadiness(
  input: ReviewApprovalReadinessInput | null,
): ReviewApprovalReadiness | null {
  const values = useReviewApprovalReadinessList(
    input === null ? NO_INPUTS : [input],
  );
  return values[0] ?? null;
}

export interface ReviewApprovalLink {
  readonly link: () => void;
  readonly busy: boolean;
  /** Fixed copy for a failed link, shown in the notice. */
  readonly error: string | null;
}

interface SharedResume {
  readonly outcome: Promise<'none' | 'linked' | 'failed'>;
  settled: boolean;
}

const resumes = new WeakMap<ReviewApprovalsClient, SharedResume>();

/**
 * The port's resume, asked once per port. `linked` invalidates readiness once,
 * here, rather than once per mounted hook.
 */
function sharedResume(port: ReviewApprovalsClient): SharedResume {
  const existing = resumes.get(port);
  if (existing !== undefined) return existing;
  const resume: SharedResume = {
    outcome: port.resumeLink(),
    settled: false,
  };
  resumes.set(port, resume);
  resume.outcome.then(
    (outcome) => {
      resume.settled = true;
      if (outcome === 'linked') invalidateReviewApprovalReadiness();
    },
    () => {
      resume.settled = true;
    },
  );
  return resume;
}

/**
 * The "Link GitHub" action. On mount it awaits the shared resume (a link whose
 * GitHub round trip landed on this page); `linked` invalidates readiness so
 * every notice disappears together. A hook mounted after the resume settled
 * doesn't repeat its outcome.
 */
export function useReviewApprovalLink(): ReviewApprovalLink {
  const port = useReviewApprovalsPort();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (port === null) return undefined;
    const resume = sharedResume(port);
    if (resume.settled) return undefined;
    let current = true;
    resume.outcome.then(
      (outcome) => {
        if (outcome === 'failed' && current) {
          setError(REVIEW_APPROVAL_LINK_FAILED_COPY);
        }
      },
      () => {
        if (current) setError(REVIEW_APPROVAL_LINK_FAILED_COPY);
      },
    );
    return (): void => {
      current = false;
    };
  }, [port]);

  const link = useCallback((): void => {
    if (port === null || busy) return;
    setBusy(true);
    setError(null);
    const returnTo = `${window.location.pathname}${window.location.search}`;
    port.startLink({ returnTo }).then(
      (outcome) => {
        // `leaving`: stay busy until the page unloads.
        if (outcome === 'leaving') return;
        setBusy(false);
        if (outcome === 'linked') invalidateReviewApprovalReadiness();
      },
      () => {
        setBusy(false);
        setError(REVIEW_APPROVAL_LINK_FAILED_COPY);
      },
    );
  }, [port, busy]);

  return { link, busy, error };
}
