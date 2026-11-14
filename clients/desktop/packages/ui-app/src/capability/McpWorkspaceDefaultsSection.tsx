'use client';

import { useState, type JSX } from 'react';
import { WORKSPACE_LABEL, WORKSPACE_LABEL_PLURAL } from '@canopy/protocol';
import { Button, SettingsSelect } from '@canopy/ui-shared';
import { ErrorBanner } from '@canopy/ui-shared/components';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  MCP_WORKSPACE_DEFAULTS_HINT,
  mcpWorkspaceDefaultsStatus,
  workspaceDefaultMcpLabel,
} from './accountMcpRows';

export interface McpWorkspaceDefaultsChoice {
  readonly id: string;
  readonly name: string;
  /** Whether the project's default plugins include the server; undefined until read. */
  readonly enabled: boolean | undefined;
}

export interface McpWorkspaceDefaultsSectionProps {
  /** Projects the server can be added to. The first one starts selected. */
  readonly workspaces: readonly McpWorkspaceDefaultsChoice[];
  /** True while the projects' default plugins are being read. */
  readonly loading?: boolean;
  readonly onAdd: (workspaceId: string) => Promise<void>;
  readonly onRemove: (workspaceId: string) => Promise<void>;
  readonly testId: string;
}

/**
 * Where a signed-in MCP server is on by default. Signing in only makes the
 * server available to the account; chats use it once it is in a project's
 * default plugins or turned on in the chat. Hosts own the reads and writes.
 */
export function McpWorkspaceDefaultsSection({
  workspaces,
  loading = false,
  onAdd,
  onRemove,
  testId,
}: McpWorkspaceDefaultsSectionProps): JSX.Element | null {
  const [targetId, setTargetId] = useState<string | null>(null);
  const [pending, setPending] = useState<'add' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const target =
    workspaces.find((workspace): boolean => workspace.id === targetId) ??
    workspaces[0];
  if (target === undefined) return null;
  const enabledNames = workspaces
    .filter((workspace): boolean => workspace.enabled === true)
    .map((workspace): string => workspace.name);
  const allRead = workspaces.every(
    (workspace): boolean => workspace.enabled !== undefined,
  );
  const inNoProject = !loading && allRead && enabledNames.length === 0;
  const run = async (kind: 'add' | 'remove'): Promise<void> => {
    setPending(kind);
    setError(null);
    try {
      if (kind === 'add') await onAdd(target.id);
      else await onRemove(target.id);
    } catch {
      setError(
        kind === 'add'
          ? `Couldn't add the server to ${target.name}. Try again.`
          : `Couldn't remove the server from ${target.name}. Try again.`,
      );
    } finally {
      setPending(null);
    }
  };
  return (
    <section
      className="grid grid-cols-[9rem_minmax(0,1fr)] items-start gap-x-4"
      aria-label={`${WORKSPACE_LABEL} defaults`}
      data-testid={testId}
    >
      <span className="flex min-h-7 items-center text-s fg-secondary">
        {WORKSPACE_LABEL_PLURAL}
      </span>
      <div className="flex min-w-0 flex-col gap-2 pt-1">
        <p className="text-s" data-testid={`${testId}-status`}>
          {loading ? (
            <span className="fg-secondary">
              {`Checking ${WORKSPACE_LABEL_PLURAL.toLowerCase()}…`}
            </span>
          ) : inNoProject ? (
            <>
              <span className="font-medium fg-primary">
                {mcpWorkspaceDefaultsStatus([])}
              </span>{' '}
              <span className="fg-tertiary">{MCP_WORKSPACE_DEFAULTS_HINT}</span>
            </>
          ) : enabledNames.length > 0 ? (
            // Names user-authored projects, so session replay masks it.
            <span className={`${REPLAY_MASK_CLASS} font-medium fg-primary`}>
              {mcpWorkspaceDefaultsStatus(enabledNames)}
            </span>
          ) : null}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {workspaces.length > 1 && (
            <SettingsSelect
              aria-label={WORKSPACE_LABEL}
              value={target.id}
              width="fit"
              disabled={pending !== null}
              onValueChange={(value): void => {
                setTargetId(value);
                setError(null);
              }}
              // Project names are user-authored: session replay masks them.
              replayPrivacy={{ maskClassName: REPLAY_MASK_CLASS }}
              data-testid={`${testId}-select`}
              options={workspaces.map((workspace) => ({
                value: workspace.id,
                label: workspace.name,
              }))}
            />
          )}
          {target.enabled === true ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={pending !== null}
              aria-label={`Remove from ${target.name}`}
              onClick={(): void => void run('remove')}
              data-testid={`${testId}-remove`}
            >
              {pending === 'remove' ? 'Removing…' : 'Remove'}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              disabled={pending !== null || loading}
              onClick={(): void => void run('add')}
              data-testid={`${testId}-add`}
            >
              {pending === 'add' ? (
                'Adding…'
              ) : target.name.trim() ? (
                <>
                  Add to{' '}
                  <span className={REPLAY_MASK_CLASS}>
                    {target.name.trim()}
                  </span>
                </>
              ) : (
                workspaceDefaultMcpLabel()
              )}
            </Button>
          )}
        </div>
        <ErrorBanner
          errorSource="mcp-workspace-defaults-section"
          className=""
          error={error}
          testId={`${testId}-error`}
        />
      </div>
    </section>
  );
}
