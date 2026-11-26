import type { JSX, ReactNode } from 'react';
import { PluginDetailSectionHeading } from './PluginDetailSectionHeading';
import { Disclosure } from '../primitives/Disclosure';

/**
 * Titled section wrapping a plugin component list (skills, agents,
 * commands, …) in the plugin detail view: the heading, then the list's
 * DataTable card. The collapsible variant is a Disclosure box.
 */
export function ComponentSection({
  title,
  children,
  collapsible = false,
}: {
  title: string;
  children: ReactNode;
  collapsible?: boolean;
}): JSX.Element {
  if (collapsible) {
    return (
      <Disclosure
        variant="box"
        label={
          <PluginDetailSectionHeading as="span">
            {title}
          </PluginDetailSectionHeading>
        }
        dataTestId="component-section"
      >
        <div className="min-w-0 overflow-x-auto">{children}</div>
      </Disclosure>
    );
  }
  // The table under the heading is the card (a DataTable), so the section
  // draws no outline of its own.
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <PluginDetailSectionHeading>{title}</PluginDetailSectionHeading>
      {children}
    </section>
  );
}
