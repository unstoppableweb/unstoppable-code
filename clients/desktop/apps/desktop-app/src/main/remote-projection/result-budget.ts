import { PORTAL_CATALOG_RESULT_MAX_BYTES } from '@canopy/protocol/portal';

/** Serialized UTF-8 byte length of a JSON result, as the wire would carry it. */
export function resultByteLength(result: unknown): number {
  return Buffer.byteLength(JSON.stringify(result), 'utf8');
}

/**
 * Truncate a markdown body to at most `maxBytes` SERIALIZED UTF-8 BYTES,
 * cutting on a full code-point boundary (never mid-sequence, so multibyte
 * characters and surrogate pairs survive intact). Byte-based (not UTF-16
 * `.length`) because the portal event size cap is a byte cap.
 */
export function truncateBodyToBytes(
  body: string,
  maxBytes: number,
): { body: string; truncated: boolean } {
  const buffer = Buffer.from(body, 'utf8');
  if (buffer.length <= maxBytes) {
    return { body, truncated: false };
  }
  let end = maxBytes;
  // Walk back over UTF-8 continuation bytes (0b10xxxxxx) so the cut lands on
  // a code-point boundary.
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return { body: buffer.subarray(0, end).toString('utf8'), truncated: true };
}

/** Return the longest deterministic prefix that fits, including its marker. */
export function fitListResult<TItem, TResult>(
  items: TItem[],
  build: (items: TItem[], truncated: boolean) => TResult,
  truncated = false,
): TResult {
  const complete = build(items, truncated);
  if (resultByteLength(complete) <= PORTAL_CATALOG_RESULT_MAX_BYTES) {
    return complete;
  }
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = build(items.slice(0, mid), true);
    if (resultByteLength(candidate) <= PORTAL_CATALOG_RESULT_MAX_BYTES) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return build(items.slice(0, low), true);
}

/**
 * Fit a read result whose single body dominates its size.
 *
 * Capping the body's RAW bytes is not enough: JSON escaping expands control
 * characters up to 6 bytes each, so a body at the per-body cap can still
 * serialize to several times that. This measures the FINAL SERIALIZED result
 * and halves the body until it fits, mirroring the degradation ladder in
 * plugin-catalog-service.
 */
export function fitReadResult<TResult>(
  result: TResult,
  getBody: (current: TResult) => string,
  withBody: (current: TResult, body: string, truncated: boolean) => TResult,
): TResult {
  let current = result;
  let targetBytes = Buffer.byteLength(getBody(result), 'utf8');
  while (
    resultByteLength(current) > PORTAL_CATALOG_RESULT_MAX_BYTES &&
    targetBytes > 0
  ) {
    targetBytes = Math.floor(targetBytes / 2);
    current = withBody(
      result,
      truncateBodyToBytes(getBody(result), targetBytes).body,
      true,
    );
  }
  if (resultByteLength(current) > PORTAL_CATALOG_RESULT_MAX_BYTES) {
    // Metadata alone is over budget, so no body cut can rescue it. Throw so the
    // adapter fails the command explicitly instead of emitting an oversized
    // event the transport would silently drop.
    throw new Error(
      'Portal workspace-item result exceeds the deliverable size budget.',
    );
  }
  return current;
}
