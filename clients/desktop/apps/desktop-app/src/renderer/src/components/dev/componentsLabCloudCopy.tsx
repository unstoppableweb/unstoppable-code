import { useState, type JSX } from 'react';
import type { PipelinePackageAnalysisSummary } from '@canopy/protocol/pipelines';
import { CloudCopyConsentDialog } from '@canopy/ui-app/capability';
import { SpecimenPanel } from './componentsLabParts';

const file = (
  path: string,
  size: number,
): { path: string; sha256: string; size: number; mode: 'read' } => ({
  path,
  sha256: path.padEnd(64, '0').slice(0, 64),
  size,
  mode: 'read',
});

/** A fixture analysis of a local plugin: two members, three files left out. */
function analysis(
  gitIgnoreCheck: 'checked' | 'unavailable',
): PipelinePackageAnalysisSummary {
  return {
    analysisId: 'lab-analysis',
    state: 'ready',
    pipelineContentHash: 'c'.repeat(64),
    blockers: [],
    expiresAt: '2099-01-01T00:00:00.000Z',
    gitIgnoreCheck,
    withheldMemberFiles: [
      {
        rootName: 'notes',
        relativePath: 'skills/notes/.env',
        reason: 'denied_name',
      },
      ...(gitIgnoreCheck === 'checked'
        ? [
            {
              rootName: 'notes',
              relativePath: 'skills/notes/drafts.local.md',
              reason: 'git_ignored' as const,
            },
          ]
        : []),
      {
        rootName: 'notes',
        relativePath: 'skills/notes/hosts',
        reason: 'symlink',
      },
    ],
    manifest: {
      version: 1,
      pipelineContentHash: 'c'.repeat(64),
      resources: [
        {
          id: 'lab-skill',
          installedItemRef: {
            kind: 'plugin',
            marketplaceId: 'local-tools',
            pluginName: 'notes',
          },
          kind: 'plugin_skill',
          displayName: 'notes',
          sourceLabel: 'notes',
          sourceVisibility: 'local',
          invocationKeys: ['notes:notes'],
          dependencyResourceIds: [],
          trees: [
            {
              provider: 'claude',
              runtimeKind: 'plugin_fragment',
              rootName: 'notes',
              entries: [
                file('.claude-plugin/plugin.json', 48),
                file('skills/notes/SKILL.md', 1840),
                file('skills/notes/reference.md', 3120),
              ],
            },
          ],
        },
        {
          id: 'lab-command',
          installedItemRef: {
            kind: 'plugin',
            marketplaceId: 'local-tools',
            pluginName: 'notes',
          },
          kind: 'plugin_command',
          displayName: 'summarise',
          sourceLabel: 'notes',
          sourceVisibility: 'local',
          invocationKeys: ['notes:summarise'],
          dependencyResourceIds: [],
          trees: [
            {
              provider: 'claude',
              runtimeKind: 'plugin_fragment',
              rootName: 'notes',
              entries: [
                file('.claude-plugin/plugin.json', 48),
                file('commands/summarise.md', 640),
              ],
            },
          ],
        },
      ],
      bindings: [
        { target: 'subject', resourceIds: ['lab-skill', 'lab-command'] },
      ],
      environmentRequirements: [],
      totalFiles: 4,
      totalBytes: 5648,
    },
  };
}

function Specimen({
  title,
  kind,
  gitIgnoreCheck,
}: {
  readonly title: string;
  readonly kind: 'skill' | 'plugin';
  readonly gitIgnoreCheck: 'checked' | 'unavailable';
}): JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <SpecimenPanel title={title}>
      {open && (
        <CloudCopyConsentDialog
          audience="private"
          subject={{ kind, name: 'notes' }}
          replacing={false}
          analysis={analysis(gitIgnoreCheck)}
          loading={false}
          analysisError={null}
          selectedOptionalResourceIds={[]}
          onToggleOptionalResource={(): void => undefined}
          onRetry={(): void => undefined}
          onAdd={(): Promise<void> => Promise.resolve()}
          onClose={(): void => setOpen(false)}
        />
      )}
    </SpecimenPanel>
  );
}

/**
 * Adding a desktop plugin to the cloud account (CAN-6176 9c), rendered from
 * fixtures: the files that go, and the secret-looking, git-ignored and linked
 * files that don't, each with its reason.
 */
export function CloudCopyPluginSpecimen(): JSX.Element {
  return (
    <Specimen
      title="Add a plugin to the cloud (fixture render)"
      kind="plugin"
      gitIgnoreCheck="checked"
    />
  );
}

/** The same dialog when Git couldn't check the folder. */
export function CloudCopyGitUncheckedSpecimen(): JSX.Element {
  return (
    <Specimen
      title="Git couldn't check the folder (fixture render)"
      kind="skill"
      gitIgnoreCheck="unavailable"
    />
  );
}
