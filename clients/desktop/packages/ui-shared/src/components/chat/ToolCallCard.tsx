import { Stack } from '../Stack';
import { TURN_OUTCOME_UNKNOWN_IMPACT } from './turn-outcome-label';
import { useState, type JSX, type ReactNode } from 'react';
import { z } from 'zod';
import { MODEL_GATEWAY_MAX_DISCOVERED_MODELS } from '@canopy/protocol/canopy-server';
import {
  readToolInterruption,
  type ToolInterruption,
} from '@canopy/protocol/portal';
import { MinusIcon, PlusIcon, StopIcon } from '../../icons';
import { ShieldIcon } from '../../icons/AppIcons';
import {
  StepTenseProvider,
  useChatAppName,
  useCleanChatLook,
  type StepTense,
} from '../chat-look';
import { isAskUserQuestionToolName, readableToolInput } from './tool-display';
import {
  TOOL_APPROVAL_WAITING_LABEL,
  useToolApprovalWait,
} from './tool-approval-wait';
import { STEP_ROW_BODY_CLASS, StepRow } from './StepRow';
import { StatusLabel } from '../StatusLabel';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import {
  classifyToolDenial,
  stripHookErrorPrefix,
  toolDenialDetail,
  toolDenialHeading,
  type ToolDenial,
} from './tool-denial';
import {
  getToolFamilyIcon,
  type PortalChatToolFamily,
} from './tool-display-info';

/**
 * Command and output under an opened step: the well, in the reply's code
 * block fill and 12px corner, with no border or heading.
 */
const CLEAN_OUTPUT_CLASS = `${REPLAY_BLOCK_CLASS} max-h-75 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-fg-primary/[0.06] px-3 py-2 font-mono text-xs fg-secondary`;

/**
 * Result shape carried by a tool call. Mirrors the desktop `ToolResult` shape
 * (output + isError) but uses the kind-based discriminator preferred by the
 * web portal so both sides can share this primitive. `blocked` is an error
 * result recognized as an approval denial; `content` is display text, with
 * any hook wrapper removed from errors. `interrupted` is a settled call with
 * no recorded outcome; its explicit metadata outranks the error flag.
 */
export type ToolCallResult =
  | { kind: 'text' | 'error'; content: string }
  | { kind: 'blocked'; content: string; denial: ToolDenial }
  | { kind: 'interrupted'; content: string; interruption: ToolInterruption };

export type ToolCallStatus =
  | 'pending'
  | 'success'
  | 'error'
  | 'blocked'
  | 'interrupted';

const gatewayConnectCall = z.object({
  action: z.object({ type: z.literal('settings.ai_gateway.connect') }),
});
const gatewayConnectResult = z.object({
  ok: z.literal(true),
  result: z.object({
    status: z.literal('connected'),
    models: z.array(z.unknown()).max(MODEL_GATEWAY_MAX_DISCOVERED_MODELS),
  }),
});

/** Count only a completed connection's actual result, never its proposed input. */
function gatewayConnectionDetail(
  input: string | undefined,
  result: ToolCallResult | null | undefined,
): string | undefined {
  if (
    !input?.includes('settings.ai_gateway.connect') ||
    result?.kind !== 'text'
  )
    return undefined;
  try {
    const call: unknown = JSON.parse(input);
    if (!gatewayConnectCall.safeParse(call).success) return undefined;
    const output: unknown = JSON.parse(result.content);
    const parsed = gatewayConnectResult.safeParse(output);
    if (!parsed.success) return undefined;
    return `settings.ai_gateway.connect · ${parsed.data.result.models.length} models`;
  } catch {
    return undefined;
  }
}

/** Shown under an interrupted step; it never claims the call did or didn't run. */
export const TOOL_INTERRUPTED_EXPLANATION =
  'No result was recorded. Any changes this step made before it stopped are still in place.';

/** A presentation-only result for a call whose owning turn has settled. */
export function interruptedToolCallResult(
  interruption: ToolInterruption = { reason: 'unknown', at: 0 },
): ToolCallResult {
  return {
    kind: 'interrupted',
    content: TOOL_INTERRUPTED_EXPLANATION,
    interruption,
  };
}

/** The interrupted row's detail; names the app only for a known restart. */
export function toolInterruptionDetail(
  interruption: ToolInterruption,
  brandAppName: string | undefined,
): string {
  return interruption.reason === 'app_restart' && brandAppName
    ? `Interrupted when ${brandAppName} closed`
    : 'Interrupted';
}

/**
 * Normalize a raw `{ output, isError }` result for display. Persisted output
 * is untouched; only the returned display text drops the hook wrapper.
 */
export function toolCallResultFrom({
  output,
  isError,
  interruption,
}: {
  output: string;
  isError: boolean;
  interruption?: ToolInterruption;
}): ToolCallResult {
  if (interruption) return interruptedToolCallResult(interruption);
  if (!isError) return { kind: 'text', content: output };
  const denial = classifyToolDenial(output);
  if (denial != null) {
    return { kind: 'blocked', content: denial.message, denial };
  }
  return { kind: 'error', content: stripHookErrorPrefix(output) };
}

/** The heading over a result's text: "Result", "Error", "Interrupted", or who blocked it. */
export function toolCallResultHeading(result: ToolCallResult): string {
  if (result.kind === 'blocked') return toolDenialHeading(result.denial);
  if (result.kind === 'interrupted') return 'Interrupted';
  return result.kind === 'error' ? 'Error' : 'Result';
}

/**
 * A classic expanded panel's result section. Exported so host slots that
 * replace the panel (WebFetch, SendMessage) show the same heading and text.
 */
export function ToolCallResultSection({
  result,
  children,
}: {
  result: ToolCallResult;
  children?: ReactNode;
}): JSX.Element {
  // Clean rows stay colorless, including a host slot opened under one.
  const clean = useCleanChatLook();
  return (
    <>
      <div
        className="border-t px-2.5 py-1 text-3xs font-medium fg-secondary"
        data-testid="tool-call-result-heading"
      >
        {result.kind === 'error' && !clean ? (
          <StatusLabel>{toolCallResultHeading(result)}</StatusLabel>
        ) : (
          toolCallResultHeading(result)
        )}
      </div>
      {children ?? (
        <pre
          className={`${REPLAY_BLOCK_CLASS} max-h-75 overflow-auto whitespace-pre-wrap break-all px-2.5 py-2 text-xs ${
            result.kind === 'error' ? 'fg-destructive/80' : 'fg-secondary'
          }`}
        >
          {result.content}
        </pre>
      )}
      {result.kind === 'error' && (
        <p
          className="px-2.5 py-1 text-xs fg-secondary"
          data-testid="tool-call-error-impact"
        >
          {TURN_OUTCOME_UNKNOWN_IMPACT}
        </p>
      )}
    </>
  );
}

function resolveToolCallStatus(
  status: ToolCallStatus | undefined,
  result: ToolCallResult | null | undefined,
): ToolCallStatus {
  if (result?.kind === 'blocked' && (status == null || status === 'error')) {
    return 'blocked';
  }
  if (
    result?.kind === 'interrupted' &&
    (status == null || status === 'error')
  ) {
    return 'interrupted';
  }
  if (status != null) return status;
  if (result == null) return 'pending';
  return result.kind === 'error' ? 'error' : 'success';
}

const STATUS_TENSE: Record<ToolCallStatus, StepTense> = {
  pending: 'running',
  success: 'done',
  error: 'failed',
  blocked: 'blocked',
  interrupted: 'interrupted',
};

/** Decode live objects and JSON-serialized persisted results for the same card. */
export function readToolCallResult(value: unknown): ToolCallResult | null {
  let result: unknown = value;
  if (typeof result === 'string') {
    try {
      result = JSON.parse(result);
    } catch {
      return null;
    }
  }
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return null;
  }
  const output =
    'output' in result && typeof result.output === 'string'
      ? result.output
      : 'content' in result && typeof result.content === 'string'
        ? result.content
        : 'text' in result && typeof result.text === 'string'
          ? result.text
          : null;
  if (output === null) return null;
  const interruption =
    'interruption' in result
      ? readToolInterruption(result.interruption)
      : undefined;
  return toolCallResultFrom({
    output,
    isError: 'isError' in result && result.isError === true,
    ...(interruption ? { interruption } : {}),
  });
}

export interface ToolCallCardProps {
  /**
   * Tool family used to dispatch the leading icon. When omitted the renderer
   * falls back to the generic wrench icon (treated as `unknown`).
   */
  toolFamily?: PortalChatToolFamily;
  /** Raw tool name string. Used as the default label when `label` is unset. */
  toolName: string;
  /**
   * Optional rich label rendered to the right of the icon. Hosts can pass a
   * pre-formatted React element (e.g. "Read foo.ts" with code chunks) so the
   * desktop's existing `ToolDisplayInfo` table can keep producing inline
   * filename/command chunks.
   */
  label?: ReactNode;
  /**
   * Optional call-specific icon. Hosts use this when the raw tool name is not
   * enough to choose the right icon, such as Codex `file_change` delete rows.
   */
  icon?: ReactNode;
  /**
   * Optional host-provided branded app icon. Used for the `canopy`/app family
   * because this shared package cannot know the active product brand.
   */
  appIcon?: ReactNode;
  /**
   * Raw tool input. Rendered inside the expanded panel as a preformatted
   * block. Hosts can omit when the input is empty.
   */
  input?: string;
  /** Resolved tool result. Renders below `input` inside the expanded panel. */
  result?: ToolCallResult | null;
  /**
   * Tool execution status. Controls the pending spinner + error badge.
   * Defaults to `'success'` when `result` is set without `error`, `'error'`
   * when the result is an error, `'blocked'` when it is a recognized
   * approval denial, `'interrupted'` when it carries interruption metadata,
   * and `'pending'` when no result is set. A blocked or interrupted result
   * overrides an explicit `'error'`.
   */
  status?: ToolCallStatus;
  /**
   * Product name for a known restart's "Interrupted when … closed" detail.
   * Defaults to the host's `ChatAppNameProvider` value.
   */
  brandAppName?: string;
  /** Whether the body starts collapsed. Defaults to `true`. */
  defaultCollapsed?: boolean;
  /** Reveal a search target without changing the saved collapse state. */
  forceExpanded?: boolean;
  /** Optional pending-spinner slot. Hosts pass their own animated dots. */
  pendingSpinner?: ReactNode;
  /**
   * Whether this pending call is held for the person's approval. Overrides
   * the host's `ToolApprovalWaitProvider` either way; a settled status always
   * wins over it. A waiting call says so ("Waiting to run …") instead of
   * shimmering or spinning.
   */
  awaitingApproval?: boolean;
  /** Custom expanded-panel slot. When supplied, replaces input/result chrome. */
  expandedSlot?: ReactNode;
  /** One action replacing the raw input/result, inset by the expanded body. */
  expandedAction?: ReactNode;
  /**
   * Test ID hook for automation. Independent of this hook, the card root
   * always exposes nonvisual `data-tool-name` (raw canonical tool name) and
   * `data-tool-status` (`pending` | `success` | `error` | `blocked` |
   * `interrupted`) attributes, plus `data-tool-interruption` when interrupted
   * and `data-tool-approval="waiting"` while a pending call awaits approval.
   */
  dataTestId?: string;
  /**
   * The call's stable step identity, exposed as `data-tool-use-id` so a host
   * can reveal and focus this row (a turn summary landing on a blocked step).
   */
  toolUseId?: string;
}

/**
 * Pure display tool-call card. Renders an icon + label row that toggles a
 * preformatted input/result panel when clicked. Hosts wrap this with the
 * stateful concerns they need (copy buttons, restore-on-expand persistence)
 * — this primitive only owns the visual chrome + the local expand toggle.
 */
export function ToolCallCard({
  toolFamily,
  toolName,
  label,
  icon,
  appIcon,
  input,
  result,
  status,
  brandAppName,
  defaultCollapsed = true,
  forceExpanded = false,
  pendingSpinner,
  awaitingApproval,
  expandedSlot,
  expandedAction,
  dataTestId,
  toolUseId,
}: ToolCallCardProps): JSX.Element {
  const [open, setIsOpen] = useState(!defaultCollapsed);
  const isOpen = forceExpanded || open;
  const Icon = getToolFamilyIcon(toolFamily);
  const renderedIcon =
    icon ?? (toolFamily === 'canopy' && appIcon != null ? appIcon : <Icon />);

  const resolvedStatus = resolveToolCallStatus(status, result);
  const gatewayDetail =
    resolvedStatus === 'success'
      ? gatewayConnectionDetail(input, result)
      : undefined;
  const approvalWait = useToolApprovalWait();
  // Only a call still pending can wait; a question waits on its own form.
  const isWaiting =
    resolvedStatus === 'pending' &&
    !isAskUserQuestionToolName(toolName) &&
    (awaitingApproval ??
      approvalWait.isCallWaiting({
        toolName,
        ...(toolUseId !== undefined ? { toolUseId } : {}),
        ...(input !== undefined ? { input } : {}),
      }));
  const isPending = resolvedStatus === 'pending' && !isWaiting;
  const isError = resolvedStatus === 'error';
  const denial = result?.kind === 'blocked' ? result.denial : null;
  const contextAppName = useChatAppName();
  const isInterrupted = resolvedStatus === 'interrupted';
  const interruption: ToolInterruption | null = isInterrupted
    ? result?.kind === 'interrupted'
      ? result.interruption
      : { reason: 'unknown', at: 0 }
    : null;
  const interruptionDetail =
    interruption != null ? (
      <span data-testid="tool-call-interrupted">
        {toolInterruptionDetail(interruption, brandAppName ?? contextAppName)}
      </span>
    ) : null;
  const statusIcon =
    denial != null ? (
      <ShieldIcon />
    ) : interruption != null ? (
      <StopIcon aria-hidden="true" />
    ) : (
      renderedIcon
    );
  // Clean chat look: the shared step row, with readable details when opened.
  const clean = useCleanChatLook();
  if (clean) {
    // The row can cut even a short command (a long description, a narrow
    // column), so the opened body always keeps it whole.
    const shownInput =
      input != null ? readableToolInput(toolName, input) : undefined;
    return (
      <div
        data-testid={dataTestId}
        data-tool-use-id={toolUseId}
        data-tool-name={toolName}
        data-tool-status={resolvedStatus}
        data-tool-interruption={interruption?.reason}
        data-chat-disclosure=""
        data-tool-approval={isWaiting ? 'waiting' : undefined}
      >
        <StepTenseProvider
          value={isWaiting ? 'waiting' : STATUS_TENSE[resolvedStatus]}
        >
          <StepRow
            prioritizeDetail
            icon={statusIcon}
            step
            label={
              <span className={REPLAY_BLOCK_CLASS}>{label ?? toolName}</span>
            }
            detail={
              isWaiting ? (
                // A label without a verb ("Fetch", an app tool) still says
                // why it is not running.
                <span data-testid="tool-call-waiting">
                  {TOOL_APPROVAL_WAITING_LABEL}
                </span>
              ) : denial == null && interruption == null ? (
                gatewayDetail
              ) : undefined
            }
            // Blocked and interrupted say so at the row's end, in the
            // detail's grey; Failed stays after the words.
            className="w-full"
            trailing={
              denial != null ? (
                <span
                  className="ml-auto shrink-0 pl-2 fg-tertiary"
                  data-testid="tool-call-blocked"
                >
                  {toolDenialDetail(denial)}
                </span>
              ) : interruptionDetail != null ? (
                <span className="ml-auto shrink-0 pl-2 fg-tertiary">
                  {interruptionDetail}
                </span>
              ) : undefined
            }
            running={isPending}
            failed={isError}
            expandable
            isOpen={isOpen}
            onToggle={(): void => setIsOpen((prev) => !prev)}
          />
        </StepTenseProvider>
        {isOpen && (
          <div
            className={`${STEP_ROW_BODY_CLASS}${expandedAction != null ? ' p-2 empty:p-0' : ''}`}
            data-chat-reveal-body=""
          >
            {expandedAction ?? expandedSlot ?? (
              <Stack gap="tight">
                {shownInput != null && shownInput.length > 0 && (
                  <pre className={CLEAN_OUTPUT_CLASS}>{shownInput}</pre>
                )}
                {result && result.content.length > 0 && (
                  <pre className={CLEAN_OUTPUT_CLASS}>{result.content}</pre>
                )}
              </Stack>
            )}
            {isError && expandedAction == null && expandedSlot == null && (
              <p
                className="text-xs fg-secondary"
                data-testid="tool-call-error-impact"
              >
                {TURN_OUTCOME_UNKNOWN_IMPACT}
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <Stack
      gap="tight"
      data-testid={dataTestId}
      data-tool-use-id={toolUseId}
      data-tool-name={toolName}
      data-tool-status={resolvedStatus}
      data-tool-interruption={interruption?.reason}
      data-tool-approval={isWaiting ? 'waiting' : undefined}
    >
      <button
        type="button"
        onClick={(): void => setIsOpen((prev) => !prev)}
        className="group flex w-full items-center gap-2 py-1 text-xs fg-secondary transition-colors"
        aria-expanded={isOpen}
        data-tool-family={toolFamily ?? 'unknown'}
      >
        {/*
          Fixed 14px (h-3.5 w-3.5) slot that centers whichever icon is shown
          and clamps every descendant SVG to the same size. The leading icon
          swaps to a plus/minus glyph on hover; without a fixed slot a taller
          icon (e.g. a brand logo) would shrink the row when the swap happens,
          jittering the layout. Normalizing the SVG size keeps the canopy/brand
          logo the correct size instead of overflowing the row.
        */}
        <span
          className={`flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0 ${
            isError
              ? 'fg-destructive'
              : denial != null
                ? 'fg-attention'
                : interruption != null
                  ? 'fg-tertiary'
                  : ''
          }`}
        >
          <span className="flex group-hover:hidden">{statusIcon}</span>
          <span className="hidden group-hover:flex">
            {isOpen ? <MinusIcon /> : <PlusIcon />}
          </span>
        </span>
        <span className={`${REPLAY_BLOCK_CLASS} min-w-0 truncate`}>
          {label ?? toolName}
        </span>
        {gatewayDetail ? (
          <span className="fg-tertiary">{gatewayDetail}</span>
        ) : null}
        {denial != null && (
          <span
            className="flex-shrink-0 fg-tertiary"
            data-testid="tool-call-blocked"
          >
            {toolDenialHeading(denial)}
          </span>
        )}
        {isError && denial == null && (
          // In words, and kept while hovered: the icon's error tint swaps to
          // +/− on hover, so it can't be the row's only signal.
          <StatusLabel className="flex-shrink-0" data-testid="tool-call-error">
            error
          </StatusLabel>
        )}
        {interruptionDetail != null && (
          <span className="flex-shrink-0 fg-tertiary">
            {interruptionDetail}
          </span>
        )}
        {isWaiting && (
          <span
            className="flex-shrink-0 fg-tertiary"
            data-testid="tool-call-waiting"
          >
            {TOOL_APPROVAL_WAITING_LABEL}
          </span>
        )}
        {isPending && pendingSpinner != null && (
          <span className="ml-1 inline-flex -translate-y-px flex-shrink-0 fg-accent">
            {pendingSpinner}
          </span>
        )}
      </button>
      {isOpen && (
        <div className="pl-5.5">
          <div
            className={`overflow-hidden rounded border bg-fg-primary/[0.02]${expandedAction != null ? ' p-2 empty:p-0' : ''}`}
          >
            {expandedAction ?? expandedSlot ?? (
              <>
                {input != null && input.length > 0 && (
                  <pre
                    className={`${REPLAY_BLOCK_CLASS} max-h-50 overflow-auto whitespace-pre-wrap break-all px-2.5 py-2 text-xs fg-secondary`}
                  >
                    {input}
                  </pre>
                )}
                {result && <ToolCallResultSection result={result} />}
              </>
            )}
          </div>
        </div>
      )}
    </Stack>
  );
}
