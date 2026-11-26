import { useId, type JSX, type ReactNode } from 'react';
import { Surface } from '../primitives/Surface';
import { ToggleSwitch } from '../primitives/ToggleSwitch';
import { useRowToggleClick } from './settings/SettingsRows';

export const DEFAULT_KEEP_LOCAL_BRANCH = true;

/** The shared branch choice for single and bulk worktree removal. */
export function KeepLocalBranchToggle({
  checked,
  onChange,
  children,
  dataTestId,
  noteTestId,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly children: ReactNode;
  readonly dataTestId: string;
  readonly noteTestId?: string;
}): JSX.Element {
  const noteId = useId();
  // A click on the row's text flips the switch, as in a Settings row.
  const { controlRef, onRowClick } = useRowToggleClick();
  return (
    <Surface variant="group" onClick={onRowClick}>
      <div className="flex items-center gap-3 py-2 pl-3 pr-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-s fg-primary">Keep the local branch</div>
          <div
            id={noteId}
            className="text-pretty text-xs fg-tertiary wrap-anywhere"
            data-testid={noteTestId}
          >
            {children}
          </div>
        </div>
        <div ref={controlRef} className="flex">
          <ToggleSwitch
            checked={checked}
            label="Keep the local branch"
            describedBy={noteId}
            onChange={onChange}
            dataTestId={dataTestId}
          />
        </div>
      </div>
    </Surface>
  );
}
