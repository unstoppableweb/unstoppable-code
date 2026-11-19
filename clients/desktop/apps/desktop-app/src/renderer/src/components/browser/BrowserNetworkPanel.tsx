import { Badge, type BadgeTone } from '@canopy/ui-shared/components/Badge';
import { useMemo, useState, type JSX } from 'react';
import type { BrowserNetworkEntry } from '@canopy/desktop-shared/types';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import { ChatIcon } from '@canopy/ui-shared/icons';
import { useBrowserStore } from '@/stores/browserStore';
import { stageBrowserNetworkEntry } from '@/lib/browserChatStaging';
import { Button, SegmentedControl, Tooltip } from '@canopy/ui-shared';
import {
  BrowserNetworkRequestRow,
  Surface,
  StatusLabel,
} from '@canopy/ui-shared/components';

interface BrowserNetworkPanelProps {
  browserId: string;
}

type NetworkFilter = 'all' | 'failed';

const EMPTY: BrowserNetworkEntry[] = [];

function statusLabel(entry: BrowserNetworkEntry): string {
  if (entry.failed) {
    return 'failed';
  }
  if (entry.status !== undefined) {
    return String(entry.status);
  }
  return '—';
}

function statusTone(entry: BrowserNetworkEntry): BadgeTone {
  if (entry.failed) {
    return 'danger';
  }
  if (entry.status !== undefined && entry.status >= 400) {
    return 'warning';
  }
  return 'neutral';
}

function durationLabel(entry: BrowserNetworkEntry): string {
  if (entry.durationMs === undefined) {
    return '';
  }
  return `${Math.round(entry.durationMs)} ms`;
}

function displayUrl(url: string): {
  primary: string;
  secondary: string | null;
} {
  if (!url) {
    return { primary: '(unknown URL)', secondary: null };
  }
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return {
      primary: path.length > 0 ? path : '/',
      secondary: parsed.origin,
    };
  } catch {
    return { primary: url, secondary: null };
  }
}

function detailsLabel(
  entry: BrowserNetworkEntry,
  origin: string | null,
): string {
  return [
    entry.errorText,
    origin,
    entry.resourceType,
    entry.mimeType,
    entry.fromCache ? 'cache' : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' • ');
}

export function BrowserNetworkPanel({
  browserId,
}: BrowserNetworkPanelProps): JSX.Element {
  const entries = useBrowserStore((s) => s.networkEntries[browserId] ?? EMPTY);
  const clearNetwork = useBrowserStore((s) => s.clearNetwork);
  const [filter, setFilter] = useState<NetworkFilter>('all');

  const visible = useMemo(() => {
    if (filter === 'failed') {
      return entries.filter((entry) => entry.failed === true);
    }
    return entries;
  }, [entries, filter]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Surface variant="section" boundary="bottom">
        <div className="flex items-center gap-1 px-2 py-1">
          <SegmentedControl<NetworkFilter>
            value={filter}
            onChange={setFilter}
            label="Filter"
            width="content"
            options={[
              { value: 'all', label: 'All' },
              { value: 'failed', label: 'Failed' },
            ]}
          />
          <div className="flex-1" />
          <Tooltip label="Clear network">
            <Button
              variant="ghost"
              size="compact"
              onClick={(): void => clearNetwork(browserId)}
              aria-label="Clear network"
            >
              Clear
            </Button>
          </Tooltip>
        </div>
      </Surface>
      <div className="min-h-0 flex-1 overflow-auto text-2xs">
        {visible.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs fg-secondary">
            No network activity
          </div>
        ) : (
          <ul className="font-mono">
            {visible.map((entry) => {
              const formattedUrl = displayUrl(entry.url);
              const details = detailsLabel(entry, formattedUrl.secondary);
              return (
                <BrowserNetworkRequestRow
                  key={entry.id}
                  failed={entry.failed === true}
                >
                  <div className="flex items-start gap-2">
                    <div className="grid min-w-0 flex-1 grid-cols-[3.25rem_4.5rem_minmax(0,1fr)_3.75rem] gap-x-2 gap-y-0.5">
                      <span className="uppercase fg-secondary">
                        {entry.method || 'GET'}
                      </span>
                      <Badge
                        tone={statusTone(entry)}
                        className="justify-self-start"
                      >
                        {statusLabel(entry)}
                      </Badge>
                      <span
                        className="min-w-0 truncate fg-primary"
                        title={entry.url || undefined}
                      >
                        {formattedUrl.primary}
                      </span>
                      <span className="text-right fg-secondary/70">
                        {durationLabel(entry)}
                      </span>
                      {details.length > 0 &&
                        (entry.failed ? (
                          <StatusLabel
                            className="col-start-3 col-span-2 min-w-0 break-words"
                            title={details}
                          >
                            {details}
                          </StatusLabel>
                        ) : (
                          <span
                            className="col-start-3 col-span-2 min-w-0 break-words fg-secondary/70"
                            title={details}
                          >
                            {details}
                          </span>
                        ))}
                    </div>
                    <Button
                      variant="ghost"
                      size="compact"
                      onClick={(): void => {
                        void stageBrowserNetworkEntry(entry);
                      }}
                    >
                      <ChatIcon size="sm" />
                      <span>{CHAT_UNIT_LABEL}</span>
                    </Button>
                  </div>
                </BrowserNetworkRequestRow>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
