import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  EXTENSION_UI_LIMITS,
  isExtensionUiLinkAllowed,
  type ExtensionUiBox,
  type ExtensionUiChild,
  type ExtensionUiCode,
  type ExtensionUiCommand,
  type ExtensionUiInput,
  type ExtensionUiLink,
  type ExtensionUiMarkdown,
  type ExtensionUiNode,
  type ExtensionUiSelect,
  type ExtensionUiSpace,
  type ExtensionUiText,
  type ExtensionUiTone,
} from '@canopy/protocol/extension-ui';
import {
  Button,
  FormField,
  Heading,
  Markdown,
  markdownOptions,
  Select,
  TextArea,
  TextInput,
  type HeadingTone,
} from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

export interface ExtensionTreeViewProps {
  /** A tree `validateExtensionUiTree` returned; never an unvalidated one. */
  readonly tree: ExtensionUiNode;
  /** A press, an edit or a pick, for the host to send back to its plugin. */
  readonly onCommand: (command: ExtensionUiCommand) => void;
  /** Opens an allowed link through the host's external-link path. */
  readonly onOpenLink: (url: string) => void;
}

interface TreeHost {
  readonly onCommand: ExtensionTreeViewProps['onCommand'];
  readonly onOpenLink: ExtensionTreeViewProps['onOpenLink'];
}

/** A Button, Input or Select a plugin drew, as a focus ring names it. */
export interface ExtensionUiControlName {
  readonly plugin: string;
  readonly key: string;
}

const CONTROL_SELECTOR = '[data-extension-ui-key]';
const FOCUSABLE = ['button', 'input', 'textarea'].map(
  (tag) => `${tag}:not(:disabled)`,
);
const FOCUSABLE_SELECTOR = FOCUSABLE.join(', ');
const CONTROL_FOCUSABLE_SELECTOR = FOCUSABLE.map(
  (focusable) => `${CONTROL_SELECTOR} ${focusable}`,
).join(', ');

/** Names a control for a host that follows the focus ring. */
function Control({
  plugin,
  name,
  children,
}: {
  readonly plugin: string;
  readonly name: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      className="contents"
      data-extension-ui-plugin={plugin}
      data-extension-ui-key={name}
    >
      {children}
    </div>
  );
}

/** The control an element of a drawn tree belongs to, if any. */
export function findExtensionUiControl(
  element: Element | null,
): ExtensionUiControlName | null {
  const control = element?.closest<HTMLElement>(CONTROL_SELECTOR);
  const plugin = control?.dataset.extensionUiPlugin;
  const key = control?.dataset.extensionUiKey;
  return plugin === undefined || key === undefined ? null : { plugin, key };
}

/** Focuses the first control drawn under `container`; `false` without one. */
export function focusFirstExtensionUiControl(container: HTMLElement): boolean {
  const target = container.querySelector<HTMLElement>(
    CONTROL_FOCUSABLE_SELECTOR,
  );
  target?.focus();
  return target !== null;
}

/**
 * Focuses a control drawn under `container`; `false` when it draws no such
 * control, or the control can't take the keyboard.
 */
export function focusExtensionUiControl(
  container: HTMLElement,
  name: ExtensionUiControlName,
): boolean {
  for (const control of container.querySelectorAll<HTMLElement>(
    CONTROL_SELECTOR,
  )) {
    if (
      control.dataset.extensionUiPlugin !== name.plugin ||
      control.dataset.extensionUiKey !== name.key
    ) {
      continue;
    }
    const target = control.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    if (target === null) return false;
    target.focus();
    return true;
  }
  return false;
}

// One table per prop, onto the shared spacing, ink and line tokens. A Mod
// names steps and theme keys only; the validator dropped everything else.
const SPACE_GAP_X: Readonly<Record<ExtensionUiSpace, string>> = {
  xs: 'gap-x-1',
  sm: 'gap-x-2',
  md: 'gap-x-3',
  lg: 'gap-x-4',
  xl: 'gap-x-6',
};
const SPACE_GAP_Y: Readonly<Record<ExtensionUiSpace, string>> = {
  xs: 'gap-y-1',
  sm: 'gap-y-2',
  md: 'gap-y-3',
  lg: 'gap-y-4',
  xl: 'gap-y-6',
};
const SPACE_PADDING_X: Readonly<Record<ExtensionUiSpace, string>> = {
  xs: 'px-1',
  sm: 'px-2',
  md: 'px-3',
  lg: 'px-4',
  xl: 'px-6',
};
const SPACE_PADDING_Y: Readonly<Record<ExtensionUiSpace, string>> = {
  xs: 'py-1',
  sm: 'py-2',
  md: 'py-3',
  lg: 'py-4',
  xl: 'py-6',
};
const DIRECTION_CLASS: Readonly<Record<ExtensionUiBox['direction'], string>> = {
  row: 'flex-row',
  column: 'flex-col',
  'row-reverse': 'flex-row-reverse',
  'column-reverse': 'flex-col-reverse',
};
const ALIGN_ITEMS_CLASS: Readonly<
  Record<NonNullable<ExtensionUiBox['alignItems']>, string>
> = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
  stretch: 'items-stretch',
};
const ALIGN_SELF_CLASS: Readonly<
  Record<NonNullable<ExtensionUiBox['alignSelf']>, string>
> = { start: 'self-start', center: 'self-center', end: 'self-end' };
const JUSTIFY_CLASS: Readonly<
  Record<NonNullable<ExtensionUiBox['justify']>, string>
> = {
  start: 'justify-start',
  center: 'justify-center',
  end: 'justify-end',
  between: 'justify-between',
  around: 'justify-around',
};
const TONE_CLASS: Readonly<Record<ExtensionUiTone, string>> = {
  primary: 'fg-primary',
  secondary: 'fg-secondary',
  tertiary: 'fg-tertiary',
  accent: 'fg-accent',
  positive: 'fg-positive',
  attention: 'fg-attention',
  destructive: 'fg-destructive',
};
const BORDER_CLASS: Readonly<Record<ExtensionUiTone, string>> = {
  primary: 'border-line-primary',
  secondary: 'border-line-secondary',
  tertiary: 'border-line-tertiary',
  accent: 'border-line-accent',
  positive: 'border-line-positive',
  attention: 'border-line-attention',
  destructive: 'border-line-destructive',
};
const HEADING_TONE: Partial<Record<ExtensionUiTone, HeadingTone>> = {
  tertiary: 'muted',
  positive: 'success',
  attention: 'warning',
  destructive: 'destructive',
};

// A button keeps its own width where a column Box would stretch it.
const TREE_BUTTON_PLACEMENT = 'w-fit';

function classes(...names: readonly (string | false | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

function boxClass(box: ExtensionUiBox): string {
  return classes(
    'flex min-w-0',
    DIRECTION_CLASS[box.direction],
    box.gapX && SPACE_GAP_X[box.gapX],
    box.gapY && SPACE_GAP_Y[box.gapY],
    box.paddingX && SPACE_PADDING_X[box.paddingX],
    box.paddingY && SPACE_PADDING_Y[box.paddingY],
    box.wrap && 'flex-wrap',
    box.grow && 'flex-1',
    box.noShrink && 'shrink-0',
    box.clip && 'overflow-hidden',
    box.alignItems && ALIGN_ITEMS_CLASS[box.alignItems],
    box.alignSelf && ALIGN_SELF_CLASS[box.alignSelf],
    box.justify && JUSTIFY_CLASS[box.justify],
    box.border &&
      classes('rounded-md border', BORDER_CLASS[box.border.tone ?? 'primary']),
  );
}

function textClass(text: ExtensionUiText, outermost: boolean): string {
  return classes(
    outermost && REPLAY_BLOCK_CLASS,
    // Truncation sets its own white-space; a wrap class would override it.
    outermost && !text.truncate && 'whitespace-pre-wrap break-words',
    (text.size === 'caption' || text.size === 'footnote') && 'text-xs',
    text.weight === 'medium' && 'font-medium',
    text.tone
      ? TONE_CLASS[text.tone]
      : text.dim || text.size === 'caption'
        ? 'fg-tertiary'
        : undefined,
    text.italic && 'italic',
    text.underline && 'underline',
    text.strikethrough && 'line-through',
    text.mono && 'font-mono',
    text.tabular && 'tabular-nums',
    text.truncate && 'block min-w-0 truncate',
  );
}

function renderChildren(
  children: readonly ExtensionUiChild[],
  host: TreeHost,
): ReactNode[] {
  return children.map((child, index) => renderChild(child, host, index));
}

function renderChild(
  child: ExtensionUiChild,
  host: TreeHost,
  index: number,
): ReactNode {
  if (typeof child === 'string') {
    return (
      <span
        key={index}
        className={classes(
          REPLAY_BLOCK_CLASS,
          'whitespace-pre-wrap break-words',
        )}
      >
        {child}
      </span>
    );
  }
  return renderNode(child, host, index);
}

function renderText(
  text: ExtensionUiText,
  host: TreeHost,
  key: number,
  outermost: boolean,
): ReactNode {
  const content = text.children.map((child, index) =>
    typeof child === 'string'
      ? child
      : child.type === 'Link'
        ? renderLink(child, host, index)
        : renderText(child, host, index, false),
  );
  const dir = text.rtl ? 'rtl' : undefined;
  if (outermost && (text.size === 'heading' || text.size === 'title')) {
    const tone = text.tone && HEADING_TONE[text.tone];
    return (
      <div key={key} className={REPLAY_BLOCK_CLASS} dir={dir}>
        <Heading
          level={3}
          variant={text.size === 'title' ? 'section' : 'title'}
          {...(tone ? { tone } : {})}
          truncate={text.truncate === true}
        >
          {content}
        </Heading>
      </div>
    );
  }
  return (
    <span key={key} className={textClass(text, outermost)} dir={dir}>
      {content}
    </span>
  );
}

function renderLink(
  link: ExtensionUiLink,
  host: TreeHost,
  key: number,
): ReactNode {
  const children = link.children.map((child, index) =>
    typeof child === 'string' ? child : renderText(child, host, index, false),
  );
  // The host validated the tree, but a directly controlled computer's trees
  // reach the browser unparsed: a link the allow rule refuses is plain text,
  // as in markdown.
  if (!isExtensionUiLinkAllowed(link.href)) {
    return <span key={key}>{children}</span>;
  }
  return (
    <Button
      key={key}
      variant="link"
      className={TREE_BUTTON_PLACEMENT}
      onClick={(event): void => {
        // Only the link pressed opens, never one around it.
        event.stopPropagation();
        host.onOpenLink(link.href);
      }}
    >
      {children}
    </Button>
  );
}

function renderNode(
  node: ExtensionUiNode,
  host: TreeHost,
  key: number,
): ReactNode {
  switch (node.type) {
    case 'Box':
      return (
        <div key={key} className={boxClass(node)}>
          {renderChildren(node.children, host)}
        </div>
      );
    case 'Text':
      return renderText(node, host, key, true);
    case 'Link':
      return renderLink(node, host, key);
    case 'Button':
      // The site's own close control is the host's to draw.
      if (node.dismiss) return null;
      return (
        <Control key={key} plugin={node.press.plugin} name={node.key}>
          <Button
            className={TREE_BUTTON_PLACEMENT}
            variant={node.variant === 'plain' ? 'ghost' : node.variant}
            onClick={(): void =>
              host.onCommand({
                kind: 'press',
                press: node.press,
                key: node.key,
              })
            }
          >
            {node.label}
          </Button>
        </Control>
      );
    // A field keeps its unsent text across redraws by its own key, not by
    // where it sits (the CLI refuses two fields of one key in a tree).
    case 'Input':
      return (
        <Control
          key={`input:${node.key}`}
          plugin={node.press.plugin}
          name={node.key}
        >
          <TreeInput node={node} host={host} />
        </Control>
      );
    case 'Select':
      return (
        <Control
          key={`select:${node.key}`}
          plugin={node.press.plugin}
          name={node.key}
        >
          <TreeSelect node={node} host={host} />
        </Control>
      );
    case 'Code':
      return <TreeCode key={key} node={node} />;
    case 'Markdown':
      return <TreeMarkdown key={key} node={node} host={host} />;
    case 'engine':
      // The engine's own drawing of the site: nothing to draw here.
      return null;
  }
}

function TreeInput({
  node,
  host,
}: {
  readonly node: ExtensionUiInput;
  readonly host: TreeHost;
}): JSX.Element {
  const [value, setValue] = useState(node.value ?? '');
  // The plugin's value wins when it draws a new one.
  useEffect(() => setValue(node.value ?? ''), [node.value]);
  const send = (event: 'change' | 'submit', next: string): void =>
    host.onCommand({
      kind: 'input',
      press: node.press,
      key: node.key,
      event,
      value: next,
    });
  const change = (typed: string): void => {
    // The CLI takes no longer value; maxLength holds typing, this a paste.
    const next = typed.slice(0, EXTENSION_UI_LIMITS.text);
    setValue(next);
    send('change', next);
  };
  // As Claude Code's own field: Enter submits, Shift+Enter types a newline,
  // and the Enter that confirms an IME composition only confirms it.
  const submitOnEnter = (
    event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ): void => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    send('submit', value);
  };
  const field = (id: string | undefined): JSX.Element =>
    node.rows > 1 ? (
      <TextArea
        id={id}
        rows={node.rows}
        value={value}
        maxLength={EXTENSION_UI_LIMITS.text}
        placeholder={node.placeholder}
        aria-label={node.label ? undefined : (node.placeholder ?? node.key)}
        onChange={(event): void => change(event.target.value)}
        onKeyDown={submitOnEnter}
      />
    ) : (
      <TextInput
        id={id}
        value={value}
        maxLength={EXTENSION_UI_LIMITS.text}
        placeholder={node.placeholder}
        aria-label={node.label ? undefined : (node.placeholder ?? node.key)}
        onChange={(event): void => change(event.target.value)}
        onKeyDown={submitOnEnter}
      />
    );
  const row = (id: string | undefined): JSX.Element => (
    <div className="flex min-w-0 items-center gap-2">
      <div className="min-w-0 flex-1">{field(id)}</div>
      {node.submitLabel ? (
        <Button variant="secondary" onClick={(): void => send('submit', value)}>
          {node.submitLabel}
        </Button>
      ) : null}
    </div>
  );
  return node.label ? (
    <FormField label={node.label}>{({ id }): JSX.Element => row(id)}</FormField>
  ) : (
    row(undefined)
  );
}

function TreeSelect({
  node,
  host,
}: {
  readonly node: ExtensionUiSelect;
  readonly host: TreeHost;
}): JSX.Element {
  const select = (id: string | undefined): JSX.Element => (
    <Select
      {...(id ? { id } : { 'aria-label': node.key })}
      options={node.options}
      value={node.value ?? null}
      onValueChange={(value): void =>
        host.onCommand({
          kind: 'select',
          press: node.press,
          key: node.key,
          value,
        })
      }
    />
  );
  return node.label ? (
    <FormField label={node.label}>
      {({ id }): JSX.Element => select(id)}
    </FormField>
  ) : (
    select(undefined)
  );
}

/** A fence longer than any run of backticks in the source. */
function fenced(code: ExtensionUiCode): string {
  const longest = Math.max(
    0,
    ...(code.source.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const language = code.format === 'diff' ? 'diff' : (code.language ?? '');
  return `${fence}${language}\n${code.source}\n${fence}`;
}

function TreeCode({ node }: { readonly node: ExtensionUiCode }): JSX.Element {
  // Built on first draw, not on import: a module that imports this view
  // never needs the Markdown renderer until a Mod draws code.
  const options = useMemo(() => markdownOptions(), []);
  return (
    <div className={REPLAY_BLOCK_CLASS}>
      <Markdown options={options}>{fenced(node)}</Markdown>
    </div>
  );
}

function TreeMarkdown({
  node,
  host,
}: {
  readonly node: ExtensionUiMarkdown;
  readonly host: TreeHost;
}): JSX.Element {
  // The CLI sends fresh handles on every redraw. The link override reads them
  // here instead of closing over them, so it stays one component type and a
  // pressed link keeps its focus across the redraw its press brings.
  const latest = useRef(node);
  latest.current = node;
  const answersLinks = node.key !== undefined && node.press !== undefined;
  const linksKey = node.pressableLinks?.join('\u0000') ?? null;
  const options = useMemo(() => {
    // The plugin's own targets reach it as written (`mod:run` too): the
    // shared Markdown would otherwise strip a scheme it can't navigate to.
    const links = linksKey === null ? null : linksKey.split('\u0000');
    const isPressable = (href: string): boolean =>
      links === null || links.includes(href);
    const pressLink = (href: string): void => {
      const { key, press } = latest.current;
      if (key !== undefined && press !== undefined) {
        host.onCommand({ kind: 'press', press, key, href });
      }
    };
    return markdownOptions(
      {
        a({ href, children }: ComponentPropsWithoutRef<'a'>): JSX.Element {
          const target = typeof href === 'string' ? href : '';
          if (answersLinks && target !== '' && isPressable(target)) {
            return (
              <Button variant="link" onClick={(): void => pressLink(target)}>
                {children}
              </Button>
            );
          }
          return isExtensionUiLinkAllowed(target) ? (
            <Button
              variant="link"
              onClick={(): void => host.onOpenLink(target)}
            >
              {children}
            </Button>
          ) : (
            <span>{children}</span>
          );
        },
        // A Mod's markdown never loads an image: its text stands in.
        img({ alt }: ComponentPropsWithoutRef<'img'>): JSX.Element {
          return <span>{alt}</span>;
        },
      },
      answersLinks ? { keepLinkTarget: isPressable } : undefined,
    );
  }, [answersLinks, host, linksKey]);
  return (
    <div className={classes(REPLAY_BLOCK_CLASS, node.dim && 'fg-tertiary')}>
      <Markdown options={options}>{node.text}</Markdown>
    </div>
  );
}

/**
 * Draws a validated Mod or extension element tree with the shared
 * components and tokens. Text content carries the session-replay block
 * class; controls do not. Nothing in the tree reaches a style, and a link
 * opens only through `onOpenLink`.
 */
export function ExtensionTreeView({
  tree,
  onCommand,
  onOpenLink,
}: ExtensionTreeViewProps): JSX.Element {
  // One host for the view's life, calling the latest callbacks, so inline
  // callbacks from the host page never remount the tree's links.
  const callbacks = useRef({ onCommand, onOpenLink });
  callbacks.current = { onCommand, onOpenLink };
  const host = useMemo(
    (): TreeHost => ({
      onCommand: (command): void => callbacks.current.onCommand(command),
      onOpenLink: (url): void => callbacks.current.onOpenLink(url),
    }),
    [],
  );
  return (
    <div className="min-w-0 text-s fg-primary">{renderNode(tree, host, 0)}</div>
  );
}
