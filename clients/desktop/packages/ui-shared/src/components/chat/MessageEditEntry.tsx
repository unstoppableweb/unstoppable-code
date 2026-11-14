'use client';

import {
  useEffect,
  useMemo,
  useRef,
  type JSX,
  type HTMLAttributes,
  type MouseEvent,
  type PointerEvent,
  type Ref,
} from 'react';
import { PencilIcon } from '../../icons';
import {
  BUBBLE_SURFACE_CLASS,
  BUBBLE_INFO_SURFACE_CLASS,
} from '../bubble-badge';
import { Button } from '../Button';
import { Notice } from '../Notice';
import { Surface } from '../Surface';
import { MessageEditCard } from './MessageEditCard';

/**
 * Neutral explanation for an edit attempt the host rejected because the
 * message changed underneath it. It does not claim the message was sent: it
 * may instead have been removed, locked, or edited elsewhere.
 */
export const MESSAGE_NO_LONGER_EDITABLE_NOTICE =
  'This message is no longer available to edit.';

const EXCLUDED_TARGET_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  'summary',
  'label',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="treeitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  // A region (an attachment, a reference chip) whose double-click keeps its
  // own behavior instead of opening the editor.
  '[data-no-double-click-edit]',
].join(',');

/** Edit callback; a returned promise blocks repeat gestures until it settles. */
export type MessageEditHandler = () => void | Promise<void>;

/** Props to spread on the bubble surface element. */
export interface DoubleClickToEditProps {
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  onPointerCancel?: () => void;
  onMouseDown?: (event: MouseEvent<HTMLElement>) => void;
  onMouseUp?: (event: MouseEvent<HTMLElement>) => void;
  onDoubleClick?: (event: MouseEvent<HTMLElement>) => void;
  'data-double-click-edit'?: 'true';
}

function isExcludedTarget(
  surface: HTMLElement,
  target: EventTarget | null,
): boolean {
  if (!(target instanceof Element) || !surface.contains(target)) return true;
  const control = target.closest(EXCLUDED_TARGET_SELECTOR);
  return control !== null && surface.contains(control);
}

function selectionIntersects(surface: HTMLElement): boolean {
  const selection = surface.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed) return false;
  for (let index = 0; index < selection.rangeCount; index += 1) {
    if (selection.getRangeAt(index).intersectsNode(surface)) return true;
  }
  return false;
}

function isSynthesizedTouch(event: MouseEvent<HTMLElement>): boolean {
  const capabilities: unknown = Reflect.get(
    event.nativeEvent,
    'sourceCapabilities',
  );
  return (
    typeof capabilities === 'object' &&
    capabilities !== null &&
    Reflect.get(capabilities, 'firesTouchEvents') === true
  );
}

function isPrimaryUnmodified(event: MouseEvent<HTMLElement>): boolean {
  return (
    event.button === 0 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

/**
 * Opens a message's editor on a primary-pointer double-click of its bubble.
 * Spread the result on the bubble surface (not its gutter), and pass the same
 * handler the bubble's Edit badge uses.
 *
 * Without `onEdit` no handlers are installed, so a non-editable bubble keeps
 * native double-click word selection. For an editable bubble, the second press
 * of an unmodified mouse or pen gesture suppresses word selection; touch input,
 * modifier keys, nested controls, and a selection that already touched the
 * bubble before the gesture began all keep their native behavior.
 */
export function useDoubleClickToEdit(
  onEdit: MessageEditHandler | undefined,
): DoubleClickToEditProps {
  const gesture = useRef({
    armed: false,
    pointerType: '',
    protectedSelection: false,
    pending: false,
  });
  // Hosts pass fresh closures on every render, and a streaming transcript
  // re-renders between the two presses; only a change in editability resets
  // the gesture.
  const latestEdit = useRef(onEdit);
  useEffect(() => {
    latestEdit.current = onEdit;
  }, [onEdit]);
  const editable = onEdit !== undefined;
  useEffect(() => {
    const state = gesture.current;
    state.armed = false;
    state.protectedSelection = false;
  }, [editable]);

  return useMemo((): DoubleClickToEditProps => {
    if (!editable) return {};
    const state = gesture.current;
    const canStart = (event: MouseEvent<HTMLElement>): boolean =>
      state.armed &&
      !state.pending &&
      !state.protectedSelection &&
      state.pointerType !== 'touch' &&
      !event.currentTarget.closest('fieldset:disabled') &&
      !isSynthesizedTouch(event) &&
      isPrimaryUnmodified(event) &&
      !isExcludedTarget(event.currentTarget, event.target);
    return {
      onPointerDown: (event): void => {
        // Recorded per press so a touch tap on a hybrid device cannot
        // suppress a later mouse gesture.
        state.pointerType = event.pointerType;
      },
      onPointerCancel: (): void => {
        state.armed = false;
        state.protectedSelection = false;
      },
      onMouseDown: (event): void => {
        if (event.detail <= 1) {
          // Read before the press's default action collapses the selection.
          state.armed = true;
          state.protectedSelection = selectionIntersects(event.currentTarget);
          return;
        }
        if (canStart(event)) event.preventDefault();
      },
      onMouseUp: (event): void => {
        // Record drag selection before the second press can collapse it.
        if (event.detail === 1 && selectionIntersects(event.currentTarget))
          state.protectedSelection = true;
      },
      onDoubleClick: (event): void => {
        const start = canStart(event);
        state.armed = false;
        state.protectedSelection = false;
        const edit = latestEdit.current;
        if (!start || !edit) return;
        const result = edit();
        if (result instanceof Promise) {
          state.pending = true;
          void result
            .catch(() => undefined)
            .finally(() => {
              state.pending = false;
            });
        }
      },
      'data-double-click-edit': 'true',
    };
  }, [editable]);
}

/** Shared edit-entry surface; hosts supply the same callback as the badge. */
export function MessageEditSurface({
  onEdit,
  children,
  variant = 'message',
  tone = 'default',
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, 'className'> & {
  readonly onEdit?: MessageEditHandler;
  /** Drafts use the shared neutral group; ordinary message bubbles retain their tone. */
  readonly variant?: 'message' | 'draft';
  readonly tone?: 'default' | 'info';
}): JSX.Element {
  const gesture = useDoubleClickToEdit(onEdit);
  if (variant === 'draft') {
    return (
      <Surface
        {...props}
        {...gesture}
        variant="group"
        padding="compact"
        className="relative"
      >
        <div className="text-s fg-secondary">{children}</div>
      </Surface>
    );
  }
  return (
    <div
      {...props}
      {...gesture}
      className={`relative ${tone === 'info' ? BUBBLE_INFO_SURFACE_CLASS : BUBBLE_SURFACE_CLASS} text-s fg-secondary`}
    >
      {children}
    </div>
  );
}

export interface MessageEditBadgeProps {
  readonly label: string;
  readonly onEdit: MessageEditHandler;
  readonly testId: string;
  readonly disabled?: boolean;
  readonly buttonRef?: Ref<HTMLButtonElement>;
}

/**
 * The pencil badge that opens a message's editor: the 28px secondary icon
 * Button, the same recipe as the bubble's Copy and Revert beside it.
 */
export function MessageEditBadge({
  label,
  onEdit,
  testId,
  disabled,
  buttonRef,
}: MessageEditBadgeProps): JSX.Element {
  const pending = useRef(false);
  return (
    <Button
      ref={buttonRef}
      variant="secondary"
      size="compact"
      iconOnly
      data-testid={testId}
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        if (event.detail > 1 || pending.current) return;
        const result = onEdit();
        if (result instanceof Promise) {
          pending.current = true;
          void result
            .catch(() => undefined)
            .finally(() => {
              pending.current = false;
            });
        }
      }}
    >
      <PencilIcon size="sm" aria-hidden="true" />
    </Button>
  );
}

export interface MessageEditNoticeProps {
  readonly message: string;
  readonly onDismiss: () => void;
}

/** Explains a rejected edit attempt; survives removal of the affected row. */
export function MessageEditNotice({
  message,
  onDismiss,
}: MessageEditNoticeProps): JSX.Element {
  return (
    <Notice
      errorSource="message-edit-notice"
      intent="destructive"
      data-testid="message-edit-notice"
      onDismiss={onDismiss}
      dismissTestId="message-edit-notice-dismiss"
    >
      {message}
    </Notice>
  );
}

/** Changed text from an editor whose message left the queue while open. */
export interface UnsavedMessageEdit {
  readonly id: string;
  readonly text: string;
}

export interface UnsavedMessageEditsProps {
  readonly drafts: readonly UnsavedMessageEdit[];
  readonly onDismiss: (draft: UnsavedMessageEdit) => void;
}

/** Keeps each interrupted edit's text readable until the user dismisses it. */
export function UnsavedMessageEdits({
  drafts,
  onDismiss,
}: UnsavedMessageEditsProps): JSX.Element {
  return (
    <>
      {drafts.map((draft) => (
        <MessageEditCard
          key={draft.id}
          dataTestId="queued-message-unsaved-edit"
          label="Unsaved edit"
          readOnly
          ariaLabel="Unsaved edit"
          inputTestId="queued-message-unsaved-edit-text"
          value={draft.text}
          actions={
            <Button
              size="md"
              variant="secondary"
              onClick={(): void => onDismiss(draft)}
              data-testid="queued-message-unsaved-edit-dismiss"
            >
              Dismiss
            </Button>
          }
        />
      ))}
    </>
  );
}
