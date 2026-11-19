import { createHash } from 'node:crypto';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import type { DelegationTranscriptSettleRequest } from './transcript-port';

/** Versioned domain, followed by canonical JSON encoded as UTF-8. */
export const DELEGATION_SETTLEMENT_IDENTITY_DOMAIN =
  'canopy.delegation.settlement.v1\0';

/**
 * JSON-only canonical encoding. Keys use UTF-16 code-unit order, including
 * numeric-looking keys. Undefined, holes, nonfinite numbers, cycles and exotic
 * objects are rejected rather than silently dropped or normalized by toJSON.
 */
export function canonicalDelegationJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(current: unknown): string {
    if (current === null) return 'null';
    if (typeof current === 'string' || typeof current === 'boolean')
      return JSON.stringify(current);
    if (typeof current === 'number' && Number.isFinite(current))
      return JSON.stringify(current);
    if (typeof current !== 'object') throw new TypeError('Expected JSON data');
    if (ancestors.has(current)) throw new TypeError('Cyclic JSON data');
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const items: string[] = [];
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(current, index))
            throw new TypeError('Sparse JSON array');
          items.push(encode(current[index]));
        }
        return `[${items.join(',')}]`;
      }
      const prototype: unknown = Object.getPrototypeOf(current);
      // Another realm's Object.prototype (structuredClone, vm contexts) is
      // also plain: its own prototype is null. Class instances and exotic
      // objects such as Map or Date are not.
      const plain =
        prototype === null ||
        prototype === Object.prototype ||
        (typeof prototype === 'object' &&
          Object.getPrototypeOf(prototype) === null &&
          Object.prototype.toString.call(current) === '[object Object]');
      if (!plain) throw new TypeError('Expected plain JSON object');
      return `{${Object.entries(current)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => `${JSON.stringify(key)}:${encode(child)}`)
        .join(',')}}`;
    } finally {
      ancestors.delete(current);
    }
  }
  return encode(value);
}

const BLOCK_STORAGE_FIELDS = new Set([
  'outputTruncated',
  'textRef',
  'inputRef',
  'fullOutputRef',
  'partialTextRef',
  'finalTextRef',
]);

/** Digest the logical expanded row, excluding exactly hasStorageFields' keys. */
export function delegationTranscriptRowDigest(row: DelegationChildRow): string {
  const logical = Object.fromEntries(
    Object.entries(row).filter(
      ([key]) => key !== 'blocksRef' && key !== 'blocks',
    ),
  );
  logical.blocks = row.blocks.map((block) =>
    Object.fromEntries(
      Object.entries(block).filter(([key]) => !BLOCK_STORAGE_FIELDS.has(key)),
    ),
  );
  return createHash('sha256')
    .update(canonicalDelegationJson(logical), 'utf8')
    .digest('hex');
}

/**
 * Identity sorting never changes admission/display order or physical log digests.
 * Answer hashes are over raw UTF-16LE code units (no BOM), not lossy UTF-8.
 * The key is a lookup key, deliberately outside the payload identity.
 */
export function delegationTranscriptSettlementDigest(
  request: DelegationTranscriptSettleRequest,
): string {
  const seen = new Set<string>();
  const finalItems = request.finalChanges.map(({ row }) => {
    if (seen.has(row.id)) throw new TypeError('Duplicate settlement item id');
    seen.add(row.id);
    return {
      id: row.id,
      itemRevision: row.itemRevision,
      final: row.final,
      rowDigest: delegationTranscriptRowDigest(row),
    };
  });
  finalItems.sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  if (
    request.answer !== null &&
    'lost' in request.answer &&
    (!Number.isSafeInteger(request.answer.lost.length) ||
      request.answer.lost.length < 1 ||
      !/^[0-9a-f]{64}$/.test(request.answer.lost.sha256))
  )
    throw new TypeError('Invalid lost answer identity');
  // A lost answer encodes the same logical component as its text would.
  const answer =
    request.answer === null
      ? null
      : 'lost' in request.answer
        ? {
            role: request.answer.role,
            sha256: request.answer.lost.sha256,
            length: request.answer.lost.length,
          }
        : {
            role: request.answer.role,
            sha256: createHash('sha256')
              .update(Buffer.from(request.answer.text, 'utf16le'))
              .digest('hex'),
            length: request.answer.text.length,
          };
  // Existing shapes keep their version 1 object byte-for-byte; only finalize adds a field.
  return createHash('sha256')
    .update(DELEGATION_SETTLEMENT_IDENTITY_DOMAIN, 'utf8')
    .update(
      canonicalDelegationJson({
        v: 1,
        target: request.target,
        resultIndex: request.resultIndex,
        outcome: request.outcome,
        finalItems,
        answer,
        ...(request.openRows === 'finalize' ? { openRows: 'finalize' } : {}),
      }),
      'utf8',
    )
    .digest('hex');
}
