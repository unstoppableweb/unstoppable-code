import {
  createElement,
  Children,
  Fragment,
  type ComponentPropsWithoutRef,
  type ElementType,
  type JSX,
  type ReactNode,
} from 'react';
import { RuleType, type MarkdownToJSX } from 'markdown-to-jsx';
import { Checkbox } from './Choice';
import { DeferredMarkdownMath } from './DeferredMarkdownMath';
import { MarkdownCodeBlock } from './MarkdownCodeBlock';
import { MarkdownImage } from './MarkdownImage';
import { MarkdownMermaid } from './MarkdownMermaid';
import { MAX_MERMAID_BLOCKS } from './markdown-mermaid-policy';
import { parseFileLinkLineSuffix } from '../lib/file-link-line-suffix';
import './markdown-overflow.css';
import {
  MAX_MATH_EXPRESSIONS_PER_DOCUMENT,
  MAX_MATH_EXPRESSION_LENGTH,
  prepareMarkdownMath,
  restoreMarkdownMathSource,
  type MarkdownMathExpression,
} from './markdown-math';
import { isSingleDollarMathEnabled } from './markdown-math-settings';

const SAFE_URL_PROTOCOL = /^(https?|ircs?|mailto|xmpp)$/i;
type AnchorProps = ComponentPropsWithoutRef<'a'>;

/**
 * Preserve the URL policy from react-markdown's default transformer: relative
 * URLs and a small set of browser-safe schemes are allowed; everything else
 * renders without a navigable URL.
 */
function sanitizeMarkdownUrl(value: string): string | null {
  const colon = value.indexOf(':');
  const questionMark = value.indexOf('?');
  const numberSign = value.indexOf('#');
  const slash = value.indexOf('/');

  if (
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (questionMark !== -1 && colon > questionMark) ||
    (numberSign !== -1 && colon > numberSign) ||
    SAFE_URL_PROTOCOL.test(value.slice(0, colon))
  ) {
    return value;
  }

  return null;
}

const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:[\\/]/;
const FILE_URL = /^\s*file:/i;

interface LocalLinkAllowance {
  readonly windowsPaths: boolean;
  readonly fileUrls: boolean;
}

const NO_LOCAL_LINKS: LocalLinkAllowance = {
  windowsPaths: false,
  fileUrls: false,
};

/** Characters that make a URL a scheme name, e.g. `javascript` or `data`. */
const SCHEME_NAME = /^[a-z][a-z0-9+-]*$/i;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * True for a slash-less relative file path with a line suffix, such as
 * `README.md:12` (CAN-4275). URL parsing reads its first colon as a scheme
 * delimiter, so the default policy drops it. Admit it only when the suffix is
 * recognized and the remaining path holds no colon, no control character,
 * and is not itself a bare scheme name: `javascript:12` and
 * `data:text/plain:12` never become local paths by losing a "suffix". A
 * dotless bare name such as `Makefile:12` is indistinguishable from a scheme
 * and stays rejected.
 */
function isSlashlessLocalLineLink(value: string): boolean {
  if (hasControlCharacter(value)) return false;
  const parsed = parseFileLinkLineSuffix(value);
  return (
    parsed.location !== null &&
    parsed.href.length > 0 &&
    parsed.href.trim() === parsed.href &&
    !parsed.href.includes(':') &&
    !SCHEME_NAME.test(parsed.href)
  );
}

/** True when `value` is a local target the host opted into handling itself. */
function isAllowedLocalLink(
  value: string,
  allowance: LocalLinkAllowance,
): boolean {
  return (
    (allowance.windowsPaths &&
      (WINDOWS_DRIVE_PATH.test(value) || isSlashlessLocalLineLink(value))) ||
    (allowance.fileUrls && FILE_URL.test(value))
  );
}

function sanitizedAnchorOverride(
  override?: MarkdownToJSX.Override,
  allowance: LocalLinkAllowance = NO_LOCAL_LINKS,
): MarkdownToJSX.Override {
  let component: ElementType = 'a';
  let configuredProps: object = {};

  if (override) {
    if (typeof override === 'object') {
      component = override.component ?? component;
      configuredProps = override.props ?? configuredProps;
    } else {
      component = override;
    }
  }

  return function SanitizedMarkdownAnchor({
    href,
    ...props
  }: AnchorProps): JSX.Element {
    const mergedProps = { ...props, ...configuredProps };
    const linkHref = 'href' in configuredProps ? configuredProps.href : href;
    const safeHref =
      typeof linkHref === 'string'
        ? isAllowedLocalLink(linkHref, allowance)
          ? linkHref
          : (sanitizeMarkdownUrl(linkHref) ?? undefined)
        : undefined;

    return createElement(component, {
      ...mergedProps,
      href: safeHref,
    });
  };
}

type SanitizedAnchors = Map<string, MarkdownToJSX.Override>;

// One sanitizing wrapper per wrapped anchor and local-link allowance.
// `prepareMarkdownRender` builds the options again whenever the text changes,
// and a new wrapper is a new component type, so React would remount every
// link of a streaming reply on each frame, dropping its hover and focus.
const sanitizedAnchorsByOverride = new WeakMap<object, SanitizedAnchors>();
const sanitizedAnchorsByTag = new Map<string, SanitizedAnchors>();

function stableSanitizedAnchorOverride(
  override: MarkdownToJSX.Override | undefined,
  allowance: LocalLinkAllowance,
): MarkdownToJSX.Override {
  const owner = override ?? 'a';
  let anchors =
    typeof owner === 'string'
      ? sanitizedAnchorsByTag.get(owner)
      : sanitizedAnchorsByOverride.get(owner);
  if (!anchors) {
    anchors = new Map();
    if (typeof owner === 'string') sanitizedAnchorsByTag.set(owner, anchors);
    else sanitizedAnchorsByOverride.set(owner, anchors);
  }
  const key = `${allowance.windowsPaths ? 'w' : ''}${allowance.fileUrls ? 'f' : ''}`;
  let anchor = anchors.get(key);
  if (!anchor) {
    anchor = sanitizedAnchorOverride(override, allowance);
    anchors.set(key, anchor);
  }
  return anchor;
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*$/i;

/**
 * Schemes whose targets are hierarchical: they are only meaningful with an
 * `//authority` part. `https:report.md` and `https:/report.md` are NOT valid
 * absolute URLs — a browser resolves them against the current origin, which is
 * exactly the site-navigation this policy exists to prevent.
 */
const HIERARCHICAL_SCHEMES = new Set(['http', 'https', 'irc', 'ircs']);

/**
 * True when `href` is something a browser can meaningfully navigate to from an
 * agent transcript.
 *
 * Transcript markdown is authored by an agent running on the user's machine, so
 * it has no notion of the web app's route space: a bare path in that content is
 * a *filesystem* path (`/Users/me/notes.md`, `./report.md`, `C:\repo\a.ts`), not
 * a site route. Rendering those as anchors made the browser resolve them against
 * the current origin and navigate to a 404 (e.g. `https://<host>/Users/...`).
 *
 * Only in-document fragments and fully-qualified safe-scheme URLs navigate.
 * "Fully qualified" is enforced per scheme: hierarchical schemes need `//` plus
 * a non-empty authority, and opaque schemes (`mailto:`, `xmpp:`) need a
 * non-empty target.
 */
export function isNavigableTranscriptHref(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed.startsWith('#')) {
    return true;
  }

  const colon = trimmed.indexOf(':');
  if (colon <= 0) {
    return false;
  }
  const scheme = trimmed.slice(0, colon);
  if (!URL_SCHEME.test(scheme)) {
    return false;
  }
  // Reuse the shared scheme allow-list so this can never drift from it.
  if (sanitizeMarkdownUrl(trimmed) === null) {
    return false;
  }

  const rest = trimmed.slice(colon + 1);
  if (HIERARCHICAL_SCHEMES.has(scheme.toLowerCase())) {
    if (!rest.startsWith('//')) {
      return false;
    }
    const authority = rest.slice(2).split(/[/?#]/)[0] ?? '';
    return authority.length > 0;
  }
  return rest.trim().length > 0;
}

/**
 * A text link in prose: accent ink over a faint underline set clear of the
 * descenders; the underline takes the ink's full colour on hover and focus.
 */
export const TRANSCRIPT_LINK_CLASS =
  'fg-accent underline decoration-accent/30 decoration-1 underline-offset-4 transition-[text-decoration-color] hover:decoration-current focus-visible:decoration-current';

/**
 * Anchor override for agent transcripts: navigable URLs stay links, everything
 * else renders as inert text carrying the original target in `title` so the
 * path is still readable and copyable.
 */
export function TranscriptMarkdownAnchor({
  href,
  children,
  ...props
}: AnchorProps): JSX.Element {
  if (typeof href === 'string' && isNavigableTranscriptHref(href)) {
    return (
      <a {...props} href={href} className={TRANSCRIPT_LINK_CLASS}>
        {children}
      </a>
    );
  }

  return (
    <span
      {...props}
      data-testid="markdown-non-navigable-link"
      title={typeof href === 'string' ? href : undefined}
      className="break-all underline decoration-dotted decoration-1 underline-offset-4"
    >
      {children}
    </span>
  );
}

function plainCellText(children: ReactNode): string | null {
  const parts = Children.toArray(children);
  return parts.every(
    (part) => typeof part === 'string' || typeof part === 'number',
  )
    ? parts.join('').trim()
    : null;
}

/** Layout metadata shared with hosts that decorate cell contents. */
export function markdownTableCellProps(
  children: ReactNode,
  header = false,
): { 'data-compact': true | undefined } {
  const text = plainCellText(children);
  const compact =
    text &&
    (header
      ? text.length <= 6
      : text.length <= 8 &&
        /^[+-]?(?:\d+(?:[.,]\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{1,3}(?:\.\d{3})+(?:,\d+)?)%?$/.test(
          text,
        ));
  return { 'data-compact': compact ? true : undefined };
}

export function MarkdownTableBlock({
  children,
  ...props
}: ComponentPropsWithoutRef<'table'>): JSX.Element {
  return (
    <div
      className="canopy-markdown-scroll canopy-markdown-table"
      data-testid="markdown-table-scroll"
      role="group"
      aria-label="Table"
      tabIndex={0}
    >
      <table {...props}>{children}</table>
    </div>
  );
}

export { MarkdownImage, MarkdownImageUnavailable } from './MarkdownImage';

/**
 * Typography for agent and user prose in a chat transcript. Desktop and web
 * transcripts both take it from here so their prose cannot drift apart.
 * Inline code is a neutral box: it names something without opening it, so it
 * stays out of the accent ink that marks links and chips. Its box has the
 * inline chip's geometry (InlineMention.tsx): the same height, padding,
 * corners and centring on the surrounding cap height.
 */
export const TRANSCRIPT_PROSE_CLASS =
  'prose prose-sm [--tw-prose-body:var(--fg-primary)] dark:prose-invert max-w-none break-words prose-p:my-0.5 prose-pre:my-1.5 prose-pre:overflow-x-auto prose-pre:bg-fg-primary/[0.06] prose-pre:fg-primary/80 prose-code:before:content-none prose-code:after:content-none [&_:not(pre)>code]:inline-block [&_:not(pre)>code]:max-w-full [&_:not(pre)>code]:rounded-sm [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:pt-[0.125em] [&_:not(pre)>code]:pb-[0.042em] [&_:not(pre)>code]:px-[0.417em] [&_:not(pre)>code]:align-[0.0625em] [&_:not(pre)>code]:leading-[1.5] [&_:not(pre)>code]:font-normal [&_:not(pre)>code]:fg-primary prose-headings:fg-primary prose-a:fg-accent prose-strong:fg-primary prose-li:my-0.5';

export const DEFAULT_MARKDOWN_OVERRIDES: MarkdownToJSX.Overrides = {
  a: sanitizedAnchorOverride(),
  pre: MarkdownCodeBlock,
  table: MarkdownTableBlock,
  // CAN-4785: one image for all default markdown (every transcript host and
  // any caller without its own `img` override), so a failed load reads as
  // announced alt text instead of a bare broken-image icon.
  img: MarkdownImage,
  th: ({ children, ...props }: ComponentPropsWithoutRef<'th'>): JSX.Element => (
    <th {...props} {...markdownTableCellProps(children, true)}>
      {children}
    </th>
  ),
  td: ({ children, ...props }: ComponentPropsWithoutRef<'td'>): JSX.Element => (
    <td {...props} {...markdownTableCellProps(children)}>
      {children}
    </td>
  ),
  // Raw HTML is never parsed (`disableParsingRawHTML`), so the only input
  // the renderer emits is a GFM task-list marker: a read-only, disabled
  // checkbox drawn as the shared mark, kept inline with the item's text.
  input: ({
    checked,
    readOnly,
  }: ComponentPropsWithoutRef<'input'>): JSX.Element => (
    <span className="inline-flex pr-1.5 align-middle">
      <Checkbox checked={checked} readOnly={readOnly} disabled />
    </span>
  ),
};

/**
 * Shared defaults for every user-authored markdown surface.
 *
 * Raw HTML stays text-only, matching the previous renderer without `rehypeRaw`,
 * and expression evaluation remains disabled by markdown-to-jsx's secure
 * default. GFM features are built into markdown-to-jsx.
 */
export const DEFAULT_MARKDOWN_OPTIONS: MarkdownToJSX.Options = {
  wrapper: Fragment,
  forceBlock: true,
  disableFrontmatter: true,
  disableParsingRawHTML: true,
  enforceAtxHeadings: true,
  sanitizer: sanitizeMarkdownUrl,
  overrides: DEFAULT_MARKDOWN_OVERRIDES,
};

/**
 * Options for markdown produced by an agent (chat transcripts on desktop and in
 * Remote Control). Identical to {@link DEFAULT_MARKDOWN_OPTIONS} except that
 * filesystem paths never render as navigable site links.
 */
export const TRANSCRIPT_MARKDOWN_OPTIONS: MarkdownToJSX.Options = {
  ...DEFAULT_MARKDOWN_OPTIONS,
  overrides: {
    ...DEFAULT_MARKDOWN_OVERRIDES,
    a: TranscriptMarkdownAnchor,
  },
};

export type MarkdownOptions = MarkdownToJSX.Options & {
  /**
   * Opt-in for a custom anchor that resolves local file paths safely: Windows
   * drive paths and slash-less relative paths with a line suffix
   * (`README.md:12`).
   */
  allowLocalFileLinks?: boolean;
  /**
   * Keep `file:` link targets for a custom anchor that resolves them through
   * its host instead of navigating (Remote Control transcripts, CAN-3172).
   */
  allowFileUrlLinks?: boolean;
};
export type MarkdownOverrides = MarkdownToJSX.Overrides;

const SOFT_LINE_BREAK = /\r?\n/;

/**
 * Renders every single newline inside a text run as a `<br>` (CAN-2811).
 *
 * Markdown treats a lone newline as a soft break, and the browser collapses
 * it to a space — so a person who deliberately typed three lines saw one
 * paragraph in their own bubble. This is the equivalent of remark's
 * `breaks` for markdown-to-jsx, which exposes no such option: only text
 * nodes are touched, so fenced/indented code, inline code, hard breaks, and
 * blank-line paragraphs render exactly as before. Meant for user-authored
 * bubbles; agent prose keeps standard soft-break handling.
 */
export function withSoftLineBreaks(options: MarkdownOptions): MarkdownOptions {
  const configuredRenderRule = options.renderRule;
  return {
    ...options,
    renderRule(next, node, renderChildren, state): ReactNode {
      if (node.type === RuleType.text && SOFT_LINE_BREAK.test(node.text)) {
        // A flat list of strings and keyed `<br>`s, not fragments: hosts that
        // post-process a paragraph's children (the desktop mention decorator
        // transforms direct string children) must still see each line as a
        // plain string. `Children.toArray` flattens nested arrays but not
        // fragments.
        return node.text
          .split(SOFT_LINE_BREAK)
          .flatMap((line, index): ReactNode[] =>
            index > 0
              ? [<br key={`${state.key}-br-${index}`} />, line]
              : [line],
          );
      }
      return configuredRenderRule
        ? configuredRenderRule(next, node, renderChildren, state)
        : next();
    },
  };
}

export interface MarkdownProps {
  readonly children: string;
  readonly options?: MarkdownOptions;
  readonly streaming?: boolean;
  /**
   * Opt-in bounded mounting for large, immutable documents. Parsing still
   * completes synchronously so references and custom render rules remain
   * correct; only top-level React children are committed across frames.
   */
  readonly progressive?: {
    readonly minimumCharacters?: number;
    readonly initialBlocks?: number;
    readonly blocksPerFrame?: number;
  };
}

export function markdownOptions(
  overrides?: MarkdownOverrides,
  options?: MarkdownOptions,
): MarkdownOptions {
  const anchorOverride = overrides?.a ?? options?.overrides?.a;
  const allowance: LocalLinkAllowance = {
    windowsPaths:
      options?.allowLocalFileLinks === true && anchorOverride !== undefined,
    fileUrls:
      options?.allowFileUrlLinks === true && anchorOverride !== undefined,
  };
  const mergedOverrides: MarkdownOverrides = {
    ...DEFAULT_MARKDOWN_OVERRIDES,
    ...options?.overrides,
    ...overrides,
  };

  return {
    ...DEFAULT_MARKDOWN_OPTIONS,
    ...options,
    ...(allowance.windowsPaths || allowance.fileUrls
      ? {
          sanitizer: (value: string) =>
            isAllowedLocalLink(value, allowance)
              ? value
              : sanitizeMarkdownUrl(value),
        }
      : {}),
    overrides: {
      ...mergedOverrides,
      a: stableSanitizedAnchorOverride(anchorOverride, allowance),
    },
  };
}

export interface PreparedMarkdownRender {
  readonly markdown: string;
  readonly options: MarkdownOptions;
}

function fallbackDelimitedMathSource(
  expression: MarkdownMathExpression,
): string {
  return expression.display
    ? `$$${expression.source}$$`
    : `\\(${expression.source}\\)`;
}

function fencedMathSource(text: string): string {
  const source = text.endsWith('\r\n')
    ? text.slice(0, -2)
    : text.endsWith('\n')
      ? text.slice(0, -1)
      : text;
  return `$$\n${source}\n$$`;
}

export function prepareMarkdownRender(
  markdown: string,
  options?: MarkdownOptions,
  streaming = false,
): PreparedMarkdownRender {
  const preparedMath = prepareMarkdownMath(markdown, {
    singleDollar: isSingleDollarMathEnabled(),
  });
  const preparedOptions = markdownOptions(undefined, options);
  // Keep ordinary prose on the existing fast path, but Mermaid-only documents
  // must still install the code-block rule when there is no math.
  const hasMermaid = /mermaid/i.test(markdown);
  if (!preparedMath.hasMath && !hasMermaid) {
    return { markdown, options: preparedOptions };
  }

  const configuredRenderRule = preparedOptions.renderRule;
  const configuredSlugify = preparedOptions.slugify;
  let renderedExpressionCount = preparedMath.expressions.size;
  let renderedMermaidCount = 0;
  return {
    markdown: preparedMath.markdown,
    options: {
      ...preparedOptions,
      slugify(input, defaultSlugify): string {
        const restoredInput = restoreMarkdownMathSource(
          input,
          preparedMath.originalSources,
        );
        return configuredSlugify
          ? configuredSlugify(restoredInput, defaultSlugify)
          : defaultSlugify(restoredInput);
      },
      renderRule(next, node, renderChildren, state): ReactNode {
        if (
          node.type === RuleType.codeBlock &&
          node.lang?.toLowerCase() === 'mermaid' &&
          renderedMermaidCount < MAX_MERMAID_BLOCKS
        ) {
          renderedMermaidCount += 1;
          return (
            <MarkdownMermaid
              key={state.key}
              source={node.text}
              streaming={streaming}
            />
          );
        }
        let expression: MarkdownMathExpression | undefined;
        let source: string | undefined;
        if (node.type === RuleType.codeInline) {
          expression = preparedMath.expressions.get(node.text);
          if (expression) {
            source =
              preparedMath.originalSources.get(node.text) ??
              fallbackDelimitedMathSource(expression);
          }
        } else if (
          node.type === RuleType.codeBlock &&
          typeof node.lang === 'string' &&
          ['latex', 'math', 'tex'].includes(node.lang.toLowerCase()) &&
          node.text.trim().length > 0 &&
          node.text.length <= MAX_MATH_EXPRESSION_LENGTH &&
          renderedExpressionCount < MAX_MATH_EXPRESSIONS_PER_DOCUMENT
        ) {
          expression = { source: node.text, display: true };
          source = fencedMathSource(node.text);
          renderedExpressionCount += 1;
        }

        if (expression && source !== undefined) {
          return (
            <DeferredMarkdownMath
              expression={expression}
              source={source}
              key={state.key}
            />
          );
        }
        return configuredRenderRule
          ? configuredRenderRule(next, node, renderChildren, state)
          : next();
      },
    },
  };
}
