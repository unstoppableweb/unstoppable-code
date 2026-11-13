import { logMainProcessWarn } from '../../lib/main-process-logging';
import type { CloudReachBack } from './runtime';

let running: Promise<
  (CloudReachBack & { stop(): Promise<void> }) | null
> | null = null;

/**
 * Starts reach-back after startup (CAN-6176 PR 7a). It loads lazily and
 * holds nothing (no connection, no route) until the signed-in account allows
 * a server in cloud chats with the desktop cloud chats flag on. Returns the
 * stop.
 */
export function startCloudReachBack(): () => void {
  running ??= import('./runtime')
    .then((runtime) => runtime.startCloudReachBackRuntime())
    .catch((error: unknown) => {
      logMainProcessWarn('[cloud-reach-back] Could not start.', error);
      return null;
    });
  return () => {
    const current = running;
    running = null;
    void current?.then((started) => started?.stop());
  };
}

/** The running service's parts, for the opt-in dialog (PR 7c). */
export async function getCloudReachBack(): Promise<CloudReachBack | null> {
  return (await running) ?? null;
}
