import { TranscriptSearchRevealContext } from './transcript-search-reveal';
import { useContext, memo, useMemo, type JSX, type ReactNode } from 'react';
import {
  DeferredToolOutput,
  ChatVisualSourceButton,
  type ToolOutputIdentity,
  type ChatVisualOwner,
} from '@canopy/ui-app';
import { SHOW_VISUAL_TOOL_ALIASES } from '@/lib/canopy-tool-aliases';
import {
  getToolRowInput,
  ToolCallCard,
  ToolCallResultSection,
  interruptedToolCallResult,
  toolCallResultFrom,
  type ToolCallStatus,
} from '@canopy/ui-shared/components';
import { BrandLogo } from '@/components/BrandLogo';
import { brand } from '@/lib/brand';
import type { ToolResult } from './types';
import {
  getToolDisplayInfo,
  getSendMessageDisplayInfo,
  getToolFamilyFromName,
  isAppActionToolName,
  isCodeGraphToolName,
} from './ToolDisplayInfo';
import { AuthRecoveryCard } from './AuthRecoveryCard';
import { readToolAuthRecoveryFailures } from './tool-auth-recovery';

function toUnknown(value: unknown): unknown {
  return value;
}

function parseJsonObject(input: string): object | null {
  try {
    const parsed = toUnknown(JSON.parse(input));
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function getJsonStringField(input: string, field: string): string | undefined {
  const parsed = parseJsonObject(input);
  if (!parsed) {
    return undefined;
  }
  const value = toUnknown(Reflect.get(parsed, field));
  return typeof value === 'string' ? value : undefined;
}

/**
 * Desktop wrapper that composes the shared `ToolCallCard` primitive. The
 * shared card owns the visual chrome (icon dispatch, expand/collapse,
 * pending spinner shell), while this wrapper supplies the desktop's
 * existing rich label from `getToolDisplayInfo` and the runtime pending
 * spinner. `WebFetch` continues to render its parsed `prompt` block via an
 * `expandedSlot` override so the desktop-only behaviour stays here.
 */
export const ToolCallBlock = memo(function ToolCallBlock({
  toolName,
  originChatTabId,
  originMessageId,
  input,
  result,
  resolvedRecipient,
  isCodeReviewChat,
  toolUseId,
  turnSettled = false,
  label,
  status,
}: {
  toolName: string;
  originChatTabId?: string;
  originMessageId?: string;
  input: string;
  result?: ToolResult & { readonly outputIdentity?: ToolOutputIdentity };
  resolvedRecipient?: string;
  /** True inside a Code Review sidecar chat — lets the shared plan/review
   * comment tools (see `ToolDisplayScope`) pick up the code-flavored icon
   * even for `RespondToComment`, whose raw name is identical in Plan
   * Explore chats. */
  isCodeReviewChat?: boolean;
  /** The step's identity; a turn summary lands on its row by this id. */
  toolUseId?: string;
  /**
   * True only when the owning turn is authoritatively settled. A call with
   * no result then renders interrupted instead of a spinner. Inactivity or a
   * disconnected stream alone never sets this.
   */
  turnSettled?: boolean;
  /** Replaces the row label derived from the tool name and input. */
  label?: ReactNode;
  /**
   * Explicit row status. Without one the card infers it from `result`, so a
   * settled row that has no result must pass one to avoid a pending spinner.
   */
  status?: ToolCallStatus;
}): JSX.Element {
  const forceExpanded = useContext(TranscriptSearchRevealContext);
  // Clean rows stay colorless, including their opened output.

  const toolDisplayScope = {
    isCodeReview: isCodeReviewChat,
    trustedMcpNamespace: brand.tools.namespace,
  };
  const visualOwner = useMemo((): ChatVisualOwner | null => {
    if (
      !SHOW_VISUAL_TOOL_ALIASES.includes(toolName) ||
      !result ||
      result.isError ||
      !result.visualRef ||
      !result.messageId ||
      !result.toolUseId
    ) {
      return null;
    }
    return {
      messageId: result.messageId,
      toolUseId: result.toolUseId,
      reference: result.visualRef,
    };
  }, [result, toolName]);
  const { icon, label: derivedLabel } =
    toolName === 'SendMessage'
      ? getSendMessageDisplayInfo(input, resolvedRecipient)
      : getToolDisplayInfo(
          toolName,
          // A visual row names the title its promoted reference owns, through
          // the same shared renderer the Portal uses.
          visualOwner
            ? JSON.stringify({ title: visualOwner.reference.title })
            : input,
          toolDisplayScope,
        );
  const displayLabel = label ?? derivedLabel;
  const family = getToolFamilyFromName(toolName, toolDisplayScope, input);
  // Code-graph tools keep their dedicated GraphIcon (from `getToolDisplayInfo`)
  // rather than folding into the neutral branded app logo like other
  // app-action tools.
  const displayIcon =
    isAppActionToolName(toolName, toolDisplayScope) &&
    !isCodeGraphToolName(toolName, toolDisplayScope) ? (
      <BrandLogo width={14} height={14} aria-hidden />
    ) : (
      icon
    );
  const appIcon = <BrandLogo width={14} height={14} aria-hidden />;

  const toolResult = result
    ? toolCallResultFrom({
        output: result.output,
        isError: result.isError,
        ...(result.interruption ? { interruption: result.interruption } : {}),
      })
    : turnSettled
      ? // The owning turn settled with no result recorded for this call.
        interruptedToolCallResult()
      : null;
  const authRecoveryFailures = readToolAuthRecoveryFailures(toolName, result);

  const displayInput = getToolRowInput(toolName, input);

  const outputIdentity: ToolOutputIdentity | undefined =
    result?.outputIdentity ??
    (result?.fullOutputRef && result.messageId && result.toolUseId
      ? {
          kind: 'reference',
          reference: result.fullOutputRef,
          messageId: result.messageId,
          toolUseId: result.toolUseId,
        }
      : undefined);
  if (result && (result.fullOutputRef || outputIdentity)) {
    return (
      <ToolCallCard
        forceExpanded={forceExpanded}
        dataTestId="chat-tool-call"
        toolUseId={toolUseId}
        toolFamily={family}
        toolName={toolName}
        icon={displayIcon}
        appIcon={appIcon}
        label={displayLabel}
        status={status}
        result={toolResult}
        expandedSlot={
          <>
            <pre className="max-h-50 overflow-auto whitespace-pre-wrap break-all px-2.5 py-2 text-xs fg-secondary">
              {displayInput}
            </pre>
            {authRecoveryFailures.length > 0 && (
              <AuthRecoveryCard
                failures={authRecoveryFailures}
                originChatTabId={originChatTabId}
                sourceMessageId={result?.messageId ?? originMessageId}
              />
            )}
            {toolResult && (
              <ToolCallResultSection result={toolResult}>
                {outputIdentity ? (
                  <DeferredToolOutput
                    identity={outputIdentity}
                    preview={toolResult.content}
                    isError={result.isError}
                  />
                ) : (
                  <pre
                    className={`max-h-50 overflow-auto whitespace-pre-wrap break-all px-2.5 py-2 text-xs fg-secondary`}
                  >
                    {toolResult.content}
                  </pre>
                )}
              </ToolCallResultSection>
            )}
          </>
        }
      />
    );
  }

  if (toolName === 'ClaudeModelChange') {
    return (
      <ToolCallCard
        forceExpanded={forceExpanded}
        dataTestId="chat-tool-call"
        toolUseId={toolUseId}
        toolFamily={family}
        toolName={toolName}
        icon={displayIcon}
        appIcon={appIcon}
        label={displayLabel}
        status={status}
        result={toolResult}
      />
    );
  }

  // WebFetch keeps its "Prompt" pre-section so the call body shows the parsed
  // prompt rather than the raw stringified input. Composed through the
  // expanded slot so the shared card's expand/collapse state still drives
  // visibility.
  if (toolName === 'WebFetch') {
    const prompt = getJsonStringField(input, 'prompt') ?? input;
    return (
      <ToolCallCard
        forceExpanded={forceExpanded}
        dataTestId="chat-tool-call"
        toolUseId={toolUseId}
        toolFamily={family}
        toolName={toolName}
        icon={displayIcon}
        appIcon={appIcon}
        label={displayLabel}
        status={status}
        result={toolResult}
        expandedSlot={
          <>
            <div className="px-2.5 py-1 text-3xs font-medium fg-secondary">
              Prompt
            </div>
            <pre className="max-h-50 overflow-auto whitespace-pre-wrap break-all px-2.5 py-2 text-xs fg-secondary">
              {prompt}
            </pre>
            {toolResult && <ToolCallResultSection result={toolResult} />}
          </>
        }
      />
    );
  }

  // SendMessage surfaces the parsed `message` body (the payload delivered to
  // the recipient agent) rather than the raw `{ to, summary, message }` JSON,
  // mirroring the WebFetch "Prompt" treatment above.
  if (toolName === 'SendMessage') {
    const message = getJsonStringField(input, 'message') ?? input;
    return (
      <ToolCallCard
        forceExpanded={forceExpanded}
        dataTestId="chat-tool-call"
        toolUseId={toolUseId}
        toolFamily={family}
        toolName={toolName}
        icon={displayIcon}
        appIcon={appIcon}
        label={displayLabel}
        status={status}
        result={toolResult}
        expandedSlot={
          <>
            <div className="px-2.5 py-1 text-3xs font-medium fg-secondary">
              Message
            </div>
            <pre className="max-h-75 overflow-auto whitespace-pre-wrap break-all px-2.5 py-2 text-xs fg-secondary">
              {message}
            </pre>
            {toolResult && <ToolCallResultSection result={toolResult} />}
          </>
        }
      />
    );
  }

  return (
    <>
      <ToolCallCard
        forceExpanded={forceExpanded}
        dataTestId="chat-tool-call"
        toolUseId={toolUseId}
        toolFamily={family}
        toolName={toolName}
        icon={displayIcon}
        appIcon={appIcon}
        label={displayLabel}
        status={status}
        input={displayInput}
        result={toolResult}
        // A visual row offers its source in place of the raw input.
        expandedAction={
          visualOwner ? (
            <ChatVisualSourceButton owner={visualOwner} />
          ) : undefined
        }
      />
      {authRecoveryFailures.length > 0 ? (
        <AuthRecoveryCard
          failures={authRecoveryFailures}
          originChatTabId={originChatTabId}
          sourceMessageId={result?.messageId ?? originMessageId}
        />
      ) : null}
    </>
  );
});
