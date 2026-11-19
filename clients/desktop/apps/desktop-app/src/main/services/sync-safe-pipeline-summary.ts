/**
 * The synced-summary redaction lives in `@canopy/protocol/remote-control/shell` so the
 * desktop's eager sync and the web's Remote Control write-through store
 * exactly the same shape (CAN-2830); this module keeps the desktop import
 * path.
 */
export {
  isSensitivePipelineInputName,
  looksLikeCredential,
  sanitizePipelineSummaryForSync,
} from '@canopy/protocol/remote-control/shell';
