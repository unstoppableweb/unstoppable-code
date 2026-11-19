/** @jest-environment jsdom */
/**
 * Turn notices (CAN-6176): the shared transcript shows a host's notes under
 * the turn whose `userMessageId` keys them. The web core gives a prompt its
 * own transcript id, so a note keyed by the send's own `messageId` must not
 * show; only the id the send's receipt names reaches the turn.
 */
import { act } from 'react';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { createRoot, type Root } from 'react-dom/client';
import type {
  RemoteControlChatMessage,
  RemoteControlChatTurnGroup,
} from '@canopy/protocol/remote-control/shell';
import { ChatTranscript } from '../ChatTranscript';

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** The web core's id for the prompt, which the transcript turn carries. */
const RECEIPT_ID = 'transcript-msg-9';
/** The send's own messageId, which the web core does not keep. */
const SEND_ID = 'msg-1';

const messages: RemoteControlChatMessage[] = [
  {
    messageId: RECEIPT_ID,
    chatId: 'chat-1',
    role: 'user',
    status: 'complete',
    text: 'Plan the launch',
    createdAtMs: Date.UTC(2026, 10, 10, 18),
  },
];
const turnGroups: RemoteControlChatTurnGroup[] = [
  {
    userMessageId: RECEIPT_ID,
    intermediateMessageIds: [],
    finalMessageIds: [],
    expandedMessageIds: [],
    complete: true,
    summary: null,
  } as unknown as RemoteControlChatTurnGroup,
];
const NOTE = [{ kind: 'capability_copy_stale' as const, name: 'helper' }];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(
  turnNotices?: Readonly<Record<string, readonly (typeof NOTE)[number][]>>,
): void {
  act(() => {
    root.render(
      <ChatTranscript
        messages={messages}
        turnGroups={turnGroups}
        status="idle"
        {...(turnNotices === undefined ? {} : { turnNotices })}
      />,
    );
  });
}

describe('turn notices in the shared transcript (CAN-6176)', () => {
  it('shows a note under the turn its receipt id names', () => {
    render({ [RECEIPT_ID]: NOTE });
    expect(
      container.querySelector('[data-testid="chat-turn-notices"]')?.textContent,
    ).toContain('Used the last published copy of helper.');
  });

  it('keeps the skill name out of session replay', () => {
    render({ [RECEIPT_ID]: NOTE });
    const blocked = container.querySelector(
      `[data-testid="chat-turn-notices"] .${REPLAY_BLOCK_CLASS}`,
    );
    expect(blocked?.textContent).toBe(
      'Used the last published copy of helper.',
    );
  });

  it('shows nothing for a note keyed by the send’s own messageId', () => {
    render({ [SEND_ID]: NOTE });
    expect(
      container.querySelector('[data-testid="chat-turn-notices"]'),
    ).toBeNull();
  });

  it('shows nothing when the host passes no notes', () => {
    render();
    expect(
      container.querySelector('[data-testid="chat-turn-notices"]'),
    ).toBeNull();
  });
});
