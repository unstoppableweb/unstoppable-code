import { AsyncLocalStorage } from 'node:async_hooks';

const offered = new AsyncLocalStorage<{ value: unknown }>();

/** Runs `run` and returns the Portal-shaped result a catalog effect offered meanwhile, if any. */
export async function captureCatalogRemoteControlResult<T>(
  run: () => Promise<T>,
): Promise<{ result: T; portal: unknown }> {
  const slot: { value: unknown } = { value: undefined };
  const result = await offered.run(slot, run);
  return { result, portal: slot.value };
}

/** Called by a catalog effect with its Portal-shaped result; a no-op outside a capture. */
export function offerCatalogRemoteControlResult(value: unknown): void {
  const slot = offered.getStore();
  if (slot) slot.value = value;
}
