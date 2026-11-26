'use client';

import { useCallback, useEffect, type JSX, type RefObject } from 'react';
import {
  ChevronTopMediumIcon as AppCatalogChevronTopMediumIcon,
  ChevronDownMediumIcon as AppCatalogChevronDownMediumIcon,
  CloseIcon as AppCatalogCloseIcon,
} from '../icons/AppIcons';
import { Button } from './Button';
import { SearchField } from './SearchField';

export interface SearchBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  currentIndex: number;
  totalCount: number;
  onNext: () => void;
  onPrevious: () => void;
  /** When provided, renders a close button (X) and Escape dismisses. */
  onClose?: () => void;
  autoFocus?: boolean;
  className?: string;
  /** Allows the parent to imperatively focus the input (e.g. on repeated Cmd+F). */
  inputRef?: RefObject<HTMLInputElement | null>;
  /** Accessible input name; defaults to the common search label. */
  label?: string;
  /** Input placeholder; defaults to `Search…`. */
  placeholder?: string;
}

export function SearchBar({
  query,
  onQueryChange,
  currentIndex,
  totalCount,
  onNext,
  onPrevious,
  onClose,
  autoFocus = false,
  className = '',
  inputRef,
  label = 'Search',
  placeholder = 'Search…',
}: SearchBarProps): JSX.Element {
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>): void => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onNext();
      } else if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        onPrevious();
      } else if (e.key === 'Escape' && onClose) {
        e.preventDefault();
        onClose();
      }
    },
    [onNext, onPrevious, onClose],
  );

  // Focus input on mount when autoFocus is true (handles lazy-rendered tray)
  useEffect(() => {
    if (autoFocus && inputRef?.current) {
      inputRef.current.focus();
    }
  }, [autoFocus, inputRef]);

  const hasQuery = query.length >= 2;
  const counterText = hasQuery
    ? `${totalCount === 0 ? 0 : currentIndex + 1} of ${totalCount}`
    : '';

  return (
    <div
      // Coarse pointers part the icon buttons by 16px, so their 44px touch
      // areas do not overlap.
      className={`flex items-center gap-1.5 pointer-coarse:gap-4 ${className}`}
      data-testid="content-search-bar"
    >
      {/* One live region, mounted from the start: a region added with its
          first text is often not announced. */}
      <span aria-live="polite" className="sr-only">
        {hasQuery ? counterText : ''}
      </span>
      {/* A find bar: the text field keeps its textbox role, and Escape
          belongs to the host (it closes the bar), not to clearing. */}
      <SearchField
        ref={inputRef}
        inputType="text"
        aria-label={label}
        data-search-bar
        value={query}
        onValueChange={onQueryChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoFocus={autoFocus}
        clearOnEscape={false}
        count={
          hasQuery ? <span aria-hidden="true">{counterText}</span> : undefined
        }
        className="flex-1"
      />
      <Button
        variant="ghost"
        size="compact"
        iconOnly
        onClick={onPrevious}
        disabled={totalCount === 0}
        aria-label="Previous match"
      >
        <AppCatalogChevronTopMediumIcon size="sm" />
      </Button>
      <Button
        variant="ghost"
        size="compact"
        iconOnly
        onClick={onNext}
        disabled={totalCount === 0}
        aria-label="Next match"
      >
        <AppCatalogChevronDownMediumIcon size="sm" />
      </Button>
      {onClose && (
        <Button
          variant="ghost"
          size="compact"
          iconOnly
          onClick={onClose}
          aria-label="Close search"
        >
          <AppCatalogCloseIcon size="sm" />
        </Button>
      )}
    </div>
  );
}
