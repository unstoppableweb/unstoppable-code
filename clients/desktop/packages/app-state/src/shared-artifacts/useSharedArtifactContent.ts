import { useCallback, useEffect, useRef, useState } from 'react';
import type { SharedArtifactsClient } from '@canopy/app-core';
import type {
  SharedArtifact,
  SharedArtifactGetResult,
} from '@canopy/protocol/canopy-core';
import {
  MAX_SHARED_ARTIFACT_BYTES,
  type SharedArtifactMediaType,
} from '@canopy/protocol/shared-artifacts';
import {
  resolveSharedArtifactMediaType,
  sharedArtifactSha256,
} from './shared-artifact-content-rules';
import {
  toSharedArtifactFailure,
  type SharedArtifactFailure,
} from './useSharedArtifact';

export type SharedArtifactContentFailureReason =
  /** Over `MAX_SHARED_ARTIFACT_BYTES`. */
  | 'tooLarge'
  /** The bytes kept disagreeing with the DTO's hash after one reload and one refetch. */
  | 'mismatch'
  /** Any other read failure. */
  | 'unavailable';

export type SharedArtifactContentState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly bytes: Uint8Array;
      readonly mediaType: SharedArtifactMediaType;
      /** The revision hash the bytes were checked against. */
      readonly sha256: string;
    }
  | {
      readonly status: 'failed';
      readonly reason: SharedArtifactContentFailureReason;
      readonly failure?: SharedArtifactFailure;
    };

export interface UseSharedArtifactContentOptions {
  /**
   * Receives the DTO the hash check re-read, so the viewer shows the
   * revision the bytes belong to. Applied before the hook settles on it, so
   * the change does not start another read.
   */
  readonly onArtifactRefreshed?: (result: SharedArtifactGetResult) => void;
}

export interface UseSharedArtifactContentResult {
  readonly content: SharedArtifactContentState;
  readonly retry: () => void;
}

interface Settled {
  readonly key: string;
  readonly state: SharedArtifactContentState;
}

function contentKey(
  artifactId: string,
  sha256: string,
  attempt: number,
): string {
  return `${artifactId}:${sha256}:${attempt}`;
}

function isTooLarge(failure: SharedArtifactFailure): boolean {
  return failure.code === 'core.sharedArtifact.tooLarge';
}

/**
 * Reads an artifact's latest revision (CAN-8017): abort on unmount and on an
 * id change, a second size guard, media type resolution against the DTO, and
 * the hash check. On a mismatch a republish landed between the two reads, so
 * it re-reads the DTO once, then the bytes once more; if they still disagree
 * it fails. It never loops.
 *
 * Pass `null` for an artifact whose content must not be read (taken down).
 */
export function useSharedArtifactContent(
  client: SharedArtifactsClient | null,
  artifact: SharedArtifact | null,
  options: UseSharedArtifactContentOptions = {},
): UseSharedArtifactContentResult {
  const [content, setContent] = useState<SharedArtifactContentState>({
    status: 'idle',
  });
  const [attempt, setAttempt] = useState(0);
  const settledRef = useRef<Settled | null>(null);
  const artifactRef = useRef(artifact);
  artifactRef.current = artifact;
  const refreshedRef = useRef(options.onArtifactRefreshed);
  refreshedRef.current = options.onArtifactRefreshed;

  const artifactId = artifact?.id ?? null;
  const expectedSha = artifact?.latestRevision.sha256 ?? null;

  useEffect(() => {
    if (client === null || artifactId === null || expectedSha === null) {
      setContent({ status: 'idle' });
      return undefined;
    }
    const settled = settledRef.current;
    if (settled?.key === contentKey(artifactId, expectedSha, attempt)) {
      setContent(settled.state);
      return undefined;
    }
    const controller = new AbortController();
    const { signal } = controller;
    const settle = (sha: string, state: SharedArtifactContentState): void => {
      if (signal.aborted) return;
      settledRef.current = { key: contentKey(artifactId, sha, attempt), state };
      setContent(state);
    };
    const fail = (sha: string, error: unknown): void => {
      // Only this hook's own abort is silent; any other failure, including
      // a `cancelled` the hook didn't cause, settles so retry is offered.
      if (signal.aborted) return;
      const failure = toSharedArtifactFailure(error);
      settle(sha, {
        status: 'failed',
        reason: isTooLarge(failure) ? 'tooLarge' : 'unavailable',
        failure,
      });
    };
    const read = async (): Promise<{
      bytes: Uint8Array;
      header: string | null;
      hash: string | null;
    } | null> => {
      const response = await client.readContent(artifactId, signal);
      if (signal.aborted) return null;
      if (response.bytes.byteLength > MAX_SHARED_ARTIFACT_BYTES) {
        settle(expectedSha, { status: 'failed', reason: 'tooLarge' });
        return null;
      }
      const hash = await sharedArtifactSha256(response.bytes);
      if (signal.aborted) return null;
      return { bytes: response.bytes, header: response.mediaType, hash };
    };
    const ready = (
      against: Pick<SharedArtifact, 'kind' | 'mediaType'>,
      sha: string,
      bytes: Uint8Array,
      header: string | null,
    ): void =>
      settle(sha, {
        status: 'ready',
        bytes,
        mediaType: resolveSharedArtifactMediaType(against, header),
        sha256: sha,
      });

    setContent({ status: 'loading' });
    void (async (): Promise<void> => {
      let sha = expectedSha;
      try {
        const first = await read();
        if (first === null) return;
        const current = artifactRef.current;
        if (current === null) return;
        // Without `crypto.subtle` the check is skipped.
        if (first.hash === null || first.hash === expectedSha) {
          ready(current, expectedSha, first.bytes, first.header);
          return;
        }
        // A republish landed between the two reads: re-read the DTO once.
        const refreshed = await client.get(artifactId);
        if (signal.aborted) return;
        const next = refreshed.artifact;
        if (next.takedown !== null) {
          // Taken down meanwhile: never read its content; the viewer moves
          // to the taken-down state from the refreshed DTO.
          refreshedRef.current?.(refreshed);
          return;
        }
        sha = next.latestRevision.sha256;
        const publish = (): void => {
          if (sha !== expectedSha) refreshedRef.current?.(refreshed);
        };
        if (first.hash === sha) {
          // The media type may have changed, so resolve against the new DTO.
          ready(next, sha, first.bytes, first.header);
          publish();
          return;
        }
        // Then the bytes once more (the adapter reads past the HTTP cache).
        const second = await read();
        if (second === null) return;
        if (second.hash === null || second.hash === sha) {
          ready(next, sha, second.bytes, second.header);
        } else {
          settle(sha, { status: 'failed', reason: 'mismatch' });
        }
        publish();
      } catch (error) {
        fail(sha, error);
      }
    })();
    return (): void => controller.abort();
  }, [artifactId, attempt, client, expectedSha]);

  const retry = useCallback((): void => {
    settledRef.current = null;
    setAttempt((value) => value + 1);
  }, []);

  return { content, retry };
}
