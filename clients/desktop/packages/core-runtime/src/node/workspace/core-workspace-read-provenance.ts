import type {
  W5CaptureFile,
  W5CaptureResult,
  W5FileImage,
} from '../w5/commit-log/capture-contract';
import {
  classifyW5FileProvenance,
  classifyW5RevisionEligibility,
  type W5FileProvenance,
  type W5ProjectionCompleteness,
  type W5RevisionEligibility,
} from '../w5/commit-log/eligibility';
import type { W5Resource } from '../w5/commit-log';
import {
  coreWorkspaceResourceKey,
  type CoreWorkspaceExternalField,
  type CoreWorkspaceFilters,
  type CoreWorkspaceReadFilter,
  type CoreWorkspaceResourceProjection,
  type CoreWorkspaceRevisions,
} from './core-workspace-projection';

/*
 * Internal provenance of one core workspace read (CAN-5318): which W5
 * position served it, each captured file's evidence, and per W5 resource
 * whether its projection is complete and its revision eligible. Path-free
 * and kept off the protocol; only eligible revisions become public
 * (CAN-5319, `publishableRevisions`). Moved from Electron main (CAN-7732);
 * the host names its own uncaptured reasons.
 */

/** The W5 reads one query was served from, as the host's read view reports them. */
export type CoreWorkspaceReadView<Reason extends string = string> =
  | {
      readonly status: 'captured';
      readonly capture: W5CaptureResult;
      /** Reads of W5 files the capture lacked; each failed closed. */
      readonly uncapturedReads: readonly W5CaptureFile[];
    }
  | { readonly status: 'uncaptured'; readonly reason: Reason };

/** The uncaptured reason of a projection-only read while the W5 authority is unreachable. */
const POSSIBLY_STALE_REASON = 'daemon-unavailable';

export interface CoreWorkspaceResourceProvenance {
  readonly resource: W5Resource;
  readonly completeness: W5ProjectionCompleteness;
  readonly filters: readonly CoreWorkspaceReadFilter[];
  /** Outside the guarantee a revision of `resource` would make. */
  readonly external: readonly CoreWorkspaceExternalField[];
  readonly eligibility: W5RevisionEligibility;
}

export interface CoreWorkspaceReadProvenance<Reason extends string = string> {
  readonly position:
    | {
        readonly status: 'captured';
        /** Allocation high-water mark: an internal position, not a cache key. */
        readonly commitId: number;
        readonly discovery: W5CaptureResult['discovery'];
      }
    | {
        readonly status: 'uncaptured';
        readonly reason: Reason;
      };
  readonly files: readonly {
    readonly file: W5CaptureFile;
    readonly provenance: W5FileProvenance;
  }[];
  /** The whole result, including aggregations no W5 resource represents. */
  readonly result: {
    readonly completeness: W5ProjectionCompleteness;
    readonly filters: readonly CoreWorkspaceReadFilter[];
  };
  readonly resources: readonly CoreWorkspaceResourceProvenance[];
}

function presentFilters(
  filters: CoreWorkspaceFilters = [],
): CoreWorkspaceReadFilter[] {
  return Array.from(
    new Set(
      filters.filter(
        (filter): filter is CoreWorkspaceReadFilter =>
          typeof filter === 'string',
      ),
    ),
  );
}

/** The image's file alone, without its bytes. */
function imageFile(image: W5FileImage): W5CaptureFile {
  const file: W5CaptureFile = image;
  return 'workspaceId' in file
    ? { kind: file.kind, workspaceId: file.workspaceId }
    : { kind: file.kind };
}

/**
 * The revisions a read may publish, by resource key: only eligible ones
 * (decision A1). External fields never withhold one (decision B1).
 */
export function publishableRevisions(
  provenance: Pick<CoreWorkspaceReadProvenance, 'resources'> | undefined,
): CoreWorkspaceRevisions {
  const revisions = new Map<string, number>();
  for (const { resource, eligibility } of provenance?.resources ?? [])
    if (eligibility.status === 'eligible')
      revisions.set(coreWorkspaceResourceKey(resource), eligibility.revision);
  return revisions;
}

export function projectReadProvenance<Reason extends string>(
  view: CoreWorkspaceReadView<Reason>,
  resultFilters: CoreWorkspaceFilters,
  resources: readonly CoreWorkspaceResourceProjection[],
): CoreWorkspaceReadProvenance<Reason> {
  const filters = presentFilters([
    ...resultFilters,
    view.status === 'uncaptured' &&
      view.reason === POSSIBLY_STALE_REASON &&
      'possibly-stale',
  ]);
  const result: CoreWorkspaceReadProvenance['result'] = {
    completeness: filters.length ? 'partial' : 'complete',
    filters,
  };
  const uncaptured: W5RevisionEligibility = {
    status: 'unverified',
    reason: 'not-captured',
  };
  const projected = resources.map(
    (projection): CoreWorkspaceResourceProvenance => {
      const resourceFilters = presentFilters(projection.filters);
      const completeness: W5ProjectionCompleteness = resourceFilters.length
        ? 'partial'
        : 'complete';
      return {
        resource: projection.resource,
        completeness,
        filters: resourceFilters,
        external: projection.external ?? [],
        eligibility:
          view.status === 'captured'
            ? classifyW5RevisionEligibility(
                view.capture,
                projection.resource,
                completeness,
              )
            : uncaptured,
      };
    },
  );
  if (view.status === 'uncaptured')
    return {
      position: { status: 'uncaptured', reason: view.reason },
      files: [],
      result,
      resources: projected,
    };
  return {
    position: {
      status: 'captured',
      commitId: view.capture.log.commitId,
      discovery: view.capture.discovery,
    },
    files: [...view.capture.files.map(imageFile), ...view.uncapturedReads].map(
      (file) => ({
        file,
        provenance: classifyW5FileProvenance(view.capture, file),
      }),
    ),
    result,
    resources: projected,
  };
}
