import { ControlButton } from './Button';
import { HAIRLINE_INSET_RING_CLASS } from '../lib/row-chips';
import { SURFACE_SELECTED_CLASS } from './Surface';
import type { JSX, ReactNode } from 'react';

export type ProjectChoiceCardProps = {
  readonly testId: string;
  readonly selected: boolean;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
  readonly icon: JSX.Element;
  readonly title: string;
  readonly description: string;
} & (
  | { readonly layout?: 'choice' }
  | { readonly layout: 'destination'; readonly cardTestId: string }
);

/** One option in the dialog's top row; Personal and organizations share it. */
export function ProjectChoiceCard(props: ProjectChoiceCardProps): JSX.Element {
  const { testId, selected, disabled, onSelect, icon, title, description } =
    props;
  const isDestination = props.layout === 'destination';
  const buttonProps = {
    'data-testid': testId,
    'aria-pressed': selected,
    disabled,
    onClick: onSelect,
  };
  const content = (
    <>
      <span
        className={`flex items-center text-s font-medium fg-primary ${isDestination ? 'gap-2' : 'gap-1.5'} ${isDestination && disabled ? 'opacity-60' : ''}`}
      >
        {icon}
        {title}
      </span>
      <span
        className={`text-xs ${isDestination ? 'fg-secondary' : 'wrap-anywhere'} ${isDestination && disabled ? 'opacity-60' : ''}`}
      >
        {description}
      </span>
    </>
  );

  if (isDestination) {
    return (
      <ProjectDestinationCard active={selected} testId={props.cardTestId}>
        <ControlButton {...buttonProps} presentation="project-destination">
          {content}
        </ControlButton>
      </ProjectDestinationCard>
    );
  }

  return (
    <ControlButton
      {...buttonProps}
      presentation="project-choice"
      appearance={{ selected }}
    >
      {content}
    </ControlButton>
  );
}

/** A project destination whose action and secondary controls are siblings. */
export function ProjectDestinationCard({
  active,
  testId,
  children,
}: {
  readonly active: boolean;
  readonly testId: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      data-testid={testId}
      className={`flex flex-col items-start rounded-md ${active ? SURFACE_SELECTED_CLASS : `${HAIRLINE_INSET_RING_CLASS} ring-line-base focus-within:ring-line-accent`}`}
    >
      {children}
    </div>
  );
}
