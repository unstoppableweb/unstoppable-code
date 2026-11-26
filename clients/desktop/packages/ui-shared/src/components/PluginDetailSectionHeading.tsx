import type { JSX, ReactNode } from 'react';
import { Heading } from '../primitives/Heading';

export interface PluginDetailSectionHeadingProps {
  as?: 'h3' | 'span';
  /** Lets a section name itself by this heading (`aria-labelledby`). */
  id?: string;
  children: ReactNode;
}

const TEST_ID = 'plugin-detail-section-heading';

export function PluginDetailSectionHeading({
  as = 'h3',
  id,
  children,
}: PluginDetailSectionHeadingProps): JSX.Element {
  // `span` names a `<button>` or `<summary>` toggle, where a heading element
  // is not allowed. It carries the `title` heading's exact classes, so the
  // README toggle and the component sections read as one treatment.
  if (as === 'span') {
    return (
      <span
        id={id}
        className="text-s font-medium fg-primary text-pretty"
        data-testid={TEST_ID}
      >
        {children}
      </span>
    );
  }
  return (
    <Heading level={3} variant="title" id={id} data-testid={TEST_ID}>
      {children}
    </Heading>
  );
}
