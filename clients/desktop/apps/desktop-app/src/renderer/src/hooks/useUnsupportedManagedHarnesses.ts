import { useEffect, useState } from 'react';
import type { ModelPickerManagedHarness } from '@canopy/ui-shared/components';
import { readAntigravityHostSupport } from '@/lib/antigravity-settings';

/**
 * Whether the computer this window runs on (the controlled one, in a window
 * that shows another computer) has a pinned runtime for each managed harness,
 * read from each harness's own status, which reports `supported` from the
 * pinned runtime metadata. Antigravity's answer is the window's manifest-only
 * host-support read, never its status, which can resolve and hash the CLI.
 * Cached for the window's life: support only changes with an app update. A
 * read that fails says nothing.
 */
const MANAGED_HARNESSES: readonly ModelPickerManagedHarness[] = [
  'antigravity',
  'cursor',
  'copilot',
  'opencode',
];
const known = new Map<ModelPickerManagedHarness, boolean>();
const pending = new Map<ModelPickerManagedHarness, Promise<void>>();

async function readSupported(
  harness: ModelPickerManagedHarness,
): Promise<boolean | undefined> {
  switch (harness) {
    case 'antigravity':
      return readAntigravityHostSupport();
    case 'cursor':
      return (await window.api.cursorConnection?.status())?.supported;
    case 'copilot':
      return (await window.api.copilotConnection?.status())?.supported;
    case 'opencode':
      return (await window.api.opencodeConnection?.status())?.supported;
  }
}

function load(harness: ModelPickerManagedHarness): Promise<void> {
  const existing = pending.get(harness);
  if (existing) return existing;
  // A harness that can't report (its rollout is off, or the computer is too
  // old to answer) keeps its connect prompt.
  const read = Promise.allSettled([readSupported(harness)]).then(([result]) => {
    if (result?.status === 'fulfilled' && result.value !== undefined)
      known.set(harness, result.value);
  });
  pending.set(harness, read);
  return read;
}

function unsupportedOf(
  harnesses: readonly ModelPickerManagedHarness[],
): ReadonlySet<ModelPickerManagedHarness> {
  return new Set(harnesses.filter((harness) => known.get(harness) === false));
}

/**
 * The managed harnesses among `harnesses` that can't run on this computer.
 * Pass only the harnesses the picker shows as disconnected, so a connected
 * one is never read.
 */
export function useUnsupportedManagedHarnesses(
  harnesses: readonly ModelPickerManagedHarness[],
): ReadonlySet<ModelPickerManagedHarness> {
  const key = [...harnesses].sort().join(',');
  const [unsupported, setUnsupported] = useState(() =>
    unsupportedOf(harnesses),
  );
  useEffect(() => {
    const names = key.split(',');
    const wanted = MANAGED_HARNESSES.filter((harness) =>
      names.includes(harness),
    );
    let mounted = true;
    void Promise.all(wanted.map(load)).then(() => {
      if (mounted) setUnsupported(unsupportedOf(wanted));
    });
    return (): void => {
      mounted = false;
    };
  }, [key]);
  return unsupported;
}

/**
 * How the desktop picker shows Antigravity, from the window's own
 * host-support answer (`hostSupport`, undefined until main answers or while
 * Google chats are off): whether it is listed, and whether it says this
 * computer can't run it. Reusing that one answer keeps a picker mount to a
 * single host-support read.
 */
export function antigravityPickerEntry(input: {
  hostSupport: boolean | undefined;
  released: boolean;
  available: boolean;
}): { listed: boolean; unsupported: boolean } {
  return {
    // Nothing until main answers; then listed either way, so a computer
    // without a pinned CLI says why instead of leaving Antigravity out.
    listed:
      input.hostSupport !== undefined && (input.released || input.available),
    unsupported: input.hostSupport === false,
  };
}
