import { CORE_WORKSPACE_RECORDS_LIMITS } from '@canopy/protocol/canopy-core';
import { canopyInternalError } from '../../../runtime/errors';
import {
  freezeW5Capture,
  isW5CaptureResultShape,
  W5_CAPTURE_LIMITS,
  type W5CaptureResult,
} from '../commit-log/capture-contract';
import { W5CommitRefusedError } from '../commit-log/errors';
import { isRecord } from '../commit-log/is-record';

export function isW5CaptureLimitRefusal(error: unknown): boolean {
  return (
    error instanceof W5CommitRefusedError &&
    error.reason === 'invalid-state' &&
    error.details.capture === 'limit-exceeded'
  );
}

/** Fresh and assembled captures share limits, unproven labelling and refusals. */
export function validateW5RecordCaptureResult(
  result: unknown,
): W5CaptureResult {
  if (
    !isRecord(result) ||
    !Array.isArray(result.files) ||
    !isRecord(result.log) ||
    !Array.isArray(result.log.files) ||
    !isRecord(result.log.revisions)
  )
    throw canopyInternalError('The W5 record port returned a bad capture.');
  let bytes = 0;
  const files: readonly unknown[] = result.files;
  for (const file of files)
    if (
      isRecord(file) &&
      file.state === 'present' &&
      typeof file.base64 === 'string'
    )
      bytes += Buffer.byteLength(file.base64, 'base64');
  const exceedsCaptureLimits =
    result.files.length > W5_CAPTURE_LIMITS.files ||
    bytes > W5_CAPTURE_LIMITS.bytes ||
    result.log.files.length + Object.keys(result.log.revisions).length >
      W5_CAPTURE_LIMITS.evidenceRows;
  const encodedBytes = exceedsCaptureLimits
    ? 0
    : Buffer.byteLength(JSON.stringify(result));
  if (
    exceedsCaptureLimits ||
    encodedBytes > CORE_WORKSPACE_RECORDS_LIMITS.resultBytes
  )
    throw new W5CommitRefusedError(
      'invalid-state',
      'The W5 capture exceeds its limits.',
      { capture: 'limit-exceeded' },
    );
  // In particular, evidence never grants eligibility without classification.
  if (
    !isW5CaptureResultShape(result) ||
    encodedBytes > W5_CAPTURE_LIMITS.responseBytes
  )
    throw canopyInternalError('The W5 record port returned a bad capture.');
  return freezeW5Capture(result);
}
