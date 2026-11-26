import type { JSX, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { Button } from '../primitives/Button';

export interface PlanActionButtonRowItem {
  /** Visible label. */
  label: string;
  /** Icon glyph rendered to the left of the label. */
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** Test ID hook for automation. */
  dataTestId?: string;
}

export interface PlanActionButtonRowProps {
  items: PlanActionButtonRowItem[];
  /** Optional trailing slot for additional controls (e.g., copy button). */
  trailing?: ReactNode;
}

/**
 * A plan card action: the 28px `secondary` `compact` capsule, like the card's
 * Copy plan. Pure display.
 */
function PlanActionButton({
  item,
}: {
  item: PlanActionButtonRowItem;
}): JSX.Element {
  return (
    <Button
      variant="secondary"
      size="compact"
      data-testid={item.dataTestId}
      onClick={(event: MouseEvent<HTMLButtonElement>): void => {
        event.stopPropagation();
        item.onClick();
      }}
      onKeyDown={(event: KeyboardEvent<HTMLButtonElement>): void => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.stopPropagation();
        }
      }}
      disabled={item.disabled}
    >
      {item.icon}
      {item.label}
    </Button>
  );
}

/**
 * Row of plan action buttons (approve/dismiss/chat/pipeline). Pure display.
 */
export function PlanActionButtonRow({
  items,
  trailing,
}: PlanActionButtonRowProps): JSX.Element {
  return (
    <div className="pt-3 flex flex-wrap gap-2">
      {items.map((item) => (
        <PlanActionButton key={item.label} item={item} />
      ))}
      {trailing}
    </div>
  );
}
