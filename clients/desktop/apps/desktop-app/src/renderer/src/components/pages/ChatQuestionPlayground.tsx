import { CodeBlock } from '@canopy/ui-shared/components/CodeBlock';
import { QuestionPlaygroundPhase } from '@canopy/ui-shared/components';
import { useEffect, useState, type JSX } from 'react';
import { ChatContent } from '../chat/ChatContent';
import {
  Stack,
  Button,
  Disclosure,
  Divider,
  Heading,
  ListRow,
  Surface,
} from '@canopy/ui-shared/components';
import { toActiveComposerView, toActiveTranscriptView } from '../chat/types';
import { ChatSurfaceProvider } from '@/stores/chat/surface-store';
import { createQuestionSandbox } from './chatQuestionSandbox';
import { QUESTION_PRESETS } from './chatQuestionPlaygroundData';

export function ChatQuestionPlayground(): JSX.Element {
  const [sandbox] = useState(createQuestionSandbox);
  const machine = sandbox.machine();
  const dispatch = sandbox.dispatch;
  const tab = sandbox.store((s) => Object.values(s.worktreeChats)[0].tabs[0]);
  useEffect(() => (): void => sandbox.dispose(), [sandbox]);
  const [compact, setCompact] = useState(false);
  const [turnRunning, setTurnRunning] = useState(false);
  const preset =
    QUESTION_PRESETS.find((p) => p.id === machine.presetId) ??
    QUESTION_PRESETS[0];
  const inFlight =
    machine.phase === 'submitting' || machine.phase === 'dismissing';
  const terminal =
    machine.phase === 'answered' || machine.phase === 'dismissed';
  const phases = ['pending', 'submitting', 'answered'] as const;
  const safeAnswers = machine.answers.map((answer, index) =>
    preset.questions[index]?.secret
      ? {
          ...answer,
          selectedOptions: answer.selectedOptions.map(() => '[hidden]'),
          ...(answer.freeformText ? { freeformText: '[hidden]' } : {}),
        }
      : answer,
  );

  const startConversation = (id: string): void =>
    dispatch({ type: 'preset', id });

  return (
    <Surface
      variant="outline"
      extent="parent"
      data-testid="chat-question-playground"
      data-state={machine.phase}
      className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)_280px] overflow-hidden"
    >
      <section
        data-testid="playground-chat"
        className={`flex h-full min-h-0 min-w-0 flex-col ${compact ? 'mx-auto w-full max-w-97.5' : ''}`}
      >
        <Surface
          as="header"
          variant="section"
          boundary="bottom"
          className="shrink-0"
        >
          <div className="flex h-11 items-center justify-between px-4">
            <span className="text-xs font-medium fg-primary">
              {preset.title}
            </span>
            <span className="text-xs fg-secondary">
              {inFlight ? 'Waiting for response' : 'Chat'}
            </span>
          </div>
        </Surface>
        <ChatSurfaceProvider
          scope={{
            store: sandbox.store,
            mode: 'sandbox',
            disconnected: machine.phase === 'disconnected',
          }}
        >
          <ChatContent
            transcript={toActiveTranscriptView(tab)}
            composerTab={toActiveComposerView(tab)}
            onClearQueuedMessage={() => undefined}
            onSendMessage={sandbox.sendMessage}
            hideBranchActions
            hideDirectoryPicker
            disableTerminalMode
            disableFileTypeahead
          />
        </ChatSurfaceProvider>
      </section>
      <Surface
        as="aside"
        variant="pane"
        boundary="left"
        padding="default"
        gap="block"
        aria-label="Playground controls"
        className="min-h-0 overflow-y-auto [&>*]:shrink-0"
      >
        <div className="flex items-center justify-between gap-2">
          <Heading level={2} variant="title">
            Playground controls
          </Heading>
          <Button
            variant="secondary"
            aria-pressed={compact}
            onClick={() => setCompact(!compact)}
          >
            Compact width
          </Button>
        </div>
        <Button
          variant="secondary"
          aria-pressed={turnRunning}
          data-testid="playground-turn-running"
          onClick={() => {
            sandbox.setTurnRunning(!turnRunning);
            setTurnRunning(!turnRunning);
          }}
        >
          Turn still running
        </Button>
        <Stack gap="inline">
          <Heading level={3} variant="label">
            Trigger a question
          </Heading>
          <Stack gap="tight">
            {QUESTION_PRESETS.map((item) => (
              <ListRow
                key={item.id}
                aria-label={item.title}
                aria-pressed={item.id === preset.id}
                selected={item.id === preset.id}
                onClick={() => startConversation(item.id)}
              >
                {item.title}
              </ListRow>
            ))}
          </Stack>
        </Stack>
        <section aria-label="Question state machine">
          <Divider />
          <div className="pt-5">
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <Stack gap="tight">
                  <Heading level={2} variant="title">
                    State machine
                  </Heading>
                  <p className="text-xs fg-secondary">
                    Submit or dismiss in the chat, then resolve or fail the
                    request here.
                  </p>
                </Stack>
                <span
                  role="status"
                  className={`text-s ${machine.phase === 'error' ? 'fg-destructive-strong' : terminal ? 'fg-success-strong' : 'fg-secondary'}`}
                >
                  {machine.phase}
                </span>
              </div>
              <div
                className="flex flex-wrap items-center gap-4"
                aria-label="Submission path"
              >
                {phases.map((phase) => (
                  <QuestionPlaygroundPhase
                    key={phase}
                    active={machine.phase === phase}
                  >
                    {phase}
                  </QuestionPlaygroundPhase>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  disabled={!inFlight}
                  onClick={() => dispatch({ type: 'resolve' })}
                >
                  Resolve request
                </Button>
                <Button
                  variant="secondary"
                  disabled={!inFlight}
                  onClick={() => dispatch({ type: 'fail' })}
                >
                  Fail request
                </Button>
                <Button
                  variant="secondary"
                  disabled={inFlight || terminal}
                  onClick={() =>
                    dispatch({
                      type:
                        machine.phase === 'disconnected'
                          ? 'reconnect'
                          : 'disconnect',
                    })
                  }
                >
                  {machine.phase === 'disconnected'
                    ? 'Reconnect'
                    : 'Disconnect'}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => startConversation(preset.id)}
                >
                  Start again
                </Button>
              </div>
            </div>
            <div className="">
              <Divider />
              <div className="grid gap-4 pt-4 grid-cols-1">
                <Stack gap="inline">
                  <Heading level={3} variant="label">
                    Event history
                  </Heading>
                  <ol className="flex flex-col text-xs fg-primary gap-1">
                    {machine.events.map((event, index) => (
                      <li
                        key={`${index}-${event}`}
                        className="flex items-baseline gap-2"
                      >
                        <span className="tabular-nums fg-secondary">
                          {index + 1}.
                        </span>
                        {event}
                      </li>
                    ))}
                  </ol>
                </Stack>
                <Disclosure label="Response payload">
                  <Surface
                    variant="group"
                    padding="compact"
                    className="overflow-auto"
                  >
                    <CodeBlock
                      variant="bare"
                      size="xs"
                      wrap="words"
                      tone="primary"
                      replay="inherit"
                      overflow="visible"
                    >
                      {JSON.stringify(safeAnswers, null, 2)}
                    </CodeBlock>
                  </Surface>
                </Disclosure>
              </div>
            </div>
          </div>
        </section>
        <p className="text-xs leading-relaxed fg-secondary">
          Local simulation. No messages are sent and no agents are started.
        </p>
      </Surface>
    </Surface>
  );
}
