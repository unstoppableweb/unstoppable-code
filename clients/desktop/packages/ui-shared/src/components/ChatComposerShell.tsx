'use client';

import type { HTMLAttributes, JSX, Ref } from 'react';
import { ComposerTrayBoundary, ComposerTraySlot } from './ComposerTray';
import {
  ONE_LINE_COMPOSER_BOX_STYLE,
  ONE_LINE_COMPOSER_CLASS_NAMES,
} from './composerLayoutClasses';

/**
 * The composer box: the raised tertiary surface, 20px radius, and soft shadow
 * the desktop composer has always drawn. Web used to draw its own bordered
 * 12px box with a focus ring; both hosts now wrap their composer in this one
 * shell so the box reads identically (desktop is the visual source of truth).
 *
 * A surface that already sits on tertiary (the floating App Advisor window)
 * raises it further through `--bg-composer`.
 */
export const CHAT_COMPOSER_SHELL_CLASS =
  'relative rounded-2xl bg-[var(--bg-composer,var(--bg-tertiary))] shadow-lg transition-colors';

/**
 * The same box while a file drag hovers it: an accent wash plus a ring, on
 * the same radius, so the drop target reads as the composer itself.
 */
export const CHAT_COMPOSER_SHELL_DRAG_CLASS =
  'relative rounded-2xl bg-accent-subtle shadow-lg ring-2 ring-line-accent transition-colors';

export interface ChatComposerShellProps extends HTMLAttributes<HTMLDivElement> {
  readonly layout?: 'one-line' | 'full' | 'question' | 'plan-approval';
  readonly shellRef?: Ref<HTMLDivElement>;
  readonly tapTarget?: 'compact' | 'touch';
  /** A file drag is hovering the composer; swaps the surface for the drop wash. */
  readonly dragActive?: boolean;
  /** Test hook for the outer box (the one element that spans the composer). */
  readonly dataTestId?: string;
}

export function ChatComposerShell({
  dragActive = false,
  dataTestId,
  layout,
  shellRef,
  tapTarget = 'compact',
  className,
  style,
  children,
  ...rest
}: ChatComposerShellProps): JSX.Element {
  const shell = dragActive
    ? CHAT_COMPOSER_SHELL_DRAG_CLASS
    : CHAT_COMPOSER_SHELL_CLASS;
  const layoutClass =
    layout === 'one-line'
      ? ONE_LINE_COMPOSER_CLASS_NAMES.box
      : layout === 'full'
        ? ONE_LINE_COMPOSER_CLASS_NAMES.expandedBox
        : '';
  const touchClass =
    tapTarget === 'touch'
      ? ' [--composer-control-size:2.75rem] lg:[--composer-control-size:2rem]'
      : '';
  return (
    <>
      {/* A composer tray (the compact queue) sits right on the box, below
          every notice above it, and tucks under its top edge. */}
      <ComposerTraySlot />
      <div
        ref={shellRef}
        data-testid={dataTestId}
        data-composer-layout={layout}
        className={`${className ? `${shell} ${className}` : shell}${layoutClass ? ` ${layoutClass}` : ''}${touchClass}`}
        style={
          layout === 'one-line'
            ? {
                ...ONE_LINE_COMPOSER_BOX_STYLE,
                ...(tapTarget === 'touch'
                  ? {
                      borderRadius:
                        'calc(var(--composer-control-size) / 2 + 0.5rem)',
                    }
                  : {}),
                ...style,
              }
            : style
        }
        {...rest}
      >
        <ComposerTrayBoundary>{children}</ComposerTrayBoundary>
      </div>
    </>
  );
}
