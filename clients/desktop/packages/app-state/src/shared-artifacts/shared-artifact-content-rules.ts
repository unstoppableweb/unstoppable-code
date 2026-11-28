import type { SharedArtifact } from '@canopy/protocol/canopy-core';
import {
  isSharedArtifactMediaTypeForKind,
  type SharedArtifactMediaType,
  SHARED_ARTIFACT_ALL_MEDIA_TYPES,
} from '@canopy/protocol/shared-artifacts';

/**
 * Pure rules for an artifact's bytes (CAN-8017, docs/shared-artifacts.md).
 * The adapter only reports the media type header as received; these decide
 * what the viewer trusts.
 */

function isKnownMediaType(value: string): value is SharedArtifactMediaType {
  return SHARED_ARTIFACT_ALL_MEDIA_TYPES.some((type) => type === value);
}

/**
 * The media type the viewer renders with: the content response's header,
 * lower-cased and stripped of parameters, when it is accepted for the
 * artifact's kind; otherwise the DTO's own `mediaType`. A header for another
 * kind is never trusted, so a stale or hostile header can't turn markdown
 * into an image or HTML into anything but HTML.
 */
export function resolveSharedArtifactMediaType(
  artifact: Pick<SharedArtifact, 'kind' | 'mediaType'>,
  header: string | null,
): SharedArtifactMediaType {
  if (header === null) return artifact.mediaType;
  const normalized = header.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (
    isKnownMediaType(normalized) &&
    isSharedArtifactMediaTypeForKind(artifact.kind, normalized)
  ) {
    return normalized;
  }
  return artifact.mediaType;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/**
 * The bytes' SHA-256 in the contract's encoding (64 lower-case hex
 * characters), or `null` where `crypto.subtle` is unavailable (an insecure
 * origin), in which case the caller skips the comparison.
 */
export async function sharedArtifactSha256(
  bytes: Uint8Array,
): Promise<string | null> {
  const subtle =
    typeof globalThis.crypto === 'object' ? globalThis.crypto.subtle : null;
  if (!subtle) return null;
  try {
    // A copy, so the digest gets an ArrayBuffer-backed view.
    return toHex(await subtle.digest('SHA-256', new Uint8Array(bytes)));
  } catch {
    return null;
  }
}
