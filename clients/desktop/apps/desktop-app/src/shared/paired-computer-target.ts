import { ipcArgumentsAddressPairedComputer } from '@canopy/protocol/authority-qualified-id';

/**
 * Local IPC channels that may carry a paired computer's ids, each with the
 * reason (CAN-8065). Every other channel refuses them, in preload and in
 * main. Keep it empty unless a channel truly needs one: a paired computer's
 * chats reach it through the remote-control channels with its own local ids.
 */
export const PAIRED_COMPUTER_ID_CHANNELS: ReadonlyMap<string, string> = new Map<
  string,
  string
>([]);

/**
 * Request fields that can hold another computer's ids and are deliberately
 * not read (CAN-8065), each with the reason. The scan reads only address
 * containers (`IPC_ADDRESS_CONTAINERS`), and none of these is one.
 */
export const PAIRED_COMPUTER_ID_OPAQUE_FIELDS: ReadonlyMap<string, string> =
  new Map<string, string>([
    ['inputs', "A workflow's own inputs are its data, not where it runs."],
    [
      'lastActiveContext',
      'Saved preferences may record any task, and a refused save would lose them all.',
    ],
    [
      'state',
      "A saved panel state records its browsers' own tasks; the save is addressed by its top-level ids.",
    ],
    [
      'uiState',
      "App Advisor's snapshot of the screen may show a paired computer's chat.",
    ],
    [
      'agentSent',
      "A message's provenance names the chat that sent it, which may be another computer's.",
    ],
    [
      'agentSenderProvenance',
      "A message's provenance names the chat that sent it, which may be another computer's.",
    ],
  ]);

/**
 * Returns true when a local Electron IPC request carries a paired-computer
 * authority-qualified project, worktree, or chat ID (`computer-<deviceId>:...`).
 * Non-paired requests fail the prefix check immediately and pass through unchanged.
 */
export function hasPairedComputerTarget(request: unknown): boolean {
  return ipcArgumentsAddressPairedComputer([request]);
}

/**
 * Whether a local IPC call on `channel` must be refused because its
 * arguments address a paired computer (see `ipcArgumentsAddressPairedComputer`).
 */
export function refusesPairedComputerIds(
  channel: string,
  args: readonly unknown[],
): boolean {
  return (
    !PAIRED_COMPUTER_ID_CHANNELS.has(channel) &&
    ipcArgumentsAddressPairedComputer(args)
  );
}

export function rejectPairedComputerLocalIpc(channel: string): Promise<never> {
  return Promise.reject(pairedComputerLocalIpcError(channel));
}

/** The refusal a local IPC call that addresses a paired computer gets. */
export function pairedComputerLocalIpcError(
  channel: string,
): Error & { code: 'capability_unavailable' } {
  return Object.assign(
    new Error(
      `Local IPC ${channel} is not available for paired computer scopes.`,
    ),
    { code: 'capability_unavailable' as const },
  );
}
