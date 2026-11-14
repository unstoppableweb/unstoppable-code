import type { ComponentType, JSX, SVGProps } from 'react';
import type { AgentExecutionHarness } from '@canopy/protocol/models';
import { Button } from './Button';
import { ComponentSection } from './ComponentSection';
import { CheckIcon, GitHubIcon, RefreshIcon } from '../icons/AppIcons';
import { ClaudeLogo } from '../icons/ClaudeLogo';
import { CodexLogo } from '../icons/CodexLogo';
import { CursorLogo } from '../icons/CursorLogo';
import { OpenCodeLogo } from '../icons/OpenCodeLogo';
import { DataTable } from './DataTable';
import { Tooltip } from './Tooltip';

/**
 * Plugin harness names and marks, in display order. Antigravity is chat-only
 * and rejects plugins, so it has no plugin connection entry.
 */
const HARNESSES: Readonly<
  Record<
    Exclude<AgentExecutionHarness, 'antigravity'>,
    { name: string; Logo: ComponentType<SVGProps<SVGSVGElement>> }
  >
> = {
  claude: { name: 'Claude', Logo: ClaudeLogo },
  codex: { name: 'Codex', Logo: CodexLogo },
  cursor: { name: 'Cursor', Logo: CursorLogo },
  // Copilot has no brand mark here; match ModelProviderIcon's GitHub mark.
  copilot: { name: 'Copilot', Logo: GitHubIcon },
  opencode: { name: 'OpenCode', Logo: OpenCodeLogo },
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
  installation: 'Installed' | 'Not installed' | 'Not supported';
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
  })[];
}

export function PluginHarnessConnections({
  rows,
}: PluginHarnessConnectionsProps): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <DataTable
      testId="plugin-harness-connections"
      caption="Plugin installation by harness"
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
            row.installation === 'Installed' ? 'success' : 'secondary',
          render: (row) => (
            <span className="inline-flex items-center justify-end gap-3">
              {row.note && <span className="fg-tertiary">{row.note}</span>}
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
              <span className="inline-flex items-center gap-1.5">
                {row.installation === 'Installed' && (
                  <CheckIcon
                    size={16}
                    className="shrink-0"
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
}: PluginHarnessConnectionsProps): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <ComponentSection title="Works with">
      <PluginHarnessConnections rows={rows} />
    </ComponentSection>
  );
}
