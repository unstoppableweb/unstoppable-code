import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  SharedPipelineDetail,
  SharedPipelineSummary,
} from '@canopy/protocol/pipelines';
import type { PipelineDefinitionSource } from '@canopy/protocol/canopy-core';
import type { ExecutionOptions } from '@canopy/execution-engine/node/pipelines/executor';
import type {
  PipelineData,
  PipelineInfo,
} from '@canopy/execution-engine/types/pipeline';

/*
 * What the desktop definition sources read beside the portable records they
 * give core: host paths, catalog and share details that the legacy desktop
 * result shapes still show. Core decides which definitions a read returns;
 * a desktop caller projecting core's result back to its legacy shape takes
 * these details from the same read, collected for that one call, instead of
 * reading the source again. Nothing here crosses the core boundary.
 */

export type PresentedPipeline =
  | { readonly kind: 'info'; readonly info: PipelineInfo }
  | {
      readonly kind: 'data';
      readonly data: PipelineData;
      /** A curated revision's package, which its run executes with. */
      readonly pipelinePackage?: NonNullable<
        ExecutionOptions['pipelinePackage']
      >;
    }
  | {
      readonly kind: 'shared';
      readonly pipeline: SharedPipelineSummary | SharedPipelineDetail;
    };

/** `listed` rows come from a source listing, `read` ones from one definition's read. */
export type PresentationView = 'listed' | 'read';

/** What one call's source reads presented. */
export interface PipelinePresentation {
  pipeline(
    view: PresentationView,
    source: PipelineDefinitionSource,
    definitionId: string,
  ): PresentedPipeline | undefined;
  /** Why an optional source's listing failed in this call. */
  sourceFailure(source: PipelineDefinitionSource): unknown;
}

interface Collected {
  readonly rows: Map<string, PresentedPipeline>;
  readonly failures: Map<PipelineDefinitionSource, unknown>;
}

const calls = new AsyncLocalStorage<Collected>();

function keyOf(
  view: PresentationView,
  source: PipelineDefinitionSource,
  definitionId: string,
): string {
  return `${view}\0${source}\0${definitionId}`;
}

/**
 * Runs one core read with its own presentation: the source reads inside it
 * record what they read, and `run` receives it to project the result.
 */
export function withPipelinePresentation<T>(
  run: (presentation: PipelinePresentation) => Promise<T>,
): Promise<T> {
  const collected: Collected = { rows: new Map(), failures: new Map() };
  return calls.run(collected, () =>
    run({
      pipeline: (view, source, definitionId) =>
        collected.rows.get(keyOf(view, source, definitionId)),
      sourceFailure: (source) => collected.failures.get(source),
    }),
  );
}

/** Records a source read's details for the call it serves, if any. */
export function presentPipeline(
  view: PresentationView,
  source: PipelineDefinitionSource,
  definitionId: string,
  row: PresentedPipeline,
): void {
  calls.getStore()?.rows.set(keyOf(view, source, definitionId), row);
}

/** A source read's details recorded earlier in the current call. */
export function presentedPipeline(
  view: PresentationView,
  source: PipelineDefinitionSource,
  definitionId: string,
): PresentedPipeline | undefined {
  return calls.getStore()?.rows.get(keyOf(view, source, definitionId));
}

/** Records why an optional source's listing failed in the current call. */
export function presentSourceFailure(
  source: PipelineDefinitionSource,
  error: unknown,
): void {
  calls.getStore()?.failures.set(source, error);
}
