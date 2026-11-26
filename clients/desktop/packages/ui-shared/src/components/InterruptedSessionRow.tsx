import type { JSX, ReactNode } from 'react';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import { ChoiceField } from '../primitives/Choice';
import {
  SPACE_ROLE_GAP_CLASS,
  Stack,
  type SpaceRole,
} from '../primitives/Stack';

const LAYOUT_CLASS = {
  /** A selectable row in the resume dialog. */
  selection: 'gap-2 py-1',
  /** A queued entry with a trailing status. */
  queue: 'justify-between gap-4 py-3',
} as const;

const INDENT_CLASS = {
  none: '',
  /** Under a workspace header. */
  group: 'pl-6',
  /** Under a worktree header. */
  worktree: 'pl-12',
} as const;

/** The checkbox that selects a row in the resume dialog. */
export interface InterruptedSessionRowSelection {
  readonly id: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: () => void;
  /** Usually the metadata line (`metadataId`). */
  readonly describedBy?: string;
  readonly testId?: string;
}

export interface InterruptedSessionRowProps {
  /** User-authored chat or pipeline title. */
  title: string;
  /**
   * Selects the row: a checkbox whose label is the title line, so clicking
   * the title toggles it, without wrapping the row or its trailing
   * controls. Takes the place of `leading`.
   */
  selection?: InterruptedSessionRowSelection;
  /** Lets a trailing control reference the title through `aria-describedby`. */
  titleId?: string;
  /** Mask the user-authored title in session replays. */
  replayMaskTitle?: boolean;
  /** Line between the title and metadata, such as the workspace name. */
  context?: ReactNode;
  /** Mask the context line in session replays. */
  replayMaskContext?: boolean;
  /** Provider, interruption reason, and readiness. */
  metadata?: ReactNode;
  /** Lets a control reference the metadata through `aria-describedby`. */
  metadataId?: string;
  metadataTestId?: string;
  /** Session kind and detail, such as paused pipeline steps. */
  secondaryMetadata?: ReactNode;
  /** Mask secondary text that contains user-authored model labels. */
  replayMaskSecondaryMetadata?: boolean;
  /** Status or error content rendered after the metadata. */
  children?: ReactNode;
  /** Opt-in gap after title/metadata and between margin-free status blocks. */
  childrenGap?: SpaceRole;
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Mutes the text of a row whose control is disabled. */
  disabled?: boolean;
  layout?: keyof typeof LAYOUT_CLASS;
  indent?: keyof typeof INDENT_CLASS;
  as?: 'div' | 'li';
  role?: string;
  'aria-live'?: 'off' | 'polite' | 'assertive';
  separated?: boolean;
  'data-testid'?: string;
}

/**
 * One interrupted session in a resume list: the selection dialog and the
 * resume queue. Pure display; hosts supply the controls and their state.
 */
export function InterruptedSessionRow({
  title,
  selection,
  titleId,
  replayMaskTitle = false,
  context,
  replayMaskContext = false,
  metadata,
  metadataId,
  metadataTestId,
  secondaryMetadata,
  replayMaskSecondaryMetadata = false,
  children,
  childrenGap,
  leading,
  trailing,
  disabled = false,
  layout = 'selection',
  indent = 'none',
  as: Element = 'div',
  role,
  'aria-live': ariaLive,
  separated = false,
  'data-testid': testId,
}: InterruptedSessionRowProps): JSX.Element {
  const titleClass = `block truncate text-s ${disabled ? 'fg-secondary' : 'fg-primary'} ${replayMaskTitle ? REPLAY_MASK_CLASS : ''}`;
  // A native tooltip would expose a masked title outside its text node.
  const titleTooltip = replayMaskTitle ? undefined : title;
  const titleContent = selection ? (
    <ChoiceField
      id={selection.id}
      checked={selection.checked}
      disabled={selection.disabled}
      onChange={selection.onChange}
      aria-describedby={selection.describedBy}
      data-testid={selection.testId}
      label={
        <span id={titleId} title={titleTooltip} className={titleClass}>
          {title}
        </span>
      }
    />
  ) : (
    <p id={titleId} title={titleTooltip} className={titleClass}>
      {title}
    </p>
  );
  const metadataContent = (
    <>
      {context ? (
        <p
          // A title would leak masked text past replay privacy.
          title={
            !replayMaskContext && typeof context === 'string'
              ? context
              : undefined
          }
          className={`truncate text-xs fg-secondary ${replayMaskContext ? REPLAY_MASK_CLASS : ''}`}
        >
          {context}
        </p>
      ) : null}
      {metadata ? (
        <p
          id={metadataId}
          data-testid={metadataTestId}
          className="text-xs text-pretty fg-secondary"
        >
          {metadata}
        </p>
      ) : null}
      {secondaryMetadata ? (
        <p
          className={`break-words text-xs text-pretty fg-secondary ${replayMaskSecondaryMetadata ? REPLAY_MASK_CLASS : ''}`}
        >
          {secondaryMetadata}
        </p>
      ) : null}
    </>
  );
  return (
    <Element
      data-testid={testId}
      role={role}
      aria-live={ariaLive}
      className={`flex items-start ${LAYOUT_CLASS[layout]} ${INDENT_CLASS[indent]}${separated ? ' border-t' : ''}`}
    >
      {selection ? null : leading}
      <div className="min-w-0 flex-1">
        {childrenGap === undefined ? (
          <>
            {titleContent}
            <div className={selection ? 'pl-6' : undefined}>
              {metadataContent}
              {children}
            </div>
          </>
        ) : (
          <Stack gap={childrenGap}>
            <div>
              {titleContent}
              <div className={selection ? 'pl-6' : undefined}>
                {metadataContent}
              </div>
            </div>
            <div
              className={`flex flex-col ${SPACE_ROLE_GAP_CLASS[childrenGap]} empty:hidden ${selection ? 'pl-6' : ''}`}
            >
              {children}
            </div>
          </Stack>
        )}
      </div>
      {trailing}
    </Element>
  );
}
