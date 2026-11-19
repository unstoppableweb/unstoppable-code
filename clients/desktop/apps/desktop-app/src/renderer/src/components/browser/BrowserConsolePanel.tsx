import { useMemo, useState, type JSX } from 'react';
import type { BrowserConsoleEntry } from '@canopy/desktop-shared/types';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import { ChatIcon } from '@canopy/ui-shared/icons';
import { useBrowserStore } from '@/stores/browserStore';
import { stageBrowserConsoleEntry } from '@/lib/browserChatStaging';
import { Button, SegmentedControl, Tooltip } from '@canopy/ui-shared';
import { Surface } from '@canopy/ui-shared/components';

interface BrowserConsolePanelProps {
  browserId: string;
}

type ConsoleFilter = 'all' | 'errors';

const EMPTY: BrowserConsoleEntry[] = [];

function levelClass(level: BrowserConsoleEntry['level']): string {
  switch (level) {
    case 'error':
      return 'fg-destructive';
    case 'warning':
      return 'fg-warning';
    case 'debug':
      return 'fg-secondary';
    default:
      return 'fg-primary';
  }
}

function sourceLocation(entry: BrowserConsoleEntry): string | null {
  if (entry.url === undefined) {
    return null;
  }
  if (entry.lineNumber === undefined) {
    return entry.url;
  }
  return `${entry.url}:${entry.lineNumber}${
    entry.columnNumber !== undefined ? `:${entry.columnNumber}` : ''
  }`;
}

export function BrowserConsolePanel({
  browserId,
}: BrowserConsolePanelProps): JSX.Element {
  const entries = useBrowserStore((s) => s.consoleEntries[browserId] ?? EMPTY);
  const clearConsole = useBrowserStore((s) => s.clearConsole);
  const [filter, setFilter] = useState<ConsoleFilter>('all');

  const visible = useMemo(() => {
    if (filter === 'errors') {
      return entries.filter((entry) => entry.level === 'error');
    }
    return entries;
  }, [entries, filter]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Surface variant="section" boundary="bottom">
        <div className="flex items-center gap-1 px-2 py-1">
          <SegmentedControl<ConsoleFilter>
            value={filter}
            onChange={setFilter}
            label="Filter"
            width="content"
            options={[
              { value: 'all', label: 'All' },
              { value: 'errors', label: 'Errors' },
            ]}
          />
          <div className="flex-1" />
          <Tooltip label="Clear console">
            <Button
              variant="ghost"
              size="compact"
              onClick={(): void => clearConsole(browserId)}
              aria-label="Clear console"
            >
              Clear
            </Button>
          </Tooltip>
        </div>
      </Surface>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-2xs">
        {visible.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs fg-secondary">
            No console output
          </div>
        ) : (
          <ul>
            {visible.map((entry) => {
              const location = sourceLocation(entry);
              return (
                <Surface
                  key={entry.id}
                  as="li"
                  variant="section"
                  boundary="bottom"
                  padding="picker-section"
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <span
                        className={`pr-2 uppercase ${levelClass(entry.level)}`}
                      >
                        {entry.level}
                      </span>
                      <span className="whitespace-pre-wrap break-words">
                        {entry.text}
                      </span>
                      {location !== null && (
                        <span className="pl-2 fg-secondary/70">{location}</span>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="compact"
                      onClick={(): void => {
                        void stageBrowserConsoleEntry(entry);
                      }}
                    >
                      <ChatIcon size="sm" />
                      <span>{CHAT_UNIT_LABEL}</span>
                    </Button>
                  </div>
                </Surface>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
