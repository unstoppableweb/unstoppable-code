'use client';

import type {
  ComponentPropsWithRef,
  ComponentPropsWithoutRef,
  JSX,
} from 'react';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { AnsiOutput, type AnsiOutputProps } from './AnsiOutput';
import { MarkdownCodeBlock } from './MarkdownCodeBlock';
import { SURFACE_VARIANT_CLASS } from './Surface';

/**
 * What a plain block is. The variant picks the fill, corners, and padding
 * together; pick it by role, never by the look you want.
 *
 * - `bare`: text only, inside a host that draws the box.
 * - `row`: a padded section of a card, such as a tool's input or output.
 * - `snippet`: a small command or value inside a row.
 * - `panel`: the code-block fill, the same surface as an ANSI log. The
 *   default, for a block that stands alone on the page fill.
 * - `tint`: a panel on a card or dialog, where a tint over the host reads and
 *   the code-block fill would not.
 * - `well`: the page fill, for a block on a surface with the code-block fill.
 * - `card`: a standalone document on a page, such as published instructions.
 * - `pane`: a full-height file view that runs edge to edge.
 * - `warning`: warning output, such as a notebook's standard error.
 */
export type CodeBlockVariant =
  | 'bare'
  | 'row'
  | 'snippet'
  | 'panel'
  | 'tint'
  | 'well'
  | 'card'
  | 'pane'
  | 'warning';

/** The type size. `inherit` takes the size of the text around the block. */
export type CodeBlockSize = 'inherit' | '2xs' | 'xs' | 's';

/**
 * How long lines behave. `none` keeps them and scrolls sideways, `words`
 * breaks at word ends, `all` breaks anywhere (paths, hashes, and tool output),
 * and `anywhere` also lets the block shrink below its longest word.
 */
export type CodeBlockWrap = 'none' | 'words' | 'all' | 'anywhere';

/** The ink. `soft` is primary at 80%, and `inherit` keeps the host's ink. */
export type CodeBlockTone =
  | 'inherit'
  | 'primary'
  | 'soft'
  | 'secondary'
  | 'tertiary'
  | 'destructive'
  | 'warning';

/**
 * `block` keeps the content out of session replay. `inherit` adds no marker,
 * for public text and for content an enclosing block already protects.
 */
export type CodeBlockReplay = 'block' | 'inherit';

const VARIANT_CLASS_NAMES: Record<CodeBlockVariant, string> = {
  bare: '',
  row: 'px-2.5 py-2',
  snippet: 'rounded bg-base/80 px-2 py-1',
  panel: 'rounded-md bg-secondary p-3',
  tint: 'rounded-md bg-subtle p-3',
  well: 'rounded-md bg-base p-3',
  card: `rounded-xl p-4 ${SURFACE_VARIANT_CLASS.card}`,
  pane: 'px-4 py-3 leading-5',
  warning: 'bg-warning-subtle px-2 py-1',
};

const DEFAULT_SIZES: Record<CodeBlockVariant, CodeBlockSize> = {
  bare: 'xs',
  row: 'xs',
  snippet: '2xs',
  panel: 'xs',
  tint: 'xs',
  well: 'xs',
  card: 's',
  pane: 'xs',
  warning: 'xs',
};

const SIZE_CLASS_NAMES: Record<CodeBlockSize, string> = {
  inherit: '',
  '2xs': 'text-2xs',
  xs: 'text-xs',
  s: 'text-s',
};

const WRAP_CLASS_NAMES: Record<CodeBlockWrap, string> = {
  none: 'whitespace-pre',
  words: 'whitespace-pre-wrap break-words',
  all: 'whitespace-pre-wrap break-all',
  anywhere: 'whitespace-pre-wrap wrap-anywhere',
};

const TONE_CLASS_NAMES: Record<CodeBlockTone, string> = {
  inherit: '',
  primary: 'fg-primary',
  soft: 'fg-primary/80',
  secondary: 'fg-secondary',
  tertiary: 'fg-tertiary',
  destructive: 'fg-destructive/80',
  warning: 'fg-warning',
};

export interface PlainCodeBlockProps extends ComponentPropsWithRef<'pre'> {
  format?: 'plain';
  /** What the block is for (default: `panel`). */
  variant?: CodeBlockVariant;
  /** Replaces the variant's type size. */
  size?: CodeBlockSize;
  /** A 20px line height, for long blocks people read line by line. */
  relaxed?: boolean;
  /** How long lines behave (default: `words`). */
  wrap?: CodeBlockWrap;
  /** The ink (default: `secondary`). */
  tone?: CodeBlockTone;
  /** `sans` is for verbatim prose: instructions, prompts, a quoted passage. */
  font?: 'mono' | 'sans';
  /** Whether the block marks its content for session replay (default: `block`). */
  replay?: CodeBlockReplay;
  /** `hidden` clips a collapsed block; the block scrolls otherwise. */
  overflow?: 'auto' | 'hidden';
  /** Keeps the text selectable inside a host that turns selection off. */
  selectable?: boolean;
  /** Placement and height in the host. The surface is not the caller's. */
  className?: string;
}

export interface AnsiCodeBlockProps extends AnsiOutputProps {
  format: 'ansi';
}

export interface MarkdownCodeBlockProps extends ComponentPropsWithoutRef<'pre'> {
  format: 'markdown';
}

export type CodeBlockProps =
  | PlainCodeBlockProps
  | AnsiCodeBlockProps
  | MarkdownCodeBlockProps;

/** `format` picks the renderer; it never reaches the DOM. */
function withoutFormat<Props extends { format?: string }>(
  props: Props,
): Omit<Props, 'format'> {
  const { format, ...rest } = props;
  void format;
  return rest;
}

function PlainCodeBlock({
  variant = 'panel',
  size = DEFAULT_SIZES[variant],
  relaxed = false,
  wrap = 'words',
  tone = 'secondary',
  font = 'mono',
  replay = 'block',
  overflow = 'auto',
  selectable = false,
  className = '',
  ...props
}: Omit<PlainCodeBlockProps, 'format'>): JSX.Element {
  const classes = [
    replay === 'block' ? REPLAY_BLOCK_CLASS : '',
    overflow === 'auto' ? 'overflow-auto' : 'overflow-hidden',
    font === 'mono' ? 'font-mono' : 'font-sans',
    VARIANT_CLASS_NAMES[variant],
    SIZE_CLASS_NAMES[size],
    relaxed ? 'leading-5' : '',
    WRAP_CLASS_NAMES[wrap],
    TONE_CLASS_NAMES[tone],
    selectable ? 'select-text' : '',
    className,
  ];
  return <pre {...props} className={classes.filter(Boolean).join(' ')} />;
}

/**
 * The one code block for Markdown, ANSI, and plain output.
 *
 * - `plain` (the default) renders text verbatim. See {@link CodeBlockVariant}.
 * - `ansi` renders terminal lines with their colors, converts only the lines
 *   that changed, follows the tail, and always blocks session replay.
 * - `markdown` is the fenced-code chrome with its copy button.
 */
export function CodeBlock(props: CodeBlockProps): JSX.Element | null {
  if (props.format === 'ansi') {
    return <AnsiOutput {...withoutFormat(props)} />;
  }
  if (props.format === 'markdown') {
    return <MarkdownCodeBlock {...withoutFormat(props)} />;
  }
  return <PlainCodeBlock {...withoutFormat(props)} />;
}
