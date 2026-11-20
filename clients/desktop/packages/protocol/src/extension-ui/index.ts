/**
 * The element tree a Claude Mod's `ui.render` hook draws on a `desktop`
 * surface, as Claude Code 2.1.319 sends it in a `ui_render` response, and
 * the one closed union Canopy draws it from. Canopy extensions will draw the
 * same union. A tree comes from a local process Canopy does not trust, so it
 * reaches the UI only through {@link validateExtensionUiTree}.
 *
 * The 2.1.319 desktop element table is Box, Text, Button, Input, Select,
 * Svg, Link, Code, Markdown and Client, plus `engine` nodes. `Image` and
 * `Raster` are drawn by the terminal only. `Svg` and `Client` are left out
 * until their sites are built (site group M4), so they drop like an unknown
 * element. Every value is plain data: no host paths, no plugin roots, and no
 * raw CSS, HTML or `style`.
 */

/** Names the handler of a control in its plugin's hooks environment. */
export interface ExtensionUiPressRef {
  readonly plugin: string;
  readonly handle: number;
}

/** Spacing steps, mapped onto the app's spacing tokens by the view. */
export type ExtensionUiSpace = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

/** Ink a theme key resolves to; anything else draws the default ink. */
export type ExtensionUiTone =
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'accent'
  | 'positive'
  | 'attention'
  | 'destructive';

export type ExtensionUiChild = string | ExtensionUiNode;
export type ExtensionUiTextChild = string | ExtensionUiText | ExtensionUiLink;

export interface ExtensionUiBox {
  readonly type: 'Box';
  /** Like the terminal's, a Box lays out in a row unless it says otherwise. */
  readonly direction: 'row' | 'column' | 'row-reverse' | 'column-reverse';
  readonly gapX?: ExtensionUiSpace;
  readonly gapY?: ExtensionUiSpace;
  readonly paddingX?: ExtensionUiSpace;
  readonly paddingY?: ExtensionUiSpace;
  readonly wrap?: true;
  readonly grow?: true;
  readonly noShrink?: true;
  readonly clip?: true;
  readonly alignItems?: 'start' | 'center' | 'end' | 'stretch';
  readonly alignSelf?: 'start' | 'center' | 'end';
  readonly justify?: 'start' | 'center' | 'end' | 'between' | 'around';
  readonly border?: { readonly tone?: ExtensionUiTone };
  /** Whose drawing starts here, as the engine marked each hook's root. */
  readonly part?: { readonly plugin: string };
  readonly children: readonly ExtensionUiChild[];
}

export interface ExtensionUiText {
  readonly type: 'Text';
  readonly size: 'caption' | 'footnote' | 'body' | 'heading' | 'title';
  /** Canopy draws two weights; `medium`, `semibold` and `bold` are medium. */
  readonly weight: 'regular' | 'medium';
  readonly tone?: ExtensionUiTone;
  readonly dim?: true;
  readonly italic?: true;
  readonly underline?: true;
  readonly strikethrough?: true;
  readonly mono?: true;
  readonly tabular?: true;
  readonly rtl?: true;
  readonly truncate?: true;
  readonly part?: { readonly plugin: string };
  readonly children: readonly ExtensionUiTextChild[];
}

export interface ExtensionUiButton {
  readonly type: 'Button';
  readonly key: string;
  readonly label: string;
  readonly variant: 'primary' | 'secondary' | 'plain';
  readonly dim?: true;
  /** The site's own close control: the host draws it, never inline. */
  readonly dismiss?: true;
  readonly press: ExtensionUiPressRef;
}

export interface ExtensionUiInput {
  readonly type: 'Input';
  readonly key: string;
  readonly label?: string;
  readonly placeholder?: string;
  readonly value?: string;
  readonly submitLabel?: string;
  /** 1 for a single line; more for a field of several lines. */
  readonly rows: number;
  readonly press: ExtensionUiPressRef;
}

export interface ExtensionUiSelect {
  readonly type: 'Select';
  readonly key: string;
  readonly label?: string;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
  }[];
  readonly value?: string;
  readonly press: ExtensionUiPressRef;
}

/** A link that passed {@link isExtensionUiLinkAllowed}. */
export interface ExtensionUiLink {
  readonly type: 'Link';
  readonly href: string;
  /** What it draws: its children, else its label, else the URL. */
  readonly children: readonly (string | ExtensionUiText)[];
}

export interface ExtensionUiCode {
  readonly type: 'Code';
  readonly source: string;
  readonly language?: string;
  readonly format: 'source' | 'diff';
}

export interface ExtensionUiMarkdown {
  readonly type: 'Markdown';
  readonly text: string;
  readonly dim?: true;
  /** With `press`: the plugin answers these links itself. */
  readonly key?: string;
  readonly pressableLinks?: readonly string[];
  readonly press?: ExtensionUiPressRef;
}

/** Where the engine's own drawing of the site goes; the host decides. */
export interface ExtensionUiEngine {
  readonly type: 'engine';
  readonly ref: number;
}

export type ExtensionUiNode =
  | ExtensionUiBox
  | ExtensionUiText
  | ExtensionUiButton
  | ExtensionUiInput
  | ExtensionUiSelect
  | ExtensionUiLink
  | ExtensionUiCode
  | ExtensionUiMarkdown
  | ExtensionUiEngine;

/** What a drawn tree reports back, in the shape `ui_press`, `ui_input` and
 * `ui_select` carry. */
export type ExtensionUiCommand =
  | {
      readonly kind: 'press';
      readonly press: ExtensionUiPressRef;
      readonly key: string;
      /** For a link a Markdown element's plugin answers. */
      readonly href?: string;
    }
  | {
      readonly kind: 'input';
      readonly press: ExtensionUiPressRef;
      readonly key: string;
      readonly event: 'change' | 'submit';
      readonly value: string;
    }
  | {
      readonly kind: 'select';
      readonly press: ExtensionUiPressRef;
      readonly key: string;
      readonly value: string;
    };

export const EXTENSION_UI_LIMITS = Object.freeze({
  /** Deeper subtrees drop. */
  depth: 32,
  /** Nodes past this count drop, in document order. */
  nodes: 2000,
  /** Longer strings are cut, as the CLI bounds a field's text. */
  text: 16_384,
  /** A plugin name or element key past this drops its node. */
  name: 256,
});

export interface ExtensionUiValidation {
  /** `null` when the root itself could not be kept. */
  readonly tree: ExtensionUiNode | null;
  /** Something was dropped or cut on the way. */
  readonly trimmed: boolean;
}

/**
 * The Desktop link rules: `https:`, or `http:` on localhost, no `@`, and
 * spelled as the URL parser spells it (a bare origin may leave off its `/`).
 */
export function isExtensionUiLinkAllowed(href: string): boolean {
  if (href.length > 2048 || href.includes('@')) return false;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  const allowed =
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && url.hostname === 'localhost');
  return allowed && (url.href === href || url.href === `${href}/`);
}

// One table maps Claude Code's theme keys, and the theme allowlist's own
// `fg-*` names, onto the tones the view draws (08-shared-rendering-with-
// chat-visuals.md, "One theme contract"). A raw name or hex is never drawn.
const TONE_BY_KEY: Readonly<Record<string, ExtensionUiTone>> = {
  text: 'primary',
  inactive: 'tertiary',
  subtle: 'tertiary',
  claude: 'accent',
  suggestion: 'accent',
  permission: 'accent',
  success: 'positive',
  diffAdded: 'positive',
  diffAddedWord: 'positive',
  warning: 'attention',
  error: 'destructive',
  diffRemoved: 'destructive',
  diffRemovedWord: 'destructive',
  'fg-primary': 'primary',
  'fg-secondary': 'secondary',
  'fg-tertiary': 'tertiary',
  'fg-accent': 'accent',
  'fg-positive': 'positive',
  'fg-attention': 'attention',
  'fg-destructive': 'destructive',
};

// The engine's cell steps (2.1.319): a number of cells maps to the nearest
// step across (columns) or down (rows), as the terminal draws them.
const SPACES: readonly ExtensionUiSpace[] = ['xs', 'sm', 'md', 'lg', 'xl'];

function space(
  value: unknown,
  axis: 'across' | 'down',
): ExtensionUiSpace | undefined {
  if (typeof value === 'string') {
    return SPACES.find((step) => step === value);
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return undefined;
  }
  if (axis === 'down') return value < 2 ? 'lg' : 'xl';
  return value < 2 ? 'sm' : value < 3 ? 'lg' : 'xl';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T>(
  value: unknown,
  table: Readonly<Record<string, T>>,
): T | undefined {
  return typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(table, value)
    ? table[value]
    : undefined;
}

const DIRECTION = {
  row: 'row',
  column: 'column',
  'row-reverse': 'row-reverse',
  'column-reverse': 'column-reverse',
} as const;
const ALIGN_ITEMS = {
  'flex-start': 'start',
  center: 'center',
  'flex-end': 'end',
  stretch: 'stretch',
} as const;
const ALIGN_SELF = {
  'flex-start': 'start',
  center: 'center',
  'flex-end': 'end',
} as const;
const JUSTIFY = {
  'flex-start': 'start',
  center: 'center',
  'flex-end': 'end',
  'space-between': 'between',
  'space-around': 'around',
  'space-evenly': 'around',
} as const;
const SIZE = {
  caption: 'caption',
  footnote: 'footnote',
  body: 'body',
  heading: 'heading',
  title: 'title',
} as const;
const MEDIUM_WEIGHTS = new Set(['medium', 'semibold', 'bold']);
const TRUNCATING_WRAPS = new Set([
  'truncate',
  'truncate-end',
  'truncate-middle',
  'truncate-start',
  'end',
  'middle',
]);

// C0 and C1 controls other than tab and newline never reach the view.
const CONTROL_CHARACTERS = /[^\P{Cc}\t\n]/gu;

interface Budget {
  nodes: number;
  trimmed: boolean;
}

/** Spend one node of the tree's budget; false (and trimmed) once it is spent. */
function take(budget: Budget): boolean {
  if (budget.nodes >= EXTENSION_UI_LIMITS.nodes) {
    budget.trimmed = true;
    return false;
  }
  budget.nodes += 1;
  return true;
}

function text(value: unknown, budget: Budget): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(CONTROL_CHARACTERS, '');
  if (clean !== value || clean.length > EXTENSION_UI_LIMITS.text) {
    budget.trimmed = true;
  }
  return clean.slice(0, EXTENSION_UI_LIMITS.text);
}

function name(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value !== '' &&
    value.length <= EXTENSION_UI_LIMITS.name
    ? value
    : undefined;
}

function pressRef(value: unknown): ExtensionUiPressRef | undefined {
  if (!isRecord(value)) return undefined;
  const plugin = name(value.plugin);
  const { handle } = value;
  return plugin !== undefined &&
    typeof handle === 'number' &&
    Number.isSafeInteger(handle)
    ? { plugin, handle }
    : undefined;
}

function part(value: unknown): { plugin: string } | undefined {
  const plugin = isRecord(value) ? name(value.plugin) : undefined;
  return plugin === undefined ? undefined : { plugin };
}

function tone(value: unknown): ExtensionUiTone | undefined {
  return oneOf(value, TONE_BY_KEY);
}

function flag(value: unknown): true | undefined {
  return value === true ? true : undefined;
}

function children<T extends ExtensionUiChild>(
  value: unknown,
  depth: number,
  budget: Budget,
  keep: (child: ExtensionUiChild) => child is T,
): T[] {
  if (!Array.isArray(value)) return [];
  const kept: T[] = [];
  for (const child of value) {
    const next = node(child, depth + 1, budget);
    if (next === null) continue;
    if (keep(next)) kept.push(next);
    else budget.trimmed = true;
  }
  return kept;
}

const anyChild = (child: ExtensionUiChild): child is ExtensionUiChild =>
  typeof child === 'string' || typeof child === 'object';
const textChild = (child: ExtensionUiChild): child is ExtensionUiTextChild =>
  typeof child === 'string' || child.type === 'Text' || child.type === 'Link';
const linkChild = (
  child: ExtensionUiChild,
): child is string | ExtensionUiText =>
  typeof child === 'string' || child.type === 'Text';

/** One untrusted element, or `null` (with `budget.trimmed` set) to drop it. */
function node(
  value: unknown,
  depth: number,
  budget: Budget,
): ExtensionUiChild | null {
  if (depth > EXTENSION_UI_LIMITS.depth) {
    budget.trimmed = true;
    return null;
  }
  if (!take(budget)) return null;
  if (typeof value === 'string') return text(value, budget) ?? null;
  if (!isRecord(value)) {
    budget.trimmed = true;
    return null;
  }
  const props = isRecord(value.props) ? value.props : {};
  const read = oneOf(value.type, ELEMENT_READERS);
  const kept =
    read === undefined ? null : read({ value, props, depth, budget });
  if (kept === null) budget.trimmed = true;
  return kept;
}

/** One element as it arrived, with what its reader needs. */
interface ElementInput {
  readonly value: Record<string, unknown>;
  readonly props: Record<string, unknown>;
  readonly depth: number;
  readonly budget: Budget;
}

type ElementReader = (input: ElementInput) => ExtensionUiNode | null;

function readBox({
  value,
  props,
  depth,
  budget,
}: ElementInput): ExtensionUiBox | null {
  if (props.display === 'none') return null;
  return {
    type: 'Box',
    direction: oneOf(props.flexDirection, DIRECTION) ?? 'row',
    gapX: space(props.columnGap ?? props.gap, 'across'),
    gapY: space(props.rowGap ?? props.gap, 'down'),
    paddingX: space(props.paddingX ?? props.padding, 'across'),
    paddingY: space(props.paddingY ?? props.padding, 'down'),
    wrap: flag(props.flexWrap === 'wrap'),
    grow: flag(typeof props.flexGrow === 'number' && props.flexGrow > 0),
    noShrink: flag(props.flexShrink === 0),
    clip: flag(props.overflow === 'hidden'),
    alignItems: oneOf(props.alignItems, ALIGN_ITEMS),
    alignSelf: oneOf(props.alignSelf, ALIGN_SELF),
    justify: oneOf(props.justifyContent, JUSTIFY),
    border:
      props.borderStyle === undefined
        ? undefined
        : { tone: tone(props.borderColor) },
    part: part(value.part),
    children: children(value.children, depth, budget, anyChild),
  };
}

function isMediumWeight(props: Record<string, unknown>): boolean {
  // `bold` is deprecated since 2.1.299; it counts only without a `weight`.
  return typeof props.weight === 'string'
    ? MEDIUM_WEIGHTS.has(props.weight)
    : props.bold === true;
}

function readText({
  value,
  props,
  depth,
  budget,
}: ElementInput): ExtensionUiText {
  return {
    type: 'Text',
    size: oneOf(props.size, SIZE) ?? 'body',
    weight: isMediumWeight(props) ? 'medium' : 'regular',
    tone: tone(props.color),
    dim: flag(props.dimColor),
    italic: flag(props.italic),
    underline: flag(props.underline),
    strikethrough: flag(props.strikethrough),
    mono: flag(props.mono),
    tabular: flag(props.tabular),
    rtl: flag(props.dir === 'rtl'),
    truncate: flag(
      typeof props.wrap === 'string' && TRUNCATING_WRAPS.has(props.wrap),
    ),
    part: part(value.part),
    children: children(value.children, depth, budget, textChild),
  };
}

function readButton({
  value,
  props,
  budget,
}: ElementInput): ExtensionUiButton | null {
  const key = name(props.key);
  const label = text(props.label, budget);
  const press = pressRef(value.press);
  if (key === undefined || label === undefined || press === undefined) {
    return null;
  }
  const variant =
    props.plain === true
      ? 'plain'
      : props.variant === 'primary'
        ? 'primary'
        : 'secondary';
  return {
    type: 'Button',
    key,
    label,
    variant,
    dim: flag(props.dimColor),
    dismiss: flag(props.role === 'dismiss'),
    press,
  };
}

function readInput({
  value,
  props,
  budget,
}: ElementInput): ExtensionUiInput | null {
  const key = name(props.key);
  const press = pressRef(value.press);
  if (key === undefined || press === undefined) return null;
  const { rows } = props;
  return {
    type: 'Input',
    key,
    label: text(props.label, budget),
    placeholder: text(props.placeholder, budget),
    value: text(props.value, budget),
    submitLabel: text(props.submitLabel, budget),
    rows:
      typeof rows === 'number' && Number.isSafeInteger(rows) && rows > 1
        ? Math.min(rows, 48)
        : 1,
    press,
  };
}

function selectOptions(
  value: unknown,
  budget: Budget,
): ExtensionUiSelect['options'] {
  return (Array.isArray(value) ? value : [])
    .filter(isRecord)
    .flatMap((option) => {
      if (!take(budget)) return [];
      const optionValue = text(option.value, budget);
      if (optionValue === undefined) return [];
      return [
        {
          value: optionValue,
          label: text(option.label, budget) ?? optionValue,
        },
      ];
    });
}

function readSelect({
  value,
  props,
  budget,
}: ElementInput): ExtensionUiSelect | null {
  const key = name(props.key);
  const press = pressRef(value.press);
  const options = selectOptions(props.options, budget);
  const unique = new Set(options.map((option) => option.value));
  if (key === undefined || press === undefined) return null;
  // The CLI requires at least one option, each value once.
  if (options.length === 0 || unique.size !== options.length) return null;
  const selected = text(props.value, budget);
  return {
    type: 'Select',
    key,
    label: text(props.label, budget),
    options,
    value:
      selected !== undefined && unique.has(selected) ? selected : undefined,
    press,
  };
}

function readLink({
  value,
  props,
  depth,
  budget,
}: ElementInput): ExtensionUiLink | ExtensionUiText {
  const href = typeof props.href === 'string' ? props.href : '';
  const drawn = children(value.children, depth, budget, linkChild).map(
    (child) => (typeof child === 'string' ? child : unlinked(child, budget)),
  );
  const label = text(props.label, budget);
  // The URL shows only as cleaned, bounded text, like any other string.
  const shown = drawn.length > 0 ? drawn : [label ?? text(href, budget) ?? ''];
  if (isExtensionUiLinkAllowed(href)) {
    return { type: 'Link', href, children: shown };
  }
  // Not a link Canopy opens: its text stays, as plain text.
  budget.trimmed = true;
  return { type: 'Text', size: 'body', weight: 'regular', children: shown };
}

/** A link's text with every link inside it turned into its plain text. */
function unlinked(drawn: ExtensionUiText, budget: Budget): ExtensionUiText {
  return {
    ...drawn,
    children: drawn.children.map((child) => {
      if (typeof child === 'string') return child;
      if (child.type === 'Text') return unlinked(child, budget);
      budget.trimmed = true;
      return unlinked(
        {
          type: 'Text',
          size: 'body',
          weight: 'regular',
          children: child.children,
        },
        budget,
      );
    }),
  };
}

function readCode({ props, budget }: ElementInput): ExtensionUiCode | null {
  const source = text(props.source, budget);
  if (source === undefined) return null;
  const language =
    typeof props.language === 'string' &&
    /^[A-Za-z0-9_+#.-]{1,32}$/.test(props.language)
      ? props.language
      : undefined;
  return {
    type: 'Code',
    source,
    language,
    format: props.format === 'diff' ? 'diff' : 'source',
  };
}

function readMarkdown({
  value,
  props,
  budget,
}: ElementInput): ExtensionUiMarkdown | null {
  const markdown = text(props.text, budget);
  if (markdown === undefined) return null;
  const drawn: ExtensionUiMarkdown = {
    type: 'Markdown',
    text: markdown,
    dim: flag(props.dimColor),
  };
  // A plugin answers its links only through a keyed Markdown with a press.
  const key = name(props.key);
  const press = pressRef(value.press);
  if (key === undefined || press === undefined) return drawn;
  const links = Array.isArray(props.pressableLinks)
    ? props.pressableLinks.filter(
        (link): link is string =>
          typeof link === 'string' && link !== '' && take(budget),
      )
    : undefined;
  return {
    ...drawn,
    key,
    press,
    ...(links === undefined ? {} : { pressableLinks: links }),
  };
}

function readEngine({ value }: ElementInput): ExtensionUiEngine | null {
  const { ref } = value;
  return typeof ref === 'number' && Number.isSafeInteger(ref)
    ? { type: 'engine', ref }
    : null;
}

// Anything else drops: Svg, Client, the terminal-only elements, unknown
// ones, and the `div`, `span` and `b` that carry a raw `style`.
const ELEMENT_READERS: Readonly<Record<string, ElementReader>> = {
  Box: readBox,
  Text: readText,
  Button: readButton,
  Input: readInput,
  Select: readSelect,
  Link: readLink,
  Code: readCode,
  Markdown: readMarkdown,
  engine: readEngine,
};

/**
 * The site's own close control a validated tree carries (a Button with
 * `role: dismiss`), for the host to press when the person closes the site.
 */
export function findExtensionUiDismiss(
  tree: ExtensionUiNode | null,
): ExtensionUiCommand | null {
  if (tree === null) return null;
  if (tree.type === 'Button') {
    return tree.dismiss === true
      ? { kind: 'press', press: tree.press, key: tree.key }
      : null;
  }
  if (tree.type !== 'Box') return null;
  for (const child of tree.children) {
    if (typeof child === 'string') continue;
    const dismiss = findExtensionUiDismiss(child);
    if (dismiss !== null) return dismiss;
  }
  return null;
}

/** One Mod's part of a band, as the engine marked whose hook drew it. */
export interface ClaudeModBandPart {
  readonly plugin: string;
  readonly tree: ExtensionUiNode;
}

/** Whether a validated node draws anything; the engine's own drawing does not. */
function drawsSomething(node: ExtensionUiNode): boolean {
  if (node.type === 'engine') return false;
  if (node.type !== 'Box') return true;
  return node.children.some((child) =>
    typeof child === 'string' ? child.trim() !== '' : drawsSomething(child),
  );
}

/**
 * The Mod a node belongs to: a Box's or Text's hook root, or a control's own
 * press, which is all a standalone control at a band's root carries.
 */
function ownerOf(node: ExtensionUiNode): string | undefined {
  switch (node.type) {
    case 'Box':
    case 'Text':
      return node.part?.plugin;
    case 'Button':
    case 'Input':
    case 'Select':
      return node.press.plugin;
    case 'Markdown':
      return node.press?.plugin;
    default:
      return undefined;
  }
}

/**
 * A validated band split by the Mod whose hook drew each part, in drawing
 * order. A part inside another Mod's part stays in that part. A part that
 * draws nothing is left out, so a Mod that only passes the band on to the
 * next hook has no part.
 */
export function splitClaudeModBand(
  tree: ExtensionUiNode | null,
): readonly ClaudeModBandPart[] {
  const parts = new Map<string, ExtensionUiNode[]>();
  const visit = (node: ExtensionUiNode): void => {
    const plugin = ownerOf(node);
    if (plugin !== undefined) {
      if (drawsSomething(node)) {
        parts.set(plugin, [...(parts.get(plugin) ?? []), node]);
      }
      return;
    }
    if (node.type !== 'Box') return;
    for (const child of node.children) {
      if (typeof child !== 'string') visit(child);
    }
  };
  if (tree !== null) visit(tree);
  return [...parts].map(([plugin, nodes]) => {
    const [only] = nodes;
    return {
      plugin,
      tree:
        nodes.length === 1 && only !== undefined
          ? only
          : { type: 'Box', direction: 'column', children: nodes },
    };
  });
}

/** Turn an untrusted render tree into the closed union, within the limits. */
export function validateExtensionUiTree(input: unknown): ExtensionUiValidation {
  const budget: Budget = { nodes: 0, trimmed: false };
  const root = node(input, 0, budget);
  if (typeof root === 'string') {
    return {
      tree: { type: 'Text', size: 'body', weight: 'regular', children: [root] },
      trimmed: budget.trimmed,
    };
  }
  return { tree: root, trimmed: budget.trimmed };
}

/**
 * A Mod's line as the CLI bounds it: 10,000 characters, then an ellipsis.
 * Plain text, drawn as a text node, never as markup.
 */
export const CLAUDE_MOD_SURFACE_TEXT_LIMIT = 10_000;

/**
 * A fire-and-forget push a Claude Mod sends from a headless session (site
 * group M1): `$.ui.toast`, `$.ui.status` and `$.ui.log`. The plugin name is
 * the engine's, never the plugin's own.
 */
export type ClaudeModSurfacePush =
  | {
      readonly kind: 'toast';
      readonly plugin: string;
      readonly text: string;
      readonly timeoutMs: number;
    }
  | {
      readonly kind: 'status';
      readonly plugin: string;
      /** Replaces the plugin's one status line; `null` removes it. */
      readonly text: string | null;
    }
  | {
      readonly kind: 'log';
      readonly plugin: string;
      readonly text: string;
    };

/** A `system` message for a Mod's surface (`ui_*`): never transcript content. */
export function isClaudeModSurfaceMessage(message: unknown): boolean {
  return (
    isRecord(message) &&
    message.type === 'system' &&
    typeof message.subtype === 'string' &&
    message.subtype.startsWith('ui_')
  );
}

function surfaceText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(CONTROL_CHARACTERS, '');
  return clean.length > CLAUDE_MOD_SURFACE_TEXT_LIMIT
    ? `${clean.slice(0, CLAUDE_MOD_SURFACE_TEXT_LIMIT)}…`
    : clean;
}

const DEFAULT_TOAST_MS = 4000;

/**
 * The M1 push a `ui_toast`, `ui_status` or `ui_log` message carries (Claude
 * Code 2.1.319), or `null` for any other or malformed message.
 */
export function parseClaudeModSurfacePush(
  message: unknown,
): ClaudeModSurfacePush | null {
  if (!isRecord(message) || !isClaudeModSurfaceMessage(message)) return null;
  const plugin = name(message.plugin);
  if (plugin === undefined) return null;
  switch (message.subtype) {
    case 'ui_toast': {
      const text = surfaceText(message.text);
      const { timeout_ms: timeout } = message;
      return text === undefined
        ? null
        : {
            kind: 'toast',
            plugin,
            text,
            timeoutMs:
              typeof timeout === 'number' && Number.isFinite(timeout)
                ? Math.min(Math.max(Math.round(timeout), 1000), 30_000)
                : DEFAULT_TOAST_MS,
          };
    }
    case 'ui_status': {
      if (message.text === null) return { kind: 'status', plugin, text: null };
      const text = surfaceText(message.text);
      return text === undefined ? null : { kind: 'status', plugin, text };
    }
    case 'ui_log': {
      const text = surfaceText(message.text);
      return text === undefined ? null : { kind: 'log', plugin, text };
    }
    default:
      return null;
  }
}

/** One pane a Mod opened, as the CLI's roster lists it. */
export interface ClaudeModPane {
  /** 1 to 64 letters, digits, `_` and `-`, as the Mod opened it. */
  readonly id: string;
  readonly title: string;
  readonly plugin: string;
}

/** The panes a session's Mods have open (`ui_panes`, Claude Code 2.1.319). */
export interface ClaudeModPaneRoster {
  readonly panes: readonly ClaudeModPane[];
  readonly shownId: string | null;
  readonly focusedId: string | null;
  /** A pane that asks for the keyboard; honored only at an idle, empty composer. */
  readonly focusRequestedId: string | null;
}

export const EMPTY_CLAUDE_MOD_PANE_ROSTER: ClaudeModPaneRoster = Object.freeze({
  panes: [],
  shownId: null,
  focusedId: null,
  focusRequestedId: null,
});

const PANE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PANE_LIMIT = 32;

function paneId(value: unknown): string | null {
  return typeof value === 'string' && PANE_ID.test(value) ? value : null;
}

/**
 * The roster a `ui_panes` push or response carries, bounded: at most 32 panes,
 * each with a valid id, a plugin name and a title cut like any Mod text.
 */
export function parseClaudeModPaneRoster(value: unknown): ClaudeModPaneRoster {
  if (!isRecord(value)) return EMPTY_CLAUDE_MOD_PANE_ROSTER;
  const panes = (Array.isArray(value.panes) ? value.panes : [])
    .filter(isRecord)
    .flatMap((pane): ClaudeModPane[] => {
      const id = paneId(pane.id);
      const plugin = name(pane.plugin);
      const title = surfaceText(pane.title);
      return id === null || plugin === undefined
        ? []
        : [{ id, plugin, title: title || id }];
    })
    .slice(0, PANE_LIMIT);
  const open = (candidate: unknown): string | null => {
    const id = paneId(candidate);
    return id !== null && panes.some((pane) => pane.id === id) ? id : null;
  };
  return {
    panes,
    shownId: open(value.shown_id),
    focusedId: open(value.focused_id),
    focusRequestedId: open(value.focus_requested_id),
  };
}

/** A render site of the desktop surface (site group M2). */
export type ClaudeModSurfaceSite = 'band' | 'pane';

/** The most text a Mod's fill or copy, or a draft the composer reads, carries. */
export const CLAUDE_MOD_COMPOSER_TEXT_LIMIT = 1_000_000;

/** Where a Mod's fill places its text: over the draft, after it, or at the caret. */
export type ClaudeModComposerFillMode = 'replace' | 'append' | 'insert';

/**
 * A Mod's ask of a chat's composer (site group M3), which the desktop window
 * showing the chat answers.
 */
export type ClaudeModComposerRequest =
  | { readonly kind: 'read' }
  | {
      readonly kind: 'fill';
      readonly text: string;
      readonly mode: ClaudeModComposerFillMode;
      /**
       * Where the caret stands after the write, as a UTF-16 offset into the
       * whole draft; after the placed text when absent.
       */
      readonly cursor?: number;
    }
  | { readonly kind: 'copy'; readonly plugin: string; readonly text: string }
  | { readonly kind: 'selection' };

/** A desktop window's answer to a {@link ClaudeModComposerRequest}. */
export type ClaudeModComposerAnswer =
  | { readonly kind: 'read'; readonly text: string; readonly cursor: number }
  | { readonly kind: 'fill'; readonly filled: boolean }
  | { readonly kind: 'copy'; readonly copied: boolean }
  /** The selection in the chat's own transcript, `null` for none. */
  | { readonly kind: 'selection'; readonly text: string | null };

/** Something a Mod did to the chat's composer, which the person is shown. */
export type ClaudeModComposerAction = 'read' | 'fill' | 'copy';

/**
 * What a chat's Mod surface shows: a parsed push, or what the session's
 * bridge got from the CLI, the pane roster and a site's validated tree.
 */
export type ClaudeModSurfaceUpdate =
  | ClaudeModSurfacePush
  | {
      readonly kind: 'panes';
      readonly roster: ClaudeModPaneRoster;
      /**
       * The session's surface ended (it closed, restarted or fell back to
       * M1): its panes are gone with it, not closed by their Mods.
       */
      readonly reset?: true;
    }
  | {
      readonly kind: 'tree';
      readonly site: ClaudeModSurfaceSite;
      /** The pane's id; the band's is `above-prompt`. */
      readonly instanceId: string;
      /** `null` while the site draws nothing. */
      readonly tree: ExtensionUiNode | null;
    }
  | {
      /** A Mod moved a site's window, or a hook rewrote the person's move. */
      readonly kind: 'scroll';
      readonly site: ClaudeModSurfaceSite;
      readonly instanceId: string;
      /** The first content row to show, in rows of the code font. */
      readonly offset: number;
      /** Keep the window on the last rows as the tree grows. */
      readonly followEnd: boolean;
    }
  | {
      /** A Mod moved a site's focus ring onto one of its controls. */
      readonly kind: 'focus';
      readonly site: ClaudeModSurfaceSite;
      readonly instanceId: string;
      readonly element: ClaudeModSurfaceElement;
    }
  | {
      /**
       * From the client itself, never a session: what it held of the chat's
       * surface is no longer current (its paired desktop changed), so it
       * forgets it and asks again. Never relayed.
       */
      readonly kind: 'ended';
    }
  | {
      /**
       * A Mod's ask of the chat's composer, for the desktop window showing
       * the chat to answer with a `composer-answer`. The host withholds it
       * from every Remote Control controller (CAN-7436).
       */
      readonly kind: 'composer-request';
      readonly requestId: string;
      readonly request: ClaudeModComposerRequest;
      /**
       * When the asker stops waiting, in ms since the epoch (one machine's
       * clock): a window that gets the request later leaves it unanswered.
       */
      readonly expiresAt: number;
    }
  | {
      /**
       * The asker gave up a `composer-request` (the CLI cancelled it, its
       * wait ran out, or the surface ended): a window that has not acted
       * on it yet drops it. The host withholds it from every Remote Control
       * controller (CAN-7436).
       */
      readonly kind: 'composer-withdraw';
      readonly requestId: string;
    }
  | {
      /** A Mod read or filled the chat's draft, or copied text. */
      readonly kind: 'composer-activity';
      readonly action: ClaudeModComposerAction;
      /** The Mod, when the engine names it; `null` when it does not. */
      readonly plugin: string | null;
    };

/** A Button, Input or Select a Mod drew, as `ui_focus` names it. */
export interface ClaudeModSurfaceElement {
  readonly plugin: string;
  readonly key: string;
}

/** A Mod surface update, addressed to the chat whose session sent it. */
export interface ClaudeModSurfacePushEvent {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
  readonly push: ClaudeModSurfaceUpdate;
}

/**
 * What the person did on a chat's Mod surface, for the session's bridge to
 * send: a tree's press, input or pick, or a pane shown, focused or closed.
 */
export type ClaudeModSurfaceCommand =
  | ExtensionUiCommand
  | { readonly kind: 'pane-show'; readonly paneId: string }
  | { readonly kind: 'pane-focus'; readonly paneId: string | null }
  | { readonly kind: 'pane-close'; readonly paneId: string }
  | {
      readonly kind: 'pane-resize';
      readonly paneId: string;
      /** The panel's body in cells of the code font. */
      readonly columns: number;
      readonly rows: number;
    }
  | {
      /** The person scrolled a site, in rows of the code font. */
      readonly kind: 'scroll';
      readonly site: ClaudeModSurfaceSite;
      readonly instanceId: string;
      readonly offset: number;
      readonly by: number;
      readonly bodyRows: number;
      readonly contentRows: number;
    }
  | {
      /** The keyboard moved into, within or out of a site. */
      readonly kind: 'focus';
      readonly site: ClaudeModSurfaceSite;
      readonly instanceId: string;
      readonly isHeld: boolean;
      /** The control that took the ring, or `null` for the site itself. */
      readonly element: ClaudeModSurfaceElement | null;
    }
  | {
      /**
       * Send the chat's current surface again: pushes do not replay, so a
       * client that mounts late (a reloaded window, a web page) asks for it.
       */
      readonly kind: 'resend';
    }
  | {
      /**
       * A desktop window's answer to a `composer-request`. The host refuses
       * it from every Remote Control controller (CAN-7436).
       */
      readonly kind: 'composer-answer';
      readonly requestId: string;
      readonly answer: ClaudeModComposerAnswer;
    };

const SITE_ROWS = 1_000_000;
const BAND_INSTANCE = 'above-prompt';

function siteOf(
  site: unknown,
  instanceId: unknown,
): { site: ClaudeModSurfaceSite; instanceId: string } | null {
  if (site === 'band') {
    return instanceId === BAND_INSTANCE
      ? { site, instanceId: BAND_INSTANCE }
      : null;
  }
  const id = site === 'pane' ? paneId(instanceId) : null;
  return id === null ? null : { site: 'pane', instanceId: id };
}

function rows(value: unknown, min: number): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= min &&
    value <= SITE_ROWS
    ? value
    : null;
}

function elementOf(value: unknown): ClaudeModSurfaceElement | null {
  if (!isRecord(value)) return null;
  const plugin = name(value.plugin);
  const key = name(value.key);
  return plugin === undefined || key === undefined ? null : { plugin, key };
}

function readSiteCommand(
  value: Record<string, unknown>,
): ClaudeModSurfaceCommand | null {
  const where = siteOf(value.site, value.instanceId);
  if (where === null) return null;
  if (value.kind === 'focus') {
    if (typeof value.isHeld !== 'boolean') return null;
    const element = value.element === null ? null : elementOf(value.element);
    if (value.element !== null && element === null) return null;
    return { kind: 'focus', ...where, isHeld: value.isHeld, element };
  }
  const offset = rows(value.offset, 0);
  const by = rows(value.by, -SITE_ROWS);
  const bodyRows = rows(value.bodyRows, 0);
  const contentRows = rows(value.contentRows, 0);
  return offset === null ||
    by === null ||
    bodyRows === null ||
    contentRows === null
    ? null
    : { kind: 'scroll', ...where, offset, by, bodyRows, contentRows };
}

/**
 * The update a `ui_scroll` or `ui_focus` push carries for a site, or `null`
 * for another message or one addressed to another client.
 */
export function parseClaudeModSitePush(
  message: unknown,
  clientId: string,
): ClaudeModSurfaceUpdate | null {
  if (!isRecord(message) || message.client_id !== clientId) return null;
  const where = siteOf(
    message.component === 'Pane'
      ? 'pane'
      : message.component === 'AbovePrompt'
        ? 'band'
        : null,
    message.instance_id,
  );
  if (where === null) return null;
  if (message.subtype === 'ui_scroll') {
    const offset = rows(message.offset, 0);
    return offset === null
      ? null
      : {
          kind: 'scroll',
          ...where,
          offset,
          followEnd: message.follow_end === true,
        };
  }
  if (message.subtype === 'ui_focus') {
    const element = elementOf(message);
    return element === null ? null : { kind: 'focus', ...where, element };
  }
  return null;
}

/** The cell grid a Mod pane may report, from a narrow side panel to a wall. */
export const CLAUDE_MOD_PANE_CELLS = Object.freeze({
  columns: { min: 10, max: 1000 },
  rows: { min: 1, max: 500 },
});

function cells(
  value: unknown,
  bounds: { min: number; max: number },
): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= bounds.min &&
    value <= bounds.max
    ? value
    : null;
}

/** A command addressed to the chat whose Mod surface the person used. */
export interface ClaudeModSurfaceCommandArgs {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
  readonly command: ClaudeModSurfaceCommand;
}

function readPaneCommand(
  value: Record<string, unknown>,
): ClaudeModSurfaceCommand | null {
  if (value.kind === 'pane-focus' && value.paneId === null) {
    return { kind: 'pane-focus', paneId: null };
  }
  const id = paneId(value.paneId);
  if (id === null) return null;
  switch (value.kind) {
    case 'pane-show':
    case 'pane-close':
    case 'pane-focus':
      return { kind: value.kind, paneId: id };
    case 'pane-resize': {
      const columns = cells(value.columns, CLAUDE_MOD_PANE_CELLS.columns);
      const rows = cells(value.rows, CLAUDE_MOD_PANE_CELLS.rows);
      return columns === null || rows === null
        ? null
        : { kind: 'pane-resize', paneId: id, columns, rows };
    }
    default:
      return null;
  }
}

function readTreeCommand(
  value: Record<string, unknown>,
): ExtensionUiCommand | null {
  const press = pressRef(value.press);
  const key = name(value.key);
  if (press === undefined || key === undefined) return null;
  if (value.kind === 'press') {
    const href =
      typeof value.href === 'string' && value.href.length <= 2048
        ? value.href
        : undefined;
    return { kind: 'press', press, key, ...(href ? { href } : {}) };
  }
  const text = typeof value.value === 'string' ? value.value : undefined;
  if (text === undefined || text.length > EXTENSION_UI_LIMITS.text) return null;
  if (value.kind === 'select')
    return { kind: 'select', press, key, value: text };
  const event = value.event === 'submit' ? 'submit' : 'change';
  return { kind: 'input', press, key, event, value: text };
}

/** A command the renderer sends, checked before the bridge forwards it. */
export function parseClaudeModSurfaceCommand(
  value: unknown,
): ClaudeModSurfaceCommand | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case 'pane-show':
    case 'pane-focus':
    case 'pane-close':
    case 'pane-resize':
      return readPaneCommand(value);
    case 'press':
    case 'input':
    case 'select':
      return readTreeCommand(value);
    case 'scroll':
    case 'focus':
      return readSiteCommand(value);
    case 'resend':
      return { kind: 'resend' };
    case 'composer-answer': {
      const requestId = name(value.requestId);
      const answer = composerAnswer(value.answer);
      return requestId === undefined || answer === null
        ? null
        : { kind: 'composer-answer', requestId, answer };
    }
    default:
      return null;
  }
}

function composerText(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length <= CLAUDE_MOD_COMPOSER_TEXT_LIMIT
    ? value
    : undefined;
}

function composerAnswer(value: unknown): ClaudeModComposerAnswer | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case 'read': {
      const text = composerText(value.text);
      const cursor =
        text === undefined
          ? null
          : cells(value.cursor, { min: 0, max: text.length });
      return text === undefined || cursor === null
        ? null
        : { kind: 'read', text, cursor };
    }
    case 'fill':
      return typeof value.filled === 'boolean'
        ? { kind: 'fill', filled: value.filled }
        : null;
    case 'copy':
      return typeof value.copied === 'boolean'
        ? { kind: 'copy', copied: value.copied }
        : null;
    case 'selection': {
      if (value.text === null) return { kind: 'selection', text: null };
      const text = composerText(value.text);
      return text === undefined ? null : { kind: 'selection', text };
    }
    default:
      return null;
  }
}

/**
 * The composer request a CLI control request asks of a client that named it
 * in `ui_attach.answers` (Claude Code 2.1.319), or `null` for another or a
 * malformed one.
 */
export function parseClaudeModComposerRequest(
  value: unknown,
): ClaudeModComposerRequest | null {
  if (!isRecord(value)) return null;
  switch (value.subtype) {
    case 'ui_prompt_read':
      return { kind: 'read' };
    case 'ui_read_selection':
      return { kind: 'selection' };
    case 'ui_copy': {
      const plugin = name(value.plugin);
      const text = composerText(value.text);
      return plugin === undefined || text === undefined
        ? null
        : { kind: 'copy', plugin, text };
    }
    case 'ui_prompt_fill': {
      const text = composerText(value.text);
      const { mode } = value;
      if (
        text === undefined ||
        (mode !== 'replace' && mode !== 'append' && mode !== 'insert')
      ) {
        return null;
      }
      if (value.cursor === undefined) return { kind: 'fill', text, mode };
      const cursor = cells(value.cursor, {
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
      });
      return cursor === null ? null : { kind: 'fill', text, mode, cursor };
    }
    default:
      return null;
  }
}

/**
 * A surface update as it is relayed to another client: a site's tree goes as
 * the CLI rendered it, for the receiving client to validate. Validation
 * translates the CLI's tree into Canopy's own, so a validated tree cannot be
 * validated again.
 */
export type ClaudeModSurfaceRelayedUpdate =
  | Exclude<
      ClaudeModSurfaceUpdate,
      | { readonly kind: 'tree' }
      | { readonly kind: 'composer-request' }
      | { readonly kind: 'composer-withdraw' }
    >
  | {
      readonly kind: 'tree';
      readonly site: ClaudeModSurfaceSite;
      readonly instanceId: string;
      /** The CLI's own tree, or `null` while the site draws nothing. */
      readonly tree: unknown;
    };

/** A relayed surface update, addressed to the chat whose session sent it. */
export interface ClaudeModSurfaceRelayEvent {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
  readonly push: ClaudeModSurfaceRelayedUpdate;
}

/**
 * A surface update relayed to another client (the web Portal's
 * `portal.claude_mods.surface` event), checked on arrival with the bounds the
 * CLI's own messages get: a client draws only a tree it validated itself and
 * bounded text, whatever the relay carried.
 */
export function parseClaudeModSurfacePushEvent(
  value: unknown,
): ClaudeModSurfacePushEvent | null {
  if (!isRecord(value)) return null;
  const { projectId, worktreeId, chatId } = value;
  const push = parseRelayedUpdate(value.push);
  return typeof projectId === 'string' &&
    typeof worktreeId === 'string' &&
    typeof chatId === 'string' &&
    push !== null
    ? { projectId, worktreeId, chatId, push }
    : null;
}

function parseRelayedUpdate(value: unknown): ClaudeModSurfaceUpdate | null {
  if (!isRecord(value)) return null;
  const component =
    value.site === 'pane'
      ? 'Pane'
      : value.site === 'band'
        ? 'AbovePrompt'
        : null;
  const element = isRecord(value.element) ? value.element : {};
  switch (value.kind) {
    case 'toast':
    case 'status':
    case 'log':
      return parseClaudeModSurfacePush({
        type: 'system',
        subtype: `ui_${value.kind}`,
        plugin: value.plugin,
        text: value.text,
        timeout_ms: value.timeoutMs,
      });
    case 'panes': {
      const roster = isRecord(value.roster) ? value.roster : {};
      return {
        kind: 'panes',
        roster: parseClaudeModPaneRoster({
          panes: roster.panes,
          shown_id: roster.shownId,
          focused_id: roster.focusedId,
          focus_requested_id: roster.focusRequestedId,
        }),
        ...(value.reset === true ? { reset: true } : {}),
      };
    }
    case 'tree': {
      const where = siteOf(value.site, value.instanceId);
      return where === null
        ? null
        : {
            kind: 'tree',
            ...where,
            tree:
              value.tree === null
                ? null
                : validateExtensionUiTree(value.tree).tree,
          };
    }
    case 'scroll':
    case 'focus':
      // A relayed update is already this client's.
      return parseClaudeModSitePush(
        {
          subtype: `ui_${value.kind}`,
          client_id: '',
          component,
          instance_id: value.instanceId,
          offset: value.offset,
          follow_end: value.followEnd,
          plugin: element.plugin,
          key: element.key,
        },
        '',
      );
    case 'composer-activity': {
      const { action } = value;
      const plugin = value.plugin === null ? null : name(value.plugin);
      return (action === 'read' || action === 'fill' || action === 'copy') &&
        plugin !== undefined
        ? { kind: 'composer-activity', action, plugin }
        : null;
    }
    default:
      return null;
  }
}

/** The chat and command the renderer sent; the host still checks the ids. */
export function parseClaudeModSurfaceCommandArgs(
  value: unknown,
): ClaudeModSurfaceCommandArgs | null {
  if (!isRecord(value)) return null;
  const { projectId, worktreeId, chatId } = value;
  const command = parseClaudeModSurfaceCommand(value.command);
  return typeof projectId === 'string' &&
    typeof worktreeId === 'string' &&
    typeof chatId === 'string' &&
    command !== null
    ? { projectId, worktreeId, chatId, command }
    : null;
}
