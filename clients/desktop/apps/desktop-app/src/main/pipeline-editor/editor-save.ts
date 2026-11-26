import * as yaml from 'js-yaml';
import type {
  PipelineEditorSavedRecord,
  PipelineEditorSaveSnapshot,
} from '@canopy/desktop-shared/types';
import type { SharedPipelineDetail } from '@canopy/execution-engine/types/pipeline';

/** The window gets a share's metadata, never its document again. */
function withoutDocument(
  detail: SharedPipelineDetail,
): Omit<SharedPipelineDetail, 'rawPipeline'> {
  const { rawPipeline, ...metadata } = detail;
  void rawPipeline;
  return metadata;
}

export type PipelineEditorSaveOutcome =
  | { ok: true; saved?: PipelineEditorSavedRecord }
  | { ok: false; error: string };

/**
 * CAN-5822: saves the draft a Pipeline Editor holds, exactly as its Save
 * button does, from main. A stored pipeline goes through
 * `core.pipeline.definition.upsert` with the revision the editor loaded, so
 * an agent's save never overwrites a newer definition; a shared one goes
 * back to its share.
 */
export async function savePipelineEditorSnapshot(
  snapshot: PipelineEditorSaveSnapshot,
): Promise<PipelineEditorSaveOutcome> {
  const { target, pipeline } = snapshot;
  // Deferred: the pipeline handlers pull in the whole pipeline service graph.
  const { saveEditorPipeline, updateSharedPipelineFromEditor } =
    await import('../pipelines/pipeline-handlers');
  if (target.sharedRemoteId) {
    const result = await updateSharedPipelineFromEditor({
      remoteId: target.sharedRemoteId,
      rawPipeline: yaml.dump({ pipeline }, { lineWidth: 120, noRefs: true }),
    });
    if (!result.success) return { ok: false, error: result.error };
    return {
      ok: true,
      saved: { kind: 'shared', detail: withoutDocument(result.data) },
    };
  }
  const expectedRevision =
    target.persistedId && target.source === 'user'
      ? (target.revision ?? 0)
      : undefined;
  const result = await saveEditorPipeline({
    ...(target.persistedId ? { id: target.persistedId } : {}),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    name: pipeline.name,
    description: pipeline.description ?? '',
    icon: pipeline.icon ?? '',
    content: pipeline,
  });
  if (!result.success)
    return {
      ok: false,
      // CAN-5782: only a person can confirm, on the workflow's page.
      error:
        result.scheduleRefusal === 'needs_confirmation'
          ? `${result.error ?? ''} Ask the person to make this change from the workflow's page, where they can confirm it.`
          : (result.error ?? 'Failed to save workflow'),
    };
  return result.data
    ? { ok: true, saved: { kind: 'stored', info: result.data } }
    : { ok: true };
}
