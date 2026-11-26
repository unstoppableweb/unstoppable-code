import type { ComponentPropsWithRef, JSX } from 'react';
import { TextLink, type TextLinkProps } from '../primitives/TextLink';

const STATUS_FRAME =
  'electron-no-drag inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-normal';

export function PullRequestHeaderStatus({
  intent = 'default',
  hover = false,
  ...props
}: Omit<ComponentPropsWithRef<'span'>, 'className'> & {
  readonly intent?: 'default' | 'queued';
  readonly hover?: boolean;
}): JSX.Element {
  const presentation =
    intent === 'queued' ? 'fg-warning' : 'fg-primary transition-colors';
  return (
    <span
      {...props}
      className={`${STATUS_FRAME} ${presentation}${hover ? ' hover:bg-subtle' : ''}`}
    />
  );
}

export function PullRequestHeaderLink(
  props: Omit<TextLinkProps, 'className' | 'variant'>,
): JSX.Element {
  return <TextLink {...props} variant="pull-request-header" />;
}
