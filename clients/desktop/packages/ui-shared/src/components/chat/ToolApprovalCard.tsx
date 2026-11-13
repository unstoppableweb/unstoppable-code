'use client';

import { Badge } from '../Badge';
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import type {
  ApprovalPromptDecision,
  ApprovalPromptRequest,
  ApprovalRuleTarget,
} from '@canopy/protocol/approvals';
import {
  ChevronDownMediumIcon as AppCatalogChevronDownMediumIcon,
  CircleCheckIcon,
  EyeIcon,
  ShieldIcon,
} from '../../icons/AppIcons';
import { Stack } from '../Stack';
import { formatTransferBytes } from '../../lib/format-transfer-bytes';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { isMacPlatform } from '../../lib/shortcut-platform';
import {
  type ActionMenuItem,
  ActionMenuItems,
  ActionMenuRowStyle,
} from '../ActionMenuItems';
import { Button } from '../Button';
import {
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuLabel,
} from '../DropdownMenu';
import { TextArea } from '../Field';
import { FloatingMenu } from '../FloatingMenu';
import { FormField } from '../FormField';
import { Tooltip } from '../Tooltip';
import {
  ApprovalContentModal,
  type ApprovalContentModalContent,
} from './ApprovalContentModal';
import {
  previewApprovalContent,
  previewApprovalTargetLabel,
} from './approval-content-preview';
import { ApprovalFileChangePreview } from './ApprovalFileChangePreview';
import { approvalFileChangeExpansionCopy } from './approval-file-change-rows';

export interface ToolApprovalCardProps {
  pending: ApprovalPromptRequest;
  /** Records the decision; the host owns the request and what it does. */
  onRespond: (
    requestId: string,
    decision: ApprovalPromptDecision,
  ) => Promise<void>;
  /**
   * Whether the host can remember a decision as a chat, project, or global
   * rule. Without it the scoped allow and deny options are hidden.
   */
  ruleScopes?: boolean;
  /** Whether a denial's reason reaches the agent; hides "Add a reason" if not. */
  denyReason?: boolean;
  /** Whether a denial can also stop the turn ("Deny and stop"). */
  denyAndStop?: boolean;
  /** The longest reason the host passes on; unlimited when absent. */
  reasonMaxLength?: number;
  /**
   * Shown instead of the actions to a viewer who may not decide. The card
   * then answers nothing.
   */
  readOnlyHint?: ReactNode;
  /**
   * Lets a host move focus into the card (CAN-4997). The chat dock uses it
   * to hand focus between successive approvals; Settings leaves it unset, so
   * the card never takes focus on its own.
   */
  focusHandleRef?: Ref<ToolApprovalCardHandle>;
}

export interface ToolApprovalCardHandle {
  /**
   * Focuses the primary action (Allow once, or Choose file(s)… for a
   * browser file request), or the labelled card when it is unavailable.
   */
  focusPrimaryAction: () => void;
}

/** The reason draft and its disclosure belong to one request. */
interface ReasonDraft {
  requestId: string;
  open: boolean;
  text: string;
}

/**
 * Cmd+Enter on macOS, Ctrl+Enter elsewhere, with no other modifier. IME
 * composition and key repeat never submit.
 */
function isReasonSubmitChord(
  event: KeyboardEvent<HTMLTextAreaElement>,
): boolean {
  if (event.key !== 'Enter') return false;
  if (event.nativeEvent.isComposing || event.repeat) return false;
  if (event.shiftKey || event.altKey) return false;
  return isMacPlatform()
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

/** What the full-content modal shows when opened from the card or a menu. */
interface FullContentView {
  title: string;
  subtitle?: string;
  content: ApprovalContentModalContent;
}

type FileWriteDetails = Extract<
  ApprovalPromptRequest['details'],
  { kind: 'file-write' }
>;

/** Copy for the one payload field per request kind that can grow unbounded. */
interface ApprovalContentCopy {
  /** Card button label when the inline preview was cut. */
  viewFull: string;
  /** Modal title when opened from that button. */
  title: string;
}

const APPROVAL_CONTENT_COPY: Record<
  'command' | 'mcp' | 'tool',
  ApprovalContentCopy
> = {
  command: { viewFull: 'View full command', title: 'Full command' },
  mcp: { viewFull: 'View full parameters', title: 'Full parameters' },
  tool: { viewFull: 'View full input', title: 'Full input' },
};

const RULE_TARGET_VIEW_TITLE = 'Rule target';
const RULE_TARGET_VIEW_SUBTITLE = 'Applies to every scoped option in this menu';

const TOOL_WIDE_RULE_LABELS: ReadonlyMap<string, string> = new Map([
  ['Skill', 'Skill (all skills)'],
  ['Read', 'Read (all files)'],
  ['NotebookRead', 'NotebookRead (all notebooks)'],
  ['Glob', 'Glob (all folders)'],
  ['Grep', 'Grep (all folders)'],
]);

function describeApprovalTarget(target: ApprovalRuleTarget): string {
  switch (target.kind) {
    case 'command':
      return target.pattern;
    case 'file-write':
      return target.path;
    case 'mcp':
      return target.tool ? `${target.server}: ${target.tool}` : target.server;
    case 'network':
      return target.host;
    case 'tool':
      // The card names the specific skill or read target, but a remembered
      // rule covers every skill or every read. Say so here so the two cannot
      // be confused.
      return TOOL_WIDE_RULE_LABELS.get(target.toolName) ?? target.toolName;
    case 'browser-upload':
      return target.path ? `${target.origin}: ${target.path}` : target.origin;
    default:
      return '';
  }
}

interface ApprovalContentPreviewProps {
  content: string;
  copy: ApprovalContentCopy;
  onViewFull: (view: FullContentView) => void;
}

/**
 * Bounded preview of a request's variable-size payload (CAN-3001). The card
 * is docked at the bottom of the window with no scroll ancestor, so an
 * unbounded `<pre>` pushed the Allow/Deny row off-screen. The preview is cut
 * at a fixed line/character budget; the full text is only ever rendered in
 * `ApprovalContentModal`, which scrolls.
 */
function ApprovalContentPreview({
  content,
  copy,
  onViewFull,
}: ApprovalContentPreviewProps): JSX.Element {
  const preview = previewApprovalContent(content);
  return (
    <>
      <pre
        data-testid="tool-approval-content-preview"
        className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-fg-primary/[0.06] px-2 py-1.5 font-mono text-2xs fg-primary/80"
      >
        <code>
          {preview.text}
          {preview.truncated ? '…' : ''}
        </code>
      </pre>
      {preview.truncated && (
        <div className="pt-1 text-2xs">
          <Button
            variant="link"
            data-testid="tool-approval-content-view-full"
            onClick={(): void =>
              onViewFull({
                title: copy.title,
                content: { kind: 'text', text: content },
              })
            }
          >
            {copy.viewFull}
          </Button>
        </div>
      )}
    </>
  );
}

/**
 * The file a write targets, on one truncated line (CAN-5165). The host
 * projects a worktree-relative `displayPath` when the path is inside the
 * working directory; otherwise the provider path shows as supplied. The
 * complete path is in the tooltip and, for keyboard and touch, in the inline
 * disclosure the same control toggles.
 */
function ApprovalFileTarget({
  path,
  displayPath,
}: {
  path: string;
  displayPath: string | undefined;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const fullPathId = useId();
  return (
    <Stack gap="tight" className="min-w-0">
      <Tooltip
        label={<span className={REPLAY_BLOCK_CLASS}>{path}</span>}
        contentClassName="max-w-96 break-all"
        className="max-w-full self-start"
        allowShrink
        delay="long"
      >
        <button
          type="button"
          data-testid="tool-approval-file-target"
          aria-expanded={open}
          aria-controls={open ? fullPathId : undefined}
          onClick={(): void => setOpen((value) => !value)}
          className="flex min-w-0 max-w-full items-center gap-1 rounded bg-fg-primary/[0.06] px-1.5 py-0.5 text-left font-mono text-2xs fg-primary/80 transition-colors hover:bg-fg-primary/[0.1]"
        >
          <span
            data-testid="tool-approval-file-target-label"
            className="min-w-0 truncate whitespace-nowrap"
          >
            {displayPath ?? path}
          </span>
          <span
            aria-hidden="true"
            className={`shrink-0 fg-secondary transition-transform ${open ? 'rotate-180' : ''}`}
          >
            <AppCatalogChevronDownMediumIcon size={14} />
          </span>
        </button>
      </Tooltip>
      {open && (
        <div
          id={fullPathId}
          data-testid="tool-approval-file-target-full"
          className="select-text whitespace-pre-wrap break-all font-mono text-2xs fg-secondary"
        >
          {path}
        </div>
      )}
    </Stack>
  );
}

function FileWriteDetailsView({
  details,
  onViewFull,
}: {
  details: FileWriteDetails;
  onViewFull: (view: FullContentView) => void;
}): JSX.Element {
  const { change, path } = details;
  // A projected relative path stands in for the absolute one in the card
  // body, so the modal's subtitle is the only place the latter repeats.
  const viewChange =
    change === undefined
      ? undefined
      : (): void =>
          onViewFull({
            title: approvalFileChangeExpansionCopy(change.truncated === true)
              .title,
            subtitle: path,
            content: { kind: 'change', change },
          });
  return (
    <div
      className={`${REPLAY_BLOCK_CLASS} flex min-w-0 flex-col gap-1 text-xs fg-primary/80`}
    >
      {(path || change) && (
        <div className="flex flex-col gap-1.5">
          {path && (
            <ApprovalFileTarget path={path} displayPath={details.displayPath} />
          )}
          {change && (
            <div>
              <ApprovalFileChangePreview
                change={change}
                mode="compact"
                onExpand={viewChange}
              />
            </div>
          )}
        </div>
      )}
      {details.reason && (
        <div className="text-2xs fg-secondary">{details.reason}</div>
      )}
    </div>
  );
}

/**
 * The request's details: the command, path, parameters, or input the agent
 * asks to run. Each kind's root carries the session-replay block, so the
 * card's title and actions stay recorded while the tool input does not.
 */
function ApprovalDetails({
  details,
  onViewFull,
}: {
  details: ApprovalPromptRequest['details'];
  onViewFull: (view: FullContentView) => void;
}): JSX.Element {
  switch (details.kind) {
    case 'command':
      return (
        <div className={`${REPLAY_BLOCK_CLASS} flex flex-col gap-1`}>
          <ApprovalContentPreview
            content={details.command}
            copy={APPROVAL_CONTENT_COPY.command}
            onViewFull={onViewFull}
          />
          {details.cwd && (
            <div className="text-2xs fg-secondary">in {details.cwd}</div>
          )}
          {details.reason && (
            <div className="text-2xs fg-secondary">{details.reason}</div>
          )}
        </div>
      );
    case 'file-write':
      return <FileWriteDetailsView details={details} onViewFull={onViewFull} />;
    case 'mcp':
      return (
        <div
          className={`${REPLAY_BLOCK_CLASS} flex flex-col gap-1 text-xs fg-primary/80`}
        >
          <div>
            <code className="rounded bg-fg-primary/[0.06] px-1 py-0.5 font-mono text-2xs">
              {details.server}: {details.tool}
            </code>
          </div>
          {details.paramsDisplay && (
            <div>
              <ApprovalContentPreview
                content={details.paramsDisplay}
                copy={APPROVAL_CONTENT_COPY.mcp}
                onViewFull={onViewFull}
              />
            </div>
          )}
          {details.reason && (
            <div className="text-2xs fg-secondary">{details.reason}</div>
          )}
        </div>
      );
    case 'network':
      return (
        <div
          className={`${REPLAY_BLOCK_CLASS} flex flex-col gap-1 text-xs fg-primary/80`}
        >
          <div>
            <code className="rounded bg-fg-primary/[0.06] px-1 py-0.5 font-mono text-2xs">
              {details.host}
            </code>
          </div>
          {details.reason && (
            <div className="text-2xs fg-secondary">{details.reason}</div>
          )}
        </div>
      );
    case 'tool':
      return (
        <div
          className={`${REPLAY_BLOCK_CLASS} flex min-w-0 flex-col gap-1 text-xs fg-primary/80`}
        >
          {/* A read tool names its target (CAN-4998); the title names the tool. */}
          {details.path ? (
            <ApprovalFileTarget
              path={details.path}
              displayPath={details.displayPath}
            />
          ) : (
            <div>
              <code className="rounded bg-fg-primary/[0.06] px-1 py-0.5 font-mono text-2xs">
                {details.toolName}
              </code>
            </div>
          )}
          {details.inputSummary && (
            <div>
              <ApprovalContentPreview
                content={details.inputSummary}
                copy={APPROVAL_CONTENT_COPY.tool}
                onViewFull={onViewFull}
              />
            </div>
          )}
          {details.reason && (
            <div className="text-2xs fg-secondary">{details.reason}</div>
          )}
        </div>
      );
    case 'browser-upload':
      return (
        <div
          data-testid="tool-approval-upload-details"
          className="text-xs fg-primary/80 flex flex-col gap-1"
        >
          <ul className="max-h-24 grid grid-cols-1 content-start gap-0.5 overflow-y-auto">
            {details.files.map((file, index) => (
              <li
                key={`${index}:${file.displayPath}`}
                className="flex min-w-0 items-baseline gap-2"
              >
                <code className="min-w-0 truncate rounded bg-fg-primary/[0.06] px-1 py-0.5 font-mono text-2xs">
                  {file.displayPath}
                </code>
                <span className="shrink-0 text-2xs fg-secondary">
                  {formatTransferBytes(file.sizeBytes)}
                </span>
              </li>
            ))}
          </ul>
          <div className="text-2xs fg-secondary">
            To {details.origin}
            {details.topOrigin && details.topOrigin !== details.origin
              ? ` on ${details.topOrigin}`
              : ''}
          </div>
          {details.reason && (
            <div className="text-2xs fg-secondary">{details.reason}</div>
          )}
        </div>
      );
    case 'browser-file-request':
      return (
        <div
          data-testid="tool-approval-file-request-details"
          className="text-xs fg-primary/80 flex flex-col gap-1"
        >
          {details.purpose && (
            <div className="whitespace-pre-wrap break-words">
              “{details.purpose}”
            </div>
          )}
          <div className="text-2xs fg-secondary">
            For {details.origin}
            {details.topOrigin && details.topOrigin !== details.origin
              ? ` on ${details.topOrigin}`
              : ''}
          </div>
        </div>
      );
    default:
      return <></>;
  }
}

interface ApprovalMenuTargetHeaderProps {
  /** The suggested rule target the scoped options below will persist. */
  targetLabel: string;
  testIdPrefix: 'tool-approval-allow-menu' | 'tool-approval-deny-menu';
  onViewFull: () => void;
}

/**
 * The rule target, shown once per menu on a single truncated line. Inline
 * interpreter payloads keep the complete command as their pattern
 * (`suggestedCommandPattern`), so repeating it under every option row used
 * to make the dropdown itself several screens tall. When the line is cut, a
 * `View full` row opens the same modal the card uses.
 */
function ApprovalMenuTargetHeader({
  targetLabel,
  testIdPrefix,
  onViewFull,
}: ApprovalMenuTargetHeaderProps): JSX.Element {
  const preview = previewApprovalTargetLabel(targetLabel);
  return (
    <>
      <DropdownMenuLabel data-testid={`${testIdPrefix}-target`} mono>
        {/* The rule target is tool input: blocked from session replay. The
            unstyled inline span keeps the label's truncation; the menu
            options around it stay recorded. */}
        <span className={REPLAY_BLOCK_CLASS}>
          {preview.text}
          {preview.truncated ? '…' : ''}
        </span>
      </DropdownMenuLabel>
      {preview.truncated && (
        <DropdownMenuItem
          data-testid={`${testIdPrefix}-view-full`}
          onClick={onViewFull}
        >
          <DropdownMenuItemIcon>
            <EyeIcon />
          </DropdownMenuItemIcon>
          View full
        </DropdownMenuItem>
      )}
      <DropdownMenuDivider />
    </>
  );
}

export const ToolApprovalCard = memo(function ToolApprovalCard({
  pending,
  onRespond: respondWith,
  focusHandleRef,
  ruleScopes = true,
  denyReason = true,
  denyAndStop: denyAndStopAvailable = true,
  reasonMaxLength,
  readOnlyHint,
}: ToolApprovalCardProps): JSX.Element {
  /**
   * One response at a time. A repeated click or chord while the first is in
   * flight is ignored; a failed response leaves the card for a retry. The
   * buttons are not disabled meanwhile, because disabling the focused one
   * would drop focus to the body.
   */
  const respondingRef = useRef(false);
  const respondToApproval = useCallback(
    async (
      requestId: string,
      decision: ApprovalPromptDecision,
    ): Promise<void> => {
      // A read-only card decides nothing, keyboard shortcuts included.
      if (respondingRef.current || readOnlyHint !== undefined) return;
      respondingRef.current = true;
      try {
        await respondWith(requestId, decision);
      } finally {
        respondingRef.current = false;
      }
    },
    [readOnlyHint, respondWith],
  );

  const [allowMenuOpen, setAllowMenuOpen] = useState(false);
  const [denyMenuOpen, setDenyMenuOpen] = useState(false);
  // Keyed by request, like the full view below, so a reason typed for one
  // request never carries over to the next.
  const [reasonDraft, setReasonDraft] = useState<ReasonDraft | null>(null);
  const ownReasonDraft =
    reasonDraft?.requestId === pending.requestId ? reasonDraft : null;
  const reasonOpen = ownReasonDraft?.open ?? false;
  const reason = ownReasonDraft?.text ?? '';
  const setReason = useCallback(
    (text: string): void =>
      setReasonDraft({ requestId: pending.requestId, open: true, text }),
    [pending.requestId],
  );
  const titleId = useId();
  const descriptionId = useId();
  const reasonId = useId();
  const reasonToggleRef = useRef<HTMLButtonElement>(null);
  const reasonFieldRef = useRef<HTMLTextAreaElement>(null);
  const primaryActionRef = useRef<HTMLButtonElement>(null);
  /** Where focus goes after the reason field opens or closes. */
  const reasonFocusRef = useRef<'field' | 'toggle' | null>(null);
  // Keyed by request so a card reused for the next request never shows the
  // previous request's content.
  const [openView, setOpenView] = useState<{
    requestId: string;
    view: FullContentView;
  } | null>(null);
  const fullView =
    openView?.requestId === pending.requestId ? openView.view : null;
  const setFullView = useCallback(
    (view: FullContentView): void =>
      setOpenView({ requestId: pending.requestId, view }),
    [pending.requestId],
  );
  const cardRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(
    focusHandleRef,
    (): ToolApprovalCardHandle => ({
      focusPrimaryAction: (): void => {
        const primary = primaryActionRef.current;
        if (primary && !primary.disabled && primary.isConnected) {
          primary.focus();
          return;
        }
        cardRef.current?.focus();
      },
    }),
    [],
  );

  const toggleReason = useCallback((): void => {
    reasonFocusRef.current = reasonOpen ? 'toggle' : 'field';
    setReasonDraft({
      requestId: pending.requestId,
      open: !reasonOpen,
      text: reason,
    });
  }, [pending.requestId, reason, reasonOpen]);

  useEffect(() => {
    const target = reasonFocusRef.current;
    reasonFocusRef.current = null;
    if (target === 'field') reasonFieldRef.current?.focus();
    else if (target === 'toggle') reasonToggleRef.current?.focus();
  }, [reasonOpen]);
  /**
   * The Allow/Deny button cluster. Passed to both menus as their outside-press
   * boundary so a click on "Allow once" or "Deny" while a menu is open still
   * resolves the prompt in one click instead of being swallowed as the press
   * that dismissed the menu. The two menus close each other explicitly.
   */
  const actionsRef = useRef<HTMLDivElement>(null);
  const allowTriggerRef = useRef<HTMLButtonElement>(null);
  const denyTriggerRef = useRef<HTMLButtonElement>(null);

  const target = ruleScopes ? pending.suggestedTarget : undefined;
  const targetLabel = target ? describeApprovalTarget(target) : undefined;

  const closeFullView = useCallback((): void => setOpenView(null), []);

  const toggleAllowMenu = useCallback((): void => {
    setDenyMenuOpen(false);
    setAllowMenuOpen((open) => !open);
  }, []);

  const toggleDenyMenu = useCallback((): void => {
    setAllowMenuOpen(false);
    setDenyMenuOpen((open) => !open);
  }, []);

  const viewFullTarget = useCallback((): void => {
    if (targetLabel === undefined) return;
    setAllowMenuOpen(false);
    setDenyMenuOpen(false);
    setFullView({
      title: RULE_TARGET_VIEW_TITLE,
      subtitle: RULE_TARGET_VIEW_SUBTITLE,
      content: { kind: 'text', text: targetLabel },
    });
  }, [setFullView, targetLabel]);

  const allowOnce = useCallback((): void => {
    void respondToApproval(pending.requestId, {
      behavior: 'allow',
      scope: 'once',
    });
  }, [pending.requestId, respondToApproval]);

  const allowScoped = useCallback(
    (scope: 'session' | 'project' | 'global'): void => {
      if (!target) return;
      void respondToApproval(pending.requestId, {
        behavior: 'allow',
        scope,
        target,
      });
      setAllowMenuOpen(false);
    },
    [pending.requestId, respondToApproval, target],
  );

  const denyOnce = useCallback((): void => {
    void respondToApproval(pending.requestId, {
      behavior: 'deny',
      scope: 'once',
      ...(reason.trim() ? { message: reason.trim() } : {}),
    });
  }, [pending.requestId, reason, respondToApproval]);

  // Cmd/Ctrl+Enter denies once with the reason. The chord stops here so it
  // never reaches the composer's own send shortcut.
  const onReasonKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (!isReasonSubmitChord(event)) return;
      event.preventDefault();
      event.stopPropagation();
      denyOnce();
    },
    [denyOnce],
  );

  const denyScoped = useCallback(
    (scope: 'project' | 'global'): void => {
      if (!target) return;
      void respondToApproval(pending.requestId, {
        behavior: 'deny',
        scope,
        target,
        ...(reason.trim() ? { message: reason.trim() } : {}),
      });
      setDenyMenuOpen(false);
    },
    [pending.requestId, reason, respondToApproval, target],
  );

  const denyAndStop = useCallback((): void => {
    void respondToApproval(pending.requestId, {
      behavior: 'deny',
      scope: 'once',
      stopTurn: true,
      ...(reason.trim() ? { message: reason.trim() } : {}),
    });
    setDenyMenuOpen(false);
  }, [pending.requestId, reason, respondToApproval]);

  // Each menu's rows are variants of one decision (allow or deny), so they
  // share one icon and only the first row of the run shows it.
  const allowMenuItems: readonly ActionMenuItem[] = [
    {
      key: 'session',
      label: 'Allow for this chat',
      icon: <CircleCheckIcon />,
      onSelect: (): void => allowScoped('session'),
    },
    {
      key: 'project',
      label: 'Always in this project',
      icon: <CircleCheckIcon />,
      onSelect: (): void => allowScoped('project'),
    },
    {
      key: 'global',
      label: 'Always everywhere',
      icon: <CircleCheckIcon />,
      onSelect: (): void => allowScoped('global'),
    },
  ];
  const hasTarget = target !== undefined && targetLabel !== undefined;
  const denyMenuItems: readonly ActionMenuItem[] = [
    ...(hasTarget
      ? [
          {
            key: 'project',
            label: 'Never in this project',
            icon: <ShieldIcon />,
            onSelect: (): void => denyScoped('project'),
          },
          {
            key: 'global',
            label: 'Never everywhere',
            icon: <ShieldIcon />,
            onSelect: (): void => denyScoped('global'),
          },
        ]
      : []),
    ...(denyAndStopAvailable
      ? [
          {
            key: 'stop',
            label: 'Deny and stop',
            icon: <ShieldIcon />,
            onSelect: denyAndStop,
          },
        ]
      : []),
  ];

  return (
    <div
      ref={cardRef}
      data-testid="tool-approval-card"
      role="group"
      aria-labelledby={titleId}
      aria-describedby={pending.description ? descriptionId : undefined}
      tabIndex={-1}
      className="flex flex-col gap-3 rounded-lg border border-line-attention/30 bg-warning/[0.06] px-4 py-3"
    >
      <div className="flex flex-col gap-1.5">
        <div>
          <div className="flex items-center gap-1.5">
            <div id={titleId} className="text-s font-medium fg-primary">
              {pending.title}
            </div>
            {pending.subagentId && (
              <Badge data-testid="tool-approval-subagent-badge">
                Subagent request
              </Badge>
            )}
          </div>
          {pending.description && (
            <div
              id={descriptionId}
              className={`${REPLAY_BLOCK_CLASS} mt-0.5 text-xs fg-secondary`}
            >
              {pending.description}
            </div>
          )}
        </div>
        <ApprovalDetails details={pending.details} onViewFull={setFullView} />
      </div>
      <Stack gap="inline">
        {readOnlyHint !== undefined ||
        pending.details.kind === 'browser-file-request' ? (
          <div className="flex flex-wrap items-center gap-2">
            {readOnlyHint !== undefined ? (
              // A viewer who may not decide sees why instead of the actions.
              <span
                data-testid="tool-approval-read-only"
                className="text-xs fg-secondary"
              >
                {readOnlyHint}
              </span>
            ) : (
              // The user picks the files, so there is no rule to remember.
              <>
                <Button
                  variant="primary"
                  size="compact"
                  ref={primaryActionRef}
                  onClick={allowOnce}
                  data-testid="tool-approval-choose-files"
                >
                  {pending.details.kind === 'browser-file-request' &&
                  pending.details.multiple
                    ? 'Choose files…'
                    : 'Choose file…'}
                </Button>
                <Button
                  size="compact"
                  onClick={denyOnce}
                  data-testid="tool-approval-decline-files"
                >
                  Decline
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <div ref={actionsRef} className="flex flex-wrap items-center gap-2">
              <div className="relative flex">
                <button
                  ref={primaryActionRef}
                  type="button"
                  onClick={allowOnce}
                  data-testid="tool-approval-allow"
                  className={`${ruleScopes ? 'rounded-l' : 'rounded'} bg-accent-subtle px-3 py-1.5 text-xs font-medium fg-accent-strong transition-colors hover:bg-accent-subtle/80`}
                >
                  Allow once
                </button>
                {ruleScopes && (
                  <>
                    <button
                      ref={allowTriggerRef}
                      type="button"
                      aria-haspopup="menu"
                      aria-expanded={allowMenuOpen}
                      aria-label="More allow options"
                      onClick={toggleAllowMenu}
                      className="rounded-r border-l border-line-accent/20 bg-accent-subtle px-1.5 py-1.5 fg-accent-strong transition-colors hover:bg-accent-subtle/80"
                    >
                      <AppCatalogChevronDownMediumIcon size={14} />
                    </button>
                    {/* Portaled and collision-clamped: the card sits at the bottom of
              the window, so an in-card popover opening downward ran behind
              the composer and off the viewport (CAN-3001). */}
                    <FloatingMenu
                      open={allowMenuOpen}
                      onOpenChange={setAllowMenuOpen}
                      anchorRef={allowTriggerRef}
                      outsidePressBoundaryRef={actionsRef}
                      placement="top-left"
                      aria-label="Allow options"
                      data-testid="tool-approval-allow-menu"
                      className="min-w-55 max-w-80"
                    >
                      {target && targetLabel !== undefined ? (
                        <>
                          <ApprovalMenuTargetHeader
                            targetLabel={targetLabel}
                            testIdPrefix="tool-approval-allow-menu"
                            onViewFull={viewFullTarget}
                          />
                          <ActionMenuRowStyle>
                            <ActionMenuItems
                              items={allowMenuItems}
                              onSelect={(item): void => {
                                if (item.disabled || !item.onSelect) return;
                                item.onSelect();
                                setAllowMenuOpen(false);
                                allowTriggerRef.current?.focus({
                                  preventScroll: true,
                                });
                              }}
                            />
                          </ActionMenuRowStyle>
                        </>
                      ) : (
                        <DropdownMenuLabel>
                          No additional options
                        </DropdownMenuLabel>
                      )}
                    </FloatingMenu>
                  </>
                )}
              </div>

              <div className="relative flex">
                <button
                  type="button"
                  onClick={denyOnce}
                  data-testid="tool-approval-deny"
                  className={`${denyMenuItems.length > 0 ? 'rounded-l' : 'rounded'} px-3 py-1.5 text-xs fg-secondary transition-colors hover:bg-fg-primary/[0.06] hover:fg-primary/80`}
                >
                  Deny
                </button>
                {denyMenuItems.length > 0 && (
                  <>
                    <button
                      ref={denyTriggerRef}
                      type="button"
                      aria-haspopup="menu"
                      aria-expanded={denyMenuOpen}
                      aria-label="More deny options"
                      onClick={toggleDenyMenu}
                      className="rounded-r px-1.5 py-1.5 fg-secondary transition-colors hover:bg-fg-primary/[0.06] hover:fg-primary/80"
                    >
                      <AppCatalogChevronDownMediumIcon size={14} />
                    </button>
                    <FloatingMenu
                      open={denyMenuOpen}
                      onOpenChange={setDenyMenuOpen}
                      anchorRef={denyTriggerRef}
                      outsidePressBoundaryRef={actionsRef}
                      placement="top-left"
                      aria-label="Deny options"
                      data-testid="tool-approval-deny-menu"
                      className="min-w-55 max-w-80"
                    >
                      {target && targetLabel !== undefined && (
                        <>
                          <ApprovalMenuTargetHeader
                            targetLabel={targetLabel}
                            testIdPrefix="tool-approval-deny-menu"
                            onViewFull={viewFullTarget}
                          />
                        </>
                      )}
                      <ActionMenuRowStyle>
                        <ActionMenuItems
                          items={denyMenuItems}
                          onSelect={(item): void => {
                            if (item.disabled || !item.onSelect) return;
                            item.onSelect();
                            setDenyMenuOpen(false);
                            denyTriggerRef.current?.focus({
                              preventScroll: true,
                            });
                          }}
                        />
                      </ActionMenuRowStyle>
                    </FloatingMenu>
                  </>
                )}
              </div>
            </div>

            {denyReason && (
              <Button
                variant="ghost-quiet"
                size="compact"
                ref={reasonToggleRef}
                data-testid="tool-approval-reason-toggle"
                aria-expanded={reasonOpen}
                aria-controls={reasonOpen ? reasonId : undefined}
                onClick={toggleReason}
              >
                {reasonOpen ? 'Hide reason' : 'Add a reason'}
              </Button>
            )}
          </div>
        )}

        {reasonOpen && readOnlyHint === undefined && (
          <div>
            <FormField id={reasonId} label="Reason for denying">
              {(control) => (
                <div className={REPLAY_BLOCK_CLASS}>
                  <TextArea
                    {...control}
                    ref={reasonFieldRef}
                    data-testid="tool-approval-reason"
                    value={reason}
                    onChange={(e): void => setReason(e.target.value)}
                    onKeyDown={onReasonKeyDown}
                    placeholder="Included in the response to the agent…"
                    rows={2}
                    maxLength={reasonMaxLength}
                  />
                </div>
              )}
            </FormField>
          </div>
        )}
      </Stack>
      {fullView && (
        <ApprovalContentModal
          title={fullView.title}
          subtitle={fullView.subtitle}
          content={fullView.content}
          onClose={closeFullView}
          restoreFocusRef={cardRef}
        />
      )}
    </div>
  );
});
