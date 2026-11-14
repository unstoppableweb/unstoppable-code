'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type JSX,
} from 'react';
import {
  EXPLORER_EVIDENCE_TYPES,
  EXPLORER_LIVENESS_FILTERS,
  type ExplorerFact,
  type ExplorerFactDetail,
  type ExplorerRankedFact,
} from '@canopy/protocol/settings/organization-memory';
import {
  Stack,
  BusyLabel,
  Button,
  buttonClassName,
  DelayedLoadingPlaceholder,
  EmptyState,
  ErrorBanner,
  SearchField,
  SegmentedControl,
  SettingsSelect,
  type SettingsSelectOption,
  Sheet,
  TextInput,
} from '@canopy/ui-shared/components';
import { SettingsLink, useSettingsClient } from '../host';
import { fetchMemoryFact, fetchMemoryFacts } from './api';
import {
  INITIAL_FACT_CORPUS_FILTERS,
  isDefaultFilters,
  isEmptyCorpus,
  type EvidenceFilter,
  type FactCorpusMode,
  type LivenessFilter,
} from './fact-corpus-filters';
import { FactCard } from './FactCard';
import { FactCardsSkeleton } from './FactCardsSkeleton';
import { FactDetailDrawer } from './FactDetailDrawer';
import { useMemoryErrorCopy } from './memory-error-copy';
import { RetrievalPreview } from './RetrievalPreview';
import { Surface } from '@canopy/ui-shared/components';

interface FactCorpusViewProps {
  orgId: string;
  initialFacts: Array<ExplorerFact | ExplorerRankedFact>;
  initialNextCursor: string | null;
  /**
   * Where a viewer chooses who contributes to memory, when their role can
   * edit the organization's Policies; `null` otherwise.
   */
  policiesHref: string | null;
}

const EVIDENCE_TYPE_OPTIONS: readonly SettingsSelectOption<EvidenceFilter>[] = [
  { value: '', label: 'All evidence' },
  { value: 'OBSERVED', label: 'Observed' },
  { value: 'ASSERTED', label: 'Asserted' },
  { value: 'INFERRED', label: 'Inferred' },
];

const LIVENESS_OPTIONS: readonly SettingsSelectOption<LivenessFilter>[] = [
  { value: 'live', label: 'Live' },
  { value: 'superseded', label: 'Superseded' },
  { value: 'all', label: 'All' },
];

function isEvidenceFilter(value: string): value is EvidenceFilter {
  return value === '' || EXPLORER_EVIDENCE_TYPES.some((type) => type === value);
}

function isLivenessFilter(value: string): value is LivenessFilter {
  return EXPLORER_LIVENESS_FILTERS.some((liveness) => liveness === value);
}

/** Optional filter values; an empty input sends no filter. */
function optionalFilter(value: string): string | undefined {
  return value.length > 0 ? value : undefined;
}

const MEMORY_EMPTY_SUBTITLE =
  "Facts appear here as agents learn from chats in this organization's projects.";

/** The read a Retry runs again: the list, its next page, or one fact. */
type FailedRead =
  | { readonly kind: 'list' }
  | { readonly kind: 'more' }
  | { readonly kind: 'fact'; readonly factId: string };

interface FactCorpusError {
  readonly copy: string;
  readonly details?: string;
  readonly retry: FailedRead;
}

const MODES: ReadonlyArray<{
  key: FactCorpusMode;
  label: string;
}> = [
  { key: 'search', label: 'Search corpus' },
  { key: 'preview', label: 'Preview retrieval' },
];

export function FactCorpusView({
  orgId,
  initialFacts,
  initialNextCursor,
  policiesHref,
}: FactCorpusViewProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useMemoryErrorCopy();
  const initial = INITIAL_FACT_CORPUS_FILTERS;
  const [mode, setMode] = useState<FactCorpusMode>(initial.mode);
  const [facts, setFacts] =
    useState<Array<ExplorerFact | ExplorerRankedFact>>(initialFacts);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  // Page data reads the first page without filters.
  const [readWithDefaultFilters, setReadWithDefaultFilters] = useState(true);
  const [query, setQuery] = useState(initial.query);
  // Corpus search hits the paid embed + rerank pipeline, so it only fires on
  // explicit submit (Enter / Search button), never per keystroke.
  const [submittedQuery, setSubmittedQuery] = useState(initial.submittedQuery);
  const [submissionVersion, setSubmissionVersion] = useState(0);
  const [evidenceType, setEvidenceType] = useState<EvidenceFilter>(
    initial.evidenceType,
  );
  const [liveness, setLiveness] = useState<LivenessFilter>(initial.liveness);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FactCorpusError | null>(null);
  const [detail, setDetail] = useState<ExplorerFactDetail | null>(null);
  // No live facts can still leave superseded ones, reachable through the
  // filters; the empty state waits until a check for this organization finds
  // none.
  const [supersededCheck, setSupersededCheck] = useState<{
    readonly orgId: string;
    readonly found: boolean;
  } | null>(null);
  const requestSequence = useRef(0);
  const isInitialRender = useRef(true);

  useEffect(() => {
    if (isInitialRender.current) {
      isInitialRender.current = false;
      return;
    }
    // Claim a fresh sequence number so any in-flight fetch (earlier filter
    // change or loadMore) is superseded the moment this fetch starts.
    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    const requestDefaults = isDefaultFilters({
      ...INITIAL_FACT_CORPUS_FILTERS,
      submittedQuery,
      evidenceType,
      liveness,
      from,
      to,
    });
    const load = async (): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const payload = await fetchMemoryFacts(client, {
          organizationId: orgId,
          q: optionalFilter(submittedQuery),
          evidenceType: evidenceType === '' ? undefined : evidenceType,
          liveness,
          from: optionalFilter(from),
          to: optionalFilter(to),
        });
        if (requestSequence.current === sequence) {
          setFacts(payload.facts);
          setNextCursor(payload.nextCursor);
          setReadWithDefaultFilters(requestDefaults);
        }
      } catch (caught) {
        if (requestSequence.current === sequence) {
          setError({
            ...errorCopy.loadFailure(caught),
            retry: { kind: 'list' },
          });
        }
      } finally {
        if (requestSequence.current === sequence) {
          setLoading(false);
        }
      }
    };
    void load();
  }, [
    client,
    errorCopy,
    evidenceType,
    from,
    liveness,
    orgId,
    submittedQuery,
    submissionVersion,
    to,
  ]);

  const submitSearch = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setSubmittedQuery(query.trim());
    setSubmissionVersion((current) => current + 1);
  };

  const onQueryChange = (value: string): void => {
    setQuery(value);
    // Clearing the input immediately restores the cheap paged list without
    // requiring another submit; non-empty edits still wait for one.
    if (value.trim().length === 0) {
      setSubmittedQuery('');
    }
  };

  const openFact = useCallback(
    async (factId: string): Promise<void> => {
      setError(null);
      try {
        setDetail(await fetchMemoryFact(client, orgId, factId));
      } catch (caught) {
        setError({
          ...errorCopy.loadFailure(caught),
          retry: { kind: 'fact', factId },
        });
      }
    },
    [client, errorCopy, orgId],
  );

  // Stable reference so memoized FactCards do not re-render per fetch.
  const selectFact = useCallback(
    (factId: string): void => {
      void openFact(factId);
    },
    [openFact],
  );

  const loadMore = async (): Promise<void> => {
    if (nextCursor === null) return;
    // Claim a fresh sequence number (not just read the current one): a filter
    // change claims a newer number for its fetch, so this page request is
    // superseded in BOTH directions — it can neither append onto fresher
    // filter results nor be clobbered silently.
    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    setLoading(true);
    setError(null);
    try {
      const payload = await fetchMemoryFacts(
        client,
        {
          organizationId: orgId,
          cursor: nextCursor,
          liveness,
          evidenceType: evidenceType === '' ? undefined : evidenceType,
          from: optionalFilter(from),
          to: optionalFilter(to),
        },
        {
          unexpected: 'Unexpected fact response',
          fallback: 'Unable to load more facts',
        },
      );
      if (requestSequence.current !== sequence) return;
      setFacts((current) => [...current, ...payload.facts]);
      setNextCursor(payload.nextCursor);
    } catch (caught) {
      if (requestSequence.current !== sequence) return;
      setError({ ...errorCopy.loadFailure(caught), retry: { kind: 'more' } });
    } finally {
      if (requestSequence.current === sequence) {
        setLoading(false);
      }
    }
  };

  // Retry clears the error and runs the failed read again; a list read
  // clears it itself and shows the list placeholder while it runs.
  const retry = (failed: FailedRead): void => {
    if (failed.kind === 'list') {
      setSubmissionVersion((current) => current + 1);
      return;
    }
    setError(null);
    if (failed.kind === 'more') void loadMore();
    else void openFact(failed.factId);
  };

  const onEvidenceTypeChange = (value: string): void => {
    if (isEvidenceFilter(value)) setEvidenceType(value);
  };

  const onLivenessChange = (value: string): void => {
    if (isLivenessFilter(value)) setLiveness(value);
  };

  // An organization with no memory yet has nothing to search or filter, so
  // the view explains where facts come from instead of offering controls.
  const emptyLiveCorpus =
    !loading &&
    error === null &&
    isEmptyCorpus(
      { mode, query, submittedQuery, evidenceType, liveness, from, to },
      { facts, nextCursor, readWithDefaultFilters },
    );
  const supersededFound =
    supersededCheck?.orgId === orgId ? supersededCheck.found : null;
  useEffect(() => {
    if (!emptyLiveCorpus || supersededFound !== null) return;
    let cancelled = false;
    void fetchMemoryFacts(client, {
      organizationId: orgId,
      liveness: 'all',
      limit: 1,
    })
      .then((payload): void => {
        if (!cancelled)
          setSupersededCheck({ orgId, found: payload.facts.length > 0 });
      })
      .catch((): void => {
        // Unknown counts as found: the filters stay, so nothing is hidden.
        if (!cancelled) setSupersededCheck({ orgId, found: true });
      });
    return (): void => {
      cancelled = true;
    };
  }, [client, emptyLiveCorpus, orgId, supersededFound]);
  if (emptyLiveCorpus && supersededFound === null) {
    return (
      <DelayedLoadingPlaceholder>
        <FactCardsSkeleton layout="grid" />
      </DelayedLoadingPlaceholder>
    );
  }
  const emptyCorpus = emptyLiveCorpus && supersededFound === false;
  if (emptyCorpus) {
    return (
      <EmptyState
        testId="memory-facts-empty"
        title="No organization memory yet"
        subtitle={
          policiesHref === null
            ? MEMORY_EMPTY_SUBTITLE
            : `${MEMORY_EMPTY_SUBTITLE} Choose who contributes in Policies.`
        }
        action={
          policiesHref === null ? undefined : (
            <SettingsLink
              href={policiesHref}
              className={buttonClassName({
                variant: 'secondary',
                size: 'compact',
              })}
              data-testid="memory-facts-empty-policies"
            >
              Open Policies
            </SettingsLink>
          )
        }
      />
    );
  }

  return (
    <Stack gap="group">
      <SegmentedControl
        label="Facts tab mode"
        semantics="toggle"
        width="content"
        value={mode}
        onChange={setMode}
        options={MODES.map((item) => ({ value: item.key, label: item.label }))}
      />

      {mode === 'preview' ? (
        <RetrievalPreview orgId={orgId} />
      ) : (
        <>
          <Surface gap="item" variant="card" padding="default">
            <form onSubmit={submitSearch} className="flex gap-2">
              <SearchField
                value={query}
                onValueChange={onQueryChange}
                placeholder="Search organization memory"
                aria-label="Search organization memory"
                className="min-w-0 flex-1"
              />
              <Button
                type="submit"
                size="compact"
                disabled={loading || query.trim().length === 0}
                className="self-center"
              >
                Search
              </Button>
            </form>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <SettingsSelect
                value={evidenceType}
                onValueChange={onEvidenceTypeChange}
                width="fill"
                aria-label="Evidence type"
                options={EVIDENCE_TYPE_OPTIONS}
              />
              <SettingsSelect
                value={liveness}
                onValueChange={onLivenessChange}
                width="fill"
                aria-label="Fact liveness"
                options={LIVENESS_OPTIONS}
              />
              <TextInput
                density="settings"
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                aria-label="Created from"
              />
              <TextInput
                density="settings"
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                aria-label="Created to"
              />
            </div>
          </Surface>

          {error !== null && (
            <ErrorBanner
              errorSource="fact-corpus"
              className=""
              error={error.copy}
              details={error.details}
              onRetry={() => retry(error.retry)}
            />
          )}
          {loading && facts.length === 0 ? (
            <DelayedLoadingPlaceholder>
              <FactCardsSkeleton layout="grid" />
            </DelayedLoadingPlaceholder>
          ) : facts.length === 0 ? (
            <Surface variant="dashed">
              <div className="py-16 text-center">
                <p className="text-s fg-secondary">No matching memory facts.</p>
              </div>
            </Surface>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {facts.map((fact) => (
                <FactCard key={fact.id} fact={fact} onSelect={selectFact} />
              ))}
            </div>
          )}
          {nextCursor !== null && submittedQuery.length === 0 && (
            <Button
              className="self-start"
              size="compact"
              disabled={loading}
              aria-busy={loading}
              onClick={() => void loadMore()}
            >
              <BusyLabel busy={loading}>Load more</BusyLabel>
            </Button>
          )}
          <Sheet
            side="right"
            open={detail !== null}
            onClose={() => setDetail(null)}
            ariaLabel="Memory fact detail"
            widthClassName="w-full max-w-xl"
          >
            {detail !== null && (
              <FactDetailDrawer
                orgId={orgId}
                detail={detail}
                onClose={() => setDetail(null)}
              />
            )}
          </Sheet>
        </>
      )}
    </Stack>
  );
}
