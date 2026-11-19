import type { RemoteControlChatEventPayload } from '@canopy/protocol/remote-control/shell';
import type { ConversationPresentationSource } from '@canopy/app-core/conversation';
import {
  createConversationHostClientBridge,
  type ConversationHostBridgeTarget,
} from './client-bridge';

/**
 * Host conformance for the shared conversation bridge: every host that binds
 * a cloud conversation must drive the same CanopyClient-shaped chat events
 * for the same conversation. Each host runs this suite with its own fixture.
 */
export interface ConversationConformanceTestApi {
  describe(name: string, body: () => void): void;
  it(name: string, body: () => Promise<void>): void;
}

/** One host's binding, scripted through one conversation. */
export interface ConversationConformanceHost {
  readonly source: ConversationPresentationSource;
  /** A user prompt opens a running turn. */
  startTurn(prompt: string): void;
  /** The running turn's assistant reply so far. */
  reply(text: string): void;
  /** The running turn asks the user an AskUserQuestion request card. */
  askUser(question: string): void;
  endTurn(outcome: 'complete' | 'failed'): void;
  /** The account behind the binding is revoked. */
  revoke(): void;
}

interface RecordedSink extends ConversationHostBridgeTarget {
  readonly messages: RemoteControlChatEventPayload[];
  readonly starts: { userMessageId: string; canonicalId: string }[];
  readonly settles: ('complete' | 'failed')[];
  readonly resets: string[];
}

function recordingSink(): RecordedSink {
  const sink: RecordedSink = {
    messages: [],
    starts: [],
    settles: [],
    resets: [],
    emitChatMessage(payload): void {
      sink.messages.push(payload);
    },
    startTurn(_chatId, userMessageId, canonicalUserMessageId): void {
      sink.starts.push({ userMessageId, canonicalId: canonicalUserMessageId });
    },
    settleTurn(_chatId, status): void {
      sink.settles.push(status);
    },
    resetStream(chatId): void {
      sink.resets.push(chatId);
    },
  };
  return sink;
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Conversation conformance: ${message}`);
}

function lastMessageWithRole(
  sink: RecordedSink,
  role: 'user' | 'assistant',
): RemoteControlChatEventPayload['message'] | undefined {
  const messages = sink.messages
    .map((payload) => payload.message)
    .filter((message) => message.role === role);
  return messages[messages.length - 1];
}

interface Bound {
  readonly host: ConversationConformanceHost;
  readonly sink: RecordedSink;
  /** Re-applies the source's current presentation. */
  readonly reapply: () => void;
}

async function bound(
  makeHost: () => ConversationConformanceHost,
): Promise<Bound> {
  const host = makeHost();
  const sink = recordingSink();
  const bridge = createConversationHostClientBridge(sink);
  const reapply = (): void => bridge.apply(host.source.getSnapshot());
  host.source.subscribe(reapply);
  await host.source.open();
  reapply();
  return { host, sink, reapply };
}

export function runConversationHostConformance(
  t: ConversationConformanceTestApi,
  hostName: string,
  makeHost: () => ConversationConformanceHost,
): void {
  t.describe(`conversation host conformance: ${hostName}`, () => {
    t.it('emits the prompt once and opens its turn', async () => {
      const { host, sink, reapply } = await bound(makeHost);
      host.startTurn('hello');
      const emitted = sink.messages.length;
      reapply();

      const user = lastMessageWithRole(sink, 'user');
      check(user?.text === 'hello', 'the prompt reaches the client');
      check(sink.starts.length === 1, 'the turn opens once');
      check(
        sink.starts[0]?.userMessageId === user?.messageId,
        'the turn opens under the emitted user message',
      );
      check(sink.messages.length === emitted, 'no duplicate emission');
    });

    t.it('streams a reply into one assistant message', async () => {
      const { host, sink } = await bound(makeHost);
      host.startTurn('hello');
      host.reply('Work');
      host.reply('Working');

      const assistantIds = new Set(
        sink.messages
          .map((payload) => payload.message)
          .filter((message) => message.role === 'assistant')
          .map((message) => message.messageId),
      );
      check(assistantIds.size === 1, 'the reply is one message');
      check(
        lastMessageWithRole(sink, 'assistant')?.text === 'Working',
        'the latest reply text reaches the client',
      );
      check(sink.settles.length === 0, 'a running turn does not settle');
    });

    t.it(
      'delivers an AskUserQuestion request card as a tool part',
      async () => {
        const { host, sink } = await bound(makeHost);
        host.startTurn('hello');
        host.askUser('Which branch?');

        const parts = lastMessageWithRole(sink, 'assistant')?.parts ?? [];
        check(
          parts.some(
            (part) =>
              part.kind === 'tool_use' &&
              typeof part.data === 'object' &&
              part.data !== null &&
              'toolName' in part.data &&
              part.data.toolName === 'AskUserQuestion',
          ),
          'the request card arrives as an AskUserQuestion tool part',
        );
      },
    );

    t.it('settles a completed turn as complete', async () => {
      const { host, sink } = await bound(makeHost);
      host.startTurn('hello');
      host.reply('Done');
      host.endTurn('complete');

      check(
        sink.settles.join() === 'complete',
        'the turn settles complete once',
      );
    });

    t.it('settles a failed turn as failed', async () => {
      const { host, sink } = await bound(makeHost);
      host.startTurn('hello');
      host.endTurn('failed');

      check(sink.settles.join() === 'failed', 'the turn settles failed once');
    });

    t.it('resets the stream on revocation without settling', async () => {
      const { host, sink } = await bound(makeHost);
      host.startTurn('hello');
      const emitted = sink.messages.length;
      host.revoke();

      check(sink.resets.length === 1, 'the stream resets once');
      check(sink.settles.length === 0, 'revocation does not settle');
      check(sink.messages.length === emitted, 'nothing is emitted after');
    });
  });
}
