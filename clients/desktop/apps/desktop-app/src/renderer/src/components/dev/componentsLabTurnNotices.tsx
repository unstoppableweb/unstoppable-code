import type { JSX } from 'react';
import type {
  RemoteControlChatMessage,
  RemoteControlChatTurnGroup,
} from '@canopy/protocol/remote-control/shell';
import { ChatTranscript } from '@canopy/ui-app';
import { SpecimenCell, SpecimenPanel } from './componentsLabParts';

/** Fixture turns: one prompt and its reply. */
const PROMPT_ID = 'lab-turn-notices-prompt';
const REPLY_ID = 'lab-turn-notices-reply';
const AT = Date.UTC(2026, 10, 10, 18);

const messages: RemoteControlChatMessage[] = [
  {
    messageId: PROMPT_ID,
    chatId: 'lab-chat',
    role: 'user',
    status: 'complete',
    text: 'Draft the release notes with the changelog skill.',
    createdAtMs: AT,
  },
  {
    messageId: REPLY_ID,
    chatId: 'lab-chat',
    role: 'assistant',
    status: 'complete',
    text: 'Here are the release notes, grouped by area.',
    createdAtMs: AT + 1_000,
  },
];

const turnGroups: RemoteControlChatTurnGroup[] = [
  {
    userMessageId: PROMPT_ID,
    intermediateMessageIds: [],
    finalMessageIds: [REPLY_ID],
    expandedMessageIds: [REPLY_ID],
    complete: true,
  },
];

function Transcript({
  turnNotices,
}: {
  readonly turnNotices?: Parameters<typeof ChatTranscript>[0]['turnNotices'];
}): JSX.Element {
  return (
    <div className="flex h-72 w-full flex-col">
      <ChatTranscript
        messages={messages}
        turnGroups={turnGroups}
        status="idle"
        {...(turnNotices === undefined ? {} : { turnNotices })}
      />
    </div>
  );
}

/**
 * Turn notices (CAN-6176), rendered from fixtures: the same shared transcript
 * as a local chat, which keeps no notes, and as a desktop cloud chat whose
 * turn used a skill's last published copy.
 */
export function TurnNoticesSpecimen(): JSX.Element {
  return (
    <SpecimenPanel title="ChatTranscript turnNotices (fixture render)">
      <SpecimenCell
        label="Local chat (left), no turn notices, beside a desktop cloud chat (right) whose turn used a skill's last published copy"
        wide
      >
        <div className="grid w-full grid-cols-2 gap-4">
          <Transcript />
          <Transcript
            turnNotices={{
              [PROMPT_ID]: [
                { kind: 'capability_copy_stale', name: 'changelog' },
              ],
            }}
          />
        </div>
      </SpecimenCell>
    </SpecimenPanel>
  );
}
