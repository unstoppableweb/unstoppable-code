import { isDeepStrictEqual } from 'node:util';
import {
  isW5CaptureResult,
  w5CaptureFileComponents,
  type W5CaptureResult,
} from '../w5/commit-log/capture-contract';
import {
  requireW5RootEvidenceScope,
  w5RootEvidenceScope,
  type W5RootEvidenceScope,
} from '../w5/service-history';
import type { RelocationRepairContext } from './index';
import { relocationTransition, RelocationRefusedError } from './transition';

export interface RelocatedW5CaptureContext extends Pick<
  RelocationRepairContext,
  'transition' | 'recordAuthority'
> {
  /** Frozen source capture, persisted by the migration owner before repair. */
  readonly source: W5CaptureResult;
  /** Checks the exact journaled mapping and published directory identity. */
  admit(
    transition: RelocationRepairContext['transition'],
    scope: W5RootEvidenceScope,
  ): Promise<void>;
  capture(): Promise<W5CaptureResult>;
  /** W5 owners verify every changed image against their frozen repair inventory. */
  qualify(source: W5CaptureResult, destination: W5CaptureResult): Promise<void>;
}

/** Separate provenance, never a rewrite or synthetic merge of path-keyed log history. */
export interface RelocatedW5Capture {
  readonly transition: RelocationRepairContext['transition'];
  readonly source: W5CaptureResult;
  readonly destination: W5CaptureResult;
}

export async function captureRelocatedW5Destination(
  context: RelocatedW5CaptureContext,
): Promise<RelocatedW5Capture> {
  const transition = relocationTransition(context.transition);
  const source = structuredClone(context.source);
  if (
    !isW5CaptureResult(source) ||
    source.log.unresolvedCommits !== 0 ||
    source.files.some((file) => file.state === 'unreadable') ||
    !['complete', 'not-requested'].includes(source.discovery) ||
    new Set(
      source.files.map((file) => JSON.stringify(w5CaptureFileComponents(file))),
    ).size !== source.files.length
  )
    throw new RelocationRefusedError('unsettled-source-capture');
  const scope = Object.freeze(
    await w5RootEvidenceScope(transition.to.canonicalDataRoot),
  );
  if (scope.canonicalDataRoot !== transition.to.canonicalDataRoot)
    throw new RelocationRefusedError('destination-scope-mismatch');
  await context.admit(transition, scope);
  await requireW5RootEvidenceScope(scope);
  await context.recordAuthority(transition);
  await requireW5RootEvidenceScope(scope);
  const destination = structuredClone(await context.capture());
  if (
    !isW5CaptureResult(destination) ||
    destination.log.unresolvedCommits !== 0 ||
    !['complete', 'not-requested'].includes(destination.discovery) ||
    destination.log.schemaVersion !== source.log.schemaVersion ||
    destination.log.commitId < source.log.commitId ||
    destination.log.retainedCommits < source.log.retainedCommits ||
    !isDeepStrictEqual(
      source.files.map(w5CaptureFileComponents),
      destination.files.map(w5CaptureFileComponents),
    ) ||
    destination.files.some((file) => file.state === 'unreadable') ||
    Object.entries(source.log.revisions).some(
      ([key, revision]) => (destination.log.revisions[key] ?? -1) < revision,
    )
  )
    throw new RelocationRefusedError('destination-capture-mismatch');
  // Qualifiers inspect copies so they cannot rewrite the retained evidence.
  await context.qualify(structuredClone(source), structuredClone(destination));
  await context.admit(transition, scope);
  await requireW5RootEvidenceScope(scope);
  return { transition, source, destination };
}
