import { createHash } from 'node:crypto';
import {
  isStoredSecretValue,
  type SecretValueInput,
  type StoredSecretErrorCode,
  type StoredSecretValue,
} from '@canopy/execution-engine/types/stored-secrets';

/**
 * Stored-secret references for the CAN-4411 replies. A reference names the
 * slot that holds a secret, so it survives restarts and value replacement and
 * reveals nothing about the value. It is not a capability: keeping a value
 * is only honoured inside the record that holds it.
 *
 * Design: docs/planning/2026-11-02-can-4411-secret-replies/README.md
 */
export type StoredSecretFamily =
  | 'environment'
  | 'mcp.server'
  | 'shared_container.run_env'
  | 'agent.chat';

const REF_PREFIX = 'ssr1_';
const DOMAIN = 'canopy.stored-secret.v1';

export class StoredSecretError extends Error {
  constructor(
    readonly code: StoredSecretErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StoredSecretError';
  }
}

export function isStoredSecretError(
  error: unknown,
): error is StoredSecretError {
  return error instanceof StoredSecretError;
}

export function storedSecretRef(
  family: StoredSecretFamily,
  record: string,
  slot: string,
): string {
  const digest = createHash('sha256')
    .update([DOMAIN, family, record, slot].join('\0'))
    .digest('base64url');
  return `${REF_PREFIX}${digest}`;
}

/** Projects one stored value: empty stays empty, anything else is a reference. */
export function toStoredSecretValue(
  family: StoredSecretFamily,
  record: string,
  slot: string,
  value: string,
): string | StoredSecretValue {
  if (value.length === 0) return '';
  return { kind: 'stored-secret', ref: storedSecretRef(family, record, slot) };
}

export interface StoredSecretResolver {
  /**
   * Plaintext for a save field; a reference must name a slot of the record.
   * When the slot was stored with a destination, the field's destination
   * must be the same, or the value would go somewhere the user never chose.
   */
  resolve(input: SecretValueInput, destination?: string): string;
}

export interface StoredSecretSlot {
  slot: string;
  value: string;
  /** Where the value is sent, for families that bind kept values to one. */
  destination?: string;
}

/**
 * Builds a resolver over the slots one stored record holds right now. Call it
 * inside the record's write lock, so a kept value is the one being replaced.
 */
export function createStoredSecretResolver(
  family: StoredSecretFamily,
  record: string,
  slots: Iterable<StoredSecretSlot>,
): StoredSecretResolver {
  const byRef = new Map<string, StoredSecretSlot>();
  for (const stored of slots) {
    if (stored.value.length > 0)
      byRef.set(storedSecretRef(family, record, stored.slot), stored);
  }
  return {
    resolve(input, destination) {
      if (typeof input === 'string') return input;
      if (!isStoredSecretValue(input)) {
        throw new StoredSecretError(
          'stored_secret_unknown',
          'A saved secret could not be found. Reload and try again.',
        );
      }
      const stored = byRef.get(input.ref);
      if (stored === undefined) {
        throw new StoredSecretError(
          'stored_secret_unknown',
          'A saved secret changed or was removed. Reload and try again.',
        );
      }
      if (
        stored.destination !== undefined &&
        stored.destination !== destination
      ) {
        throw new StoredSecretError(
          'stored_secret_destination_changed',
          'Re-enter saved secrets after changing where this server connects or what it runs.',
        );
      }
      return stored.value;
    },
  };
}
