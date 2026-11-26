import type { FieldsetHTMLAttributes, JSX, ReactNode, Ref } from 'react';
import { SPACE_ROLE_GAP_CLASS, type SpaceRole } from './Stack';

export interface FieldsetProps extends Omit<
  FieldsetHTMLAttributes<HTMLFieldSetElement>,
  'children' | 'className' | 'style'
> {
  /** Native group name. Its content keeps the form's existing label treatment. */
  readonly legend: ReactNode;
  /** Parent-owned rhythm; control preserves an existing 6px native control group. */
  readonly gap?: SpaceRole | 'control';
  /** Placement only: width, flex participation, and position. */
  readonly className?: string;
  readonly children?: ReactNode;
  readonly ref?: Ref<HTMLFieldSetElement>;
}

/**
 * A named group of controls with native fieldset disabling and a real legend.
 * A normal legend sits outside the fieldset's anonymous flex content box.
 * Floating it makes it an ordinary item in that box (flex ignores the float),
 * so the same gap spaces the legend and controls without compensating margins
 * or padding. The legend remains the native accessible name of the fieldset.
 */
export function Fieldset({
  legend,
  gap = 'group',
  className,
  children,
  ref,
  ...attributes
}: FieldsetProps): JSX.Element {
  return (
    <fieldset
      {...attributes}
      ref={ref}
      className={`m-0 flex min-w-0 flex-col border-0 p-0 ${gap === 'control' ? 'gap-1.5' : SPACE_ROLE_GAP_CLASS[gap]}${className ? ` ${className}` : ''}`}
    >
      <legend className="float-left flex w-full p-0">{legend}</legend>
      {children}
    </fieldset>
  );
}
