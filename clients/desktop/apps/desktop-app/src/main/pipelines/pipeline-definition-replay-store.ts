import {
  createPipelineDefinitionReplayStore as createPortableReplayStore,
  type PipelineDefinitionReplayStore,
} from '@canopy/core-runtime/node/pipeline';
import { getPipelineDefinitionReplaysFilePath } from '../lib/paths';
import { writeStoreFileDurably } from '../lib/durable-store-write';

/**
 * The desktop's definition write receipts, through the portable store in
 * core-runtime (CAN-5092) and main's durable store write.
 */
export function createPipelineDefinitionReplayStore(
  filePath: () => string = getPipelineDefinitionReplaysFilePath,
): PipelineDefinitionReplayStore {
  return createPortableReplayStore({
    filePath,
    write: (file, contents) => writeStoreFileDurably(file, contents),
  });
}
