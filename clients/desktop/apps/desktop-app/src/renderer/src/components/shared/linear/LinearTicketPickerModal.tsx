import { Badge } from '@canopy/ui-shared/primitives/Badge';
import { useEffect, useRef, useState, type JSX } from 'react';
import type { LinearTicketSearchResult } from '@canopy/desktop-shared/types';
import {
  DialogModal,
  KeyHintFooter,
  PickerSearchList,
  PickerOptionContent,
  PickerOptionDescription,
  PickerOptionLabel,
  PickerOptionTrailing,
  WordBoundaryTruncatedText,
} from '@canopy/ui-shared/components';
import { pickerKeyHints } from '@canopy/ui-shared/lib/shortcuts';

const SEARCH_DEBOUNCE_MS = 300;
const NO_TICKETS: readonly LinearTicketSearchResult[] = [];

// Stable across renders, so PickerSearchList's row list memoizes.
function ticketKey(ticket: LinearTicketSearchResult): string {
  return ticket.id;
}

function ticketLabel(ticket: LinearTicketSearchResult): string {
  return `${ticket.identifier} ${ticket.title}`;
}

function ticketTestId(ticket: LinearTicketSearchResult): string {
  return `linear-ticket-picker-result-${ticket.id}`;
}

export interface LinearTicketPickerModalProps {
  onSelect: (ticket: LinearTicketSearchResult) => void;
  onClose: () => void;
  /** Document of a popped-out composer; defaults to the main window. */
  ownerDocument?: Document;
}

/**
 * Cmd+P-style Linear ticket picker: a palette (`DialogModal` holding a
 * `PickerSearchList`) whose results come from a debounced
 * `window.api.searchLinearIssues`. Selecting a ticket (click or Enter) calls
 * `onSelect` and then `onClose`.
 */
export function LinearTicketPickerModal({
  onSelect,
  onClose,
  ownerDocument,
}: LinearTicketPickerModalProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<LinearTicketSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchSeqRef = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      searchSeqRef.current += 1;
      setSearching(false);
      setResults([]);
      setError(null);
      return;
    }

    const seq = ++searchSeqRef.current;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void (async (): Promise<void> => {
        try {
          const found = await window.api.searchLinearIssues(trimmed);
          if (searchSeqRef.current !== seq) return;
          setResults(found);
          setError(null);
        } catch {
          if (searchSeqRef.current !== seq) return;
          setResults([]);
          setError('Unable to search Linear right now.');
        } finally {
          if (searchSeqRef.current === seq) {
            setSearching(false);
          }
        }
      })();
    }, SEARCH_DEBOUNCE_MS);

    return (): void => {
      window.clearTimeout(timer);
    };
  }, [query]);

  function handleSelect(ticket: LinearTicketSearchResult): void {
    onSelect(ticket);
    onClose();
  }

  const trimmedQuery = query.trim();
  const showPrompt = trimmedQuery.length === 0;
  // The list's status line carries the prompt, the error and no results.
  const emptyLabel = showPrompt
    ? 'Search Linear tickets by id or title'
    : (error ?? 'No matching tickets');

  // DialogModal portals into `ownerDocument`'s body, so a transformed host,
  // such as the Home composer shell, cannot trap the overlay in its stacking
  // context under later page content.
  return (
    <DialogModal
      onClose={onClose}
      title="Attach Linear ticket"
      titleId="linear-ticket-picker-title"
      placement="top"
      maxWidth="2xl"
      inset="flush"
      headerBorder={false}
      scrollableBody={false}
      ownerDocument={ownerDocument}
      dataTestId="linear-ticket-picker"
    >
      <div className="flex min-h-0 flex-1 flex-col px-4 pb-2">
        <PickerSearchList
          items={showPrompt ? NO_TICKETS : results}
          getKey={ticketKey}
          getLabel={ticketLabel}
          query={query}
          onQueryChange={setQuery}
          loading={!showPrompt && searching}
          loadingLabel="Searching Linear"
          emptyLabel={emptyLabel}
          renderItem={(ticket) => {
            const description = ticket.description?.trim() ?? '';
            return (
              <>
                <PickerOptionContent>
                  <span className="flex min-w-0 items-center gap-2">
                    <Badge>
                      <span className="font-mono">{ticket.identifier}</span>
                    </Badge>
                    <PickerOptionLabel className="min-w-0 flex-1">
                      <WordBoundaryTruncatedText
                        text={ticket.title}
                        hoverTitle
                        data-testid="linear-ticket-picker-result-title"
                        className="block"
                      />
                    </PickerOptionLabel>
                  </span>
                  {description.length > 0 && (
                    <PickerOptionDescription>
                      {description}
                    </PickerOptionDescription>
                  )}
                </PickerOptionContent>
                <PickerOptionTrailing>
                  {ticket.priorityLabel}
                </PickerOptionTrailing>
              </>
            );
          }}
          onPick={handleSelect}
          onEscape={onClose}
          searchLabel="Search Linear tickets"
          placeholder="Search Linear by id or title…"
          listLabel="Linear tickets"
          listMaxHeight="lg"
          searchTestId="linear-ticket-picker-input"
          optionTestId={ticketTestId}
        />
      </div>
      <KeyHintFooter hints={pickerKeyHints('attach')} />
    </DialogModal>
  );
}
