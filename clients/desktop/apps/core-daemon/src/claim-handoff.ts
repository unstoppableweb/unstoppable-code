import { addAbortSignal, type Readable } from 'node:stream';

/** Value-free marker set only by the trusted supervisor; the bearer rides stdin. */
export const CLAIM_HANDOFF_ENV = 'CANOPY_DAEMON_CLAIM_HANDOFF';
const CLAIM_HANDOFF_PROTOCOL = 'stdin-v1';
export const CLAIM_HANDOFF_LIMITS = { maxBytes: 4096, timeoutMs: 2000 };

export interface ClaimHandoffSource {
  readonly env: NodeJS.ProcessEnv;
  /** Opened only when the marker is present; the reader then owns and closes it. */
  readonly openStream: () => Readable;
}

class ClaimHandoffRejected extends Error {}

async function readBounded(
  stream: Readable,
  { maxBytes, timeoutMs }: typeof CLAIM_HANDOFF_LIMITS,
): Promise<string> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  try {
    addAbortSignal(timeout.signal, stream);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const bytes: unknown = chunk;
      if (!Buffer.isBuffer(bytes)) throw new ClaimHandoffRejected();
      size += bytes.length;
      if (size > maxBytes) throw new ClaimHandoffRejected();
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Without the marker this is a standalone start and the stream is never opened.
 * With it, exactly one bounded JSON object up to EOF is the launcher's claim
 * handle; the adoption port validates its root, token and owner. The marker is
 * consumed so descendants never inherit it. Every rejection is the same fixed
 * text so bearer bytes never reach stderr.
 */
export async function consumeClaimHandoff(
  { env, openStream }: ClaimHandoffSource,
  limits = CLAIM_HANDOFF_LIMITS,
): Promise<object | undefined> {
  const marker = env[CLAIM_HANDOFF_ENV];
  if (marker === undefined) return undefined;
  Reflect.deleteProperty(env, CLAIM_HANDOFF_ENV);
  const stream = openStream();
  try {
    if (marker !== CLAIM_HANDOFF_PROTOCOL) throw new ClaimHandoffRejected();
    const handle: unknown = JSON.parse(await readBounded(stream, limits));
    if (typeof handle !== 'object' || handle === null || Array.isArray(handle))
      throw new ClaimHandoffRejected();
    return handle;
  } catch {
    throw new Error('Startup claim handoff rejected.');
  } finally {
    stream.destroy();
  }
}

export interface DaemonHandoff {
  readonly recoveryAuth?: {
    readonly secret: string;
    readonly dataRootHash: string;
  };
  readonly claimHandle?: object;
  readonly migrationAuth?: {
    readonly secret: string;
    readonly dataRootHash: string;
  };
  /** `stdin-owner-v1` only (CAN-5771); 32 bytes. */
  readonly ownerSecret?: Uint8Array;
}

/** The launcher's owner secret beside its claim handle (CAN-5771). */
async function consumeOwnerHandoff(
  source: ClaimHandoffSource,
): Promise<DaemonHandoff> {
  Reflect.deleteProperty(source.env, CLAIM_HANDOFF_ENV);
  const stream = source.openStream();
  try {
    const value: unknown = JSON.parse(
      await readBounded(stream, CLAIM_HANDOFF_LIMITS),
    );
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'claim,owner' ||
      !('claim' in value) ||
      !('owner' in value)
    )
      throw new ClaimHandoffRejected();
    const { claim, owner } = value;
    if (
      (claim !== null && (typeof claim !== 'object' || Array.isArray(claim))) ||
      typeof owner !== 'object' ||
      owner === null ||
      Array.isArray(owner) ||
      Object.keys(owner).join(',') !== 'secret' ||
      !('secret' in owner) ||
      typeof owner.secret !== 'string' ||
      !/^[0-9a-f]{64}$/.test(owner.secret)
    )
      throw new ClaimHandoffRejected();
    return {
      ...(claim && { claimHandle: claim }),
      ownerSecret: Buffer.from(owner.secret, 'hex'),
    };
  } catch {
    throw new Error('Startup claim handoff rejected.');
  } finally {
    stream.destroy();
  }
}

/** Per-launch HMAC bearer, not identity; never a published token or environment value. */
export async function consumeDaemonHandoff(
  source: ClaimHandoffSource,
): Promise<DaemonHandoff> {
  if (source.env[CLAIM_HANDOFF_ENV] === 'stdin-recovery-v1') {
    Reflect.deleteProperty(source.env, CLAIM_HANDOFF_ENV);
    const stream = source.openStream();
    try {
      const value: unknown = JSON.parse(
        await readBounded(stream, CLAIM_HANDOFF_LIMITS),
      );
      if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        Object.keys(value).join() !== 'auth' ||
        !('auth' in value)
      )
        throw new ClaimHandoffRejected();
      const auth = value.auth;
      if (
        typeof auth !== 'object' ||
        auth === null ||
        Array.isArray(auth) ||
        Object.keys(auth).sort().join() !== 'dataRootHash,secret' ||
        !('secret' in auth) ||
        typeof auth.secret !== 'string' ||
        !/^[a-f0-9]{64}$/.test(auth.secret) ||
        !('dataRootHash' in auth) ||
        typeof auth.dataRootHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(auth.dataRootHash)
      )
        throw new ClaimHandoffRejected();
      return {
        recoveryAuth: { secret: auth.secret, dataRootHash: auth.dataRootHash },
      };
    } catch {
      throw new Error('Recovery handoff rejected.');
    } finally {
      stream.destroy();
    }
  }
  if (source.env[CLAIM_HANDOFF_ENV] === 'stdin-owner-v1')
    return consumeOwnerHandoff(source);
  if (source.env[CLAIM_HANDOFF_ENV] !== 'stdin-migration-v1') {
    const claimHandle = await consumeClaimHandoff(source);
    return claimHandle ? { claimHandle } : {};
  }
  Reflect.deleteProperty(source.env, CLAIM_HANDOFF_ENV);
  const stream = source.openStream();
  try {
    const value: unknown = JSON.parse(
      await readBounded(stream, CLAIM_HANDOFF_LIMITS),
    );
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'auth,claim' ||
      !('claim' in value) ||
      !('auth' in value)
    )
      throw new ClaimHandoffRejected();
    const { claim, auth } = value;
    if (
      (claim !== null && (typeof claim !== 'object' || Array.isArray(claim))) ||
      typeof auth !== 'object' ||
      auth === null ||
      Array.isArray(auth) ||
      Object.keys(auth).sort().join(',') !== 'dataRootHash,secret' ||
      !('secret' in auth) ||
      typeof auth.secret !== 'string' ||
      !/^[0-9a-f]{64}$/.test(auth.secret) ||
      !('dataRootHash' in auth) ||
      typeof auth.dataRootHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(auth.dataRootHash)
    )
      throw new ClaimHandoffRejected();
    return {
      ...(claim && { claimHandle: claim }),
      migrationAuth: { secret: auth.secret, dataRootHash: auth.dataRootHash },
    };
  } catch {
    throw new Error('Startup claim handoff rejected.');
  } finally {
    stream.destroy();
  }
}
