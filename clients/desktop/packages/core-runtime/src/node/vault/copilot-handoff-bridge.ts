import { randomUUID } from 'node:crypto';
import {
  COPILOT_HANDOFF_PROTOCOL,
  COPILOT_HANDOFF_BOUND_MS,
  CopilotHandoffFrameSchema,
  CopilotHandoffWireSchema,
  CopilotHandoffEnvelopeSchema,
  type CopilotHandoffFrame,
  type CopilotHandoffCorrelation,
} from '@canopy/protocol/copilot-handoff';
import type { MigrationWireFrame } from './migration-protocol';
export {
  COPILOT_HANDOFF_PROTOCOL,
  COPILOT_HANDOFF_BOUND_MS,
  type CopilotHandoffFrame,
  type CopilotHandoffCorrelation,
} from '@canopy/protocol/copilot-handoff';

export function encodeCopilotHandoffFrame(
  frame: CopilotHandoffFrame,
): MigrationWireFrame {
  const checked = CopilotHandoffFrameSchema.parse(frame);
  const wire = {
    protocol: checked.protocol,
    version: checked.version,
    type: checked.type,
    payload: JSON.stringify({
      correlation: checked.correlation,
      payload: checked.payload,
    }),
  };
  if (Buffer.byteLength(JSON.stringify(wire)) > 16_384)
    throw new Error('Handoff control too large.');
  return wire;
}
export function parseCopilotHandoffFrame(raw: unknown): CopilotHandoffFrame {
  const wire = CopilotHandoffWireSchema.parse(raw);
  if (Buffer.byteLength(JSON.stringify(wire)) > 16_384)
    throw new Error('Handoff control too large.');
  const inner = CopilotHandoffEnvelopeSchema.parse(JSON.parse(wire.payload));
  return CopilotHandoffFrameSchema.parse({ ...wire, ...inner });
}
export interface CopilotHandoffHost {
  action(payload: string): Promise<string>;
}
/** One coroutine, one outstanding action. Exchange yields instead of awaiting its own next reply. */
export interface CopilotHandoffPump {
  close(): void;
  complete(): void;
  terminal(payload: string): MigrationWireFrame;
  start(
    kind: CopilotHandoffCorrelation['operation'],
    run: (host: CopilotHandoffHost) => Promise<MigrationWireFrame>,
  ): Promise<{ frames: MigrationWireFrame[] }>;
  reply(raw: unknown): Promise<{ frames: MigrationWireFrame[] }>;
}
export function createCopilotHandoffPump(options: {
  sourceFlavor: string;
  sourceMode: string;
  binding(): CopilotHandoffCorrelation['binding'];
  freezeId(): string | null;
  lost(): void;
}): CopilotHandoffPump {
  const incarnation = randomUUID();
  const runId = randomUUID();
  let requestId = 0;
  let closed = false;
  let busy = false;
  let operation: CopilotHandoffCorrelation['operation'] = 'begin';
  let pending:
    | {
        frame: CopilotHandoffFrame;
        resolve(value: string): void;
        reject(error: Error): void;
      }
    | undefined;
  let event: MigrationWireFrame | undefined;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  function close(): void {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    options.lost();
    pending?.reject(new Error('Handoff channel lost.'));
    pending = undefined;
    wake?.();
  }
  function emit(frame: MigrationWireFrame): void {
    event = frame;
    wake?.();
  }
  function facts(): CopilotHandoffCorrelation {
    return {
      incarnation,
      runId,
      requestId: ++requestId,
      operation,
      sourceFlavor: options.sourceFlavor,
      sourceMode: options.sourceMode,
      slot: 'copilot-account',
      binding: options.binding(),
      freezeId: options.freezeId(),
    };
  }
  async function next(): Promise<{ frames: MigrationWireFrame[] }> {
    if (!event && !closed)
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    wake = undefined;
    if (closed || !event) throw new Error('Handoff channel unavailable.');
    const frame = event;
    event = undefined;
    return { frames: [frame] };
  }
  return {
    close,
    complete(): void {
      clearTimeout(timer);
      timer = undefined;
    },
    terminal(payload: string): MigrationWireFrame {
      return encodeCopilotHandoffFrame({
        protocol: COPILOT_HANDOFF_PROTOCOL,
        version: 1,
        type: 'terminal',
        correlation: facts(),
        payload,
      });
    },
    async start(
      kind: CopilotHandoffCorrelation['operation'],
      run: (host: CopilotHandoffHost) => Promise<MigrationWireFrame>,
    ): Promise<{ frames: MigrationWireFrame[] }> {
      if (closed || busy || running || pending || event) {
        close();
        throw new Error('Handoff protocol overlap.');
      }
      busy = true;
      running = true;
      operation = kind;
      timer ??= setTimeout(close, COPILOT_HANDOFF_BOUND_MS);
      try {
        const host: CopilotHandoffHost = {
          action(payload) {
            if (closed || pending || event)
              return Promise.reject(new Error('Handoff action unavailable.'));
            const frame: CopilotHandoffFrame = {
              protocol: COPILOT_HANDOFF_PROTOCOL,
              version: 1,
              type: 'action',
              correlation: facts(),
              payload,
            };
            return new Promise<string>((resolve, reject) => {
              pending = { frame, resolve, reject };
              emit(encodeCopilotHandoffFrame(frame));
            });
          },
        };
        void Promise.resolve()
          .then(() => run(host))
          .then(
            (result) => {
              if (closed) return;
              running = false;
              emit(result);
            },
            () => close(),
          );
        return await next();
      } finally {
        busy = false;
      }
    },
    async reply(raw: unknown): Promise<{ frames: MigrationWireFrame[] }> {
      if (closed || busy || !pending) {
        close();
        throw new Error('Unexpected handoff reply.');
      }
      busy = true;
      try {
        const frame = parseCopilotHandoffFrame(raw);
        if (
          frame.type !== 'reply' ||
          JSON.stringify(frame.correlation) !==
            JSON.stringify(pending.frame.correlation)
        )
          throw new Error('Stale handoff reply.');
        const waiting = pending;
        pending = undefined;
        waiting.resolve(frame.payload);
        return await next();
      } catch (error) {
        close();
        throw error;
      } finally {
        busy = false;
      }
    },
  };
}
