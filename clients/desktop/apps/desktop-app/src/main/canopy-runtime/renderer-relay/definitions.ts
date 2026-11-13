import {
  CANOPY_STREAM_DEFINITIONS,
  CORE_CLIENT_TOOL_INSTRUCTION_DEFINITIONS,
  CORE_CLIENT_TOOLS_REGISTER,
  CORE_CLIENT_TOOLS_UNREGISTER,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  composeCanopyInstructionRegistries,
  composeCanopyQueryRegistries,
  composeCanopyStreamRegistries,
  type CanopyCallerDescriptor,
  type CanopyInstructionDefinitionMap,
  type CanopyQueryDefinitionMap,
  type CanopyStreamDefinitionMap,
} from '@canopy/protocol/canopy-core';
import {
  CANOPY_RUNTIME_QUERY_DEFINITIONS,
  CANOPY_RUNTIME_STREAM_DEFINITIONS,
} from '@canopy/core-runtime';
import type { CanopyFramedConnection } from '@canopy/core-transport/types';
import { DESKTOP_INSTRUCTION_DEFINITIONS } from '../desktop-instruction-definitions';
import { DESKTOP_QUERY_DEFINITIONS } from '../desktop-query-definitions';

export const CAPABILITIES_REGISTER = 'core.client.capabilities.register';
export const TOOLS_REGISTER = CORE_CLIENT_TOOLS_REGISTER;
export const TOOLS_UNREGISTER = CORE_CLIENT_TOOLS_UNREGISTER;

export interface RelayDefinitions {
  readonly queries: CanopyQueryDefinitionMap;
  readonly instructions: CanopyInstructionDefinitionMap;
  readonly streams: CanopyStreamDefinitionMap;
}

/**
 * Everything the renderer relay can reach: the desktop dispatcher's
 * registries, runtime health/events, and capability registration. The
 * handshake is not listed; the client runs it before any of these.
 */
export const RELAY_DEFINITIONS: RelayDefinitions = {
  queries: composeCanopyQueryRegistries(
    DESKTOP_QUERY_DEFINITIONS,
    CANOPY_RUNTIME_QUERY_DEFINITIONS,
  ),
  instructions: composeCanopyInstructionRegistries(
    DESKTOP_INSTRUCTION_DEFINITIONS,
    {
      [CAPABILITIES_REGISTER]:
        CORE_TRANSPORT_INSTRUCTION_DEFINITIONS[CAPABILITIES_REGISTER],
      ...CORE_CLIENT_TOOL_INSTRUCTION_DEFINITIONS,
    },
  ),
  streams: composeCanopyStreamRegistries(
    CANOPY_STREAM_DEFINITIONS,
    CANOPY_RUNTIME_STREAM_DEFINITIONS,
  ),
};

/**
 * A bound connection plus a host-local stream release. The relay calls
 * `releaseStream` with the open result's `subscriptionId` when the renderer
 * closes a stream, including one whose open settled after the renderer gave
 * up. Unknown or ended ids no-op.
 */
export interface RelayBindingConnection extends CanopyFramedConnection {
  /**
   * `ended`: the core delivered its end; `unsubscribed`: abandoned and the
   * client asked the core to drop it (`core.events.unsubscribe`, CAN-5970);
   * `cancelled`: abandoned while the core may still serve it.
   */
  releaseStream?(
    subscriptionId: string,
    reason?: 'ended' | 'unsubscribed' | 'cancelled',
  ): void;
}

/** Opens one authenticated framed connection bound to `caller`. */
export type RelayBindingProvider = (input: {
  caller: CanopyCallerDescriptor;
  /** The WebContents this connection serves; set by the relay host, never by the renderer. */
  webContentsId: number;
  signal: AbortSignal;
}) => Promise<RelayBindingConnection>;
