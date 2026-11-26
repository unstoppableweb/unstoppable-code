import { classifyError } from '@canopy/protocol/app-errors/classification';
import {
  isPairedComputerId,
  requestAddressesPairedComputer,
} from '@canopy/protocol/authority-qualified-id';
import { isDeviceId } from '@canopy/protocol/device-relay';
import type {
  PairedComputerHoldResult,
  PairedComputerState,
  PairedComputerWindowEvent,
} from '@canopy/desktop-shared/types';
import type {
  PairedComputerHold,
  PairedComputerListener,
} from './paired-computer-connections';

/** A window's renderer as main sees it: Electron's `WebContents`. */
export interface PairedComputerWindowSender {
  readonly id: number;
  isDestroyed(): boolean;
}

/** What decides whether a sender is one of this computer's own windows. */
export interface OwnWindowChecks<Sender extends PairedComputerWindowSender> {
  /** The paired computer acting through a bridge window, or null. */
  bridgeController: (sender: Sender) => string | null;
  /** Whether the window shows another computer (its separate window). */
  showsAnotherComputer: (sender: Sender) => boolean;
  /** Whether the sender is an app window at all, not a page inside one. */
  isAppWindow: (sender: Sender) => boolean;
}

/**
 * `isOwnWindow` for the window API: an app window that is neither a bridge
 * nor a window showing another computer. A paired computer acting here, or
 * this computer acting for one, never reaches a third computer this way.
 */
export function ownWindowCheck<Sender extends PairedComputerWindowSender>(
  checks: OwnWindowChecks<Sender>,
): (sender: Sender) => boolean {
  return (sender): boolean =>
    checks.bridgeController(sender) === null &&
    !checks.showsAnotherComputer(sender) &&
    checks.isAppWindow(sender);
}

/** The parts of `RemoteControlService` the window API drives. */
export interface PairedComputerWindowService {
  holdComputer(deviceId: string): Promise<PairedComputerHold>;
  invokeComputer(
    deviceId: string,
    channel: string,
    args: unknown[],
    stillWanted?: () => boolean,
  ): Promise<unknown>;
  sendToComputer(
    deviceId: string,
    channel: string,
    args: unknown[],
    stillWanted?: () => boolean,
  ): void;
  onComputerEvent(listener: PairedComputerListener): () => void;
  computerState(deviceId: string): PairedComputerState;
}

export interface PairedComputerWindowApiOptions<
  Sender extends PairedComputerWindowSender,
> {
  service: PairedComputerWindowService;
  /**
   * Whether the sender is one of this computer's own windows. False for a
   * bridge window (a paired computer acting on this computer) and for a
   * window showing another computer: neither may reach a paired computer
   * through this one.
   */
  isOwnWindow: (sender: Sender) => boolean;
  /** Sends one event to one window. */
  deliver: (sender: Sender, event: PairedComputerWindowEvent) => void;
  /**
   * Calls `listener` each time the window's renderer is reset: it crashed,
   * loaded a new document (a reload included) or was destroyed. Ids it was
   * given are gone then, so its holds must go too.
   */
  onRendererReset: (sender: Sender, listener: () => void) => void;
}

/** A call that passed every check, with the holds that allowed it. */
interface CheckedCall {
  deviceId: string;
  channel: string;
  args: unknown[];
  /** Whether a hold that allowed the call still keeps the computer. */
  stillHeld: () => boolean;
}

interface WindowHold<Sender extends PairedComputerWindowSender> {
  readonly holdId: string;
  readonly deviceId: string;
  readonly hold: PairedComputerHold;
  readonly sender: Sender;
}

/**
 * Main's side of the main window's per-computer API (CAN-7761). Each window
 * holds the computers it shows; their pushes, reconnects and state changes
 * go only to windows holding them, tagged with the computer. Every call is
 * checked here, never trusted from the window: the sender must be one of
 * this computer's own windows holding that paired computer, and
 * `RemoteControlService` passes only the channels and arguments the
 * one-window policy allows on the computer's live session.
 */
export class PairedComputerWindowApi<
  Sender extends PairedComputerWindowSender,
> {
  private readonly holds = new Map<string, WindowHold<Sender>>();
  /** Renderer resets seen per watched sender, to spot a hold that outlived one. */
  private readonly rendererResets = new Map<number, number>();
  private nextHoldId = 1;
  private readonly stopListening: () => void;

  constructor(
    private readonly options: PairedComputerWindowApiOptions<Sender>,
  ) {
    this.stopListening = options.service.onComputerEvent((event) => {
      switch (event.type) {
        case 'push':
          this.deliverTo(event.deviceId, {
            deviceId: event.deviceId,
            type: 'push',
            channel: event.channel,
            args: event.args,
          });
          return;
        case 'reconnected':
          this.deliverTo(event.deviceId, {
            deviceId: event.deviceId,
            type: 'reconnected',
          });
          return;
        case 'state':
          this.deliverState(event.deviceId);
          return;
        case 'closed': {
          // Every hold on it was dropped: the windows hear its state once,
          // then nothing more until they hold it again.
          const senders = this.holdersOf(event.deviceId);
          for (const entry of Array.from(this.holds.values())) {
            if (entry.deviceId === event.deviceId)
              this.holds.delete(entry.holdId);
          }
          const state = this.options.service.computerState(event.deviceId);
          for (const sender of senders) {
            this.deliverEvent(sender, {
              deviceId: event.deviceId,
              type: 'state',
              state,
            });
          }
          return;
        }
      }
    });
  }

  async hold(
    sender: Sender,
    deviceId: unknown,
  ): Promise<PairedComputerHoldResult> {
    this.assertOwnWindow(sender);
    const id = parseDeviceId(deviceId);
    this.watchRenderer(sender);
    const resets = this.rendererResets.get(sender.id);
    const hold = await this.options.service.holdComputer(id);
    // The renderer that asked is gone: its successor never saw this hold.
    if (sender.isDestroyed() || this.rendererResets.get(sender.id) !== resets) {
      hold.release();
      throw classifyError(
        new Error('The window reloaded or closed.'),
        'external.state_changed',
      );
    }
    const holdId = String(this.nextHoldId++);
    this.holds.set(holdId, { holdId, deviceId: id, hold, sender });
    return { holdId, state: this.options.service.computerState(id) };
  }

  release(sender: Sender, holdId: unknown): void {
    this.assertOwnWindow(sender);
    if (typeof holdId !== 'string') return;
    const entry = this.holds.get(holdId);
    // A window releases only its own holds.
    if (!entry || entry.sender.id !== sender.id) return;
    this.holds.delete(holdId);
    entry.hold.release();
  }

  invoke(
    sender: Sender,
    deviceId: unknown,
    channel: unknown,
    args: unknown,
  ): Promise<unknown> {
    const call = this.parseCall(sender, deviceId, channel, args);
    // Checked again just before dispatch, against the holds that allowed
    // the call: the window may let go while the connection opens, and
    // neither another window's hold nor one its reloaded page took later
    // may carry it.
    return this.options.service.invokeComputer(
      call.deviceId,
      call.channel,
      call.args,
      call.stillHeld,
    );
  }

  /** Dropped, like any refused send, when the call is not allowed. */
  send(
    sender: Sender,
    deviceId: unknown,
    channel: unknown,
    args: unknown,
  ): void {
    let call: CheckedCall;
    try {
      call = this.parseCall(sender, deviceId, channel, args);
    } catch {
      return;
    }
    this.options.service.sendToComputer(
      call.deviceId,
      call.channel,
      call.args,
      call.stillHeld,
    );
  }

  state(sender: Sender, deviceId: unknown): PairedComputerState {
    this.assertOwnWindow(sender);
    return this.options.service.computerState(parseDeviceId(deviceId));
  }

  dispose(): void {
    this.stopListening();
    for (const entry of Array.from(this.holds.values())) entry.hold.release();
    this.holds.clear();
  }

  private parseCall(
    sender: Sender,
    deviceId: unknown,
    channel: unknown,
    args: unknown,
  ): CheckedCall {
    this.assertOwnWindow(sender);
    const id = parseDeviceId(deviceId);
    if (
      typeof channel !== 'string' ||
      channel.length === 0 ||
      channel.length > 256
    )
      throw classifyError(
        new Error('Channel must be a non-empty string.'),
        'input.not_accepted',
      );
    if (!Array.isArray(args))
      throw classifyError(
        new Error('Arguments must be an array.'),
        'input.not_accepted',
      );
    // The computer that owns an id is called with its own local id; a
    // qualified one here is the window's mistake, refused before it leaves.
    const callArgs: unknown[] = args;
    if (
      callArgs.some((arg) =>
        argumentAddressesPairedComputer(arg, ADDRESS_SEARCH_DEPTH),
      )
    )
      throw classifyError(
        new Error('Invalid id: pass the computer its own id.'),
        'input.not_accepted',
      );
    const authorizing = this.liveHolds(sender, id);
    if (authorizing.length === 0)
      throw classifyError(
        new Error('This window is not connected to that computer.'),
        'external.state_changed',
      );
    return {
      deviceId: id,
      channel,
      args: callArgs,
      stillHeld: (): boolean =>
        !sender.isDestroyed() &&
        authorizing.some(
          (entry) => entry.hold.held && this.holds.get(entry.holdId) === entry,
        ),
    };
  }

  private assertOwnWindow(sender: Sender): void {
    if (!this.options.isOwnWindow(sender))
      throw classifyError(
        new Error(
          "Only this computer's own windows can reach a paired computer.",
        ),
        'input.not_accepted',
      );
  }

  /** The window's holds on the computer that still keep it. */
  private liveHolds(sender: Sender, deviceId: string): WindowHold<Sender>[] {
    if (sender.isDestroyed()) return [];
    return Array.from(this.holds.values()).filter(
      (entry) =>
        entry.sender.id === sender.id &&
        entry.deviceId === deviceId &&
        entry.hold.held,
    );
  }

  private holdersOf(deviceId: string): Sender[] {
    const senders = new Map<number, Sender>();
    for (const entry of this.holds.values()) {
      if (entry.deviceId === deviceId)
        senders.set(entry.sender.id, entry.sender);
    }
    return Array.from(senders.values());
  }

  private deliverTo(deviceId: string, event: PairedComputerWindowEvent): void {
    for (const sender of this.holdersOf(deviceId))
      this.deliverEvent(sender, event);
  }

  private deliverState(deviceId: string): void {
    const senders = this.holdersOf(deviceId);
    if (senders.length === 0) return;
    const state = this.options.service.computerState(deviceId);
    for (const sender of senders) {
      this.deliverEvent(sender, { deviceId, type: 'state', state });
    }
  }

  private deliverEvent(sender: Sender, event: PairedComputerWindowEvent): void {
    if (!sender.isDestroyed()) this.options.deliver(sender, event);
  }

  /** Releases the window's holds whenever its renderer is reset. */
  private watchRenderer(sender: Sender): void {
    if (this.rendererResets.has(sender.id)) return;
    this.rendererResets.set(sender.id, 0);
    this.options.onRendererReset(sender, () => {
      if (sender.isDestroyed()) this.rendererResets.delete(sender.id);
      else
        this.rendererResets.set(
          sender.id,
          (this.rendererResets.get(sender.id) ?? 0) + 1,
        );
      for (const entry of Array.from(this.holds.values())) {
        if (entry.sender.id !== sender.id) continue;
        this.holds.delete(entry.holdId);
        entry.hold.release();
      }
    });
  }
}

/** How many containers deep the window's arguments are searched. */
const ADDRESS_SEARCH_DEPTH = 4;

/**
 * Address fields the session snapshot's selectors use (`DesktopSessionSnapshotArgs`),
 * on top of the shared ones `requestAddressesPairedComputer` reads.
 */
const SNAPSHOT_SELECTOR_FIELDS: readonly string[] = [
  'workspaceLocalId',
  'worktreeLocalId',
  'standaloneChatLocalId',
];

function selectsPairedComputer(value: object): boolean {
  return SNAPSHOT_SELECTOR_FIELDS.some((field) => {
    const id: unknown = Reflect.get(value, field);
    return typeof id === 'string' && isPairedComputerId(id);
  });
}

/**
 * Whether an argument names a paired computer's id in an address field
 * (CAN-7757), at its top level or in any object or list inside it, such as
 * the scopes a chat:set-state-scopes declaration lists, and in the session
 * snapshot's selectors. Only address fields are read, never free text.
 */
function argumentAddressesPairedComputer(
  value: unknown,
  depth: number,
): boolean {
  if (requestAddressesPairedComputer(value)) return true;
  if (typeof value !== 'object' || value === null) return false;
  if (!Array.isArray(value) && selectsPairedComputer(value)) return true;
  if (depth === 0) return false;
  const children: unknown[] = Array.isArray(value)
    ? value
    : Object.values(value);
  return children.some((child) =>
    argumentAddressesPairedComputer(child, depth - 1),
  );
}

function parseDeviceId(value: unknown): string {
  if (typeof value !== 'string' || !isDeviceId(value))
    throw classifyError(new Error('Invalid device ID.'), 'input.not_accepted');
  return value;
}
