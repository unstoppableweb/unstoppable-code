import type {
  CanopyErrorKind,
  SHARED_ARTIFACT_ERROR_CODES,
  SharedArtifact,
  SharedArtifactAudienceInput,
  SharedArtifactGetResult,
  SharedArtifactListParams,
  SharedArtifactListResult,
} from '@canopy/protocol/canopy-core';
import type { SharedArtifactReportReason } from '@canopy/protocol/shared-artifacts';

/** A `core.sharedArtifact.*` error code, written in full. */
export type SharedArtifactErrorCode =
  (typeof SHARED_ARTIFACT_ERROR_CODES)[keyof typeof SHARED_ARTIFACT_ERROR_CODES];

/**
 * The bytes of an artifact's latest revision, read through
 * `sharedArtifactContentPath(id)`. `mediaType` is the response header's value
 * as received, or `null` when the host got none: the adapter doesn't know the
 * artifact's kind, so shared code validates it against the DTO and falls back
 * to `artifact.mediaType`.
 */
export interface SharedArtifactContent {
  readonly bytes: Uint8Array;
  readonly mediaType: string | null;
}

/**
 * Shared artifacts (CAN-8017, docs/shared-artifacts.md): read, share and
 * report static content a desktop user published. Present only when the host
 * reports `capabilities.sharedArtifacts`; absent reads as
 * `capability_unavailable`. Not part of `QueryMap` or `CommandMap`, so nothing
 * here is tunneled over Remote Control.
 *
 * Keyed calls take the idempotency key the UI minted when the user committed
 * the action; a retry of the same input reuses it.
 *
 * Failures reject with `SharedArtifactsClientError`, carrying the protocol
 * error kind and, when present, the `core.sharedArtifact.*` code. A reply
 * that fails schema validation rejects as `unavailable`. The error's message
 * is never server text, so it is safe to log but not meant as copy.
 *
 * CAN-8018 extends this with stage, commit, republish, takedown and grants.
 */
export interface SharedArtifactsClient {
  get(artifactId: string): Promise<SharedArtifactGetResult>;
  list(params: SharedArtifactListParams): Promise<SharedArtifactListResult>;
  updateAudience(input: {
    readonly artifactId: string;
    readonly audience: SharedArtifactAudienceInput;
    readonly idempotencyKey: string;
  }): Promise<SharedArtifact>;
  setPublic(input: {
    readonly artifactId: string;
    readonly public: boolean;
    readonly idempotencyKey: string;
  }): Promise<SharedArtifact>;
  /** Deletes the artifact and its link for everyone. */
  unshare(input: {
    readonly artifactId: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly unshared: boolean }>;
  report(input: {
    readonly artifactId: string;
    readonly reason: SharedArtifactReportReason;
    readonly detail?: string;
    readonly idempotencyKey: string;
  }): Promise<void>;
  /**
   * Streams the latest revision's bytes and refuses a body over
   * `MAX_SHARED_ARTIFACT_BYTES`, with or without a `Content-Length`.
   * Aborting `signal` rejects with kind `cancelled`.
   */
  readContent(
    artifactId: string,
    signal: AbortSignal,
  ): Promise<SharedArtifactContent>;
}

/** The typed failure every `SharedArtifactsClient` method rejects with. */
export class SharedArtifactsClientError extends Error {
  public readonly kind: CanopyErrorKind;
  public readonly code: SharedArtifactErrorCode | undefined;

  public constructor(input: {
    readonly kind: CanopyErrorKind;
    readonly code?: SharedArtifactErrorCode;
  }) {
    super(
      input.code
        ? `Shared artifact request failed (${input.kind}, ${input.code}).`
        : `Shared artifact request failed (${input.kind}).`,
    );
    this.name = 'SharedArtifactsClientError';
    this.kind = input.kind;
    this.code = input.code;
  }
}

export function isSharedArtifactsClientError(
  error: unknown,
): error is SharedArtifactsClientError {
  return error instanceof SharedArtifactsClientError;
}
