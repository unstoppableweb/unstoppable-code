import { createHash } from 'node:crypto';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type { CanopyHandlerContext } from './types';

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('base64url');

/** A base64url SHA-256 digest, as `digest` writes it. */
const DIGEST = /^[A-Za-z0-9_-]{43}$/;

/**
 * A caller principal as a dispatch tag carries it: the digest a worker
 * counts that principal's tags under, and that a host's per-principal tag
 * bound is keyed on.
 */
export function dispatchTagPrincipal(principalId: string): string {
  return digest(principalId);
}

/**
 * One interface caller's dispatch tag, as the core forwards it to a worker
 * (CAN-4733): `peer:<principal digest>:<peer digest>:<tag digest>`. The
 * bundled worker sees every caller as the owning core, so the core names the
 * caller's principal and peer (principal and client instance), and the
 * worker bounds each peer's and each principal's tags.
 */
export function peerScopedDispatchTag(
  caller: Pick<CanopyCallerDescriptor, 'principalId' | 'clientInstanceId'>,
  tag: string,
): string {
  return `peer:${dispatchTagPrincipal(caller.principalId)}:${digest([caller.principalId, caller.clientInstanceId])}:${digest(tag)}`;
}

/** The principal and peer a core-scoped dispatch tag belongs to. */
export interface DispatchTagScope {
  readonly principal: string;
  readonly peer: string;
}

/**
 * The scope of a core-scoped dispatch tag; undefined for a tag the core did
 * not scope, including the earlier two-part form, which a worker refuses.
 */
export function dispatchTagScope(tag: string): DispatchTagScope | undefined {
  const [scheme, principal, peer, rest, ...extra] = tag.split(':');
  return scheme === 'peer' &&
    extra.length === 0 &&
    principal !== undefined &&
    peer !== undefined &&
    rest !== undefined &&
    DIGEST.test(principal) &&
    DIGEST.test(peer) &&
    DIGEST.test(rest)
    ? { principal, peer }
    : undefined;
}

type Handler = (params: unknown, context: CanopyHandlerContext) => unknown;

/**
 * Instructions with each request's report-only dispatch tag scoped to its
 * interface caller before a worker's receipts see it, as CAN-5629 scopes
 * idempotency keys. Every host that hands instructions to worker receipts
 * applies it: the daemon core on every forward and the desktop dispatcher
 * on its in-process worker, so no raw tag reaches a worker.
 */
export function scopeForwardedDispatchTags(
  instructions: Readonly<Record<string, Handler>>,
): Readonly<Record<string, Handler>> {
  return Object.fromEntries(
    Object.entries(instructions).map(([name, forward]) => [
      name,
      (params: unknown, context: CanopyHandlerContext): unknown => {
        const tag = context.metadata.dispatchId;
        return forward(
          params,
          tag === undefined
            ? context
            : {
                ...context,
                metadata: {
                  ...context.metadata,
                  dispatchId: peerScopedDispatchTag(context.caller, tag),
                },
              },
        );
      },
    ]),
  );
}
