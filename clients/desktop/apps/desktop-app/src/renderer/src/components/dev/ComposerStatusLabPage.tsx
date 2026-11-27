import { useMemo, useRef, useState, type JSX, type RefObject } from 'react';
import type { Descendant } from 'slate';
import { Transforms } from 'slate';
import {
  buildEditorValueFromMessage,
  ComposerEditor,
  createChatEditor,
  focusEditor,
  serializeEditorValue,
} from '@canopy/ui-rich/editor';
import {
  BUBBLE_SURFACE_CLASS,
  CHAT_COMPOSER_SHELL_CLASS,
  ChatComposerToolbar,
  PICKER_GAP,
  ThinkingLevelControl,
  ThinkingLevelPanelPicker,
  UsageIndicator,
  UsageIndicatorAccountSummary,
  type UsageIndicatorContextBreakdown,
  type UsageIndicatorUsage,
  buildPlanModeChip,
  ComposerSendButton,
  defaultChatPlaceholder,
} from '@canopy/ui-shared';
import {
  ChatComposerToolbarChip,
  ChoiceField,
  SettingsSelect,
  Surface,
  ResizeRailIndicator,
} from '@canopy/ui-shared/components';
import {
  THINKING_LEVELS as CANONICAL_THINKING_LEVELS,
  type ThinkingLevel,
} from '@canopy/protocol/thinking';
import type {
  ApprovalMode,
  FileIndexEntry,
  RepoFileIndex,
  SlashCommandData,
} from '@canopy/desktop-shared/types';
import { useComposerMenu } from '@/hooks/useComposerMenu';
import { LabSlider } from './LabSlider';
import { getSlashCommandInsertText } from '@/hooks/useSlashCommands';
import {
  buildComposerCommands,
  getComposerAction,
} from '@/lib/composerCommands';
import { searchFileMentions } from '@/lib/fileMentionSearch';
import { ApprovalModePicker } from '@/components/chat/ApprovalModePicker';
import { ComposerPlusMenu } from '@/components/shared/ComposerPlusMenu';
import { VoiceInputButton } from '@/components/shared/VoiceInputButton';
import { createSlateVoiceTarget } from '@/lib/voice/insert-into-slate';
import { useVoiceTranscription } from '@/hooks/useVoiceTranscription';
import { ScriptedVoiceProvider } from './composerLabVoice';
import {
  buildChatComposerPlusItems,
  buildFastModeChip,
  runComposerAction,
  ComposerStatusRow,
  expandedComposerEditorContainerClassName,
  VOICE_TAKE_EDITOR_CONTAINER_CLASS,
  ONE_LINE_COMPOSER_BOX_STYLE,
  ONE_LINE_COMPOSER_CLASS_NAMES,
  useAnimatedComposerBox,
  useOneLineComposer,
  useStatusRowCompact,
} from '@/components/chat/ComposerLayout';
import { applyChatWidth, applyTheme } from '@/lib/theme';
import { DICTATION_SHORTCUT_LABEL } from '@/lib/keyboardShortcuts';
import { ModelPicker } from '@/components/chat/ModelPicker';
import {
  getEffectiveSupportedThinkingLevelsForModel,
  getModelContextWindow,
  getModelDisplayName,
  getProviderForModel,
  modelConfigForProviderSupportsFastMode,
  type ModelHarness,
} from '@canopy/desktop-shared/types';
import { isGatewayOnlyModel } from '@canopy/execution-engine/lib/gateway-model-availability';
import type { BillingFramework } from '@/lib/chatBillingFramework';
import {
  ComposerVoiceOptionsLab,
  useFakeSpeechLevel,
} from './ComposerVoiceOptionsLab';
import { VoiceRecordingRow } from '@/components/chat/VoiceRecordingRow';

/**
 * Dev-only lab for polishing the composer status row (model, effort, context
 * usage under the composer box). Renders the same shared primitives
 * `ChatInput` uses, fed with mock state, so geometry and popovers can be
 * iterated on without launching Electron.
 *
 * Run: npx vite --config apps/desktop-app/src/renderer/composer-status-lab.vite.mts
 */

// Includes Off, like the app's Claude models: cycling past Max turns
// thinking off and shows the control's resting glyph. Taken from the shared
// list so the lab never carries its own copy of the vocabulary.
const THINKING_LEVELS: readonly ThinkingLevel[] =
  CANONICAL_THINKING_LEVELS.filter(
    (level) => level !== 'low' && level !== 'ultra',
  );

function labUsage(
  contextTokens: number,
  contextWindow: number,
  model: string,
): UsageIndicatorUsage {
  return {
    contextTokens,
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

/**
 * A Claude session's /context categories scaled to the lab's context slider,
 * in the proportions of a long real session.
 */
function labContextBreakdown(
  usage: UsageIndicatorUsage,
): UsageIndicatorContextBreakdown {
  const used = usage.contextTokens;
  const window = usage.contextWindow;
  const share = (fraction: number): number => Math.round(used * fraction);
  const buffer = Math.round(window * 0.033);
  return {
    maxTokens: window,
    categories: [
      { name: 'Messages', tokens: share(0.878), kind: 'used' },
      { name: 'Memory files', tokens: share(0.075), kind: 'used' },
      { name: 'System tools', tokens: share(0.017), kind: 'used' },
      { name: 'MCP tools', tokens: share(0.017), kind: 'used' },
      { name: 'Skills', tokens: share(0.008), kind: 'used' },
      { name: 'System prompt', tokens: share(0.005), kind: 'used' },
      { name: 'Autocompact buffer', tokens: buffer, kind: 'buffer' },
      {
        name: 'Free space',
        tokens: Math.max(0, window - used - buffer),
        kind: 'free',
      },
      { name: 'MCP tools (deferred)', tokens: 97_900, kind: 'deferred' },
      { name: 'System tools (deferred)', tokens: 22_600, kind: 'deferred' },
    ],
  };
}

function hoursFromNow(hours: number): number {
  return Date.now() + hours * 3_600_000;
}

const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_WIDTH = 1000;
const PANEL_WIDTH_STEP = 10;

/** Drag the panel's right edge to resize it; it grows on both sides. */
function PanelResizeHandle({
  panelRef,
  onResize,
}: {
  readonly panelRef: RefObject<HTMLElement | null>;
  readonly onResize: (width: number) => void;
}): JSX.Element {
  const resizeTo = (clientX: number): void => {
    // The panel stays centered, so the edge sits half its width from the
    // center: the width is twice the pointer's distance from it.
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    onResize(Math.round(2 * (clientX - (rect.left + rect.width / 2))));
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize chat panel"
      className="absolute inset-y-0 right-0 z-10 group flex w-2 cursor-col-resize justify-center"
      onPointerDown={(event): void => {
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      }}
      onPointerMove={(event): void => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          resizeTo(event.clientX);
        }
      }}
    >
      <ResizeRailIndicator active={false} />
    </div>
  );
}

function LabField({
  label,
  children,
}: {
  readonly label: string;
  readonly children: JSX.Element;
}): JSX.Element {
  return (
    // The control carries its own accessible name; the caption is visual.
    <div className="flex items-center gap-2 text-xs fg-secondary">
      <span aria-hidden="true">{label}</span>
      {children}
    </div>
  );
}

/** Sample skills and commands for the / menu (the app discovers these). */
const LAB_SLASH_COMMANDS: SlashCommandData[] = [
  {
    name: 'review',
    description: 'Review the current diff for bugs and cleanups',
    section: 'discovered',
  },
  {
    name: 'commit',
    description: 'Write a commit message and commit the staged changes',
    section: 'discovered',
  },
  {
    name: 'test',
    description: 'Run the tests that cover the changed files',
    argumentHint: '[pattern]',
    section: 'discovered',
  },
  {
    name: 'explain',
    description: 'Explain how a file or symbol works',
    argumentHint: '<path>',
    section: 'discovered',
  },
];

function labFile(relativePath: string): FileIndexEntry {
  return {
    relativePath,
    filename: relativePath.split('/').pop() ?? relativePath,
    absolutePath: `/lab/canopy/${relativePath}`,
    isIgnored: false,
  };
}

/** A sample worktree for the @ menu's file search. */
const LAB_FILE_REPOS: RepoFileIndex[] = [
  {
    repoId: 'lab-repo',
    repoName: 'canopy',
    absolutePath: '/lab/canopy',
    rootKind: 'git-repo',
    files: [
      'README.md',
      'package.json',
      'src/upload/uploader.ts',
      'src/upload/uploader.test.ts',
      'src/upload/mock-server.ts',
      'src/components/Composer.tsx',
      'src/components/ComposerToolbar.tsx',
      'docs/testing.md',
    ].map(labFile),
  },
];

/**
 * Design iterations the lab can switch between. 1 is the committed composer;
 * later ones answer review feedback. Kept in the URL (`?iteration=2`) so a
 * reload or a shared link opens the same one.
 */
const LAB_ITERATIONS = [
  { id: 1, label: 'Iteration 1 (committed)' },
  { id: 2, label: 'Iteration 2 (effort panel)' },
  { id: 3, label: 'Iteration 3 (fast mode first)' },
  { id: 4, label: 'Iteration 4' },
  { id: 5, label: 'Iteration 5' },
  { id: 6, label: 'Iteration 6 (no chevrons)' },
] as const;
type LabIteration = (typeof LAB_ITERATIONS)[number]['id'];

function readIterationFromUrl(): LabIteration {
  const value = Number(
    new URLSearchParams(window.location.search).get('iteration'),
  );
  return LAB_ITERATIONS.find((option) => option.id === value)?.id ?? 1;
}

/**
 * `level` when the model declares it, else the nearest lower level it does
 * declare, else its first level.
 */
function nearestSupportedLevel(
  level: ThinkingLevel | undefined,
  supported: readonly ThinkingLevel[],
): ThinkingLevel | undefined {
  if (level === undefined || supported.includes(level)) return level;
  for (let at = CANONICAL_THINKING_LEVELS.indexOf(level); at >= 0; at -= 1) {
    const candidate = CANONICAL_THINKING_LEVELS[at];
    if (candidate !== undefined && supported.includes(candidate)) {
      return candidate;
    }
  }
  return supported[0];
}

export function ComposerStatusLabPage(): JSX.Element {
  const [iteration, setIteration] =
    useState<LabIteration>(readIterationFromUrl);
  const [dark, setDark] = useState(true);
  const [width, setWidth] = useState(720);
  const [contextPercent, setContextPercent] = useState(12);
  const [showLimits, setShowLimits] = useState(true);
  const [modelId, setModelId] = useState('opus[1m]');
  // How the picked model runs, as the composer tracks it per chat: its
  // billing and harness decide which effort levels it declares.
  const [modelRoute, setModelRoute] = useState<{
    billing?: BillingFramework;
    harness?: ModelHarness;
  }>({});
  // Auto routing picks the model per turn, as a chat's model selection mode.
  const [autoModel, setAutoModel] = useState(false);
  const [thinking, setThinking] = useState<ThinkingLevel | undefined>('medium');
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('auto');
  const [planMode, setPlanMode] = useState(false);
  const [fastMode, setFastMode] = useState(false);
  // Debug switch: lets a review hide fast mode even where the model has it.
  const [fastOffered, setFastOffered] = useState(true);
  const [fiveHourPercent, setFiveHourPercent] = useState(5);
  const [weeklyPercent, setWeeklyPercent] = useState(2);
  const [streaming, setStreaming] = useState(false);
  const [showVoiceOptions, setShowVoiceOptions] = useState(false);
  // The same one-line behaviour ChatInput uses.
  const editor = useMemo(() => createChatEditor(), []);
  const [draftValue, setDraftValue] = useState<Descendant[]>(() =>
    buildEditorValueFromMessage('', []),
  );
  // Dictation runs through the composer's own voice code; only the provider
  // is a stand-in (the real microphone helper needs the app).
  const [voiceProvider] = useState(() => new ScriptedVoiceProvider());
  const voiceTarget = useMemo(() => createSlateVoiceTarget(editor), [editor]);
  const voice = useVoiceTranscription({
    target: voiceTarget,
    provider: voiceProvider,
    onFinalCommitted: (): void => {
      setDraftValue(structuredClone(editor.children));
    },
  });
  const voiceRecording =
    voice.state === 'connecting' || voice.state === 'listening';
  // The waveform reads a stand-in level: the scripted provider has no audio.
  const readFakeLevel = useFakeSpeechLevel();
  const voiceButton = (primary: boolean): JSX.Element => (
    <VoiceInputButton
      state={voice.state}
      error={null}
      onStart={(): void => void voice.start()}
      onStop={(): void => void voice.stop()}
      capsule
      primary={primary}
      shortcut={DICTATION_SHORTCUT_LABEL}
    />
  );

  const boxRef = useRef<HTMLDivElement>(null);
  const hasDraftText = serializeEditorValue(draftValue).text.length > 0;
  // Selection moves re-render so the menu controller re-reads the caret,
  // as ChatInput does.
  const [, setSelectionRevision] = useState(0);
  const composerMenu = useComposerMenu(editor, {
    enabled: true,
    dollar: false,
    scopeKey: 'lab',
    onChange: () => setDraftValue(structuredClone(editor.children)),
  });
  // Fast mode follows the model as the composer's does: only models on the
  // ChatGPT (Codex) harness have it.
  const fastAvailable =
    fastOffered &&
    modelConfigForProviderSupportsFastMode(
      getProviderForModel(modelId) ?? 'claude',
    );
  const composerCommands = useMemo(
    () =>
      buildComposerCommands(LAB_SLASH_COMMANDS, {
        home: false,
        fast: fastAvailable,
      }),
    [fastAvailable],
  );
  const syncDraft = (): void => setDraftValue(structuredClone(editor.children));
  const handleSelectCommand = (command: SlashCommandData): void => {
    const action = getComposerAction(command);
    if (action) {
      runComposerAction(action, {
        controller: composerMenu,
        handlers: {
          plan: () => setPlanMode((on) => !on),
          fast: () => setFastMode((on) => !on),
          thinking: () =>
            setThinking((level) => {
              const index = level ? THINKING_LEVELS.indexOf(level) : -1;
              return THINKING_LEVELS[(index + 1) % THINKING_LEVELS.length];
            }),
          model: () => {},
          plugins: () => {},
          attach: () => {},
          schedule: () => {},
        },
        syncDraft,
        onUnavailable: () => {},
      });
      return;
    }
    composerMenu.consumeTrigger();
    Transforms.insertText(editor, getSlashCommandInsertText(command));
    syncDraft();
    focusEditor(editor);
  };
  const inline = useOneLineComposer({
    boxRef,
    hasDraftText,
    allowed: !voiceRecording,
    draftRevision: draftValue,
  });
  useAnimatedComposerBox(boxRef);
  const statusRowRef = useRef<HTMLDivElement>(null);
  const statusRowCompact = useStatusRowCompact(statusRowRef);

  const isCodex = getProviderForModel(modelId) === 'codex';
  const modelLabel = getModelDisplayName(modelId);
  const contextWindow = getModelContextWindow(modelId) ?? 200_000;
  // The chosen model's own effort levels, as the composer resolves them: a
  // hosted model (or one billed to AI Credits) takes the catalog's set.
  const thinkingLevels = getEffectiveSupportedThinkingLevelsForModel(
    modelId,
    modelRoute.billing === 'ai-credits' || isGatewayOnlyModel(modelId),
    isCodex ? 'codex' : 'claude',
    modelRoute.harness,
  );
  // A level the new model lacks shows as its nearest lower one, as the
  // composer displays it, or the model's first level.
  const shownThinking = nearestSupportedLevel(thinking, thinkingLevels);
  const usage = labUsage(
    Math.round((contextWindow * contextPercent) / 100),
    contextWindow,
    modelId,
  );
  // The panel renders in one frame, so it tracks the slider directly; a
  // deferred render made it trail the thumb.
  const panelWidth = width;
  const panelRef = useRef<HTMLElement | null>(null);
  const widthSliderRef = useRef<HTMLInputElement | null>(null);
  const pendingWidthRef = useRef(width);
  const widthFrameRef = useRef<number | null>(null);
  // The slider and the edge handle resize the panel straight away and commit
  // React state at most once a frame. A controlled slider re-rendered behind
  // the trackpad and wrote older values back, so the panel slid backwards.
  //
  // A trackpad wiggles a few pixels back and forth even while held still, so
  // the panel moves in 10px steps and only once the pointer has travelled a
  // full step from the current width: a wiggle inside that band is ignored.
  const resizePanel = (raw: number): void => {
    if (Math.abs(raw - pendingWidthRef.current) < PANEL_WIDTH_STEP) return;
    const next = Math.min(
      PANEL_MAX_WIDTH,
      Math.max(
        PANEL_MIN_WIDTH,
        Math.round(raw / PANEL_WIDTH_STEP) * PANEL_WIDTH_STEP,
      ),
    );
    pendingWidthRef.current = next;
    if (panelRef.current) panelRef.current.style.width = `${next}px`;
    if (widthFrameRef.current !== null) return;
    widthFrameRef.current = window.requestAnimationFrame((): void => {
      widthFrameRef.current = null;
      setWidth(pendingWidthRef.current);
    });
  };
  const compact = panelWidth < 640;

  const accountUsage = showLimits ? (
    <UsageIndicatorAccountSummary
      providerLabel={isCodex ? 'Codex' : 'Claude'}
      account="daniil@example.com"
      plan={isCodex ? 'ChatGPT Pro' : 'Claude Max 20x'}
      limits={[
        {
          id: 'five-hour',
          label: '5-hour limit',
          usedPercent: fiveHourPercent,
          resetsAt: hoursFromNow(2.75),
        },
        {
          id: 'weekly',
          label: 'Weekly · all models',
          usedPercent: weeklyPercent,
          resetsAt: hoursFromNow(80),
        },
        {
          id: 'weekly-model',
          label: isCodex ? 'Weekly · GPT-6' : 'Weekly · Fable',
          usedPercent: 0,
          resetsAt: hoursFromNow(80),
        },
      ]}
    />
  ) : undefined;

  // Iteration 5: model and effort lead the row, the permission level trails
  // it, and nothing collapses as the row narrows: the names truncate instead.
  const modelFirst = iteration >= 5;
  // Iteration 6: the row's selectors drop their chevrons.
  const noChevrons = iteration >= 6;
  const rowCompact = modelFirst ? false : statusRowCompact;
  const approvalPicker = (
    <ApprovalModePicker
      mode={approvalMode}
      onChange={setApprovalMode}
      compact={rowCompact}
      compactStyle="label"
      // Iteration 2 on: the trigger drops the mode glyph.
      hideTriggerIcon={iteration >= 2}
      menuAlignRef={boxRef}
      menuAlignEdge={modelFirst ? 'right' : 'left'}
      hideTriggerChevron={noChevrons}
    />
  );
  const modelPicker = (
    <div
      className={`flex items-center ${rowCompact || modelFirst ? 'min-w-0' : 'shrink-0'}`}
    >
      {/* The app's own picker, over the app's model registries (see
          composerLabModels). */}
      <ModelPicker
        browserLayout="harnesses"
        currentModel={modelId}
        onModelChange={(next, billing, harness): void => {
          if (!next) return;
          setModelId(next);
          setModelRoute({ billing, harness });
          setAutoModel(false);
        }}
        // The app's Auto row, offered as it is to an interactive chat.
        auto={{
          selected: autoModel,
          onSelect: (): void => setAutoModel(true),
        }}
        allowCursor
        capsule
        allowTriggerShrink
        foldTriggerIconWhenTight
        // Iteration 5: the icon goes as soon as the names truncate.
        foldTriggerIconOnTruncate={modelFirst}
        hideTriggerChevron={noChevrons}
        menuAlignRef={boxRef}
        menuAlignEdge={modelFirst ? 'left' : 'right'}
        triggerTooltip={null}
      />
    </div>
  );
  // A model that declares no effort levels shows no effort control.
  const effortPicker =
    thinkingLevels.length === 0 ? null : iteration >= 2 ? (
      // Iteration 2: effort opens a panel with a faster-to-smarter slider
      // and the fast mode switch.
      <ThinkingLevelPanelPicker
        testId="chat-input-thinking-level-button"
        value={shownThinking}
        supportedLevels={thinkingLevels}
        onChange={setThinking}
        // Iteration 5: the panel opens over its own trigger, left edges
        // aligned, rather than spanning to the composer's edge.
        {...(modelFirst
          ? // 8px left of its trigger's edge.
            { menuAlignOffset: -8 }
          : { menuAlignRef: boxRef })}
        menuAlignEdge={modelFirst ? 'left' : 'right'}
        allowTriggerShrink={modelFirst}
        hideTriggerChevron={noChevrons}
        // The panel heads with the level and carries fast mode as a corner
        // toggle in every iteration; the earlier slider-first and
        // slider-last panels were retired. Iterations 4 and 5 start the
        // scale at Low, not None; iteration 6 offers every level the model
        // declares, None and Low included.
        lowestLevel={iteration >= 4 && iteration < 6 ? 'low' : 'off'}
        includeLow={iteration >= 6}
        {...(fastAvailable
          ? {
              fastMode: {
                on: fastMode,
                onToggle: (): void => setFastMode((on) => !on),
              },
            }
          : {})}
      />
    ) : (
      <ThinkingLevelControl
        testId="chat-input-thinking-level-button"
        value={shownThinking}
        supportedLevels={thinkingLevels}
        onChange={setThinking}
        variant="capsule"
        compact={rowCompact}
      />
    );
  const usageIndicator = (
    <div className="shrink-0">
      <UsageIndicator
        usage={usage}
        isCodex={isCodex}
        modelLabel={modelLabel}
        accountUsage={accountUsage}
        onSeeDetails={(): void => {}}
        contextBreakdown={labContextBreakdown(usage)}
        capsule
        alignRef={boxRef}
      />
    </div>
  );

  return (
    <Surface variant="pane" extent="viewport">
      <div className="flex h-full flex-col fg-primary">
        <Surface variant="section" boundary="bottom">
          <div className="flex flex-wrap items-center gap-4 px-4 py-3">
            <span className="text-s">Chat composer lab</span>
            <LabField label="Version">
              <SettingsSelect
                aria-label="Version"
                data-testid="lab-iteration"
                width="fit"
                value={String(iteration)}
                options={LAB_ITERATIONS.map((option) => ({
                  value: String(option.id),
                  label: option.label,
                }))}
                onValueChange={(value): void => {
                  const next =
                    LAB_ITERATIONS.find((option) => option.id === Number(value))
                      ?.id ?? 1;
                  setIteration(next);
                  const url = new URL(window.location.href);
                  url.searchParams.set('iteration', String(next));
                  window.history.replaceState(null, '', url);
                }}
              />
            </LabField>
            <ChoiceField
              label="Dark"
              checked={dark}
              onChange={(event): void => {
                setDark(event.target.checked);
                applyTheme('default', event.target.checked ? 'dark' : 'light');
              }}
            />
            <ChoiceField
              label="Full-width chat"
              // The app's Settings option: the transcript and composer fill the
              // panel instead of capping at the reading width.
              onChange={(event): void =>
                applyChatWidth(event.target.checked ? 'full' : 'default')
              }
            />
            <LabField label={`Chat panel ${width}px`}>
              <LabSlider
                aria-label="Chat panel width"
                min={PANEL_MIN_WIDTH}
                max={PANEL_MAX_WIDTH}
                ref={widthSliderRef}
                defaultValue={width}
                // Long enough that a trackpad moves about 2px of panel per pixel
                // instead of skipping values.
                className="w-80"
                onInput={(event): void =>
                  resizePanel(Number(event.currentTarget.value))
                }
                // Settle the thumb on the width the panel actually took.
                onPointerUp={(event): void => {
                  event.currentTarget.value = String(pendingWidthRef.current);
                }}
              />
            </LabField>
            <LabField label={`Context ${contextPercent}%`}>
              <LabSlider
                aria-label="Context"
                min={0}
                max={100}
                value={contextPercent}
                onChange={(event): void =>
                  setContextPercent(Number(event.target.value))
                }
              />
            </LabField>
            <LabField label={`5-hour ${fiveHourPercent}%`}>
              <LabSlider
                aria-label="5-hour limit"
                min={0}
                max={100}
                value={fiveHourPercent}
                onChange={(event): void =>
                  setFiveHourPercent(Number(event.target.value))
                }
              />
            </LabField>
            <LabField label={`Weekly ${weeklyPercent}%`}>
              <LabSlider
                aria-label="Weekly limit"
                min={0}
                max={100}
                value={weeklyPercent}
                onChange={(event): void =>
                  setWeeklyPercent(Number(event.target.value))
                }
              />
            </LabField>
            <ChoiceField
              label="Fast mode (GPT models)"
              checked={fastOffered}
              onChange={(event): void => setFastOffered(event.target.checked)}
            />
            <ChoiceField
              label="Agent running"
              checked={streaming}
              onChange={(event): void => setStreaming(event.target.checked)}
            />
            <ChoiceField
              label="Voice options"
              checked={showVoiceOptions}
              onChange={(event): void =>
                setShowVoiceOptions(event.target.checked)
              }
            />
            <ChoiceField
              label="Plan limits"
              checked={showLimits}
              onChange={(event): void => setShowLimits(event.target.checked)}
            />
          </div>
        </Surface>

        {/* The chats screen: a chat panel with its transcript, and the small
          composer docked at the bottom, not the New task composer. */}
        {showVoiceOptions ? (
          <ComposerVoiceOptionsLab width={width} />
        ) : (
          <>
            {/* Centered in the page; the edge handle grows it on both sides. */}
            <Surface
              variant="well"
              padding="compact"
              className="relative flex min-h-0 flex-1 justify-center"
            >
              <Surface
                as="section"
                variant="inset"
                ref={panelRef}
                data-testid="panel-content-chat"
                className="relative flex min-h-0 max-w-full flex-col overflow-hidden"
                paneWidth={panelWidth}
              >
                <PanelResizeHandle panelRef={panelRef} onResize={resizePanel} />
                <div className="flex h-9 shrink-0 items-center gap-2 px-3 text-xs fg-secondary">
                  <span className="fg-primary">Fix the flaky upload test</span>
                </div>
                <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
                  <div className="mx-auto flex w-full max-w-[var(--chat-reading-width)] flex-col gap-4 px-4 py-6 text-s">
                    <div
                      className={`${BUBBLE_SURFACE_CLASS} self-end fg-primary`}
                    >
                      The upload test fails about one run in five. Can you find
                      out why?
                    </div>
                    <p className="fg-primary">
                      The test waits a fixed 200 ms for the upload to finish,
                      but the mock server sometimes takes longer under load. I
                      replaced the timeout with a wait on the upload&apos;s
                      completion event and ran the suite 50 times without a
                      failure.
                    </p>
                  </div>
                </div>
                <div
                  data-chat-composer-root
                  className="relative mx-auto w-full max-w-[var(--chat-composer-shell-width)] shrink-0 px-4 pb-2 pt-2"
                >
                  <div
                    ref={boxRef}
                    style={inline ? ONE_LINE_COMPOSER_BOX_STYLE : undefined}
                    className={
                      inline
                        ? `${CHAT_COMPOSER_SHELL_CLASS} ${ONE_LINE_COMPOSER_CLASS_NAMES.box}`
                        : `${CHAT_COMPOSER_SHELL_CLASS} ${ONE_LINE_COMPOSER_CLASS_NAMES.expandedBox}`
                    }
                  >
                    <span
                      ref={composerMenu.anchorRef}
                      aria-hidden
                      className="pointer-events-none absolute inset-0"
                    />
                    <ComposerEditor
                      editor={editor}
                      value={draftValue}
                      onChange={setDraftValue}
                      onSelectionChange={(): void =>
                        setSelectionRevision((revision) => revision + 1)
                      }
                      onKeyDown={(event): void => {
                        if (composerMenu.handleKeyDown(event)) return;
                        if (
                          event.key === 'Enter' &&
                          !event.shiftKey &&
                          hasDraftText
                        ) {
                          event.preventDefault();
                          setDraftValue(buildEditorValueFromMessage('', []));
                          setStreaming(true);
                        }
                      }}
                      placeholder={
                        voiceRecording
                          ? 'Start talking…'
                          : defaultChatPlaceholder(true, true)
                      }
                      density="minimal"
                      className={
                        inline
                          ? ONE_LINE_COMPOSER_CLASS_NAMES.editor
                          : undefined
                      }
                      containerClassName={
                        inline
                          ? ONE_LINE_COMPOSER_CLASS_NAMES.editorContainer
                          : `${expandedComposerEditorContainerClassName(
                              'comfortable',
                            )}${voiceRecording ? ` ${VOICE_TAKE_EDITOR_CONTAINER_CLASS}` : ''}`
                      }
                    />
                    {voiceRecording ? (
                      <VoiceRecordingRow
                        readLevel={readFakeLevel}
                        listeningSince={voice.listeningSince}
                        onCancel={(): void => void voice.cancel()}
                        onStop={(): void => void voice.stop()}
                        onSend={(): void => {
                          void voice.stop().then((): void => {
                            setDraftValue(buildEditorValueFromMessage('', []));
                            setStreaming(true);
                          });
                        }}
                      />
                    ) : (
                      <ChatComposerToolbar
                        capsuleLayout
                        compact={compact}
                        inline={inline}
                        leadingSlot={
                          <div
                            className={
                              inline
                                ? `relative shrink-0 ${ONE_LINE_COMPOSER_CLASS_NAMES.leading}`
                                : 'relative shrink-0'
                            }
                          >
                            <ComposerPlusMenu
                              dataTestIdPrefix="chat-input"
                              gap={PICKER_GAP}
                              capsuleTrigger
                              controller={composerMenu}
                              searchFiles={(query) =>
                                searchFileMentions(query, LAB_FILE_REPOS, 50)
                              }
                              onSelectFile={(file) =>
                                composerMenu.insertFile(
                                  file,
                                  LAB_FILE_REPOS.length,
                                )
                              }
                              commands={composerCommands}
                              onSelectCommand={handleSelectCommand}
                              providerScope="mixed"
                              onPickAttachment={(): void => {}}
                              additionalItems={buildChatComposerPlusItems({
                                onOpenPlugins: (): void => {},
                                hasPluginSelections: false,
                                plan: {
                                  on: planMode,
                                  readOnly: false,
                                  disabled: false,
                                  onToggle: (): void =>
                                    setPlanMode((on) => !on),
                                },
                                onSchedule: (): void => {},
                              })}
                            />
                          </div>
                        }
                        planMode={
                          planMode
                            ? buildPlanModeChip({
                                readOnly: false,
                                disabled: false,
                                onDisable: (): void => setPlanMode(false),
                              })
                            : undefined
                        }
                        trailingSlot={
                          streaming ? (
                            <>
                              {voiceButton(false)}
                              <ComposerSendButton
                                kind="stop"
                                onStop={(): void => setStreaming(false)}
                                pending={false}
                                armed={false}
                                shortcutReady
                                dataTestId="chat-stop-generation"
                              />
                            </>
                          ) : hasDraftText ? (
                            <>
                              {voiceButton(false)}
                              <ComposerSendButton
                                kind="send"
                                onSend={(): void => {
                                  setDraftValue(
                                    buildEditorValueFromMessage('', []),
                                  );
                                  setStreaming(true);
                                }}
                                disabled={false}
                                pending={false}
                              />
                            </>
                          ) : (
                            voiceButton(true)
                          )
                        }
                      />
                    )}
                  </div>

                  <ComposerStatusRow
                    rowRef={statusRowRef}
                    {...(modelFirst
                      ? {
                          fill: 'start' as const,
                          start: (
                            <>
                              {modelPicker}
                              {effortPicker}
                            </>
                          ),
                          end: (
                            <>
                              {approvalPicker}
                              {usageIndicator}
                            </>
                          ),
                        }
                      : {
                          start: approvalPicker,
                          end: (
                            <>
                              {modelPicker}
                              {effortPicker}
                              {fastAvailable && iteration < 2 && (
                                <ChatComposerToolbarChip
                                  {...buildFastModeChip({
                                    on: fastMode,
                                    disabled: false,
                                    compact: rowCompact,
                                    onToggle: (): void =>
                                      setFastMode((on) => !on),
                                  })}
                                />
                              )}
                              {usageIndicator}
                            </>
                          ),
                        })}
                  />
                </div>
              </Surface>
            </Surface>
          </>
        )}
      </div>
    </Surface>
  );
}
