import type { TerminalClient } from '@canopy/app-core';
import {
  createDurableTerminalClient,
  createScopedTerminalClient,
} from '@canopy/app-state/core-cowork';
import { createRelayCoreCoworkInvoker } from '@/cloud-chats/relay-invoker';
import { isWebCoreScope, webCoreLocalId } from '@/lib/chat-authority';

/**
 * Cloud terminals per window. Each holds one relay stream of the relay's 16,
 * which cloud chats use up to 10 of (one task stream, eight chat streams and
 * one live stream).
 */
const MAX_CLOUD_TERMINALS = 4;
/** As `DurablePtyClient` keeps reading after a kill for the exit it causes. */
const KILL_DRAIN_MS = 5_000;

/**
 * The desktop's terminal client with cloud chat terminals (CAN-6175 R10):
 * local work entries keep `local`; a cloud chat's terminals run as durable
 * shells in its sandbox over the web core relay. `dispose` kills them.
 */
export function createDesktopCloudTerminalClient(local: TerminalClient): {
  readonly client: TerminalClient;
  readonly dispose: () => void;
} {
  const lifetime = new AbortController();
  const connection = {
    invoker: createRelayCoreCoworkInvoker(window.canopyCore),
    signal: lifetime.signal,
  };
  const cloud = createDurableTerminalClient({
    connection: () => (lifetime.signal.aborted ? undefined : connection),
    chatIdOf: webCoreLocalId,
    maxTerminals: MAX_CLOUD_TERMINALS,
  });
  return {
    client: createScopedTerminalClient({
      local,
      cloud,
      isCloudScope: isWebCoreScope,
    }),
    dispose: (): void => {
      cloud.dispose();
      // The kills go out on this connection; end it once they have drained.
      setTimeout(() => lifetime.abort(), KILL_DRAIN_MS);
    },
  };
}
