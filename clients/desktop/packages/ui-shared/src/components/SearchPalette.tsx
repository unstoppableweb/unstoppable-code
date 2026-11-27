import type { JSX, ReactNode } from 'react';
import { SegmentedControl } from '../primitives/SegmentedControl';

/** One scope of a search palette: a tab along its bottom edge. */
export interface SearchPaletteScope<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly dataTestId?: string;
  /**
   * A scope this host cannot search: shown and focusable so its tooltip can
   * say why, but never selected.
   */
  readonly unavailable?: boolean;
  /** Says why an unavailable scope cannot be searched. */
  readonly tooltip?: string;
}

export interface SearchPaletteLayoutProps<T extends string> {
  /** The palette's `SearchField` (`size="lg"`), drawn above a hairline. */
  readonly field: ReactNode;
  /**
   * The results: `PickerSearchResults`, which scrolls in its own overlay scroll
   * area, or the empty state, with any notice above them.
   */
  readonly children: ReactNode;
  readonly scopes: readonly SearchPaletteScope<T>[];
  readonly scope: T;
  readonly onScopeChange: (next: T) => void;
  /** Accessible name of the scope tabs. */
  readonly scopeLabel: string;
  readonly resultsTestId?: string;
  readonly scopesTestId?: string;
}

/**
 * The search palette's body inside a content-header `DialogModal`: the field
 * on top, the results below it, and the scopes as full-width tabs along the
 * bottom. The results keep one height in every scope and state, so
 * switching scope or typing never moves the field or the tabs.
 */
export function SearchPaletteLayout<T extends string>({
  field,
  children,
  scopes,
  scope,
  onScopeChange,
  scopeLabel,
  resultsTestId,
  scopesTestId,
}: SearchPaletteLayoutProps<T>): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b">{field}</div>
      {/* 384px tall, but it gives way when the card is capped (a phone in
          landscape) so the scope tabs below stay on screen. */}
      <div
        className="flex h-96 min-h-0 shrink flex-col overscroll-contain"
        data-testid={resultsTestId}
      >
        {children}
      </div>
      <div className="shrink-0 border-t p-2">
        <SegmentedControl
          value={scope}
          options={scopes}
          onChange={onScopeChange}
          label={scopeLabel}
          semantics="tabs"
          width="fill"
          dataTestId={scopesTestId}
        />
      </div>
    </div>
  );
}

/**
 * Text at the end of a palette row: where an item lives (a branch, a chat),
 * or a command's shortcut. Pass it in the row's trailing part (the picker
 * row's `PickerOptionTrailing`), which sets the quiet type; this only
 * keeps a long name from pushing the title aside.
 */
export function SearchPaletteRowContext({
  children,
  'data-testid': testId,
}: {
  readonly children: ReactNode;
  readonly 'data-testid'?: string;
}): JSX.Element {
  return (
    <span data-testid={testId} className="min-w-0 max-w-60 truncate">
      {children}
    </span>
  );
}
