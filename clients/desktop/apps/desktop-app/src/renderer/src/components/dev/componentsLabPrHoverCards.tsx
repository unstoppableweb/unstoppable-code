import type { JSX } from 'react';
import type { GitHubItemPreview } from '@canopy/protocol/reference-previews';
import {
  MenuSurface,
  PrHoverCardsProvider,
  usePrHoverCards,
} from '@canopy/ui-shared/components';
import { GitHubReferencePreviewCard } from '@canopy/ui-shared/components/GitHubReferencePreviewCard';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const PULL: GitHubItemPreview = {
  kind: 'item',
  owner: 'acme',
  repository: 'tower',
  number: 1234,
  itemType: 'pull',
  title: 'Hydrate GitHub references in chat transcripts',
  url: 'https://github.com/acme/tower/pull/1234',
  description: 'Adds hover previews for GitHub references.',
  state: 'open',
  draft: false,
  author: 'octocat',
  updatedAt: '2026-10-10T09:00:00Z',
  pull: {
    additions: 120,
    deletions: 14,
    changedFiles: 6,
    mergeable: 'mergeable',
    checks: 'passing',
    reviewDecision: 'approved',
    inMergeQueue: false,
  },
};

/** The real consumer of the setting: the hover card picks its layout from it. */
function Consumer(): JSX.Element {
  const on = usePrHoverCards();
  return (
    <div className="flex w-full flex-col gap-2">
      <span className="text-2xs fg-tertiary">
        usePrHoverCards() returns <code>{String(on)}</code>, so the card uses
        the {on ? 'status' : 'classic'} layout
      </span>
      <MenuSurface role="presentation" padding="readout" className="w-72">
        <GitHubReferencePreviewCard
          label="acme/tower#1234"
          layout={on ? 'status' : 'classic'}
          view={{
            status: 'ready',
            preview: PULL,
            checkedAt: Date.parse('2026-10-10T12:00:00Z'),
            stale: false,
          }}
        />
      </MenuSurface>
    </div>
  );
}

/** PrHoverCardsProvider and usePrHoverCards: unset, on, off and nested. */
export function PrHoverCardsSpecimen(): JSX.Element {
  return (
    <SpecimenPanel
      title="Pull request cards presentation"
      hint="A provider and a hook, shown through the hover card that reads it"
    >
      <SpecimenGrid min={320}>
        <SpecimenCell label="No provider: the classic card">
          <Consumer />
        </SpecimenCell>
        <SpecimenCell label="Provider on: the status card">
          <PrHoverCardsProvider value>
            <Consumer />
          </PrHoverCardsProvider>
        </SpecimenCell>
        <SpecimenCell label="Provider off: the classic card">
          <PrHoverCardsProvider value={false}>
            <Consumer />
          </PrHoverCardsProvider>
        </SpecimenCell>
        <SpecimenCell label="Nested: the inner provider wins">
          <PrHoverCardsProvider value>
            <PrHoverCardsProvider value={false}>
              <Consumer />
            </PrHoverCardsProvider>
          </PrHoverCardsProvider>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}
