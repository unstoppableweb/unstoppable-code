import { app, ipcMain, webContents } from 'electron';
import { CANOPY_DEFAULT_MAX_FRAME_BYTES } from '@canopy/core-transport';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  CORE_CHAT_LIVE_EVENTS_SCHEMA_REVISION,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type {
  CanopyCoreRelayRequest,
  CanopyCoreRelayReply,
} from '../../shared/canopy-core-relay';
import {
  createWebCoreBindingProvider,
  type WebCoreBindingOptions,
} from '../canopy-cloud/web-core-connection';
import { registerIpcHandler } from './register';
import { desktopWebCoreBindingOptions } from './cloud-chats';
import {
  sendInterfaceToolCancellation,
  sendInterfaceToolRequest,
  setInterfaceToolReplyHandler,
} from './app-advisor';
import {
  sendPipelineEditorInterfaceToolRequest,
  setPipelineEditorInterfaceToolReplyHandler,
} from './pipeline-editor';
import { createDesktopInterfaceLeases } from '../canopy-runtime/interface-tools/desktop-interface-leases';
import { setRemoteInterfaceLeaseHost } from '../canopy-runtime/interface-tools/remote-interface-leases';
import { setMcpSignInPresenterLeases } from '../mcp/oauth-coordinator';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import {
  RELAY_DEFINITIONS,
  type RelayBindingProvider,
} from '../canopy-runtime/renderer-relay/definitions';
import {
  createInterimInMemoryBindingProvider,
  type RelayCapabilities,
} from '../canopy-runtime/renderer-relay/interim-in-memory-binding';
import { routeRendererRelayRequest } from '../canopy-runtime/renderer-relay/relay-authority';
import {
  createRendererRelay,
  type RendererRelay,
  type RendererRelayEvent,
  type RendererRelayLimits,
  type RendererRelaySurfaceResolution,
} from '../canopy-runtime/renderer-relay/relay';
import {
  WEB_CORE_HOST_DEFINITIONS,
  WEB_CORE_RELAY_DEFINITIONS,
  webCoreRelayAllows,
  webCoreRelayRefuseCall,
  webCoreRelayNarrowParams,
  webCoreRelayRefuseParams,
} from '../canopy-runtime/renderer-relay/web-core-relay-definitions';

export const RENDERER_RELAY_GRANTS: readonly CanopyCallerDescriptor['grants'][number][] =
  Array.from(
    new Set(
      [
        ...Object.values(RELAY_DEFINITIONS.queries),
        ...Object.values(RELAY_DEFINITIONS.instructions),
        ...Object.values(RELAY_DEFINITIONS.streams),
      ].flatMap((definition) => definition.requiredGrants),
    ),
  );

/**
 * The web-core authority's relay: cloud chat and cloud workflow run
 * operations only, main window only, with main holding the connection's
 * client lease and acknowledging each stream item once it is handed to the
 * renderer. Requests and replies may be as large as the framed bindings
 * carry, which the web core budgets file reads, saves and search pages
 * against (CAN-6175).
 */
export function createWebCoreRendererRelay({
  cloudChatsEnabled = (): boolean => true,
  ...options
}: {
  readonly bindingProvider: RelayBindingProvider;
  readonly resolveSurface: (
    event: RendererRelayEvent,
  ) => RendererRelaySurfaceResolution;
  /** `canopyDesktopCloudChats`; cloud run operations don't need it (CAN-6326). */
  readonly cloudChatsEnabled?: () => boolean;
  readonly clientVersion?: string;
  readonly limits?: Partial<RendererRelayLimits>;
}): RendererRelay {
  return createRendererRelay({
    ...options,
    limits: {
      maxFrameBytes: CANOPY_DEFAULT_MAX_FRAME_BYTES,
      maxReplyBytes: CANOPY_DEFAULT_MAX_FRAME_BYTES,
      ...options.limits,
    },
    definitions: WEB_CORE_RELAY_DEFINITIONS,
    allows: webCoreRelayAllows,
    refuseParams: webCoreRelayRefuseParams,
    narrowParams: webCoreRelayNarrowParams,
    refuseCall: (method) => webCoreRelayRefuseCall(method, cloudChatsEnabled),
    // Live reply tool calls come only on revision 2 (CAN-6451).
    streamRevisions: {
      'core.chat.live.events': CORE_CHAT_LIVE_EVENTS_SCHEMA_REVISION,
    },
    host: {
      definitions: WEB_CORE_HOST_DEFINITIONS,
      lease: { label: 'Desktop cloud chats', interfaceKind: 'http' },
      ackDelivered: true,
    },
  });
}

export function registerCanopyCoreRelayHandlers(
  dispatcher: DesktopCanopyDispatcher,
  resolveSurface: (event: RendererRelayEvent) => RendererRelaySurfaceResolution,
  webCore: WebCoreBindingOptions = desktopWebCoreBindingOptions(),
): () => void {
  // Interim connection-scoped declarations; durable ownership waits for a relay daemon binding (W3 exit, CAN-3166).
  const registrations = new Map<string, RelayCapabilities>();
  const interfaceLeases = createDesktopInterfaceLeases({
    registry: dispatcher.interfaceTools,
    webContentsFromId: (id) => webContents.fromId(id) ?? null,
    send: (target, request) => {
      const contents = webContents.fromId(target.id);
      return contents ? sendInterfaceToolRequest(contents, request) : false;
    },
    sendCancellation: (target, cancellation) => {
      const contents = webContents.fromId(target.id);
      return contents
        ? sendInterfaceToolCancellation(contents, cancellation)
        : false;
    },
    sendPipelineEditor: (target, request) => {
      const contents = webContents.fromId(target.id);
      return contents
        ? sendPipelineEditorInterfaceToolRequest(contents, request)
        : false;
    },
  });
  setMcpSignInPresenterLeases({
    leaseFor: (id) => interfaceLeases.leaseOf(id),
    isLive: (leaseId) => dispatcher.interfaceTools.hasLease(leaseId),
  });
  setRemoteInterfaceLeaseHost(interfaceLeases);
  const claimReply = (
    senderId: number,
    response: unknown,
  ): 'claimed' | 'not_claimed' =>
    interfaceLeases.reply(senderId, response) === 'unknown_call'
      ? 'not_claimed'
      : 'claimed';
  setInterfaceToolReplyHandler(claimReply);
  setPipelineEditorInterfaceToolReplyHandler(claimReply);
  const relay = createRendererRelay({
    bindingProvider: createInterimInMemoryBindingProvider(dispatcher, {
      onCapabilities: (caller, capabilities) => {
        if (capabilities.length === 0)
          registrations.delete(caller.clientInstanceId);
        else registrations.set(caller.clientInstanceId, capabilities);
      },
      onTools: {
        register: interfaceLeases.register,
        unregister: interfaceLeases.unregister,
      },
    }),
    resolveSurface,
    clientVersion: app.getVersion(),
  });
  // The connection opens whenever the account is signed in; each call checks
  // its own feature, so cloud runs work without the cloud chats flag.
  const webCoreRelay = createWebCoreRendererRelay({
    bindingProvider: createWebCoreBindingProvider({
      ...webCore,
      isEnabled: () => true,
    }),
    cloudChatsEnabled: webCore.isEnabled,
    resolveSurface,
    clientVersion: app.getVersion(),
  });
  registerIpcHandler<[CanopyCoreRelayRequest], CanopyCoreRelayReply>(
    IPC_CHANNELS.canopyCoreRelay,
    (event, input) =>
      routeRendererRelayRequest(
        { local: relay, webCore: webCoreRelay },
        event,
        input,
      ),
  );
  return () => {
    ipcMain.removeHandler(IPC_CHANNELS.canopyCoreRelay);
    setInterfaceToolReplyHandler(null);
    setPipelineEditorInterfaceToolReplyHandler(null);
    setRemoteInterfaceLeaseHost(null);
    setMcpSignInPresenterLeases(null);
    interfaceLeases.dispose();
    relay.dispose();
    webCoreRelay.dispose();
    registrations.clear();
  };
}
