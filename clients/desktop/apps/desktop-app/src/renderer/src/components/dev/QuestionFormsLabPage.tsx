import {
  useCallback,
  useEffect,
  useReducer,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  ChatComposerShell,
  AnsweredQuestionsBlock,
  AskUserQuestionCard,
  Button,
  DocumentProse,
  Heading,
  Markdown,
  Surface,
  answersToDisplay,
  type AskUserQuestionCardProps,
} from '@canopy/ui-shared/components';
import type { RemoteControlAskUserQuestionState } from '@canopy/protocol/remote-control/shell';
import {
  QUESTION_PRESETS,
  initialPlaygroundMachine,
  reduceQuestionPlayground,
  type PlaygroundPhase,
} from '@/components/pages/chatQuestionPlaygroundData';
import { ChoiceField, ListRow } from '@canopy/ui-shared/components';
import { applyTheme } from '@/lib/theme';
import { ChoiceOptionsLab } from './ChoiceOptionsLab';
import { LabComposerReplicaInput } from './LabComposerReplicaInput';
import { FieldOptionsLab } from './FieldOptionsLab';

/**
 * Localhost lab for iterating on the interactive question forms outside
 * Electron (`question-forms-lab.vite.mts`, port 5181). It mounts the same
 * shared `AskUserQuestionCard` and `AnsweredQuestionsBlock` the desktop chat
 * and web portal render, docked above a static replica of the compact
 * composer. Requests settle through the playground reducer; nothing leaves
 * the page.
 */

// Compact composer classes from `ChatInput.tsx` while a question is docked.
const COMPACT_COMPOSER_CLASS = 'relative flex flex-wrap items-center';
const COMPACT_EDITOR_CLASS =
  'min-w-0 flex-1 max-h-20 overflow-y-auto cursor-text pl-12 pr-1 py-3';
const COMPACT_EDITABLE_CLASS =
  'min-h-5 w-full whitespace-pre-wrap break-words bg-transparent text-s leading-5 fg-primary outline-none';

function QuestionComposerFrame({
  children,
  open,
}: {
  readonly children: ReactNode;
  readonly open: boolean;
}): JSX.Element {
  if (open) {
    return (
      <Surface variant="raised" className="overflow-hidden">
        {children}
      </Surface>
    );
  }
  return <ChatComposerShell>{children}</ChatComposerShell>;
}

const AUTO_RESOLVE_MS = 600;
const OPEN_PHASES: readonly PlaygroundPhase[] = [
  'pending',
  'submitting',
  'dismissing',
  'error',
  'disconnected',
];

type ColorMode = 'light' | 'dark';
type ColumnWidth = 'normal' | 'compact';
type LabView = 'card' | 'fields' | 'choices';

function renderQuestionMarkdown(text: string): ReactNode {
  return (
    <DocumentProse variant="preview">
      <Markdown>{text}</Markdown>
    </DocumentProse>
  );
}

function LabSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="px-2">
        <Heading level={2} variant="label">
          {title}
        </Heading>
      </div>
      {children}
    </section>
  );
}

function ToggleRow<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}): JSX.Element {
  return (
    <div className="flex flex-wrap gap-1 px-1">
      {options.map((option) => (
        <Button
          key={option.value}
          size="sm"
          variant={option.value === value ? 'secondary' : 'ghost'}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

export function QuestionFormsLabPage(): JSX.Element {
  const [machine, dispatch] = useReducer(
    reduceQuestionPlayground,
    initialPlaygroundMachine,
  );
  const [view, setView] = useState<LabView>('card');
  const [colorMode, setColorMode] = useState<ColorMode>('light');
  const [width, setWidth] = useState<ColumnWidth>('normal');
  const [autoResolve, setAutoResolve] = useState(true);
  const [draft, setDraft] = useState('');

  const preset =
    QUESTION_PRESETS.find((entry) => entry.id === machine.presetId) ??
    QUESTION_PRESETS[0];
  const open = OPEN_PHASES.includes(machine.phase);
  const settling =
    machine.phase === 'submitting' || machine.phase === 'dismissing';

  useEffect(() => {
    applyTheme('default', colorMode);
  }, [colorMode]);

  useEffect(() => {
    if (!autoResolve || !settling) return undefined;
    const timer = window.setTimeout(
      () => dispatch({ type: 'resolve' }),
      AUTO_RESOLVE_MS,
    );
    return (): void => window.clearTimeout(timer);
  }, [autoResolve, settling]);

  const onSubmit = useCallback<AskUserQuestionCardProps['onSubmit']>(
    (answers) => dispatch({ type: 'submit', answers }),
    [],
  );
  const onDismiss = useCallback((): void => dispatch({ type: 'dismiss' }), []);

  const state: RemoteControlAskUserQuestionState = {
    requestId: `lab-${machine.generation}`,
    questions: preset.questions,
    answered: false,
  };

  return (
    <Surface variant="pane" extent="viewport" data-testid="question-forms-lab">
      <div className="flex h-full fg-primary">
        <Surface
          as="aside"
          variant="section"
          boundary="right"
          padding="compact"
          gap="block"
          className="w-64 shrink-0 overflow-y-auto"
        >
          <LabSection title="View">
            <ToggleRow
              value={view}
              onChange={setView}
              options={[
                { value: 'card', label: 'Question card' },
                { value: 'fields', label: 'Fields' },
                { value: 'choices', label: 'Choices' },
              ]}
            />
          </LabSection>
          {view === 'card' && (
            <>
              <LabSection title="Preset">
                <div className="flex flex-col">
                  {QUESTION_PRESETS.map((entry) => (
                    <ListRow
                      key={entry.id}
                      data-testid={`question-forms-lab-preset-${entry.id}`}
                      aria-pressed={entry.id === machine.presetId}
                      selected={entry.id === machine.presetId}
                      onClick={() => dispatch({ type: 'preset', id: entry.id })}
                      description={entry.description}
                    >
                      {entry.title}
                    </ListRow>
                  ))}
                </div>
              </LabSection>

              <LabSection title="Request">
                <div className="flex flex-wrap gap-1 px-1">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!settling}
                    onClick={() => dispatch({ type: 'resolve' })}
                  >
                    Resolve
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!settling}
                    onClick={() => dispatch({ type: 'fail' })}
                  >
                    Fail
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
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
                    size="sm"
                    variant="secondary"
                    onClick={() => dispatch({ type: 'reset' })}
                  >
                    Start again
                  </Button>
                </div>
                <div className="px-2">
                  <ChoiceField
                    label="Resolve automatically"
                    checked={autoResolve}
                    onChange={(event) => setAutoResolve(event.target.checked)}
                  />
                </div>
              </LabSection>
            </>
          )}
          <LabSection title="Appearance">
            <ToggleRow
              value={colorMode}
              onChange={setColorMode}
              options={[
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
            />
            <ToggleRow
              value={width}
              onChange={setWidth}
              options={[
                { value: 'normal', label: 'Normal' },
                { value: 'compact', label: 'Narrow' },
              ]}
            />
          </LabSection>

          {view === 'card' && (
            <LabSection title="Events">
              <ol
                className="flex flex-col gap-0.5 px-2 text-xs fg-secondary"
                data-testid="question-forms-lab-events"
              >
                {machine.events.map((event, index) => (
                  <li key={`${index}-${event}`}>{event}</li>
                ))}
              </ol>
            </LabSection>
          )}
        </Surface>

        {view !== 'card' ? (
          <main className="h-full min-w-0 flex-1 overflow-y-auto">
            {view === 'fields' ? <FieldOptionsLab /> : <ChoiceOptionsLab />}
          </main>
        ) : (
          <main
            className={`mx-auto flex h-full min-w-0 flex-1 flex-col ${
              width === 'compact' ? 'max-w-90' : ''
            }`}
          >
            <div className="min-h-0 flex-1 overflow-y-auto py-6">
              <div className="mx-auto flex w-full max-w-[var(--chat-composer-shell-width)] flex-col gap-4 px-4">
                <div className="flex min-w-0 max-w-full justify-start px-3">
                  <div className="min-w-0 max-w-full text-s fg-primary">
                    <Markdown>{preset.prompt}</Markdown>
                  </div>
                </div>
                {machine.phase === 'answered' ? (
                  <div className="px-3">
                    <AnsweredQuestionsBlock
                      answers={answersToDisplay(
                        machine.answers,
                        preset.questions,
                      )}
                    />
                  </div>
                ) : null}
                {machine.phase === 'dismissed' ? (
                  <p className="px-3 text-xs fg-tertiary">
                    Question dismissed.
                  </p>
                ) : null}
              </div>
            </div>

            <div className="relative mx-auto w-full max-w-[var(--chat-composer-shell-width)] shrink-0 px-4 pb-4 pt-2">
              <QuestionComposerFrame open={open}>
                {open ? (
                  <Surface
                    as="section"
                    variant="panel"
                    aria-label="Questions awaiting your reply"
                    data-testid="chat-question-dock"
                  >
                    <div className="max-h-[min(60vh,32rem)] overflow-y-auto overscroll-contain">
                      <AskUserQuestionCard
                        key={state.requestId}
                        state={state}
                        renderMarkdown={renderQuestionMarkdown}
                        onSubmit={onSubmit}
                        onDismiss={onDismiss}
                        busy={
                          machine.phase === 'submitting'
                            ? 'answer'
                            : machine.phase === 'dismissing'
                              ? 'dismiss'
                              : null
                        }
                        errorKind={
                          machine.phase === 'error'
                            ? machine.failedAction
                            : null
                        }
                        disconnected={machine.phase === 'disconnected'}
                        embedded
                      />
                    </div>
                  </Surface>
                ) : null}
                <Surface
                  variant="section"
                  boundary={open ? 'top' : 'none'}
                  className={COMPACT_COMPOSER_CLASS}
                >
                  <div
                    className={
                      open ? COMPACT_EDITOR_CLASS : 'min-h-22 px-4 pb-12 pt-3'
                    }
                  >
                    <LabComposerReplicaInput
                      aria-label="Message"
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      placeholder="Send a message"
                      className={COMPACT_EDITABLE_CLASS}
                    />
                  </div>
                </Surface>
              </QuestionComposerFrame>
            </div>
          </main>
        )}
      </div>
    </Surface>
  );
}
