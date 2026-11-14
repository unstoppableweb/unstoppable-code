import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSea } from 'node:sea';
import type { LDClient } from 'launchdarkly-node-client-sdk';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { isRecord } from '@canopy/execution-engine/node/lib/type-guards';

declare const __CANOPY_LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID__:
  | string
  | undefined;

function clientSideId(): string {
  if (typeof __CANOPY_LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID__ !== 'undefined')
    return __CANOPY_LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID__;
  if (isSea()) return '';
  const value = process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID?.trim();
  return value === 'off' ? '' : (value ?? '');
}

export interface CliAntigravityRollout {
  isEnabled(): boolean;
  close(): Promise<void>;
}

/** No identity writer or offline grant: configured clients must initialize online. */
export async function openCliAntigravityRollout(
  signal: AbortSignal,
  revoke: () => void,
): Promise<CliAntigravityRollout> {
  const flag = CLIENT_FEATURE_FLAGS.canopyDesktopAntigravityHarness;
  const id = clientSideId();
  if (!id)
    return {
      isEnabled: () => !signal.aborted && flag.launchDarklyDisabledDefaultValue,
      close: () => Promise.resolve(),
    };
  const identity: unknown = JSON.parse(
    await readFile(
      join(getCanopyDataDir(), 'feature-flags-context.json'),
      'utf8',
    ),
  );
  if (
    !isRecord(identity) ||
    identity.version !== 1 ||
    typeof identity.anonymousKey !== 'string' ||
    !identity.anonymousKey
  )
    throw new Error('The local rollout identity is unavailable.');
  const cache = await mkdtemp(join(tmpdir(), 'antigravity-cli-flags-'));
  let client: LDClient | undefined;
  let closed = false;
  const isEnabled = (): boolean => {
    const value: unknown = client?.variation(
      flag.key,
      flag.launchDarklyEnabledUnavailableValue,
    );
    return !closed && !signal.aborted && value === true;
  };
  const close = async (): Promise<void> => {
    closed = true;
    try {
      await client?.close();
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  };
  try {
    signal.throwIfAborted();
    const { initialize } = await import('launchdarkly-node-client-sdk');
    client = initialize(
      id,
      { kind: 'user', key: identity.anonymousKey, anonymous: true },
      {
        localStoragePath: cache,
        sendEvents: false,
        streaming: true,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      },
    );
    client.on('change', () => {
      if (!isEnabled()) revoke();
    });
    client.on('error', revoke);
    await client.waitForInitialization(5);
    signal.throwIfAborted();
    if (!isEnabled())
      throw new Error(
        'Antigravity is unavailable under the current rollout policy.',
      );
    return { isEnabled, close };
  } catch (error) {
    await close();
    throw error;
  }
}
