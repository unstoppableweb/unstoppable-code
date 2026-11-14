import { z } from 'zod';
import {
  IPC_CHANNELS,
  type CloudReachBackActivityView,
  type CloudReachBackResult,
  type CloudReachBackServerView,
} from '@canopy/desktop-shared/types';
import type {
  RendererRelayEvent,
  RendererRelaySurfaceResolution,
} from '../canopy-runtime/renderer-relay/relay';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { ReachBackSignedOutError } from '../mcp/cloud-reach-back/controller';
import type { CloudReachBack } from '../mcp/cloud-reach-back/runtime';
import { getCloudReachBack } from '../mcp/cloud-reach-back/start';
import { cloudChatsEnabled, signedInAccountId } from './cloud-chats';
import { registerIpcHandler } from './register';

/** The same id shapes the cloud's desktop connection route accepts. */
const serverId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const configId = z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/);
const toolName = z.string().min(1).max(256);

const allowSchema = z.strictObject({
  expectedAccountId: z.string().min(1).max(256),
  serverId,
  configId,
  displayName: z.string().trim().min(1).max(120),
  enabledTools: z.array(toolName).max(500).nullable(),
  allowWithoutAsking: z.array(toolName).max(500),
});

const DISABLED: CloudReachBackResult = { ok: false, reason: 'disabled' };

/**
 * The opt-in, off switch and call log of reach-back (CAN-6176 PR 7c): only
 * the app's own main window may call them, by the same trusted-surface check
 * as the cloud chats handlers; remote control blocks every channel.
 */
export function registerCloudReachBackHandlers(
  resolveSurface: (event: RendererRelayEvent) => RendererRelaySurfaceResolution,
  reachBack: () => Promise<CloudReachBack | null> = getCloudReachBack,
): void {
  const requireMainWindow = (event: RendererRelayEvent): void => {
    let trusted = false;
    try {
      trusted = resolveSurface(event).surface === 'main';
    } catch {
      // An untrusted sender is refused below.
    }
    if (!trusted) throw new Error('Untrusted cloud reach-back sender.');
  };
  /** The service and the signed-in account, or null while either is missing. */
  const ready = async (): Promise<{
    service: CloudReachBack;
    accountId: string;
  } | null> => {
    if (!cloudChatsEnabled()) return null;
    const [service, accountId] = await Promise.all([
      reachBack(),
      signedInAccountId(),
    ]);
    return service === null || accountId === null
      ? null
      : { service, accountId };
  };
  const failed = (error: unknown): CloudReachBackResult => {
    if (error instanceof ReachBackSignedOutError)
      return { ok: false, reason: 'signed_out' };
    logMainProcessWarn('[cloud-reach-back] A change failed.', error);
    return { ok: false, reason: 'failed' };
  };

  registerIpcHandler<[], readonly CloudReachBackServerView[]>(
    IPC_CHANNELS.cloudReachBackList,
    async (event) => {
      requireMainWindow(event);
      const current = await ready();
      if (current === null) return [];
      return (await current.service.allowList.list(current.accountId)).map(
        (server) => ({
          serverId: server.serverId,
          configId: server.configId,
          displayName: server.displayName,
          enabledTools: server.enabledTools,
          allowWithoutAsking: server.allowWithoutAsking,
          allowedAt: server.allowedAt,
          unreachable: current.service.reachability.cause(
            current.accountId,
            server.serverId,
            server.configId,
          ),
        }),
      );
    },
  );
  registerIpcHandler<[], readonly CloudReachBackActivityView[]>(
    IPC_CHANNELS.cloudReachBackActivity,
    async (event) => {
      requireMainWindow(event);
      const current = await ready();
      return current === null
        ? []
        : current.service.log.list(current.accountId);
    },
  );
  registerIpcHandler<[unknown], CloudReachBackResult>(
    IPC_CHANNELS.cloudReachBackAllow,
    async (event, request) => {
      requireMainWindow(event);
      const input = allowSchema.safeParse(request);
      if (!input.success) return { ok: false, reason: 'rejected' };
      const current = await ready();
      if (current === null) return DISABLED;
      const { expectedAccountId, ...optIn } = input.data;
      // The consent was given for the account shown then; never another.
      if (expectedAccountId !== current.accountId)
        return { ok: false, reason: 'signed_out' };
      try {
        await current.service.controller.allow(optIn, expectedAccountId);
        return { ok: true };
      } catch (error) {
        return failed(error);
      }
    },
  );
  registerIpcHandler<[unknown, unknown], CloudReachBackResult>(
    IPC_CHANNELS.cloudReachBackDisallow,
    async (event, givenServerId, givenConfigId) => {
      requireMainWindow(event);
      const ids = z
        .tuple([serverId, configId])
        .safeParse([givenServerId, givenConfigId]);
      if (!ids.success) return { ok: false, reason: 'rejected' };
      // Turning off works with the flag off too: it only ever stops serving.
      const service = await reachBack();
      if (service === null) return DISABLED;
      try {
        const cloudRemoved = await service.controller.disallow(...ids.data);
        return { ok: true, cloudRemoved };
      } catch (error) {
        return failed(error);
      }
    },
  );
}
