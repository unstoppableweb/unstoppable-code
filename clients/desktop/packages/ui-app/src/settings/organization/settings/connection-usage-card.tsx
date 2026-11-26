'use client';

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type {
  SharedConnectionUsageListResult,
  SharedConnectionUse,
} from '@canopy/protocol/canopy-core';
import {
  Badge,
  Button,
  EmptyStateRow,
  ErrorBanner,
  SettingsSelect,
} from '@canopy/ui-shared/components';
import {
  SETTINGS_CARD_ROW_CLASS,
  SettingsCard,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';
import { useSettingsClient } from '../../host';
import { useSettingsLoadFailure, type SettingsFailure } from '../../errors';

const USAGE_ERROR_SCOPE = 'settings.organization.connectors.usage';
const PAGE = 50;
/** The filter value for "no filter". */
const ALL = '';

type Filters = SharedConnectionUsageListResult['filters'];
type FilterKey = 'connectionId' | 'projectId' | 'personId';

const EMPTY_FILTERS: Filters = { connections: [], projects: [], people: [] };

/** Why a refused call was refused, as an admin reads it. */
const REASON_COPY: Readonly<Record<string, string>> = {
  toolLimited: 'Tool not allowed in this project',
  notOnProject: 'Not on the project',
  claimInvalid: 'No valid project sign-in',
  otherOrganization: 'Another organization’s project',
  projectArchived: 'Project archived',
  notInProject: 'Not shared with the project',
  writeNotAllowed: 'Write not allowed for this scheduled run',
};

function reasonCopy(reason: string | null): string {
  return reason === null ? 'Refused' : (REASON_COPY[reason] ?? 'Refused');
}

function whenCopy(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? at
    : date.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
}

/**
 * Who used the organization's connections (CAN-6249; spec FR-9): every call
 * the hosted proxy saw, allowed or refused, newest first, filtered by
 * connection, project and person, a page at a time. Owners and admins only,
 * as the Connectors page is. Arguments and results are never recorded.
 */
export function ConnectionUsageCard({
  organizationId,
}: {
  organizationId: string;
}): JSX.Element {
  const client = useSettingsClient();
  const loadFailure = useSettingsLoadFailure(USAGE_ERROR_SCOPE);
  const [filter, setFilter] = useState<Record<FilterKey, string>>({
    connectionId: ALL,
    projectId: ALL,
    personId: ALL,
  });
  const [uses, setUses] = useState<readonly SharedConnectionUse[] | null>(null);
  const [options, setOptions] = useState<Filters>(EMPTY_FILTERS);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const [attempt, setAttempt] = useState(0);
  // A page read for older filters or an older attempt never lands.
  const generation = useRef(0);

  const read = useCallback(
    async (cursor: string | null): Promise<void> => {
      const current = ++generation.current;
      setLoading(true);
      // A first page (new filters, or a retry) starts over: the cursor of
      // the old list never pages the new one, even when this read fails.
      if (cursor === null) setNextCursor(null);
      try {
        const result = await client.read(
          'organization.settings.connectionUsage',
          {
            organizationId,
            limit: PAGE,
            ...(filter.connectionId === ALL
              ? {}
              : { connectionId: filter.connectionId }),
            ...(filter.projectId === ALL
              ? {}
              : { projectId: filter.projectId }),
            ...(filter.personId === ALL ? {} : { personId: filter.personId }),
            ...(cursor === null ? {} : { cursor }),
          },
        );
        if (current !== generation.current) return;
        setUses((previous) =>
          cursor === null || previous === null
            ? result.uses
            : [...previous, ...result.uses],
        );
        setOptions(result.filters);
        setNextCursor(result.nextCursor);
        setError(null);
      } catch (failure) {
        if (current !== generation.current) return;
        setError(loadFailure(failure));
      } finally {
        if (current === generation.current) setLoading(false);
      }
    },
    [client, organizationId, filter, loadFailure],
  );

  useEffect(() => {
    void read(null);
    return (): void => {
      generation.current += 1;
    };
  }, [read, attempt]);

  const choose =
    (key: FilterKey) =>
    (value: string): void => {
      setUses(null);
      setFilter((previous) => ({ ...previous, [key]: value }));
    };

  const filtered =
    filter.connectionId !== ALL ||
    filter.projectId !== ALL ||
    filter.personId !== ALL;

  return (
    <SettingsCard
      title="Usage"
      subtitle="Every call to the organization’s connections in the last 180 days, allowed or refused. What was sent and returned isn’t kept."
      testId="organization-connectors-usage"
    >
      <div
        className={`${SETTINGS_CARD_ROW_CLASS} flex-wrap justify-start`}
        data-testid="organization-connectors-usage-filters"
      >
        <SettingsSelect
          aria-label="Connection"
          width="field"
          value={filter.connectionId}
          onValueChange={choose('connectionId')}
          options={[
            { value: ALL, label: 'All connections' },
            ...options.connections.map((option) => ({
              value: option.id,
              label: option.name,
            })),
          ]}
          replayPrivacy={{ maskClassName: REPLAY_MASK_CLASS }}
          data-testid="organization-connectors-usage-connection"
        />
        <SettingsSelect
          aria-label="Project"
          width="field"
          value={filter.projectId}
          onValueChange={choose('projectId')}
          options={[
            { value: ALL, label: 'All projects' },
            ...options.projects.map((option) => ({
              value: option.id,
              label: option.name,
            })),
          ]}
          replayPrivacy={{ maskClassName: REPLAY_MASK_CLASS }}
          data-testid="organization-connectors-usage-project"
        />
        <SettingsSelect
          aria-label="Person"
          width="field"
          value={filter.personId}
          onValueChange={choose('personId')}
          options={[
            { value: ALL, label: 'Everyone' },
            ...options.people.map((option) => ({
              value: option.id,
              label: option.name,
            })),
          ]}
          replayPrivacy={{ blockClassName: REPLAY_BLOCK_CLASS }}
          data-testid="organization-connectors-usage-person"
        />
      </div>
      <ErrorBanner
        errorSource="organization-connectors-usage-load"
        testId="organization-connectors-usage-error"
        className=""
        error={error?.copy}
        details={error?.details}
        onRetry={() => {
          setError(null);
          setUses(null);
          setAttempt((current) => current + 1);
        }}
      />
      {uses !== null && uses.length === 0 && (
        <div className={SETTINGS_CARD_ROW_CLASS}>
          <EmptyStateRow
            title={
              filtered
                ? 'Nothing matches these filters'
                : 'The organization’s connections haven’t been used yet'
            }
            testId="organization-connectors-usage-empty"
          />
          {filtered && (
            <Button
              size="compact"
              variant="secondary"
              onClick={() => {
                setUses(null);
                setFilter({ connectionId: ALL, projectId: ALL, personId: ALL });
              }}
              data-testid="organization-connectors-usage-clear"
            >
              Clear filters
            </Button>
          )}
        </div>
      )}
      {uses?.map((use) => (
        <UsageRow key={use.id} use={use} />
      ))}
      {nextCursor !== null && (
        <div className={`${SETTINGS_CARD_ROW_CLASS} justify-center`}>
          <Button
            size="compact"
            variant="secondary"
            disabled={loading}
            aria-busy={loading}
            onClick={() => void read(nextCursor)}
            data-testid="organization-connectors-usage-more"
          >
            Load more
          </Button>
        </div>
      )}
    </SettingsCard>
  );
}

function UsageRow({ use }: { use: SharedConnectionUse }): JSX.Element {
  const action = use.tool ?? use.method;
  return (
    <div
      className={SETTINGS_CARD_ROW_CLASS}
      data-testid={`organization-connectors-usage-row-${use.id}`}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-s font-medium fg-primary">
            <span className={REPLAY_MASK_CLASS}>{use.connection.name}</span>
            {' · '}
            <span className={REPLAY_BLOCK_CLASS}>{action}</span>
          </p>
          {use.outcome === 'refused' && (
            <Badge
              tone="danger"
              data-testid={`organization-connectors-usage-refused-${use.id}`}
            >
              {reasonCopy(use.reason)}
            </Badge>
          )}
        </div>
        <p className="text-xs text-pretty fg-secondary">
          {whenCopy(use.at)}
          {' · '}
          {use.person === null ? (
            'Deleted account'
          ) : (
            <span className={REPLAY_BLOCK_CLASS}>{use.person.name}</span>
          )}
          {use.project !== null && (
            <>
              {' · '}
              <span className={REPLAY_MASK_CLASS}>{use.project.name}</span>
            </>
          )}
          {use.runKind === 'scheduled' && ' · Scheduled run'}
          {use.chatId !== null && (
            <>
              {' · Chat '}
              {/* The first part of the chat's id: enough to tell chats
                  apart without wrapping the row. */}
              <span className={REPLAY_BLOCK_CLASS} title={use.chatId}>
                {use.chatId.length > 8
                  ? `${use.chatId.slice(0, 8)}…`
                  : use.chatId}
              </span>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
