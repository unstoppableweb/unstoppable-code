import type { Readable } from 'node:stream';

/** The one stdout line a worker writes, once its endpoint is bound. */
export const DAEMON_WORKER_READY = 'canopy-daemon-worker-v1 ready\n';
/** Bounds the handoff a supervising core writes to the worker's stdin. */
const DAEMON_WORKER_HANDOFF_LIMIT = 4 * 1024;

/**
 * The private handoff from the supervising core: where to listen and the
 * binding's handshake material. Never argv or environment.
 */
export interface DaemonWorkerHandoff {
  readonly version: 1;
  readonly endpointName: string;
  /** 64 lowercase hex digits each. */
  readonly secret: string;
  readonly dataRootHash: string;
  readonly authorityId: string;
  /** The core's build brand Cowork folder name, so both resolve scopes alike. */
  readonly coworkManagedDirName: string;
}

const HEX = /^[0-9a-f]{64}$/;
const ENDPOINT_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const KEYS = [
  'authorityId',
  'coworkManagedDirName',
  'dataRootHash',
  'endpointName',
  'secret',
  'version',
].join();

function parseHandoff(value: unknown): DaemonWorkerHandoff | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const field = (name: string): unknown => Reflect.get(value, name);
  const [
    version,
    endpointName,
    secret,
    dataRootHash,
    authorityId,
    coworkManagedDirName,
  ] = [
    'version',
    'endpointName',
    'secret',
    'dataRootHash',
    'authorityId',
    'coworkManagedDirName',
  ].map(field);
  if (
    Object.keys(value).sort().join() !== KEYS ||
    version !== 1 ||
    typeof endpointName !== 'string' ||
    !ENDPOINT_NAME.test(endpointName) ||
    typeof secret !== 'string' ||
    !HEX.test(secret) ||
    typeof dataRootHash !== 'string' ||
    !HEX.test(dataRootHash) ||
    typeof authorityId !== 'string' ||
    authorityId.length === 0 ||
    authorityId.length > 256 ||
    typeof coworkManagedDirName !== 'string' ||
    coworkManagedDirName.length > 256
  )
    return null;
  return {
    version,
    endpointName,
    secret,
    dataRootHash,
    authorityId,
    coworkManagedDirName,
  };
}

export function encodeDaemonWorkerHandoff(
  handoff: DaemonWorkerHandoff,
): string {
  const parsed = parseHandoff(handoff);
  if (parsed === null) throw new Error('Worker handoff malformed.');
  return `${JSON.stringify(parsed)}\n`;
}

/** Reads the core's one-line handoff from `stream`, which the core then closes. */
export async function readDaemonWorkerHandoff(
  stream: Readable,
): Promise<DaemonWorkerHandoff> {
  let text = '';
  for await (const chunk of stream) {
    text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (Buffer.byteLength(text) > DAEMON_WORKER_HANDOFF_LIMIT)
      throw new Error('Worker handoff too large.');
  }
  const line = text.endsWith('\n') ? text.slice(0, -1) : text;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error('Worker handoff malformed.');
  }
  const parsed = parseHandoff(value);
  if (parsed === null) throw new Error('Worker handoff malformed.');
  return parsed;
}
