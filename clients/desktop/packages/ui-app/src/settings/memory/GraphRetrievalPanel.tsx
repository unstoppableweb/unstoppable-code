'use client';

import { useRef, useState, type FormEvent, type JSX } from 'react';
import type { ExplorerRetrievalPreview } from '@canopy/protocol/settings/organization-memory';
import {
  Stack,
  Button,
  ErrorBanner,
  Notice,
  SearchField,
} from '@canopy/ui-shared/components';
import { useSettingsClient } from '../host';
import { previewMemorySearch } from './api';
import { useMemoryErrorCopy } from './memory-error-copy';
import { gateSummary } from './RetrievalPreview';
import { FactCard } from './FactCard';
import type { SettingsFailure } from '../errors';
import { Surface } from '@canopy/ui-shared/components';

interface GraphRetrievalPanelProps {
  orgId: string;
  preview: ExplorerRetrievalPreview | null;
  // Highlighted entities missing from the current node set (filtered out).
  hiddenEntityCount: number;
  onPreview: (preview: ExplorerRetrievalPreview | null) => void;
}

// Compact retrieval probe for the graph page: runs the same preview-search
// pipeline as the Facts tab's RetrievalPreview and reports the result to the
// parent, which projects it onto the graph as a highlight.
export function GraphRetrievalPanel({
  orgId,
  preview,
  hiddenEntityCount,
  onPreview,
}: GraphRetrievalPanelProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useMemoryErrorCopy();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const requestSequence = useRef(0);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length === 0) return;
    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    setLoading(true);
    setError(null);
    try {
      const payload = await previewMemorySearch(client, orgId, trimmed);
      if (requestSequence.current === sequence) {
        onPreview(payload);
      }
    } catch (caught) {
      if (requestSequence.current === sequence) {
        setError(errorCopy.actionFailure(caught, 'preview retrieval'));
      }
    } finally {
      if (requestSequence.current === sequence) {
        setLoading(false);
      }
    }
  };

  const onQueryChange = (value: string): void => {
    setQuery(value);
    // Clearing the input clears the graph highlight immediately, mirroring the
    // corpus search behavior; non-empty edits wait for an explicit submit.
    if (value.trim().length === 0) {
      // Supersede any in-flight preview so a late response cannot restore the
      // highlight the user just cleared.
      requestSequence.current += 1;
      setLoading(false);
      setError(null);
      onPreview(null);
    }
  };

  return (
    <Surface variant="card" padding="default">
      <form onSubmit={(event) => void submit(event)} className="flex gap-2">
        <SearchField
          value={query}
          onValueChange={onQueryChange}
          placeholder="Preview retrieval and highlight matched entities"
          aria-label="Retrieval highlight query"
          className="min-w-0 flex-1"
        />
        <Button
          type="submit"
          size="compact"
          disabled={loading || query.trim().length === 0}
          className="self-center"
        >
          {loading ? 'Previewing…' : 'Highlight'}
        </Button>
      </form>
      <p className="mt-2 text-xs fg-secondary">
        Runs the exact turn-time retrieval pipeline. Entities of injected facts
        get a solid ring, near-miss candidates a dashed ring. Each preview
        counts against the shared search rate limit.
      </p>

      <ErrorBanner
        errorSource="graph-retrieval-panel"
        className="mt-3"
        error={error?.copy}
        details={error?.details}
      />

      {preview !== null && (
        <Stack gap="item" className="mt-3">
          <Notice
            intent={preview.gatePassed ? 'positive' : 'attention'}
            title={preview.gatePassed ? 'Gate passed' : 'Gate blocked'}
            data-testid="graph-retrieval-gate"
            detail={
              <span className="font-mono">
                top rerank{' '}
                {preview.diagnostics.topRerankScore?.toFixed(4) ?? '—'} · top
                cosine {preview.diagnostics.topCosineScore?.toFixed(4) ?? '—'} ·{' '}
                {preview.candidates.length} near-miss candidate
                {preview.candidates.length === 1 ? '' : 's'} ·{' '}
                {preview.diagnostics.latencyMs} ms
              </span>
            }
          >
            {gateSummary(preview)}
          </Notice>
          {hiddenEntityCount > 0 && (
            <p className="text-xs fg-warning">
              {hiddenEntityCount} retrieved{' '}
              {hiddenEntityCount === 1 ? 'entity is' : 'entities are'} not
              visible with the current filters.
            </p>
          )}
          {preview.facts.length > 0 && (
            <div className="grid max-h-64 gap-3 overflow-y-auto lg:grid-cols-2">
              {preview.facts.map((fact) => (
                <FactCard key={fact.id} fact={fact} />
              ))}
            </div>
          )}
        </Stack>
      )}
    </Surface>
  );
}
