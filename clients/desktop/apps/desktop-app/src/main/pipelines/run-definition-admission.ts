import { CanopyOperationError } from '@canopy/core-runtime';
import {
  PIPELINE_GRANTS,
  type CanopyCallerDescriptor,
  type PipelineDefinition,
} from '@canopy/protocol/canopy-core';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import type { ExecutionOptions } from '@canopy/execution-engine/node/pipelines/executor';
import type {
  Pipeline,
  PipelineData,
} from '@canopy/execution-engine/types/pipeline';
import { getDesktopCanopyRuntime } from '../canopy-runtime/desktop-runtime-access';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { withPipelinePresentation } from './pipeline-definition-presentation';

export interface AdmittedRunDefinition {
  /** The validated document the run executes and snapshots. */
  readonly pipeline: Pipeline;
  readonly definition: PipelineDefinition;
}

/**
 * Electron main's run start path. It alone may read a definition for a run
 * owner, once it has resolved and authorized that owner.
 */
export const PIPELINE_RUN_ADMISSION_CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-main-pipeline-run-admission',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: [PIPELINE_GRANTS.read, PIPELINE_GRANTS.ownerRead],
};

export interface RunDefinitionAdmission {
  /**
   * The owner a global run was authorized for. Core reads the definition as
   * that owner may use it; without one, through the navigation context.
   */
  readonly owner?: string;
  /** The project a run without an owner read is authorized in. */
  readonly projectId?: string;
}

/**
 * The validated definition a stored (user or bundled) run executes, read
 * through `core.pipeline.definition.get` rather than taken from the caller.
 * `null` when core has no such definition, as for an inline one. A stored
 * definition that no longer validates refuses the run with its first
 * diagnostic.
 */
export async function admitStoredRunDefinition(
  definitionId: string,
  admission: RunDefinitionAdmission = {},
): Promise<AdmittedRunDefinition | null> {
  let definition: PipelineDefinition;
  try {
    ({ definition } = await getDesktopCanopyRuntime().query(
      'core.pipeline.definition.get',
      {
        definitionId,
        scope:
          admission.projectId === undefined
            ? {}
            : { workspaceId: admission.projectId },
        ...(admission.owner === undefined ? {} : { owner: admission.owner }),
      },
      { caller: PIPELINE_RUN_ADMISSION_CALLER },
    ));
  } catch (error) {
    if (
      error instanceof CanopyOperationError &&
      error.payload.code === 'core.pipeline.definitionNotFound'
    )
      return null;
    throw error instanceof CanopyOperationError
      ? new Error(error.payload.message)
      : error;
  }
  const diagnostic = definition.diagnostics.find(
    (entry) => entry.severity === 'error',
  );
  if (diagnostic) throw new Error(diagnostic.message);
  return { pipeline: parsePipelineText(definition.document), definition };
}

export interface AdmittedCuratedRunDefinition extends AdmittedRunDefinition {
  /**
   * The managed revision the same read refreshed, with its cached file.
   */
  readonly managed: PipelineData;
  /** The revision's package, which the run executes with. */
  readonly pipelinePackage?: NonNullable<ExecutionOptions['pipelinePackage']>;
}

/** A refusal in the words of the source that refused it. */
function sourceMessage(error: CanopyOperationError): string {
  const cause = error.runtimeCause;
  return cause instanceof Error && cause.message
    ? cause.message
    : error.payload.message;
}

/**
 * The validated revision a curated run executes, read through
 * `core.pipeline.definition.get` like a stored run's. Core's curated source
 * refreshes the managed revision and its package in that one read; a revision
 * that does not validate refuses the run with its first diagnostic.
 */
export function admitCuratedRunDefinition(
  definitionId: string,
): Promise<AdmittedCuratedRunDefinition> {
  return withPipelinePresentation(async (presentation) => {
    let definition: PipelineDefinition;
    try {
      ({ definition } = await getDesktopCanopyRuntime().query(
        'core.pipeline.definition.get',
        { definitionId, scope: {} },
        { caller: PIPELINE_RUN_ADMISSION_CALLER },
      ));
    } catch (error) {
      throw error instanceof CanopyOperationError
        ? new Error(sourceMessage(error))
        : error;
    }
    const read = presentation.pipeline('read', 'curated', definitionId);
    if (read?.kind !== 'data')
      throw new Error('This curated workflow could not be read.');
    const diagnostic = definition.diagnostics.find(
      (entry) => entry.severity === 'error',
    );
    if (diagnostic) throw new Error(diagnostic.message);
    return {
      pipeline: parsePipelineText(definition.document),
      definition,
      managed: read.data,
      ...(read.pipelinePackage
        ? { pipelinePackage: read.pipelinePackage }
        : {}),
    };
  });
}
