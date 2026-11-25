// "Use on this computer" for the Personal AI gateway (CAN-7657). The choice is
// saved only on this desktop, per Personal organization, so other computers,
// and other accounts on this one, keep their own. The gateway is on unless
// this file lists it: a missing or unreadable file means on.

import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { normalizeUuid } from '@canopy/execution-engine/lib/workspace-owner';
import type { ModelGatewayDeviceOptOuts } from '@canopy/desktop-shared/lib/org-model-gateway';
import {
  IPC_CHANNELS,
  type CanopyCloudAccountPublicState,
} from '@canopy/desktop-shared/types';
import { writeFileAtomically } from './atomic-file';
import { getModelGatewayDeviceUseFilePath } from './paths';
import { sendToAllWindows } from './window-send';

interface DeviceUseFile {
  version: 1;
  offOrganizationIds: string[];
}

let cache: ModelGatewayDeviceOptOuts | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function parseDeviceUse(value: unknown): ModelGatewayDeviceOptOuts {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('offOrganizationIds' in value) ||
    !Array.isArray(value.offOrganizationIds)
  )
    return new Set();
  return new Set(
    value.offOrganizationIds.flatMap((entry: unknown) => {
      const id = normalizeUuid(entry);
      return id ? [id] : [];
    }),
  );
}

/** Personal organizations this computer opts out of. */
export async function readModelGatewayDeviceOptOuts(): Promise<ModelGatewayDeviceOptOuts> {
  if (cache) return cache;
  try {
    const stored: unknown = JSON.parse(
      await readFile(getModelGatewayDeviceUseFilePath(), 'utf8'),
    );
    cache = parseDeviceUse(stored);
  } catch {
    cache = new Set();
  }
  return cache;
}

/** Whether this computer uses the Personal gateway of `organizationId`. */
export async function isModelGatewayUsedOnThisComputer(
  organizationId: string,
): Promise<boolean> {
  const id = normalizeUuid(organizationId);
  return id === null || !(await readModelGatewayDeviceOptOuts()).has(id);
}

/**
 * Save whether this computer uses the Personal gateway of `organizationId`.
 * Resolves once the choice is on disk; returns whether it changed.
 */
export async function setModelGatewayUsedOnThisComputer(
  organizationId: string,
  used: boolean,
): Promise<boolean> {
  const id = normalizeUuid(organizationId);
  if (id === null) throw new Error('Invalid organization');
  const write = writeQueue.then(async () => {
    const current = await readModelGatewayDeviceOptOuts();
    if (current.has(id) !== used) return false;
    const next = new Set(current);
    if (used) next.delete(id);
    else next.add(id);
    const file: DeviceUseFile = {
      version: 1,
      offOrganizationIds: [...next].sort(),
    };
    const path = getModelGatewayDeviceUseFilePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomically(path, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    cache = next;
    sendToAllWindows(IPC_CHANNELS.modelGatewayDeviceUseChanged);
    return true;
  });
  writeQueue = write.then(
    () => undefined,
    () => undefined,
  );
  return write;
}

/**
 * This computer's opt-outs for routing `account`. "Use only my AI gateway"
 * applies everywhere, so it clears this computer's opt-out, as the account
 * does for cloud chats. A removed gateway clears it too, so setting one up
 * again starts on everywhere.
 */
export async function reconcileModelGatewayDeviceOptOuts(
  account: Pick<
    CanopyCloudAccountPublicState,
    'personalModelGateway' | 'personalModelGatewayConfig'
  > | null,
): Promise<ModelGatewayDeviceOptOuts> {
  const gateway = account?.personalModelGateway;
  const config = account?.personalModelGatewayConfig;
  const clear = gateway?.enforced
    ? gateway.organizationId
    : config && config.baseUrl === null
      ? config.organizationId
      : undefined;
  if (clear !== undefined && !(await isModelGatewayUsedOnThisComputer(clear))) {
    // Routing ignores the opt-out either way; a failed write retries next time.
    await setModelGatewayUsedOnThisComputer(clear, true).catch(() => false);
  }
  return readModelGatewayDeviceOptOuts();
}
