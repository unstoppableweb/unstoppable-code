'use client';

import { useRef, useState, type FormEvent, type JSX } from 'react';
import type { ExplorerRetrievalPreview } from '@canopy/protocol/settings/organization-memory';
import { buildPreviewQuery } from '@canopy/protocol/settings/memory-preview-query';
import {
  Stack,
  Inline,
  Button,
  ChoiceList,
  ChoiceListRow,
  CopyButton,
  Disclosure,
  SearchField,
  TextInput,
  EmptyState,
  ErrorBanner,
  Notice,
  ValueRow,
  ValueRows,
  Heading,
} from '@canopy/ui-shared/components';
import { withPrivacyClass } from '../account/privacy-class';
import { useSettingsClient, useSettingsPrivacy } from '../host';
import { previewMemorySearch } from './api';
import { useMemoryErrorCopy } from './memory-error-copy';
import { FactCard } from './FactCard';
import type { SettingsFailure } from '../errors';
import { Surface } from '@canopy/ui-shared/components';

interface RetrievalPreviewProps {
  orgId: string;
}

// Also reused by the graph page's GraphRetrievalPanel.
export function gateSummary(preview: ExplorerRetrievalPreview): string {
  if (preview.gatePassed) {
    return `${preview.facts.length} fact${preview.facts.length === 1 ? '' : 's'} would be injected into the agent turn.`;
  }
  if (preview.candidateCount === 0) {
    return 'No candidates retrieved — nothing would be injected.';
  }
  return `${preview.candidateCount} candidate${preview.candidateCount === 1 ? '' : 's'} retrieved, but none cleared the calibration gate — nothing would be injected.`;
}

function formatScores(scores: number[]): string {
  if (scores.length === 0) return '—';
  return scores.map((score) => score.toFixed(4)).join(', ');
}

export function RetrievalPreview({
  orgId,
}: RetrievalPreviewProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useMemoryErrorCopy();
  const { blockClassName } = useSettingsPrivacy();
  const [query, setQuery] = useState('');
  const [usePrefix, setUsePrefix] = useState(false);
  const [repo, setRepo] = useState('');
  const [worktree, setWorktree] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const [preview, setPreview] = useState<ExplorerRetrievalPreview | null>(null);
  const requestSequence = useRef(0);

  const submit = async (event: FormEvent<HTMLElement>): Promise<void> => {
    event.preventDefault();
    const effectiveQuery = usePrefix
      ? buildPreviewQuery(query, { repo, worktree })
      : buildPreviewQuery(query);
    if (effectiveQuery.length === 0) return;
    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    setLoading(true);
    setError(null);
    try {
      const payload = await previewMemorySearch(client, orgId, effectiveQuery);
      if (requestSequence.current === sequence) {
        setPreview(payload);
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

  return (
    <Stack gap="group">
      <Surface
        as="form"
        gap="item"
        variant="card"
        padding="default"
        onSubmit={(event) => void submit(event)}
      >
        <p className="text-xs fg-secondary">
          Runs the exact turn-time retrieval pipeline — calibration gate,
          injection cap, and rendered block — and shows what the agent would
          see. Each preview counts against the shared search rate limit.
        </p>
        <Inline gap="inline" align="stretch">
          <SearchField
            value={query}
            onValueChange={setQuery}
            placeholder="Query text, as an agent turn would send it"
            aria-label="Preview query"
            className="min-w-0 flex-1"
          />
          <Button
            type="submit"
            size="compact"
            disabled={loading || query.trim().length === 0}
            className="self-center"
          >
            {loading ? 'Previewing…' : 'Preview'}
          </Button>
        </Inline>
        <Stack gap="inline">
          <ChoiceList aria-label="Context prefix">
            <ChoiceListRow
              selected={usePrefix}
              onClick={() => setUsePrefix((current) => !current)}
            >
              Add context prefix (real turns send “repo — worktree — query”)
            </ChoiceListRow>
          </ChoiceList>
          {usePrefix && (
            <div className="grid gap-2 sm:grid-cols-2">
              <TextInput
                density="settings"
                type="text"
                value={repo}
                onChange={(event) => setRepo(event.target.value)}
                placeholder="Repo label"
                aria-label="Context repo label"
              />
              <TextInput
                density="settings"
                type="text"
                value={worktree}
                onChange={(event) => setWorktree(event.target.value)}
                placeholder="Worktree name"
                aria-label="Context worktree name"
              />
            </div>
          )}
        </Stack>
      </Surface>

      <ErrorBanner
        errorSource="retrieval-preview"
        className=""
        error={error?.copy}
        details={error?.details}
      />

      {preview === null ? (
        !loading &&
        error === null && (
          <EmptyState
            titleWeight="normal"
            title="Submit a query to preview what would be injected."
          />
        )
      ) : (
        <Stack gap="group">
          <Notice
            intent={preview.gatePassed ? 'positive' : 'attention'}
            title={preview.gatePassed ? 'Gate passed' : 'Gate blocked'}
            data-testid="retrieval-preview-gate"
          >
            {gateSummary(preview)}
          </Notice>

          {preview.facts.length > 0 && (
            <div className="grid gap-3 lg:grid-cols-2">
              {preview.facts.map((fact) => (
                <FactCard key={fact.id} fact={fact} />
              ))}
            </div>
          )}
          {preview.truncated && (
            <p className="text-xs fg-secondary">
              The injection block was truncated by the fact or character cap.
            </p>
          )}

          {preview.renderedBlock !== null && (
            <Disclosure
              variant="box"
              label="Rendered injection block"
              dataTestId="retrieval-preview-rendered-block"
            >
              <div className="flex justify-end">
                <CopyButton
                  size="compact"
                  variant="secondary"
                  value={preview.renderedBlock}
                  ariaLabel="Copy rendered block"
                  title="Copy rendered block"
                  label="Copy"
                  dataTestId="retrieval-preview-copy-block"
                />
              </div>
              <Surface variant="inset" className="overflow-hidden">
                <pre
                  className={withPrivacyClass(
                    'overflow-x-auto whitespace-pre-wrap p-3 font-mono text-xs fg-primary',
                    blockClassName,
                  )}
                >
                  {preview.renderedBlock}
                </pre>
              </Surface>
            </Disclosure>
          )}

          <Surface gap="inline" as="section" variant="card" padding="default">
            <Heading level={3} variant="title">
              Diagnostics
            </Heading>
            <div>
              <ValueRows>
                <ValueRow
                  label="Lane counts"
                  mono
                  value={`vector ${preview.diagnostics.laneCounts.vector} · fts ${preview.diagnostics.laneCounts.fts} · trigram ${preview.diagnostics.laneCounts.trigram} · graph ${preview.diagnostics.laneCounts.graph}`}
                />
                <ValueRow
                  label="Reranker"
                  mono
                  value={
                    preview.diagnostics.rerankUsed
                      ? `used · top ${preview.diagnostics.topRerankScore?.toFixed(4) ?? '—'}`
                      : 'not used (cosine fallback)'
                  }
                />
                <ValueRow
                  label="Top cosine"
                  mono
                  value={preview.diagnostics.topCosineScore?.toFixed(4) ?? '—'}
                />
                <ValueRow
                  label="Latency"
                  mono
                  value={`${preview.diagnostics.latencyMs} ms`}
                />
                <ValueRow
                  label="Rerank scores"
                  mono
                  value={formatScores(preview.diagnostics.topScores.rerank)}
                />
                <ValueRow
                  label="Cosine scores"
                  mono
                  value={formatScores(preview.diagnostics.topScores.cosine)}
                />
                <ValueRow
                  label="RRF scores"
                  mono
                  value={formatScores(preview.diagnostics.topScores.rrf)}
                />
              </ValueRows>
            </div>
          </Surface>
        </Stack>
      )}
    </Stack>
  );
}
