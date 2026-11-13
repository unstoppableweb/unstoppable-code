import { useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import type { Descendant } from 'slate';
import {
  buildEditorValueFromMessage,
  ComposerEditor,
  createChatEditor,
  serializeEditorValue,
} from '@canopy/ui-rich/editor';
import {
  BUBBLE_SURFACE_CLASS,
  Button,
  CHAT_COMPOSER_SHELL_CLASS,
  Notice,
  NoticeButton,
  NoticeShapeProvider,
  ChatComposerToolbar,
  FLOATING_PICKER_GAP,
  ThinkingLevelPanelPicker,
  UsageIndicator,
  type UsageIndicatorUsage,
  buildPlanModeChip,
  buildQuestionReadyChip,
  ComposerSendButton,
  defaultChatPlaceholder,
} from '@canopy/ui-shared';
import type { ThinkingLevel } from '@canopy/protocol/thinking';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  getEffectiveSupportedThinkingLevelsForModel,
  getModelContextWindow,
  getProviderForModel,
  modelConfigForProviderSupportsFastMode,
  type ApprovalMode,
  type AppAdvisorWatcherSummary,
  type AttachmentMeta,
} from '@canopy/desktop-shared/types';
import { isGatewayOnlyModel } from '@canopy/execution-engine/lib/gateway-model-availability';
import { useComposerMenu } from '@/hooks/useComposerMenu';
import { ChoiceField, Heading, Surface } from '@canopy/ui-shared/components';
import { applyTheme } from '@/lib/theme';
import { DICTATION_SHORTCUT_LABEL } from '@/lib/keyboardShortcuts';
import type { EditorSelectionContext } from '@/lib/editorSelectionContext';
import { ApprovalModePicker } from '@/components/chat/ApprovalModePicker';
import { AttachmentPillCarousel } from '@/components/chat/AttachmentPillCarousel';
import {
  PLAN_APPROVAL_BOX_CLASS,
  PLAN_APPROVAL_EDITOR_CONTAINER_CLASS,
  PlanApprovalPrompt,
} from '@/components/chat/PlanApprovalPrompt';
import {
  QuestionPrompt,
  QuestionSkipButton,
} from '@canopy/ui-shared/components/chat/QuestionPrompt';
import { useQuestionPrompt } from '@canopy/ui-shared/components/chat/useQuestionPrompt';
import { QUESTION_PRESETS } from '@/components/pages/chatQuestionPlaygroundData';
import { DirectoryPicker } from '@/components/chat/DirectoryPicker';
import { ModelPicker } from '@/components/chat/ModelPicker';
import { SelectionContextChips } from '@/components/chat/SelectionContextChips';
import { VoiceRecordingRow } from '@/components/chat/VoiceRecordingRow';
import { ComposerPlusMenu } from '@/components/shared/ComposerPlusMenu';
import { VoiceInputButton } from '@/components/shared/VoiceInputButton';
import { WatcherManagementButton } from '@/components/watchers/WatcherManagementButton';
import {
  buildPlanReadyChip,
  buildChatComposerPlusItems,
  CHAT_COMPOSER_MIN_TEXT_WIDTH_PX,
  ComposerStatusRow,
  expandedComposerEditorContainerClassName,
  ONE_LINE_COMPOSER_BOX_STYLE,
  ONE_LINE_COMPOSER_CLASS_NAMES,
  TERMINAL_MODE_ERROR_SHELL_CLASS,
  TERMINAL_MODE_SHELL_CLASS,
  TerminalModeLabel,
  useAnimatedComposerBox,
  useOneLineComposer,
  VOICE_TAKE_EDITOR_CONTAINER_CLASS,
} from '@/components/chat/ComposerLayout';
import { ChatDropOverlay } from '@/components/chat/ChatDropOverlay';
import { ScheduledSendChip } from '@/components/chat/ScheduledSendChip';
import { useFakeSpeechLevel } from './ComposerVoiceOptionsLab';

/**
 * Dev-only gallery of every chat composer state, side by side: the one-line
 * box, everything that makes it tall, the settings row's variations and the
 * composer's other modes. Each card is assembled from the same pieces
 * `ChatInput` uses, in the same order and with the same conditions, fed with
 * sample state.
 *
 * Open: composer-status-lab with `?view=states` (`&theme=light` for light).
 */

/** File contents the lab's `readFileContent` stand-in serves, by path. */
export const GALLERY_FILE_CONTENTS: Readonly<Record<string, string>> = {
  '/lab/canopy/src/upload/uploader.ts':
    'export async function upload(file: File): Promise<void> {\n  await send(file);\n}\n',
  '/lab/canopy/src/upload/mock-server.ts':
    'const LATENCY_MS = 200;\nexport function startMockServer(): void {}\n',
};

const DEFAULT_PLACEHOLDER = defaultChatPlaceholder(true, true);
/** The gallery's "now", so the scheduled chip reads "Tomorrow 9:00 AM". */
const GALLERY_NOW = new Date(2026, 9, 2, 11, 20);
const DEFAULT_MODEL = 'opus[1m]';
const PANEL_WIDTH = 720;
// ChatInput's toolbar compacts under 40rem of box width.
const COMPACT_BOX_WIDTH = 640;
const COMPACT_CHIPS_BOX_WIDTH = 480;
// The box sits 16px inside the panel on each side.
const BOX_INSET = 32;

function labWatcher(id: string, label: string): AppAdvisorWatcherSummary {
  return {
    id,
    trigger: 'worktree_chat_completion',
    status: 'active',
    label,
    target: {
      kind: 'worktree_chat',
      projectId: 'lab-project',
      worktreeId: 'lab-worktree',
      chatId: `lab-chat-${id}`,
      chatTitle: label,
    },
    destination: {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
      chatId: 'lab-chat',
    },
    createdAt: new Date(Date.now() - 6 * 60_000).toISOString(),
  };
}

const LAB_WATCHERS: readonly AppAdvisorWatcherSummary[] = [
  labWatcher('w1', 'Fix the flaky upload test'),
  labWatcher('w2', 'Review the retry logic'),
  labWatcher('w3', 'Update the testing docs'),
];

function labAttachment(filename: string): AttachmentMeta {
  return { filename, absolutePath: `/lab/attachments/${filename}` };
}

const LAB_ATTACHMENTS: AttachmentMeta[] = [
  labAttachment('ci-failure.png'),
  labAttachment('upload-test.log'),
];

const LAB_MANY_ATTACHMENTS: AttachmentMeta[] = [
  labAttachment('ci-failure.png'),
  labAttachment('flaky-run.png'),
  labAttachment('upload-test.log'),
  labAttachment('response.json'),
  labAttachment('ticket.pdf'),
  labAttachment('Xcode_27.1_beta.xip'),
];

/** A stand-in screenshot, drawn as SVG so the lab needs no image files. */
function labScreenshot(accent: string, label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300" viewBox="0 0 480 300"><rect width="480" height="300" fill="#16181d"/><rect x="0" y="0" width="480" height="36" fill="#22252c"/><circle cx="20" cy="18" r="6" fill="#ff5f57"/><circle cx="40" cy="18" r="6" fill="#febc2e"/><circle cx="60" cy="18" r="6" fill="#28c840"/><rect x="24" y="64" width="300" height="14" rx="7" fill="#3a3f4a"/><rect x="24" y="92" width="380" height="14" rx="7" fill="#3a3f4a"/><rect x="24" y="120" width="220" height="14" rx="7" fill="#3a3f4a"/><rect x="24" y="168" width="432" height="96" rx="10" fill="${accent}" opacity="0.9"/><text x="44" y="224" font-family="Menlo, monospace" font-size="22" fill="#fff">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** What the lab's `readFilePreview` stand-in returns, by path. */
export const GALLERY_FILE_PREVIEWS: Readonly<
  Record<string, { kind: 'image' | 'text' | 'unsupported'; content: string }>
> = {
  '/lab/attachments/ci-failure.png': {
    kind: 'image',
    content: labScreenshot('#c2410c', 'FAIL upload.test.ts'),
  },
  '/lab/attachments/flaky-run.png': {
    kind: 'image',
    content: labScreenshot('#15803d', 'PASS 50/50 runs'),
  },
  '/lab/attachments/upload-test.log': {
    kind: 'text',
    content:
      'FAIL src/upload/uploader.test.ts\n  uploads a file\n    Error: timeout of 200ms exceeded\n      at mock-server.ts:42\n\nTests: 1 failed, 23 passed\nTime: 4.81 s',
  },
  '/lab/attachments/response.json': {
    kind: 'text',
    content: '{"status":"error","error":"link not found"}',
  },
};

function labSelection(
  id: string,
  absolutePath: string,
  displayPath: string,
): EditorSelectionContext {
  const firstLine = (GALLERY_FILE_CONTENTS[absolutePath] ?? '').split('\n')[0];
  const text = firstLine ?? '';
  return {
    id,
    projectId: 'lab-project',
    worktreeId: 'lab-worktree',
    absolutePath,
    displayPath,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: text.length + 1,
    text,
    language: 'typescript',
    capturedDirty: false,
  };
}

const LAB_SELECTIONS: EditorSelectionContext[] = [
  labSelection(
    's1',
    '/lab/canopy/src/upload/uploader.ts',
    'src/upload/uploader.ts',
  ),
];

const LONG_TEXT =
  'The upload test fails about one run in five, mostly on CI. Can you check the mock server timing, make the wait deterministic, and then run the suite fifty times to make sure the flake is really gone before we merge?';

function labUsage(model: string, contextPercent: number): UsageIndicatorUsage {
  const contextWindow = getModelContextWindow(model) ?? 200_000;
  return {
    contextTokens: Math.round((contextWindow * contextPercent) / 100),
    contextWindow,
    totalCostUsd: 0.42,
    inputTokens: 1_200,
    outputTokens: 340,
    cacheReadInputTokens: 90_000,
    cacheCreationInputTokens: 0,
    durationMs: 184_000,
    numTurns: 3,
    model,
  };
}

interface ComposerStateSpec {
  readonly id: string;
  readonly title: string;
  /** Chat panel width; the box is 32px narrower. */
  readonly width?: number;
  readonly text?: string;
  readonly streaming?: boolean;
  readonly watchers?: number;
  readonly attachments?: boolean;
  readonly manyAttachments?: boolean;
  readonly selections?: boolean;
  readonly scheduled?: boolean;
  readonly scheduleError?: string;
  readonly terminalError?: string;
  readonly planMode?: boolean;
  /** A plan waits: the box is the plan-approval prompt. */
  readonly planReady?: boolean;
  /** The prompt was closed: Plan's chip reads "Plan ready". */
  readonly planReadyClosed?: boolean;
  /** Comments on the waiting plan the agent has not received. */
  readonly planUnsentComments?: number;
  /** A question waits: the box asks it (a chat-playground preset id). */
  readonly question?: string;
  /** The question prompt was closed: the chip beside + reads "Question". */
  readonly questionClosed?: boolean;
  readonly multiRepo?: boolean;
  /** Dictation is turned off or unsupported: no microphone. */
  readonly voiceOff?: boolean;
  readonly voiceRecording?: boolean;
  readonly dragging?: boolean;
  readonly pendingModel?: boolean;
  readonly sendBlocked?: boolean;
  readonly stopArmed?: boolean;
  readonly editingQueued?: boolean;
  readonly model?: string;
  readonly autoModel?: boolean;
  readonly thinking?: ThinkingLevel;
  readonly fastMode?: boolean;
  readonly approvalMode?: ApprovalMode;
  readonly contextPercent?: number;
}

/** One composer, assembled the way ChatInput assembles it. */
function GalleryComposer({
  spec,
}: {
  readonly spec: ComposerStateSpec;
}): JSX.Element {
  const editor = useMemo(() => createChatEditor(), []);
  const [value, setValue] = useState<Descendant[]>(() =>
    buildEditorValueFromMessage(spec.text ?? '', []),
  );
  const [planMode, setPlanMode] = useState(spec.planMode === true);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(
    spec.approvalMode ?? 'full-access',
  );
  const [modelId, setModelId] = useState(spec.model ?? DEFAULT_MODEL);
  const [autoModel, setAutoModel] = useState(spec.autoModel === true);
  const [thinking, setThinking] = useState<ThinkingLevel>(
    spec.thinking ?? 'high',
  );
  const [fastMode, setFastMode] = useState(spec.fastMode === true);
  const readFakeLevel = useFakeSpeechLevel();
  const [listeningSince] = useState(() => Date.now() - 14_000);
  const boxRef = useRef<HTMLDivElement>(null);
  const statusRowRef = useRef<HTMLDivElement>(null);
  const composerMenu = useComposerMenu(editor, {
    enabled: true,
    dollar: false,
    scopeKey: `gallery-${spec.id}`,
    onChange: () => setValue(structuredClone(editor.children)),
  });

  const text = serializeEditorValue(value).text;
  const width = spec.width ?? PANEL_WIDTH;
  const isCompact = width - BOX_INSET < COMPACT_BOX_WIDTH;
  // ChatInput draws the chips small under 30rem of box width.
  const chipsCompact = width - BOX_INSET < COMPACT_CHIPS_BOX_WIDTH;
  // As in ChatInput: a draft starting with `!` is a shell command, sent
  // without the `!` (first line only).
  const terminal = text.replace(/^\s+/, '').startsWith('!');
  const terminalCommand = terminal
    ? (text
        .replace(/^\s*!\s*/, '')
        .split(/\r?\n/, 1)[0]
        ?.trim() ?? '')
    : '';
  const voiceRecording = spec.voiceRecording === true;
  const editingQueued = spec.editingQueued === true;
  const watchers = LAB_WATCHERS.slice(0, spec.watchers ?? 0);
  const showWatcher = !editingQueued && watchers.length > 0;
  const attachments = spec.manyAttachments
    ? LAB_MANY_ATTACHMENTS
    : spec.attachments
      ? LAB_ATTACHMENTS
      : [];
  const selections = spec.selections ? LAB_SELECTIONS : [];
  const scheduledRunAt =
    spec.scheduled || spec.scheduleError !== undefined
      ? new Date(2026, 9, 3, 9, 0).toISOString()
      : null;
  const planCard = spec.planReady === true && spec.planReadyClosed !== true;
  const planReadyChip = spec.planReadyClosed === true;
  // A question asks in the box as a plan does. Sending the last answer
  // starts the same question again, so the lab can be replayed.
  const questionPreset = QUESTION_PRESETS.find(
    (preset) => preset.id === spec.question,
  );
  const [questionRound, setQuestionRound] = useState(0);
  const question = useQuestionPrompt({
    requestId: `${spec.id}-${questionRound}`,
    questions: questionPreset?.questions ?? [],
    onSubmit: (): void => setQuestionRound((round) => round + 1),
  });
  const questionCard =
    questionPreset !== undefined && spec.questionClosed !== true;
  const questionChip =
    questionPreset !== undefined && spec.questionClosed === true;
  const promptCard = planCard || questionCard;
  const questionSends = questionCard && question.sendAnswers(text);
  const clearDraft = (): void => {
    const empty = buildEditorValueFromMessage('', []);
    editor.children = empty;
    editor.onChange();
    setValue(empty);
  };
  const sideContentKey = [
    planReadyChip ? 'plan-ready' : planMode ? 'plan' : '',
    scheduledRunAt ? `scheduled:${spec.scheduleError ?? ''}` : '',
    showWatcher ? `watchers:${watchers.length}` : '',
    terminal ? `terminal:${spec.terminalError ?? ''}` : '',
    chipsCompact ? 'compact' : '',
  ].join('|');

  const inline = useOneLineComposer({
    boxRef,
    hasDraftText: text.length > 0,
    allowed:
      !editingQueued &&
      !promptCard &&
      !voiceRecording &&
      selections.length === 0 &&
      attachments.length === 0,
    draftRevision: value,
    minTextWidth: CHAT_COMPOSER_MIN_TEXT_WIDTH_PX,
    sideContentKey,
  });
  useAnimatedComposerBox(boxRef);

  const provider = getProviderForModel(modelId);
  const isCodex = provider === 'codex';
  const thinkingLevels = getEffectiveSupportedThinkingLevelsForModel(
    modelId,
    isGatewayOnlyModel(modelId),
    isCodex ? 'codex' : 'claude',
    undefined,
  );
  const supportsFastMode = modelConfigForProviderSupportsFastMode(
    provider ?? 'claude',
  );

  const voiceAvailable = spec.voiceOff !== true;
  const renderVoiceButton = (primary: boolean): JSX.Element | null =>
    voiceAvailable ? (
      <VoiceInputButton
        state="idle"
        error={null}
        onStart={(): void => {}}
        onStop={(): void => {}}
        disabled={terminal}
        capsule
        primary={primary}
        shortcut={DICTATION_SHORTCUT_LABEL}
      />
    ) : null;

  const shellClasses = terminal
    ? `${CHAT_COMPOSER_SHELL_CLASS} ${
        spec.terminalError === undefined
          ? TERMINAL_MODE_SHELL_CLASS
          : TERMINAL_MODE_ERROR_SHELL_CLASS
      }`
    : CHAT_COMPOSER_SHELL_CLASS;
  const slateContainerClassName = `${expandedComposerEditorContainerClassName(
    'comfortable',
  )}${voiceRecording ? ` ${VOICE_TAKE_EDITOR_CONTAINER_CLASS}` : ''}`;

  const placeholder = voiceRecording
    ? 'Start talking…'
    : editingQueued
      ? 'Edit queued message…'
      : terminal
        ? '! shell command…'
        : questionCard
          ? question.acceptsText
            ? question.kind === 'text'
              ? (question.question.placeholder ?? 'Type your answer')
              : 'Or type your own answer'
            : 'Send a message instead'
          : planCard
            ? 'No, explain what to do differently'
            : spec.planReady
              ? 'Enter your plan adjustments here…'
              : spec.streaming
                ? 'Type to queue a follow-up message…'
                : DEFAULT_PLACEHOLDER;

  const pending = spec.pendingModel === true;
  const trailingSlot: ReactNode = editingQueued ? (
    <>
      <Button size="md" variant="secondary">
        Cancel
      </Button>
      <Button size="md" variant="primary" disabled={!text.trim()}>
        Save
      </Button>
    </>
  ) : terminal ? (
    <ComposerSendButton
      kind="terminal"
      onRun={(): void => {}}
      disabled={!terminalCommand}
      failed={spec.terminalError !== undefined}
    />
  ) : spec.streaming ? (
    <>
      {renderVoiceButton(false)}
      <ComposerSendButton
        kind="stop"
        onStop={(): void => {}}
        pending={pending}
        armed={spec.stopArmed === true}
        shortcutReady
        dataTestId="chat-stop-generation"
      />
    </>
  ) : questionCard && question.skips(text) ? (
    <>
      {renderVoiceButton(false)}
      <QuestionSkipButton
        busy={null}
        onSkip={(): void => setQuestionRound((round) => round + 1)}
      />
    </>
  ) : questionSends ? (
    <>
      {renderVoiceButton(false)}
      <ComposerSendButton
        kind="send"
        onSend={(): void => {
          if (!question.canSend(text)) return;
          question.send(text);
          clearDraft();
        }}
        disabled={!question.canSend(text)}
        pending={false}
      />
    </>
  ) : voiceAvailable && !text.trim() && !pending ? (
    renderVoiceButton(true)
  ) : (
    <>
      {renderVoiceButton(false)}
      <ComposerSendButton
        kind="send"
        onSend={(): void => {}}
        disabled={!text.trim() || spec.sendBlocked === true}
        pending={pending}
        {...(spec.sendBlocked
          ? { blockedReason: 'Sending paused: memory is running low' }
          : {})}
      />
    </>
  );

  const composerEditor = (
    <ComposerEditor
      editor={editor}
      value={value}
      onChange={setValue}
      onKeyDown={(event): void => {
        composerMenu.handleKeyDown(event);
      }}
      monospace={terminal}
      density="minimal"
      className={
        inline || promptCard ? ONE_LINE_COMPOSER_CLASS_NAMES.editor : undefined
      }
      containerClassName={
        promptCard
          ? PLAN_APPROVAL_EDITOR_CONTAINER_CLASS
          : inline
            ? ONE_LINE_COMPOSER_CLASS_NAMES.editorContainer
            : slateContainerClassName
      }
      placeholder={placeholder}
    />
  );
  const composerControls = voiceRecording ? (
    <VoiceRecordingRow
      readLevel={readFakeLevel}
      listeningSince={listeningSince}
      onCancel={(): void => {}}
      onStop={(): void => {}}
      onSend={(): void => {}}
    />
  ) : (
    <ChatComposerToolbar
      capsuleLayout
      compact={isCompact}
      inline={inline || promptCard}
      leadingSlot={
        promptCard ? null : (
          <div
            className={
              inline
                ? `relative shrink-0 ${ONE_LINE_COMPOSER_CLASS_NAMES.leading}`
                : 'relative shrink-0'
            }
          >
            <ComposerPlusMenu
              dataTestIdPrefix={`gallery-${spec.id}`}
              disabled={terminal}
              gap={FLOATING_PICKER_GAP}
              capsuleTrigger
              controller={composerMenu}
              commands={[]}
              onSelectCommand={(): void => {}}
              providerScope="mixed"
              onPickAttachment={(): void => {}}
              additionalItems={buildChatComposerPlusItems({
                onOpenPlugins: (): void => {},
                hasPluginSelections: false,
                plan: {
                  on: planMode,
                  readOnly: false,
                  disabled: terminal,
                  onToggle: (): void => setPlanMode((on) => !on),
                },
                onSchedule: (): void => {},
              })}
            />
          </div>
        )
      }
      planMode={
        promptCard
          ? undefined
          : questionChip
            ? buildQuestionReadyChip({
                compact: chipsCompact,
                onOpen: (): void => {},
              })
            : planReadyChip
              ? buildPlanReadyChip({
                  compact: chipsCompact,
                  onOpen: (): void => {},
                })
              : planMode
                ? buildPlanModeChip({
                    readOnly: false,
                    compact: chipsCompact,
                    disabled: terminal,
                    onDisable: (): void => setPlanMode(false),
                  })
                : undefined
      }
      watchersSlot={
        !promptCard && showWatcher ? (
          <WatcherManagementButton
            watchers={[...watchers]}
            modalTitle="Chat Watchers"
            modalEmptyMessage="No active watchers for this chat."
            ariaLabel="Manage chat watchers"
            dataTestId={`gallery-${spec.id}-watchers`}
            icon="bigtop"
            tooltipTitle="WATCHING"
            appearance="composer-chip"
          />
        ) : null
      }
      scheduledSendSlot={
        !promptCard && scheduledRunAt ? (
          <ScheduledSendChip
            runAt={scheduledRunAt}
            error={spec.scheduleError ?? null}
            editable
            compact={chipsCompact}
            onEdit={(): void => {}}
            onClear={(): void => {}}
            now={GALLERY_NOW}
          />
        ) : null
      }
      terminalLabelSlot={
        terminal ? (
          <TerminalModeLabel error={spec.terminalError ?? null} />
        ) : null
      }
      trailingSlot={trailingSlot}
    />
  );

  return (
    <div
      data-chat-composer-root
      className={`relative mx-auto w-full max-w-[var(--chat-composer-shell-width)] shrink-0 px-4 pt-2 ${
        editingQueued ? 'pb-4' : 'pb-2'
      }`}
    >
      <div
        ref={boxRef}
        data-composer-layout={
          questionCard
            ? 'question'
            : planCard
              ? 'plan-approval'
              : inline
                ? 'one-line'
                : 'full'
        }
        className={
          promptCard
            ? `${shellClasses} ${PLAN_APPROVAL_BOX_CLASS}`
            : inline
              ? `${shellClasses} ${ONE_LINE_COMPOSER_CLASS_NAMES.box}`
              : `${shellClasses} ${ONE_LINE_COMPOSER_CLASS_NAMES.expandedBox}`
        }
        style={inline ? ONE_LINE_COMPOSER_BOX_STYLE : undefined}
      >
        <span
          ref={composerMenu.anchorRef}
          aria-hidden
          className="pointer-events-none absolute inset-0"
        />
        {(attachments.length > 0 || selections.length > 0) && (
          <AttachmentPillCarousel
            leading={
              selections.length > 0 ? (
                <SelectionContextChips
                  selections={selections}
                  onReveal={(): void => {}}
                  onOpen={(): void => {}}
                  onRemove={(): void => {}}
                />
              ) : undefined
            }
            attachments={attachments}
            onRemove={(): void => {}}
          />
        )}

        {questionCard ? (
          <QuestionPrompt
            prompt={question}
            busy={null}
            errorKind={null}
            onRetry={(): void => {}}
            onClose={(): void => {}}
          >
            {composerEditor}
            {composerControls}
          </QuestionPrompt>
        ) : planCard ? (
          <PlanApprovalPrompt
            options={[
              {
                label: 'Yes, implement this plan',
                onSelect: (): void => {},
                testId: `gallery-${spec.id}-plan-implement`,
              },
              {
                label: 'Run it as a workflow',
                onSelect: (): void => {},
                testId: `gallery-${spec.id}-plan-pipeline`,
              },
            ]}
            onOpenPlan={(): void => {}}
            onClose={(): void => {}}
            {...(spec.planUnsentComments !== undefined
              ? {
                  unsentComments: {
                    count: spec.planUnsentComments,
                    onSend: (): void => {},
                  },
                }
              : {})}
          >
            {composerEditor}
            {composerControls}
          </PlanApprovalPrompt>
        ) : (
          <>
            {composerEditor}
            {composerControls}
          </>
        )}
      </div>

      {!editingQueued && (
        <ComposerStatusRow
          rowRef={statusRowRef}
          fill="start"
          start={
            <>
              <div className="flex min-w-0 items-center" aria-busy={pending}>
                <ModelPicker
                  browserLayout="harnesses"
                  currentModel={modelId}
                  onModelChange={(next): void => {
                    if (!next) return;
                    setModelId(next);
                    setAutoModel(false);
                  }}
                  auto={{
                    selected: autoModel,
                    onSelect: (): void => setAutoModel(true),
                  }}
                  allowCursor
                  capsule
                  allowTriggerShrink
                  foldTriggerIconWhenTight
                  foldTriggerIconOnTruncate
                  hideTriggerChevron
                  menuAlignRef={boxRef}
                  menuAlignEdge="left"
                  triggerTooltip={null}
                  disabled={terminal}
                />
              </div>
              {thinkingLevels.length > 0 ? (
                <ThinkingLevelPanelPicker
                  testId={`gallery-${spec.id}-thinking`}
                  value={
                    thinkingLevels.includes(thinking)
                      ? thinking
                      : thinkingLevels[thinkingLevels.length - 1]
                  }
                  supportedLevels={thinkingLevels}
                  includeLow
                  onChange={(next): void => {
                    if (next !== undefined) setThinking(next);
                  }}
                  disabled={terminal}
                  allowTriggerShrink
                  hideTriggerChevron
                  menuAlignEdge="left"
                  menuAlignOffset={-8}
                  {...(supportsFastMode
                    ? {
                        fastMode: {
                          on: fastMode,
                          disabled: terminal,
                          onToggle: (): void => setFastMode((on) => !on),
                        },
                      }
                    : {})}
                />
              ) : null}
              {spec.multiRepo ? (
                <DirectoryPicker
                  currentRepoId="web"
                  childRepos={[
                    { id: 'web', name: 'web' },
                    { id: 'api', name: 'api' },
                  ]}
                  disabled={terminal}
                  statusRow
                  onSelect={(): void => {}}
                />
              ) : null}
            </>
          }
          end={
            <>
              <ApprovalModePicker
                mode={approvalMode}
                onChange={setApprovalMode}
                disabled={terminal}
                hideTriggerIcon
                hideTriggerChevron
                menuAlignRef={boxRef}
                menuAlignEdge="right"
              />
              <div className="shrink-0">
                {/* The composer's 32px round trigger, as the app's wrapper
                    draws it. */}
                <UsageIndicator
                  usage={labUsage(modelId, spec.contextPercent ?? 12)}
                  isCodex={isCodex}
                  alignRef={boxRef}
                  capsule
                />
              </div>
            </>
          }
        />
      )}
    </div>
  );
}

/** A short exchange above the composer, for states about the whole chat. */
function GalleryTranscript(): JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-[var(--chat-reading-width)] flex-col gap-4 px-4 py-6 text-s">
      <div className={`${BUBBLE_SURFACE_CLASS} self-end fg-primary`}>
        The upload test fails about one run in five. Can you find out why?
      </div>
      <p className="m-0 fg-primary">
        The test waits a fixed 200 ms for the upload to finish, but the mock
        server sometimes takes longer under load.
      </p>
    </div>
  );
}

/** ChatInput's read-only footer: the banner in place of the box. */
function ReadOnlyComposer({ stale }: { readonly stale: boolean }): JSX.Element {
  const actions = (
    <>
      <NoticeButton>Start new session</NoticeButton>
      <NoticeButton>Hand off session</NoticeButton>
    </>
  );
  return (
    <div className="relative mx-auto w-full max-w-[var(--chat-composer-shell-width)] shrink-0 px-4 pb-4 pt-2">
      <NoticeShapeProvider shape="composer">
        {stale ? (
          <Notice
            intent="attention"
            title="This session can no longer be resumed"
            actions={actions}
          >
            Your last message was not delivered.
          </Notice>
        ) : (
          <Notice
            intent="neutral"
            role="none"
            title="This session has been archived"
            actions={actions}
          >
            Messages are read-only.
          </Notice>
        )}
      </NoticeShapeProvider>
    </div>
  );
}

interface GallerySection {
  readonly title: string;
  readonly states: readonly (
    | ComposerStateSpec
    | {
        readonly id: string;
        readonly title: string;
        readonly readOnly: 'archived' | 'stale';
      }
  )[];
}

const SECTIONS: readonly GallerySection[] = [
  {
    title: 'One line',
    states: [
      { id: 'empty', title: 'Empty' },
      { id: 'typing', title: 'Typing', text: 'Check the mock server timing' },
      { id: 'running', title: 'Agent running', streaming: true },
      {
        id: 'running-typing',
        title: 'Agent running, follow-up typed',
        streaming: true,
        text: 'Also run it 50 times',
      },
      {
        id: 'stop-armed',
        title: 'Agent running, Esc pressed once',
        streaming: true,
        stopArmed: true,
      },
      { id: 'multi-repo', title: 'Multi-repo folder picker', multiRepo: true },
      {
        id: 'pending-model',
        title: 'Switching model',
        text: 'Check the mock server timing',
        pendingModel: true,
      },
      {
        id: 'blocked',
        title: 'Sending paused (low memory)',
        text: 'Check the mock server timing',
        sendBlocked: true,
      },
      { id: 'voice-off', title: 'Dictation off', voiceOff: true },
      { id: 'dragging', title: 'Dragging files over the chat', dragging: true },
    ],
  },
  {
    title: 'Chips beside +',
    states: [
      { id: 'plan', title: 'Plan mode on', planMode: true },
      { id: 'scheduled', title: 'Scheduled send', scheduled: true },
      {
        id: 'schedule-error',
        title: 'Scheduling failed',
        scheduleError:
          'This harness does not support scheduled messages. Choose another model or clear the schedule.',
      },
      { id: 'watcher-1', title: 'Watcher', watchers: 1 },
      { id: 'watcher-3', title: 'Three watchers', watchers: 3 },
      {
        id: 'watcher-plan',
        title: 'Plan, scheduled send and watchers',
        planMode: true,
        scheduled: true,
        watchers: 3,
      },
      { id: 'terminal', title: 'Terminal mode, just !', text: '!' },
      {
        id: 'terminal-typed',
        title: 'Terminal mode, command typed',
        text: '!npm test -- uploader',
      },
      {
        id: 'terminal-error',
        title: 'Terminal command failed',
        text: '!npm test -- uploader',
        terminalError: "Couldn't send to terminal",
      },
    ],
  },
  {
    title: 'Tall: something extra in the box',
    states: [
      { id: 'long', title: 'Long text (wraps)', text: LONG_TEXT },
      { id: 'attachments', title: 'An image and a file', attachments: true },
      {
        id: 'attachments-many',
        title: 'Many attachments (scrolls sideways)',
        manyAttachments: true,
      },
      { id: 'selection', title: 'Code selection', selections: true },
      {
        id: 'recording',
        title: 'Dictating',
        voiceRecording: true,
        text: 'The upload test fails about one run in five',
      },
      {
        id: 'everything',
        title: 'Everything at once',
        watchers: 3,
        scheduled: true,
        selections: true,
        attachments: true,
        planMode: true,
        text: LONG_TEXT,
      },
    ],
  },
  {
    title: 'Narrow chat panel (360px)',
    states: [
      { id: 'narrow-empty', title: 'Empty', width: 360 },
      {
        id: 'narrow-typing',
        title: 'Typing',
        width: 360,
        text: 'Check the timing',
      },
      {
        id: 'narrow-plan',
        title: 'Plan mode',
        width: 360,
        planMode: true,
      },
      {
        id: 'narrow-chips',
        title: 'Plan, scheduled send and watcher',
        width: 360,
        planMode: true,
        scheduled: true,
        watchers: 1,
      },
      {
        id: 'narrow-terminal',
        title: 'Terminal mode',
        width: 360,
        text: '!ls',
      },
      {
        id: 'narrow-multi-repo',
        title: 'Folder picker',
        width: 360,
        multiRepo: true,
      },
    ],
  },
  {
    title: 'Settings row',
    states: [
      { id: 'row-ask', title: 'Permission: Ask', approvalMode: 'ask' },
      {
        id: 'row-accept',
        title: 'Permission: Accept edits',
        approvalMode: 'auto',
      },
      { id: 'row-auto-model', title: 'Auto model', autoModel: true },
      {
        id: 'row-gpt',
        title: 'GPT model',
        model: 'gpt-6.1-sol',
        thinking: 'medium',
      },
      {
        id: 'row-fast',
        title: 'GPT model, fast mode on',
        model: 'gpt-6.1-sol',
        thinking: 'medium',
        fastMode: true,
      },
      {
        id: 'row-no-effort',
        title: 'Model without effort levels',
        model: 'kimi-k3',
      },
      { id: 'row-context-half', title: 'Context 55% used', contextPercent: 55 },
      { id: 'row-context-full', title: 'Context 92% used', contextPercent: 92 },
    ],
  },
  {
    title: 'Other modes',
    states: [
      {
        id: 'plan-ready',
        title: 'Plan ready to approve',
        planMode: true,
        planReady: true,
      },
      {
        id: 'plan-ready-typed',
        title: 'Plan ready, telling it what to change',
        planMode: true,
        planReady: true,
        text: 'Keep the retry, but cap it at three attempts',
      },
      {
        id: 'plan-ready-unsent-comments',
        title: 'Plan ready, comments not sent',
        planMode: true,
        planReady: true,
        planUnsentComments: 2,
      },
      {
        id: 'plan-ready-closed',
        title: 'Plan ready, prompt closed',
        planMode: true,
        planReady: true,
        planReadyClosed: true,
      },
      {
        id: 'question-choice',
        title: 'Question: one choice',
        question: 'decision',
      },
      {
        id: 'question-classic',
        title: 'Question: choices with your own answer',
        question: 'classic',
      },
      {
        id: 'question-multiple',
        title: 'Question: several choices',
        question: 'multiple',
      },
      {
        id: 'question-reply',
        title: 'Question: a written answer',
        question: 'reply',
      },
      {
        id: 'question-steps',
        title: 'Questions: several steps',
        question: 'brief',
      },
      {
        id: 'question-fields',
        title: 'Questions: a list, a number, a date',
        question: 'release',
      },
      {
        id: 'question-long-list',
        title: 'Question: a long list',
        question: 'long-list',
      },
      {
        id: 'question-private',
        title: 'Question: a private value',
        question: 'secret',
      },
      {
        id: 'question-closed',
        title: 'Question waiting, prompt closed',
        question: 'decision',
        questionClosed: true,
      },
      {
        id: 'editing-queued',
        title: 'Editing a queued message',
        editingQueued: true,
        text: 'Also run it 50 times',
      },
      { id: 'archived', title: 'Archived chat', readOnly: 'archived' },
      { id: 'stale', title: 'Session cannot resume', readOnly: 'stale' },
    ],
  },
];

export function ComposerStatesGallery(): JSX.Element {
  // The lab's entry applies `?theme=` before the first render.
  const [dark, setDark] = useState(
    () => new URLSearchParams(window.location.search).get('theme') !== 'light',
  );
  return (
    <Surface variant="well">
      <div className="min-h-screen fg-primary">
        <Surface variant="pane" boundary="bottom">
          <div className="flex items-center gap-4 px-4 py-3">
            <span className="text-s">Composer states</span>
            <ChoiceField
              label="Dark"
              checked={dark}
              onChange={(event): void => {
                setDark(event.target.checked);
                applyTheme('default', event.target.checked ? 'dark' : 'light');
              }}
            />
          </div>
        </Surface>
        <div className="flex flex-col gap-8 p-6">
          {SECTIONS.map((section) => (
            <section key={section.title} className="flex flex-col gap-3">
              <Heading level={2} variant="title">
                {section.title}
              </Heading>
              <div className="flex flex-wrap items-start gap-4">
                {section.states.map((state) => (
                  <figure
                    key={state.id}
                    data-gallery-state={state.id}
                    className="m-0 flex flex-col gap-1.5"
                  >
                    <figcaption className="text-xs fg-secondary">
                      {state.title}
                    </figcaption>
                    <div
                      data-gallery-capture
                      className="relative overflow-hidden rounded-lg bg-base"
                      style={{
                        width:
                          'width' in state && state.width !== undefined
                            ? state.width
                            : PANEL_WIDTH,
                      }}
                    >
                      {'readOnly' in state ? (
                        <ReadOnlyComposer stale={state.readOnly === 'stale'} />
                      ) : (
                        <>
                          {state.dragging ? <GalleryTranscript /> : null}
                          <GalleryComposer spec={state} />
                          {/* The whole chat dims while files are dragged. */}
                          {state.dragging ? <ChatDropOverlay /> : null}
                        </>
                      )}
                    </div>
                  </figure>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </Surface>
  );
}
