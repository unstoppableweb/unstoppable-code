import { Badge } from '../Badge';
import {
  THINKING_LEVEL_LABELS,
  isThinkingLevel,
} from '@canopy/protocol/thinking';
import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { AgentIcon, MinusIcon, PlusIcon } from '../../icons';
import { useCleanChatLook } from '../chat-look';
import { Inline } from '../Stack';
import { StepRow } from './StepRow';
import { formatDuration, formatTokenCount } from '../../lib/format-usage';
import { AgentCardOpenChatAction } from './AgentCardOpenChatAction';
import { ToolCallCard, toolCallResultFrom } from './ToolCallCard';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';

function formatReasoningEffort(reasoningEffort: string): string {
  if (isThinkingLevel(reasoningEffort)) {
    if (reasoningEffort === 'low') {
      return 'Low';
    }
    return THINKING_LEVEL_LABELS[reasoningEffort];
  }
  return reasoningEffort.charAt(0).toUpperCase() + reasoningEffort.slice(1);
}

/**
 * Optional usage stats grid displayed under the agent header. All fields are
 * optional so hosts only render what they have.
 */
export interface AgentBlockUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  toolUses?: number;
  apiCalls?: number;
  durationMs?: number;
  contextTokens?: number;
  contextWindow?: number;
  totalCostUsd?: number;
  model?: string;
}

export interface AgentBlockCardProps {
  /** Subagent type identifier, e.g. `general-purpose`, `code-reviewer`. */
  subagentType: string;
  /** Optional short description rendered as a preview after the header. */
  description?: string;
  /** Whether the agent was kicked off as a background task. */
  runInBackground?: boolean;
  /** Optional usage stats grid for the expanded view. */
  usage?: AgentBlockUsage;
  /** Optional result text displayed in a collapsible Result section. */
  result?: string;
  /** Optional prompt text displayed in a collapsible Prompt section. */
  prompt?: string;
  /** Latest configured model/effort, separate from measured usage. */
  model?: string;
  reasoningEffort?: string;
  /** Whether the result should be rendered with destructive coloring. */
  isError?: boolean;
  /**
   * Pre-rendered sub-block children. Hosts (desktop renderer / web portal)
   * pass their own recursive sub-block render output here so this primitive
   * does not need to import either runtime's chat-block renderer.
   */
  subBlocks?: ReactNode;
  /** True when the agent is still running. Drives the spinner state. */
  isRunning?: boolean;
  /** Optional spinner slot supplied by the host. */
  pendingSpinner?: ReactNode;
  /** Test ID hook for automation. */
  dataTestId?: string;
  /**
   * The call's stable step identity, exposed as `data-tool-use-id` so a host
   * can reveal and focus this row (a turn summary landing on a failed step).
   */
  toolUseId?: string;
  /**
   * Replaces the default usage cells (context, output, tool uses, API calls,
   * duration, model) for a host whose usage is not an agent's model usage,
   * such as a workflow agent's progress counters.
   */
  usageOverride?: ReactNode;
  /** Optional host metadata, using the same expanded container. */
  metadata?: ReactNode;
  /** Opens this subagent's chat from its expanded details. */
  onOpenChat?: () => void;
  /** Reports committed expansion changes and a final collapse on unmount. */
  onExpandedChange?: (expanded: boolean) => void;
  /** Leading header content, rendered before the agent label. */
  headerStatus?: ReactNode;
  /**
   * Trailing header content, rendered after the agent label. Right-aligned
   * status belongs here: an `ml-auto` item in the leading slot would push the
   * agent label to the right with it.
   */
  headerTrailing?: ReactNode;
  /**
   * Interactive control beside the header, outside its disclosure button so
   * activating it never expands or collapses the card. Always visible.
   */
  headerAction?: ReactNode;
  expandLabel?: string;
  collapseLabel?: string;
}

/** Window assumed when a host reports context fill without the model's window. */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * The desktop agent card's usage cells: context fill, output, tool uses, API
 * calls, duration, model. A host that counts API calls shows no row until the
 * first one; a host that cannot count them (cloud tasks) shows the cells it has.
 */
function defaultUsageCells(usage: AgentBlockUsage): ReactNode {
  const contextTokens = usage.contextTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const toolUses = usage.toolUses ?? 0;
  const apiCalls = usage.apiCalls ?? 0;
  const durationMs = usage.durationMs ?? 0;
  if (usage.apiCalls !== undefined && apiCalls <= 0) return null;
  const items = [
    contextTokens > 0 && contextCell(contextTokens, usage.contextWindow),
    outputTokens > 0 && (
      <span key="output">{formatTokenCount(outputTokens)} output</span>
    ),
    countCell('toolUses', toolUses, 'tool use', 'tool uses'),
    countCell('apiCalls', apiCalls, 'API call', 'API calls'),
    durationMs > 0 && (
      <span key="durationMs">{formatDuration(durationMs)}</span>
    ),
    usage.model && (
      <span key="model" className="max-w-40 truncate">
        {usage.model}
      </span>
    ),
  ].filter((item) => item !== false && item !== undefined && item !== '');
  return items.length > 0 ? items : null;
}

/** `5 tool uses`, `1 API call`; nothing for zero. */
function countCell(
  key: string,
  count: number,
  one: string,
  many: string,
): JSX.Element | false {
  return (
    count > 0 && (
      <span key={key}>
        {count} {count === 1 ? one : many}
      </span>
    )
  );
}

/** `48.2k / 200.0k context (24.1%)`, assuming a 200k window when unknown. */
function contextCell(
  contextTokens: number,
  reportedWindow: number | undefined,
): JSX.Element {
  const contextWindow = reportedWindow || DEFAULT_CONTEXT_WINDOW;
  return (
    <span key="context">
      {formatTokenCount(contextTokens)} / {formatTokenCount(contextWindow)}{' '}
      context ({Math.min((contextTokens / contextWindow) * 100, 100).toFixed(1)}
      %)
    </span>
  );
}

/**
 * Pure display agent-block card. Renders an icon + subagent header with an
 * optional background badge and inline description preview, an expand state
 * that reveals (when present) a usage-stats grid, the host's sub-block
 * children, and collapsible Prompt/Result sections.
 */
export function AgentBlockCard({
  subagentType,
  description,
  runInBackground = false,
  usage,
  result,
  prompt,
  model,
  reasoningEffort,
  isError = false,
  subBlocks,
  isRunning = false,
  pendingSpinner,
  dataTestId,
  toolUseId,
  usageOverride,
  metadata,
  onOpenChat,
  onExpandedChange,
  headerStatus,
  headerTrailing,
  headerAction,
  expandLabel,
  collapseLabel,
}: AgentBlockCardProps): JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const onExpandedChangeRef = useRef(onExpandedChange);
  const lastReportedExpansion = useRef(false);

  useEffect((): void => {
    onExpandedChangeRef.current = onExpandedChange;
  }, [onExpandedChange]);

  useEffect((): void => {
    if (lastReportedExpansion.current !== isExpanded) {
      lastReportedExpansion.current = isExpanded;
      onExpandedChangeRef.current?.(isExpanded);
    }
  }, [isExpanded]);

  useEffect(
    (): (() => void) => (): void => {
      if (lastReportedExpansion.current) {
        lastReportedExpansion.current = false;
        onExpandedChangeRef.current?.(false);
      }
    },
    [],
  );

  const preview =
    description && description.length > 80
      ? description.slice(0, 80) + '…'
      : (description ?? '');

  const usageCells = usage ? (usageOverride ?? defaultUsageCells(usage)) : null;
  const shouldShowSubagentType = subagentType.trim().toLowerCase() !== 'agent';

  // Clean chat look: the helper agent reads like any other step row.
  const clean = useCleanChatLook();
  const displayResult =
    result === undefined
      ? null
      : toolCallResultFrom({ output: result, isError });
  if (displayResult?.kind === 'blocked') {
    const agentLabel = shouldShowSubagentType
      ? `${subagentType} agent`
      : 'agent';
    return (
      <ToolCallCard
        toolName="Agent"
        toolFamily="agent"
        label={`${clean ? 'Didn’t run ' : ''}${agentLabel}${description ? ` · ${description}` : ''}`}
        input={prompt}
        result={displayResult}
        dataTestId={dataTestId}
      />
    );
  }
  const cleanHeader = (
    <StepRow
      step
      icon={<AgentIcon />}
      label={
        <>
          {headerStatus}
          {shouldShowSubagentType ? `${subagentType} agent` : 'Agent'}
          {runInBackground ? ' (background)' : ''}
        </>
      }
      detail={
        (!isExpanded || !prompt) && preview ? (
          <span className={REPLAY_BLOCK_CLASS}>{preview}</span>
        ) : undefined
      }
      running={isRunning}
      failed={isError}
      expandable
      isOpen={isExpanded}
      onToggle={(): void => setIsExpanded((prev) => !prev)}
      ariaLabel={isExpanded ? collapseLabel : expandLabel}
      trailing={headerTrailing}
      className={headerAction != null ? 'flex-1' : undefined}
    />
  );
  const header = clean ? (
    cleanHeader
  ) : (
    <button
      type="button"
      onClick={(): void => setIsExpanded((prev) => !prev)}
      aria-expanded={isExpanded}
      aria-label={isExpanded ? collapseLabel : expandLabel}
      className={`group flex ${headerAction != null ? 'min-w-0 flex-1' : 'w-full'} items-center gap-2 py-1 text-xs fg-accent/80 transition-colors`}
    >
      <span className="flex-shrink-0">
        <span className="block group-hover:hidden">
          <AgentIcon />
        </span>
        <span className="hidden group-hover:block">
          {isExpanded ? <MinusIcon /> : <PlusIcon />}
        </span>
      </span>
      {headerStatus}
      <Inline as="span" gap="item" className="min-w-0">
        <span className="min-w-0 truncate">
          Agent
          {shouldShowSubagentType ? <> &middot; {subagentType}</> : ' '}
          {runInBackground && (
            <span className="inline-flex pl-1.5 align-middle">
              <Badge data-testid="agent-block-background-badge">
                background
              </Badge>
            </span>
          )}
          {(!isExpanded || !prompt) && preview && (
            <span
              className={`${REPLAY_BLOCK_CLASS} ml-2 text-2xs fg-secondary`}
            >
              {preview}
            </span>
          )}
        </span>
        {isRunning && pendingSpinner != null && (
          <span className="flex-shrink-0 fg-accent">{pendingSpinner}</span>
        )}
        {isError && <span className="text-3xs fg-destructive/80">error</span>}
      </Inline>
      {headerTrailing}
    </button>
  );

  return (
    <div
      className={`flex flex-col items-start gap-1${clean ? '' : ' border-l-2 border-line-accent/30 pl-2'}`}
      data-testid={dataTestId}
      data-tool-use-id={toolUseId}
    >
      {headerAction != null ? (
        <div className="flex items-center gap-2 self-stretch">
          {header}
          <span className="flex shrink-0 items-center">{headerAction}</span>
        </div>
      ) : (
        header
      )}

      {isExpanded && (
        <div className="self-stretch pl-5.5">
          <div
            className={
              clean
                ? 'overflow-hidden rounded-md bg-fg-primary/[0.03] text-s'
                : 'overflow-hidden rounded border bg-fg-primary/[0.02]'
            }
          >
            {onOpenChat ? (
              <div className="border-b px-2.5 py-2">
                <AgentCardOpenChatAction onOpenChat={onOpenChat} />
              </div>
            ) : null}
            {metadata}
            {(model || reasoningEffort) && (
              <div
                data-testid="agent-block-configuration"
                className="flex flex-wrap gap-x-3 gap-y-0.5 border-b px-2.5 py-1.5 text-3xs fg-secondary"
              >
                {model && <span>Model: {model}</span>}
                {reasoningEffort && (
                  <span>Effort: {formatReasoningEffort(reasoningEffort)}</span>
                )}
              </div>
            )}
            {usageCells && (
              <div
                data-testid="agent-block-usage-grid"
                className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b px-2.5 py-1.5 text-3xs fg-secondary"
              >
                {usageCells}
              </div>
            )}

            {subBlocks != null ? (
              <div className="grid grid-cols-1 content-start max-h-125 overflow-auto px-2.5 py-2 gap-1">
                {subBlocks}
              </div>
            ) : isRunning && description ? (
              <div
                className={`${REPLAY_BLOCK_CLASS} px-2.5 py-2 text-xs fg-secondary`}
              >
                {description}
              </div>
            ) : null}

            {result && (
              <>
                <button
                  type="button"
                  onClick={(): void => setShowResult((prev) => !prev)}
                  className="w-full border-t px-2.5 py-1 text-left text-3xs font-medium fg-secondary hover:fg-secondary"
                >
                  {showResult ? 'Hide result' : 'Show result'}
                </button>
                {showResult && (
                  <pre
                    className={`${REPLAY_BLOCK_CLASS} max-h-75 overflow-auto whitespace-pre-wrap break-all border-t px-2.5 py-2 text-xs ${
                      isError ? 'fg-destructive/80' : 'fg-secondary'
                    }`}
                  >
                    {displayResult?.content}
                  </pre>
                )}
              </>
            )}

            {prompt && (
              <>
                <button
                  type="button"
                  onClick={(): void => setShowPrompt((prev) => !prev)}
                  className="w-full border-t px-2.5 py-1 text-left text-3xs font-medium fg-secondary hover:fg-secondary"
                >
                  {showPrompt ? 'Hide prompt' : 'Show prompt'}
                </button>
                {showPrompt && (
                  <pre
                    className={`${REPLAY_BLOCK_CLASS} max-h-50 overflow-auto whitespace-pre-wrap break-all border-t px-2.5 py-2 text-xs fg-secondary`}
                  >
                    {prompt}
                  </pre>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
