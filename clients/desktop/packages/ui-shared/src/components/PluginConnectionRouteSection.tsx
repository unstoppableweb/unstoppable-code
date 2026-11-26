import { Stack } from '../primitives/Stack';
import { useId, type JSX, type ReactNode } from 'react';
import { PluginDetailSectionHeading } from './PluginDetailSectionHeading';
import { Divider } from '../primitives/Surface';

export interface PluginConnectionRouteSectionProps {
  /** Names the route, such as "<App> MCP server" or "Provider connections". */
  title: string;
  /** Who holds the connection and where its tools appear. */
  description: string;
  children: ReactNode;
  dataTestId?: string;
}

/**
 * One way a service reaches chats, on a detail that offers more than one
 * (REG-3033). A divider and a heading mark where one route ends and the next
 * begins; the route's own controls keep their surfaces, so no card wraps
 * them a second time.
 */
export function PluginConnectionRouteSection({
  title,
  description,
  children,
  dataTestId,
}: PluginConnectionRouteSectionProps): JSX.Element {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid={dataTestId}
      className="flex min-w-0 flex-col gap-4"
    >
      <Divider />
      <Stack gap="tight" className="min-w-0 max-w-2xl">
        <PluginDetailSectionHeading id={headingId}>
          {title}
        </PluginDetailSectionHeading>
        <p className="text-pretty text-xs fg-secondary">{description}</p>
      </Stack>
      {/* Every route shares one measure, so the controls of consecutive
          routes end on the same edge while the dividers span the page. */}
      <div className="flex min-w-0 max-w-2xl flex-col gap-4">{children}</div>
    </section>
  );
}
