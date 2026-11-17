import { createHash } from 'node:crypto';

/** Trusted low-level source capability. Paths and Electron never enter core policy or wire DTOs. */
export interface CopilotLegacyCiphertextPort {
  read(): Promise<
    | { readonly kind: 'present'; readonly bytes: Uint8Array }
    | {
        readonly kind:
          | 'absent'
          | 'malformed'
          | 'unreadable'
          | 'outcome_unknown';
      }
  >;
}
export async function observeCopilotLegacyCiphertext(
  port: CopilotLegacyCiphertextPort,
): Promise<
  | { readonly kind: 'present'; readonly generation: string }
  | { readonly kind: 'absent' | 'malformed' | 'unreadable' | 'outcome_unknown' }
> {
  let read: Awaited<ReturnType<CopilotLegacyCiphertextPort['read']>>;
  try {
    read = await port.read();
  } catch {
    return { kind: 'outcome_unknown' };
  }
  if (read.kind !== 'present') return read;
  try {
    if (read.bytes.byteLength === 0 || read.bytes.byteLength > 1048576)
      return { kind: 'malformed' };
    return {
      kind: 'present',
      generation: createHash('sha256').update(read.bytes).digest('hex'),
    };
  } finally {
    read.bytes.fill(0);
  }
}
