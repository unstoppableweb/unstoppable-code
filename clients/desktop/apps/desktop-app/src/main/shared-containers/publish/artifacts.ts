import { createHash, randomUUID } from 'node:crypto';
import {
  MAX_SHARED_CONTAINER_ARTIFACT_BYTES,
  MAX_SHARED_CONTAINER_ARTIFACTS_PER_REVISION,
  MAX_SHARED_CONTAINER_REVISION_BYTES,
  MAX_SHARED_CONTAINER_STAGE_REQUEST_BYTES,
  type SharedContainerStageRevisionRequest,
  isAnySharedContainerRevisionLayout,
  type AnySharedContainerRevisionLayout,
} from '@canopy/protocol/shared-containers';
import { validateSharedContainerProjectionBudget } from '../materialize/projection-budget';
import { validateMaterializedRelativePath } from '../materialize/path-safety';
import type { PublishFileSource } from './source-files';
import {
  SharedContainerArtifactBudgetError,
  SharedContainerPublishRefusalError,
} from './errors';
import type { RemoteControlChatMessage } from '@canopy/protocol/remote-control/shell';

export interface RevisionArtifact {
  artifactId: string;
  path: string;
  bytes?: Buffer;
  source?: PublishFileSource;
  sizeBytes: number;
  hash: string;
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function deterministicArtifactId(
  seed: string,
  path: string,
  hash: string,
): string {
  const bytes = createHash('sha1').update(`${seed}\0${path}\0${hash}`).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createArtifactInterner(
  artifacts: RevisionArtifact[],
  artifactIdSeed?: string,
): (path: string, content: Buffer | PublishFileSource) => RevisionArtifact {
  return (path, content) => {
    let bytes: Buffer | undefined;
    let source: PublishFileSource | undefined;
    let hash: string;
    let sizeBytes: number;
    if (Buffer.isBuffer(content)) {
      bytes = content;
      hash = sha256(content);
      sizeBytes = content.byteLength;
    } else {
      source = content;
      hash = content.hash;
      sizeBytes = content.sizeBytes;
    }
    const existing = artifacts.find((artifact) => artifact.path === path);
    if (existing) {
      if (existing.hash !== hash) {
        throw new Error(`Conflicting shared-container artifact path: ${path}`);
      }
      return existing;
    }
    const artifact: RevisionArtifact = {
      artifactId: artifactIdSeed
        ? deterministicArtifactId(artifactIdSeed, path, hash)
        : randomUUID(),
      path,
      ...(bytes ? { bytes } : {}),
      ...(source ? { source } : {}),
      sizeBytes,
      hash,
    };
    artifacts.push(artifact);
    return artifact;
  };
}

export interface OutputPathDomain {
  reserve(path: string): string;
}

export function createOutputPathDomain(): OutputPathDomain {
  const reserved = new Set<string>();
  return {
    reserve(path: string): string {
      const normalized = validateMaterializedRelativePath(path);
      const key = normalized.normalize('NFC').toLocaleLowerCase('en-US');
      for (const existing of Array.from(reserved)) {
        if (
          existing === key ||
          existing.startsWith(`${key}/`) ||
          key.startsWith(`${existing}/`)
        ) {
          throw new Error(`Shared-container output path collision: ${path}`);
        }
      }
      reserved.add(key);
      return normalized;
    },
  };
}

export function reserveCommonRecipientOutputPaths(
  domain: OutputPathDomain,
  paths: readonly string[],
): void {
  for (const path of paths) domain.reserve(path);
}

export function redactAbsolutePaths(value: string): string {
  return value
    .replace(
      /"(?=(?:file:\/+|[A-Za-z]:[\\/]|\\\\|\/(?!\/)))[^"\r\n]*"/gi,
      '"[local path]"',
    )
    .replace(
      /'(?=(?:file:\/+|[A-Za-z]:[\\/]|\\\\|\/(?!\/)))[^'\r\n]*'/gi,
      "'[local path]'",
    )
    .replace(
      /`(?=(?:file:\/+|[A-Za-z]:[\\/]|\\\\|\/(?!\/)))[^`\r\n]*`/gi,
      '`[local path]`',
    )
    .replace(/\bfile:\/+[^\r\n]*/gi, '[local path]')
    .replace(
      /(^|[^A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\)[^\r\n]*/g,
      '$1[local path]',
    )
    .replace(/(^|[\s("'`=:[{,])\/(?!\/)[^\r\n]*/g, '$1[local path]');
}

export function rewritePublishedChatString(
  value: string,
  replacements: ReadonlyMap<string, string>,
): string {
  const exact = replacements.get(value);
  if (exact) return exact;
  let rewritten = value;
  replacements.forEach((replacement, source) => {
    if (
      source.startsWith('/') ||
      /^[A-Za-z]:[\\/]/.test(source) ||
      source.startsWith('\\\\')
    ) {
      rewritten = rewritten.split(source).join(replacement);
    }
  });
  return redactAbsolutePaths(rewritten);
}

export function rewritePublishedChatData<T>(
  value: T,
  replacements: ReadonlyMap<string, string>,
): T {
  if (typeof value === 'string') {
    return rewritePublishedChatString(value, replacements) as T;
  }
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) =>
      rewritePublishedChatData<unknown>(item, replacements),
    ) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) =>
        key === 'absolutePath'
          ? []
          : [
              [
                rewritePublishedChatString(key, replacements),
                rewritePublishedChatData(item, replacements),
              ],
            ],
      ),
    ) as T;
  }
  return value;
}

export function appendPublishedAttachmentPaths(
  message: RemoteControlChatMessage,
  sourcePaths: readonly string[] | undefined,
  replacements: ReadonlyMap<string, string>,
): RemoteControlChatMessage {
  const attachmentPaths = Array.from(
    new Set(
      (sourcePaths ?? []).flatMap((sourcePath) => {
        const replacement = replacements.get(sourcePath);
        return replacement ? [replacement] : [];
      }),
    ),
  );
  if (attachmentPaths.length === 0) return message;
  return {
    ...message,
    parts: [
      ...(message.parts ?? []),
      { kind: 'attachment', data: { attachmentPaths } },
    ],
  };
}

export function internCommonRevisionContent(
  intern: ReturnType<typeof createArtifactInterner>,
  content: ReadonlyArray<{
    path: string;
    content: Buffer | PublishFileSource;
  }>,
): RevisionArtifact[] {
  return content.map((item) => intern(item.path, item.content));
}

export function finalizeRevisionArtifacts(
  artifacts: RevisionArtifact[],
  layout: AnySharedContainerRevisionLayout,
  artifactIdSeed?: string,
): RevisionArtifact[] {
  const withoutLayout = artifacts.filter(
    (artifact) => artifact.path !== 'container.json',
  );
  createArtifactInterner(withoutLayout, artifactIdSeed)(
    'container.json',
    Buffer.from(JSON.stringify(layout)),
  );
  return withoutLayout;
}

export function validateRevisionForStage(
  artifacts: readonly RevisionArtifact[],
  /** Absent for a personal container: the stage request then omits it. */
  organizationId: string | undefined,
  sourceDeviceId: string,
  idempotencyKey: string,
  parentRevisionId?: string,
): Omit<SharedContainerStageRevisionRequest, 'title'> {
  if (artifacts.length > MAX_SHARED_CONTAINER_ARTIFACTS_PER_REVISION) {
    throw new SharedContainerArtifactBudgetError(
      artifacts.length,
      MAX_SHARED_CONTAINER_ARTIFACTS_PER_REVISION,
    );
  }
  let totalBytes = 0;
  for (const artifact of artifacts) {
    if (artifact.sizeBytes > MAX_SHARED_CONTAINER_ARTIFACT_BYTES) {
      throw new SharedContainerPublishRefusalError(
        'artifact-budget',
        'A shared file exceeds the 25 MiB per-file limit. Commit it or remove it from the approved scope and try again.',
      );
    }
    totalBytes += artifact.sizeBytes;
  }
  if (totalBytes > MAX_SHARED_CONTAINER_REVISION_BYTES) {
    throw new SharedContainerPublishRefusalError(
      'artifact-budget',
      'This revision exceeds the 500 MiB shared-content limit. Commit or narrow the approved scope and try again.',
    );
  }
  const layoutArtifact = artifacts[artifacts.length - 1];
  if (layoutArtifact?.path !== 'container.json' || !layoutArtifact.bytes) {
    throw new Error('Shared-container revision must end with container.json');
  }
  const layout: unknown = JSON.parse(layoutArtifact.bytes.toString('utf8'));
  if (!isAnySharedContainerRevisionLayout(layout)) {
    throw new Error('Shared-container revision layout is invalid');
  }
  const details = artifacts.map((artifact) => ({
    artifactId: artifact.artifactId,
    path: artifact.path,
    representation: 'BLOB' as const,
    hash: artifact.hash,
    objectSizeBytes: String(artifact.sizeBytes),
  }));
  validateSharedContainerProjectionBudget(layout, details);
  const request: Omit<SharedContainerStageRevisionRequest, 'title'> = {
    ...(organizationId !== undefined ? { organizationId } : {}),
    idempotencyKey,
    sourceDeviceId,
    schemaVersion: layout.schemaVersion,
    ...(parentRevisionId ? { parentRevisionId } : {}),
    artifacts: details,
  };
  if (
    Buffer.byteLength(JSON.stringify(request)) >
    MAX_SHARED_CONTAINER_STAGE_REQUEST_BYTES
  ) {
    throw new Error('Shared-container stage request byte limit exceeded');
  }
  return request;
}
