import {
  CORE_CLIENT_TOOLS_REGISTER,
  CORE_CLIENT_TOOLS_UNREGISTER,
  interfaceToolDescriptor,
  type InterfaceToolName,
} from '@canopy/protocol/canopy-core';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';

async function invoke(
  method: string,
  params: Record<string, unknown>,
  warnOnFailure: boolean,
): Promise<void> {
  if (typeof window === 'undefined' || !window.canopyCore) return;
  try {
    const reply = await window.canopyCore.invoke({
      kind: 'request',
      method,
      params,
    });
    if (!reply.ok && warnOnFailure)
      // eslint-disable-next-line no-console
      console.warn('[interface-tools] registration failed', reply.error.kind);
  } catch (cause) {
    // The tools are then simply absent.
    reportClientAppError(cause);
  }
}

/** Registers the catalog tools this page implements on its own lease. Failures are logged and ignored: the tools are then simply absent. */
export async function registerInterfaceTools(
  names: readonly InterfaceToolName[],
  idempotencyKey: string,
): Promise<void> {
  await invoke(
    CORE_CLIENT_TOOLS_REGISTER,
    {
      tools: names.map(interfaceToolDescriptor),
      _meta: { idempotencyKey },
    },
    true,
  );
}

/** Removes every tool this page registered. Failures are ignored. */
export async function unregisterAllInterfaceTools(): Promise<void> {
  await invoke(CORE_CLIENT_TOOLS_UNREGISTER, { all: true }, false);
}

/** Removes the named tools from this page's lease. Failures are ignored. */
export async function unregisterInterfaceTools(
  names: readonly InterfaceToolName[],
): Promise<void> {
  await invoke(CORE_CLIENT_TOOLS_UNREGISTER, { toolNames: [...names] }, false);
}

/*
 * A page has one lease, and a registration replaces its whole set, so every
 * bridge on the page contributes here and the page registers the union
 * (CAN-5822). Changes run one at a time, in order. Removing tools uses
 * unregister, which spends none of the lease's registration keys.
 */
const contributions = new Map<number, readonly InterfaceToolName[]>();
let nextContribution = 0;
let registered: ReadonlySet<InterfaceToolName> = new Set();
let pending: Promise<void> = Promise.resolve();

async function syncContributions(): Promise<void> {
  const wanted = [...new Set([...contributions.values()].flat())].sort();
  const added = wanted.some((name) => !registered.has(name));
  const removed = [...registered].filter((name) => !wanted.includes(name));
  registered = new Set(wanted);
  if (added)
    await registerInterfaceTools(
      wanted,
      `interface-tools:${crypto.randomUUID()}`,
    );
  else if (wanted.length === 0 && removed.length > 0)
    await unregisterAllInterfaceTools();
  else if (removed.length > 0) await unregisterInterfaceTools(removed);
}

function scheduleSync(): void {
  pending = pending.then(syncContributions, syncContributions);
}

/**
 * Adds the catalog tools one bridge implements to this page's lease and
 * returns the function that withdraws them. Failures are logged and ignored:
 * the tools are then simply absent.
 */
export function contributeInterfaceTools(
  names: readonly InterfaceToolName[],
): () => void {
  const id = nextContribution++;
  contributions.set(id, [...names]);
  scheduleSync();
  return (): void => {
    if (contributions.delete(id)) scheduleSync();
  };
}
