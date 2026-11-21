import { type JSX } from 'react';
import { Fact, FactList } from './FactList';
import { Surface } from './Surface';

function formatFrontmatterValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value.toString();
  return '';
}

export function visibleFrontmatterEntries(
  frontmatter: Record<string, unknown>,
): [string, unknown][] {
  return Object.entries(frontmatter).filter(
    ([, value]) => value !== null && value !== undefined && value !== '',
  );
}

export interface FrontmatterBlockProps {
  /** Parsed YAML frontmatter. Empty/null/undefined values are dropped. */
  readonly frontmatter: Record<string, unknown>;
  /** Extra classes appended to the outer card (e.g. spacing). */
  readonly className?: string;
}

/**
 * Renders frontmatter as a bordered fact list: each literal key in a mono
 * label, its value wrapping beside it (design call 5A, 2026-10-31). Returns an
 * empty fragment when there is nothing worth showing, so callers can render it
 * unconditionally. Shared by the skills/plugins detail views (via
 * {@link import('./MarkdownFrontmatterContent').MarkdownFrontmatterContent})
 * and the file viewer's markdown preview.
 */
export function FrontmatterBlock({
  frontmatter,
  className,
}: FrontmatterBlockProps): JSX.Element {
  const entries = visibleFrontmatterEntries(frontmatter);
  if (entries.length === 0) return <></>;

  return (
    <Surface
      variant="group"
      padding="default"
      data-selectable
      className={className}
    >
      <FactList size="s" labelMono labelTone="secondary">
        {entries.map(([key, value]) => (
          <Fact key={key} label={key}>
            {formatFrontmatterValue(value)}
          </Fact>
        ))}
      </FactList>
    </Surface>
  );
}
