import { useEffect, useState, type JSX, type RefObject } from 'react';
import * as SharedComponents from '@canopy/ui-shared/components';
import {
  CopyButton,
  Divider,
  Heading,
  InlineMention,
  ListRow,
  type HeadingLevel,
} from '@canopy/ui-shared/components';
import { FileIcon, GitPullRequestIcon } from '@canopy/ui-shared/icons/AppIcons';
import type { ComponentsLabEntry } from './componentsLabCatalog';
import type { ComponentsLabPage } from './componentsLabPages';
import { LAB_TOC_SELECTOR } from './componentsLabParts';

const SHARED_COMPONENT_DIRS = [
  'packages/ui-shared/src/components/',
  'packages/ui-shared/src/primitives/',
];
const SHARED_COMPONENTS_IMPORT = '@canopy/ui-shared/components';

/**
 * The files a catalog `source` names: paths separated by a comma and a
 * space, each either plain or `a/{b,c/d}.tsx` for `a/b.tsx` and `a/c/d.tsx`.
 */
export function expandSource(source: string): readonly string[] {
  return source.split(', ').flatMap((path) => {
    const match = /^(.*)\{([^}]*)\}(.*)$/.exec(path);
    if (!match) return [path];
    const [, before = '', names = '', after = ''] = match;
    return names.split(',').map((name) => `${before}${name}${after}`);
  });
}

export function baseName(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1);
  const dot = file.lastIndexOf('.');
  return dot > 0 ? file.slice(0, dot) : file;
}

/**
 * The import line for an entry: the components it names, then the names its
 * source files carry, keeping only what the shared components barrel really
 * exports, so the line always compiles. A sheet whose source is a helper
 * module or lives outside the barrel shows no import line.
 */
function importLine(
  components: readonly string[],
  files: readonly string[],
): string | null {
  const fromFiles = files
    .filter((file) => SHARED_COMPONENT_DIRS.some((dir) => file.startsWith(dir)))
    .map(baseName);
  const names = [...new Set([...components, ...fromFiles])].filter(
    (name) => name in SharedComponents,
  );
  if (names.length === 0) return null;
  return `import { ${names.join(', ')} } from '${SHARED_COMPONENTS_IMPORT}';`;
}

/**
 * An entry's note, its source files and pull requests, and its import line.
 * The chips name their file or pull request and open nothing: this source is
 * also published, and must not carry the private repository's address.
 */
function EntryMeta({
  entry,
}: {
  readonly entry: ComponentsLabEntry;
}): JSX.Element {
  const files = expandSource(entry.source).filter(
    (file) => !file.endsWith('/'),
  );
  const line = importLine(entry.components ?? [], files);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-s text-pretty fg-secondary">{entry.note}</p>
      {files.length > 0 || entry.prs.length > 0 ? (
        <p className="text-s leading-6 fg-tertiary">
          {files.map((file) => (
            <span key={file}>
              <InlineMention icon={FileIcon} title={file}>
                {file.slice(file.lastIndexOf('/') + 1)}
              </InlineMention>{' '}
            </span>
          ))}
          {entry.prs.map((pr) => (
            <span key={pr}>
              <InlineMention icon={GitPullRequestIcon}>
                #{pr}
              </InlineMention>{' '}
            </span>
          ))}
        </p>
      ) : null}
      {line ? (
        <div className="flex min-w-0 items-center gap-1">
          <code className="min-w-0 text-xs break-words fg-secondary">
            {line}
          </code>
          <CopyButton value={line} ariaLabel="Copy import" />
        </div>
      ) : null}
    </div>
  );
}

/**
 * One catalog entry: its title and facts, its stage, then its specimens.
 * `data-testid` and `id` stay the entry's own, on a page of its own or as
 * one section of a page that holds several.
 */
export function EntrySheet({
  entry,
  title = entry.name,
  titleLevel,
  lead = false,
}: {
  readonly entry: ComponentsLabEntry;
  /** The heading over the entry; a page of one entry passes its own name. */
  readonly title?: string;
  readonly titleLevel: HeadingLevel;
  /**
   * The entry leads its page: its title takes the page look and a divider
   * closes the header, as on the capture view and a page of one entry.
   */
  readonly lead?: boolean;
}): JSX.Element {
  const { Stage, View } = entry;
  return (
    <section
      id={entry.id}
      data-testid={`components-lab-${entry.id}`}
      className="flex flex-col gap-8"
    >
      <div className="flex flex-col gap-2">
        <Heading
          level={titleLevel}
          variant={lead ? 'page' : 'section'}
          data-lab-entry-title=""
        >
          {title}
        </Heading>
        <EntryMeta entry={entry} />
      </div>
      {lead ? <Divider /> : null}
      {Stage ? <Stage /> : null}
      <View />
    </section>
  );
}

/** A page: its one entry, or its title and each of its entries in turn. */
export function PageSheet({
  page,
}: {
  readonly page: ComponentsLabPage;
}): JSX.Element {
  const [only] = page.entries;
  if (page.entries.length === 1 && only) {
    return <EntrySheet entry={only} title={page.name} titleLevel={1} lead />;
  }
  return (
    <article className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Heading level={1} variant="page">
          {page.name}
        </Heading>
        {page.note ? (
          <p className="text-s text-pretty fg-secondary">{page.note}</p>
        ) : null}
      </div>
      <Divider />
      <div className="flex flex-col gap-16">
        {page.entries.map((entry) => (
          <EntrySheet key={entry.id} entry={entry} titleLevel={2} />
        ))}
      </div>
    </article>
  );
}

/** Scrolls the sheet so a heading sits one gutter under the card's top. */
export function scrollToHeading(element: Element): void {
  const scroller = element.closest('#components-lab-preview');
  // Framed (`?frame=1`), the preview grows with its content and the document
  // scrolls instead.
  if (!scroller || scroller.scrollHeight <= scroller.clientHeight) {
    element.scrollIntoView({ block: 'start' });
    return;
  }
  const offset =
    element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  scroller.scrollTo({ top: scroller.scrollTop + offset - 24 });
}

interface TocItem {
  readonly label: string;
  readonly element: Element;
}

/**
 * "On this page": the entries of a page that holds several, or the titled
 * sections of a page of one. It reads the headings the sheet rendered, so it
 * can never list a section that is not there. This is a jump list beside a
 * long reference page, not navigation: the sidebar stays the only place that
 * lists pages (DESIGN.md, Real navigation only).
 */
export function OnThisPage({
  page,
  container,
}: {
  readonly page: ComponentsLabPage;
  readonly container: RefObject<HTMLElement | null>;
}): JSX.Element | null {
  const [items, setItems] = useState<readonly TocItem[]>([]);
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const selector =
      page.entries.length > 1 ? '[data-lab-entry-title]' : LAB_TOC_SELECTOR;
    setItems(
      Array.from(root.querySelectorAll(selector), (element) => ({
        label: (element.textContent ?? '').trim(),
        element,
      })).filter((item) => item.label !== ''),
    );
  }, [page, container]);
  if (items.length < 2) return null;
  return (
    <nav aria-label="On this page" className="flex flex-col gap-0.5">
      <div className="px-2 pb-1">
        <Heading level={2} variant="label">
          On this page
        </Heading>
      </div>
      {items.map((item, index) => (
        <ListRow
          key={`${item.label}-${index}`}
          size="sm"
          title={item.label}
          onClick={(): void => scrollToHeading(item.element)}
        >
          {item.label}
        </ListRow>
      ))}
    </nav>
  );
}
