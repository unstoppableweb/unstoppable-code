import {
  COPILOT_RECIPIENT_LIMITS as limits,
  CopilotLocalRequestSchema,
  CopilotLocalFrameSchema,
  type CopilotLocalFrame,
  type CopilotRecipientOutcome,
} from '@canopy/protocol/copilot-recipient';
import type {
  createCopilotLocalRecipientHost,
  CopilotRecipientBinding,
  CopilotLocalDelivery,
} from './local-host';

type LocalHost = ReturnType<typeof createCopilotLocalRecipientHost>;
/** Trusted binding supplies a private authenticated local duplex, not a public socket. */
export async function openCopilotLocalChannel(
  host: LocalHost,
  binding: CopilotRecipientBinding,
  write: (encoded: string) => Promise<void>,
): Promise<{
  opened: CopilotRecipientOutcome;
  receive(encoded: string): Promise<void>;
  disconnect(): void;
}> {
  let disconnected = false;
  let handle: string | undefined;
  let active = 0;
  const abort = new AbortController();
  const requests = new Set<number>();
  let sending = Promise.resolve();
  const disconnect = (): void => {
    disconnected = true;
    abort.abort();
    if (handle) host.disconnect(handle);
  };
  const send = async (
    frame: CopilotLocalFrame,
    guard?: CopilotLocalDelivery,
    submitted?: () => void,
  ): Promise<void> => {
    if (disconnected) throw new Error('Copilot channel unavailable.');
    guard?.admit();
    const encoded = JSON.stringify(CopilotLocalFrameSchema.parse(frame));
    if (Buffer.byteLength(encoded, 'utf8') > limits.frameBytes) {
      disconnect();
      throw new Error('Copilot channel unavailable.');
    }
    const delivery = sending.then(() => {
      if (disconnected) throw new Error('Copilot channel unavailable.');
      guard?.admit();
      submitted?.();
      return write(encoded);
    });
    sending = delivery.catch(disconnect);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel!: () => void;
    guard?.signal.addEventListener('abort', disconnect, { once: true });
    if (guard?.signal.aborted) disconnect();
    try {
      await Promise.race([
        delivery,
        new Promise<never>((_resolve, reject) => {
          cancel = (): void =>
            reject(new Error('Copilot channel unavailable.'));
          abort.signal.addEventListener('abort', cancel, { once: true });
          if (abort.signal.aborted) cancel();
          timer = setTimeout(() => {
            disconnect();
            cancel();
          }, limits.callbackMs);
          timer.unref();
        }),
      ]);
      guard?.admit();
    } finally {
      clearTimeout(timer);
      abort.signal.removeEventListener('abort', cancel);
      guard?.signal.removeEventListener('abort', disconnect);
    }
  };
  const opened = await host.open(binding, {
    send: (message, guard) => send({ kind: 'message', message }, guard),
  });
  if (opened.kind === 'opened') handle = opened.handle;
  else disconnected = true;
  return {
    opened,
    disconnect,
    async receive(encoded): Promise<void> {
      if (disconnected) return;
      if (active >= 32) {
        disconnect();
        return;
      }
      active++;
      let successSubmitted = false;
      try {
        if (
          typeof encoded !== 'string' ||
          Buffer.byteLength(encoded, 'utf8') > limits.frameBytes
        ) {
          disconnect();
          return;
        }
        const parsed = CopilotLocalRequestSchema.safeParse(JSON.parse(encoded));
        if (!parsed.success) {
          disconnect();
          return;
        }
        const { requestId, command } = parsed.data;
        // No cross-handle command authority, even if a peer learns another UUID.
        if (
          command.handle !== handle ||
          requests.has(requestId) ||
          requests.size >= 4096
        ) {
          disconnect();
          return;
        }
        requests.add(requestId);
        // Deliberately not chained to other receives: replies/renewal/cancel must pass a
        // pending run. Each outbound write remains ordered and acknowledged.
        let responded = false;
        const outcome = await host.receive(
          command,
          async (completed, guard): Promise<void> => {
            await send(
              { kind: 'response', requestId, outcome: completed },
              guard,
              () => {
                successSubmitted = true;
              },
            );
            responded = true;
          },
        );
        if (responded && outcome.kind === 'refused')
          throw new Error('Copilot channel unavailable.');
        if (!responded) await send({ kind: 'response', requestId, outcome });
      } catch {
        disconnect();
        // A post-delivery guard failure must not look like an acknowledged success.
        if (successSubmitted) throw new Error('Copilot channel unavailable.');
      } finally {
        active--;
      }
    },
  };
}
