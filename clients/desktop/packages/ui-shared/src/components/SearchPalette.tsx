import type { JSX, ReactNode } from 'react';
import { OverlayScrollArea } from './OverlayScrollArea';
import { SegmentedControl } from './SegmentedControl';

/** One scope of a search palette: a tab along its bottom edge. */
export interface SearchPaletteScope<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly dataTestId?: string;
}

export interface SearchPaletteLayoutProps<T extends string> {
  /** The palette's `SearchField` (`size="lg"`), drawn above a hairline. */
  readonly field: ReactNode;
  /** The results: a listbox, or the empty state. */
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
 * on top, the results in an overlay scroll area that follows the scrollbar
 * setting and never takes row width, and the scopes as full-width tabs along
 * the bottom. The results keep one height in every scope and state, so
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
      <OverlayScrollArea
        className="h-96 shrink-0"
        viewportClassName="h-full overscroll-contain"
        viewportProps={
          resultsTestId ? { 'data-testid': resultsTestId } : undefined
        }
      >
        {children}
      </OverlayScrollArea>
      <div className="shrink-0 border-t p-2">
        <SegmentedControl
          value={scope}
          options={scopes}
          onChange={onScopeChange}
          label={scopeLabel}
          semantics="tabs"
          shape="capsule"
          width="fill"
          dataTestId={scopesTestId}
        />
      </div>
    </div>
  );
}

/**
 * Text at the end of a palette row: where an item lives (a branch, a chat),
 * or a command's shortcut. Pass it as `ListRow`'s `trailing`, which sets the
 * quiet type; this only keeps a long name from pushing the title aside.
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
