import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** Workflow documents larger than this get no revision, so no check either. */
const PIPELINE_REVISION_MAX_BYTES = 1024 * 1024;

/**
 * A short digest of a workflow document's bytes; any edit to it changes this
 * (CAN-7513). The Remote Control catalog publishes it, and a run that names
 * an expected revision is checked against the digest of the very bytes it
 * parses and runs. A document over the size cap has none.
 */
export function pipelineDocumentRevision(
  document: Buffer | string,
): string | undefined {
  const bytes =
    typeof document === 'string' ? Buffer.from(document, 'utf8') : document;
  if (bytes.byteLength > PIPELINE_REVISION_MAX_BYTES) return undefined;
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/**
 * Reads a workflow file once: its text to parse and the revision of those
 * same bytes, so what is checked is what runs.
 */
export async function readPipelineFileWithRevision(
  filePath: string,
): Promise<{ text: string; revision: string | undefined }> {
  const bytes = await readFile(filePath);
  return {
    text: bytes.toString('utf8'),
    revision: pipelineDocumentRevision(bytes),
  };
}

export { PIPELINE_REVISION_CHANGED_MESSAGE } from '@canopy/desktop-shared/constants/pipeline-revision';
