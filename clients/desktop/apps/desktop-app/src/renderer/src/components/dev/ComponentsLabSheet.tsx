import type { JSX } from 'react';
import { Heading } from '@canopy/ui-shared/components';
import type { ComponentsLabEntry } from './componentsLabCatalog';

function Caption({
  entry,
}: {
  readonly entry: ComponentsLabEntry;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <Heading level={2} variant="section">
        {entry.name}
      </Heading>
      <p className="text-s fg-secondary">{entry.note}</p>
      <p className="flex flex-wrap gap-x-3 text-xs fg-tertiary">
        <code className="min-w-0 break-all">{entry.source}</code>
        {entry.prs.length > 0 ? (
          <span>{entry.prs.map((pr) => `#${pr}`).join(', ')}</span>
        ) : null}
      </p>
    </div>
  );
}

export function ComponentsLabSheet({
  entry,
}: {
  readonly entry: ComponentsLabEntry;
}): JSX.Element {
  const { Stage, View } = entry;
  return (
    <section
      id={entry.id}
      data-testid={`components-lab-${entry.id}`}
      className="flex flex-col gap-4"
    >
      <Caption entry={entry} />
      {Stage ? <Stage /> : null}
      <View />
    </section>
  );
}
