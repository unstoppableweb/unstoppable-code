import { forwardRef, type InputHTMLAttributes, type JSX } from 'react';

/**
 * The dev labs' continuous range slider. The shared `Slider` picks between
 * stops, so the labs keep the native range input here, in one place, listed
 * as an exception in the legacy field ratchet. `aria-label` names it.
 */
export const LabSlider = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
    readonly 'aria-label': string;
  }
>(function LabSlider(props, ref): JSX.Element {
  return <input ref={ref} type="range" {...props} />;
});

LabSlider.displayName = 'LabSlider';
