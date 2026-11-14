/** @jest-environment jsdom */
/**
 * The consent to add a desktop skill or plugin to the cloud account
 * (CAN-6176 9c): it lists the files that will be sent and, apart, the ones
 * that won't, each with its reason and never as a choice; it says when Git
 * couldn't check the folder; and Add waits for a ready analysis.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PipelinePackageAnalysisSummary } from '@canopy/protocol/pipelines';
import {
  CloudCopyConsentDialog,
  type CloudCopyConsentAudience,
} from '../CloudCopyConsentDialog';

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const entry = (
  path: string,
  size = 40,
): { path: string; sha256: string; size: number; mode: 'read' } => ({
  path,
  sha256: 'a'.repeat(64),
  size,
  mode: 'read' as const,
});

const READY = {
  analysisId: 'analysis-1',
  state: 'ready',
  pipelineContentHash: 'b'.repeat(64),
  blockers: [],
  expiresAt: '2099-01-01T00:00:00.000Z',
  gitIgnoreCheck: 'checked',
  withheldMemberFiles: [
    {
      rootName: 'notes',
      relativePath: 'skills/notes/.env',
      reason: 'denied_name',
    },
    {
      rootName: 'notes',
      relativePath: 'skills/notes/drafts.local.md',
      reason: 'git_ignored',
    },
  ],
  manifest: {
    version: 1,
    pipelineContentHash: 'b'.repeat(64),
    resources: [
      {
        id: 'r1',
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
              entry('.claude-plugin/plugin.json'),
              entry('skills/notes/SKILL.md'),
            ],
          },
        ],
      },
    ],
    bindings: [{ target: 'subject', resourceIds: ['r1'] }],
    environmentRequirements: [],
    totalFiles: 2,
    totalBytes: 80,
  },
} as unknown as PipelinePackageAnalysisSummary;

describe('adding a desktop skill or plugin to the cloud account (CAN-6176 9c)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let added: number;

  const render = (
    analysis: PipelinePackageAnalysisSummary | null,
    loading = false,
    analysisError: string | null = null,
    audience: CloudCopyConsentAudience = 'private',
  ): void => {
    act(() => {
      root.render(
        <CloudCopyConsentDialog
          subject={{ kind: 'plugin', name: 'notes' }}
          replacing={false}
          audience={audience}
          analysis={analysis}
          loading={loading}
          analysisError={analysisError}
          selectedOptionalResourceIds={[]}
          onToggleOptionalResource={(): void => undefined}
          onRetry={(): void => undefined}
          onAdd={(): Promise<void> => {
            added += 1;
            return Promise.resolve();
          }}
          onClose={(): void => undefined}
        />,
      );
    });
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    added = 0;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const query = (id: string): HTMLElement | null =>
    document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const addButton = (): HTMLButtonElement => {
    const button = query('cloud-copy-consent-add');
    if (!(button instanceof HTMLButtonElement)) throw new Error('no Add');
    return button;
  };

  it('lists the files left out with their reasons, never as a choice', () => {
    render(READY);
    const withheld = query('cloud-copy-dependencies-withheld');
    expect(withheld?.textContent).toContain('Not sent');
    const items = Array.from(
      document.body.querySelectorAll<HTMLElement>(
        '[data-testid="cloud-copy-dependencies-withheld-item"]',
      ),
    );
    expect(items.map((item) => item.dataset.reason)).toEqual([
      'denied_name',
      'git_ignored',
    ]);
    expect(items[0]?.textContent).toContain('notes/skills/notes/.env');
    expect(
      withheld?.querySelector('input, [role="checkbox"], button'),
    ).toBeNull();
    expect(query('cloud-copy-dependencies-git-unchecked')).toBeNull();
    expect(query('cloud-copy-consent-plugin-note')).not.toBeNull();
  });

  it('says who already sees the copy an update reaches, rather than promising a private one', () => {
    render(READY);
    expect(query('cloud-copy-consent-body')?.textContent).toContain(
      'a private copy',
    );
    expect(query('cloud-copy-consent-audience')).toBeNull();
    for (const [audience, who] of [
      ['team', 'your team, so your team sees these changes too'],
      ['organization', 'everyone in it sees these changes too'],
      ['public_link', 'anyone with the link sees these changes too'],
    ] as const) {
      render(READY, false, null, audience);
      const body = query('cloud-copy-consent-body')?.textContent ?? '';
      expect(query('cloud-copy-consent-audience')?.textContent).toContain(who);
      expect(body).not.toContain('a private copy');
      expect(body).not.toContain('Nothing is shared with a team');
    }
  });

  it('lists every file the copy sends, by its path', () => {
    render(READY);
    expect(
      Array.from(
        document.body.querySelectorAll<HTMLElement>(
          '[data-testid="cloud-copy-consent-sent-item"]',
        ),
      ).map((item) => item.textContent),
    ).toEqual([
      'notes/.claude-plugin/plugin.json',
      'notes/skills/notes/SKILL.md',
    ]);
  });

  it('says when Git could not check the folder', () => {
    render({ ...READY, gitIgnoreCheck: 'unavailable' });
    expect(query('cloud-copy-dependencies-git-unchecked')?.textContent).toMatch(
      /Git couldn't check this folder/,
    );
  });

  it('adds only once the analysis is ready', async () => {
    render(null, true);
    expect(addButton().disabled).toBe(true);
    render({ ...READY, state: 'blocked' });
    expect(addButton().disabled).toBe(true);
    render(READY, true);
    expect(addButton().disabled).toBe(true);
    // A failed recheck leaves nothing to agree to, even an earlier analysis.
    render(READY, false, 'The files couldn’t be checked.');
    expect(addButton().disabled).toBe(true);
    render(READY);
    expect(addButton().disabled).toBe(false);
    await act(async () => {
      addButton().click();
      await Promise.resolve();
    });
    expect(added).toBe(1);
  });
});
