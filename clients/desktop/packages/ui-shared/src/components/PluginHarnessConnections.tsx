import type { ComponentType, JSX, ReactNode, SVGProps } from 'react';
import type { AgentExecutionHarness } from '@canopy/protocol/models';
import { Button } from './Button';
import { ComponentSection } from './ComponentSection';
import { CheckIcon, GitHubIcon, RefreshIcon } from '../icons/AppIcons';
import { ClaudeLogo } from '../icons/ClaudeLogo';
import { CodexLogo } from '../icons/CodexLogo';
import { CursorLogo } from '../icons/CursorLogo';
import { OpenCodeLogo } from '../icons/OpenCodeLogo';
import { AntigravityLogo } from '../icons/AntigravityLogo';
import { DataTable } from './DataTable';
import { Tooltip } from './Tooltip';
import { useItemStateMarks } from './ItemStateMark';
import { DetailFactError } from './CapabilityDetailLayout';

/** Plugin harness names and marks, in display order. */
const HARNESSES: Readonly<
  Record<
    AgentExecutionHarness,
    { name: string; Logo: ComponentType<SVGProps<SVGSVGElement>> }
  >
> = {
  claude: { name: 'Claude', Logo: ClaudeLogo },
  codex: { name: 'Codex', Logo: CodexLogo },
  cursor: { name: 'Cursor', Logo: CursorLogo },
  // Copilot has no brand mark here; match ModelProviderIcon's GitHub mark.
  copilot: { name: 'Copilot', Logo: GitHubIcon },
  opencode: { name: 'OpenCode', Logo: OpenCodeLogo },
  antigravity: { name: 'Antigravity', Logo: AntigravityLogo },
};

function harnessLogo(
  id: string,
): ComponentType<SVGProps<SVGSVGElement>> | undefined {
  return Object.entries(HARNESSES).find(([key]) => key === id)?.[1].Logo;
}

/** Small firm logos, one per harness, each naming itself on hover. */
export function HarnessLogoList({
  harnesses,
}: {
  harnesses: readonly string[];
}): JSX.Element {
  return (
    <span
      className="flex h-5 items-center gap-1.5"
      data-testid="plugin-detail-harness-logos"
    >
      {Object.entries(HARNESSES)
        .filter(([id]) => harnesses.includes(id))
        .map(([id, { name, Logo }]) => (
          <Tooltip key={id} label={name}>
            <span aria-label={name} role="img" className="inline-flex">
              <Logo
                width={14}
                height={14}
                aria-hidden="true"
                className="shrink-0 fg-secondary"
              />
            </span>
          </Tooltip>
        ))}
    </span>
  );
}

export interface PluginHarnessConnectionRow {
  id: string;
  name: string;
  /**
   * `Unknown until added`: a plugin not added yet whose files nothing has
   * read, so only its marketplace's own harness is known.
   */
  installation:
    | 'Installed'
    | 'Not installed'
    | 'Not supported'
    | 'Unknown until added'
    /** That unknown, while a light preview of the plugin's files is read. */
    | 'Checking…';
}

/**
 * Another copy of the same plugin that serves a harness (New Customize):
 * "via Slack (slackapi) from Claude official", the name opening that copy.
 */
export interface PluginHarnessViaCopy {
  readonly name: string;
  /** Where the copy comes from: its marketplace or catalog. */
  readonly source?: string;
  readonly onOpen?: () => void;
}

/** A harness whose MCP server comes from another copy of the plugin. */
export interface PluginMcpServerVia {
  /** The harness id, as on the Works with rows. */
  readonly harness: string;
  readonly via: PluginHarnessViaCopy;
  readonly installed: boolean;
}

/** One line: "via <copy> from <source>", truncated to the space it has. */
export function PluginHarnessVia({
  via,
  testId,
}: {
  via: PluginHarnessViaCopy;
  testId: string;
}): JSX.Element {
  const full = `via ${via.name}${via.source ? ` from ${via.source}` : ''}`;
  return (
    <span
      className="min-w-0 truncate text-left font-normal fg-tertiary"
      title={full}
      data-testid={testId}
    >
      via{' '}
      {via.onOpen ? (
        <Button variant="link" onClick={via.onOpen}>
          {via.name}
        </Button>
      ) : (
        via.name
      )}
      {via.source ? ` from ${via.source}` : ''}
    </span>
  );
}

/** Availability is per harness; the shared account connection is shown once. */
interface PluginHarnessConnectionsProps {
  rows: readonly (PluginHarnessConnectionRow & {
    /** A copy that does support this harness, shown beside Not supported. */
    readonly alternative?: {
      label: string;
      onOpen: () => void;
      /** A rare action: Reinstall with an icon, its full label as the tooltip. */
      iconOnly?: boolean;
    };
    /** Plain guidance when this harness has no install of its own. */
    readonly note?: string;
    /** Another copy that serves this harness, named on the row. */
    readonly via?: PluginHarnessViaCopy;
    /**
     * A harness-only setting on its row (New Customize), such as the Codex
     * compatibility toggle.
     */
    readonly control?: ReactNode;
    /** That setting's failure, said on its row instead of a page banner. */
    readonly error?: string;
  })[];
  /** The table's accessible caption; it names the kind of item. */
  caption?: string;
}

/** One Works with row, with its optional actions, note and setting. */
export type PluginWorksWithRow = PluginHarnessConnectionsProps['rows'][number];

export function PluginHarnessConnections({
  rows,
  caption = 'Plugin installation by harness',
}: PluginHarnessConnectionsProps): JSX.Element | null {
  // New Customize: the check carries the color; "Installed" stays plain.
  const neutralText = useItemStateMarks();
  if (rows.length === 0) return null;
  return (
    <DataTable
      testId="plugin-harness-connections"
      caption={caption}
      layout="fixed"
      rows={rows}
      rowKey={(row) => row.id}
      rowAttributes={(row) => ({ 'data-testid': `plugin-harness-${row.id}` })}
      columns={[
        {
          key: 'harness',
          header: 'Harness',
          width: '50%',
          rowHeader: true,
          overflow: 'wrap',
          render: (row) => {
            const Logo = harnessLogo(row.id);
            return (
              <span className="inline-flex items-center gap-2">
                {Logo && (
                  <Logo
                    width={14}
                    height={14}
                    aria-hidden="true"
                    className="shrink-0 fg-secondary"
                  />
                )}
                {row.name}
              </span>
            );
          },
        },
        {
          key: 'installation',
          header: 'Installation',
          align: 'right',
          tone: (row) =>
            neutralText
              ? row.installation === 'Installed'
                ? 'primary'
                : 'secondary'
              : row.installation === 'Installed'
                ? 'success'
                : 'secondary',
          render: (row) => (
            <span
              className={
                row.via
                  ? 'flex min-w-0 items-center justify-end gap-3'
                  : 'inline-flex items-center justify-end gap-3'
              }
            >
              {row.via && (
                <PluginHarnessVia
                  via={row.via}
                  testId={`plugin-harness-${row.id}-via`}
                />
              )}
              {row.note && <span className="fg-tertiary">{row.note}</span>}
              {row.error && (
                <DetailFactError
                  error={row.error}
                  testId={`plugin-harness-${row.id}-error`}
                />
              )}
              {row.control}
              {row.alternative?.iconOnly ? (
                <Tooltip label={row.alternative.label}>
                  <Button
                    variant="ghost"
                    size="compact"
                    aria-label={row.alternative.label}
                    data-testid={`plugin-harness-${row.id}-alternative`}
                    onClick={row.alternative.onOpen}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <RefreshIcon size="xs" aria-hidden="true" />
                      Reinstall
                    </span>
                  </Button>
                </Tooltip>
              ) : (
                row.alternative && (
                  <Button
                    variant="link"
                    data-testid={`plugin-harness-${row.id}-alternative`}
                    onClick={row.alternative.onOpen}
                  >
                    {row.alternative.label}
                  </Button>
                )
              )}
              {/* Last, so every row's status lines up at the table's edge. */}
              <span className="inline-flex shrink-0 items-center gap-1.5">
                {row.installation === 'Installed' && (
                  <CheckIcon
                    size={16}
                    className={`shrink-0${neutralText ? ' fg-success' : ''}`}
                    aria-hidden="true"
                  />
                )}
                {row.installation}
              </span>
            </span>
          ),
        },
      ]}
    />
  );
}

/** The harness table under its heading; nothing at all without a row to show. */
export function PluginWorksWith({
  rows,
  caption,
}: PluginHarnessConnectionsProps): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <ComponentSection title="Works with">
      <PluginHarnessConnections rows={rows} caption={caption} />
    </ComponentSection>
  );
}
