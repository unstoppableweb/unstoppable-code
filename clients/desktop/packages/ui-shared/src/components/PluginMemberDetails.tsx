import { Badge, Count } from './Badge';
import type { JSX, ReactNode } from 'react';
import type {
  RemoteControlMcpConnectionMetadata,
  RemoteControlPluginCatalogMemberInventory,
} from '@canopy/protocol/remote-control/shell';
import { Heading } from './Heading';
import { Surface } from './Surface';
import { PluginModNotice, pluginModRows } from './PluginModMembers';

export interface PluginMemberDetailsProps {
  inventory: RemoteControlPluginCatalogMemberInventory;
  hooksStripped?: boolean;
  mcpUnavailable?: boolean;
  connectionState?: RemoteControlMcpConnectionMetadata['connectionState'];
  toolsEditor?: ReactNode;
}

interface MemberRow {
  key: string;
  name: string;
  description?: string;
  /** Shows the name and description as code, for paths. */
  code?: boolean;
}

function MemberSection({
  title,
  rows,
  status,
  note,
}: {
  title: string;
  rows: MemberRow[];
  status?: ReactNode;
  /** A line between the heading and the list. */
  note?: ReactNode;
}): JSX.Element {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <div className="flex flex-wrap items-center gap-2">
        <Heading level={3} variant="label">
          {title}
        </Heading>
        <Count value={rows.length} />
        {status}
      </div>
      {note}
      {rows.length === 0 ? (
        <p className="text-xs fg-secondary">No members</p>
      ) : (
        <Surface variant="outline">
          <ul className="divide-y">
            {rows.map((row) => (
              <li key={row.key} className="px-3 py-2">
                <p
                  className={
                    row.code
                      ? 'font-mono text-xs font-medium fg-primary'
                      : 'text-s font-medium fg-primary'
                  }
                >
                  {row.name}
                </p>
                {row.description && (
                  <p
                    className={
                      row.code
                        ? 'font-mono text-xs fg-secondary'
                        : 'text-xs fg-secondary'
                    }
                  >
                    {row.description}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Surface>
      )}
    </section>
  );
}

function InertStatus({ children }: { children: ReactNode }): JSX.Element {
  return <Badge tone="warning">{children}</Badge>;
}

/** Pure member-inventory display shared by cloud now and desktop later. */
export function PluginMemberDetails({
  inventory,
  hooksStripped = true,
  mcpUnavailable = true,
  connectionState,
  toolsEditor,
}: PluginMemberDetailsProps): JSX.Element {
  const modRows = pluginModRows(inventory.mods);
  return (
    <div className="flex flex-col gap-5" data-testid="plugin-member-details">
      <MemberSection
        title="Skills"
        rows={inventory.skills.map((member) => ({
          key: member.path,
          name: member.name,
          description: member.description,
        }))}
      />
      <MemberSection
        title="Agents"
        rows={inventory.agents.map((member) => ({
          key: member.filePath,
          name: member.name,
          description: member.description,
        }))}
      />
      <MemberSection
        title="Commands"
        rows={inventory.commands.map((member) => ({
          key: member.filePath,
          name: member.name,
          description: member.description,
        }))}
      />
      <MemberSection
        title="Apps"
        rows={(inventory.apps ?? []).map((member) => ({
          key: member.filePath,
          name: member.name,
          description: member.description,
        }))}
      />
      <MemberSection
        title="Hooks"
        rows={inventory.hooks.map((member, index) => ({
          key: `${member.event}-${String(index)}`,
          name: member.event,
          description: member.matcher ?? member.command,
        }))}
        status={
          hooksStripped ? (
            <InertStatus>Stripped in cloud sessions</InertStatus>
          ) : undefined
        }
      />
      {modRows.length > 0 && (
        <MemberSection
          title="Mods"
          note={<PluginModNotice />}
          rows={modRows.map((mod) => ({
            key: mod.key,
            name: mod.module,
            description: mod.hooksFile,
            code: true,
          }))}
        />
      )}
      <MemberSection
        title="MCP servers"
        rows={inventory.mcpServers.map((member) => ({
          key: member.name,
          name: member.name,
          description: member.type === 'http' ? 'HTTP' : 'Command',
        }))}
        status={
          connectionState ? (
            <span className="text-xs fg-secondary">
              {
                {
                  connected: 'Connected',
                  reauth_required: 'Reconnect required',
                  not_connected: 'Not connected',
                  desktop_only: 'Available on desktop only',
                }[connectionState]
              }
            </span>
          ) : mcpUnavailable ? (
            <InertStatus>Not yet available in cloud sessions</InertStatus>
          ) : undefined
        }
      />
      {connectionState === 'connected' && toolsEditor}
      <MemberSection
        title="LSP servers"
        rows={inventory.lspServers.map((member) => ({
          key: member.name,
          name: member.name,
          description:
            member.languages && member.languages.length > 0
              ? member.languages.join(', ')
              : member.command,
        }))}
      />
    </div>
  );
}
