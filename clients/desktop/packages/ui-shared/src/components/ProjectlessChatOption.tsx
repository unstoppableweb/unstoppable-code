'use client';

import type { JSX } from 'react';
import {
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionLabel,
  PickerMenuOptionLeading,
  type PickerMenuOptionProps,
} from './PickerMenu';
import { ProjectAvatarBadge } from './ProjectAvatarBadge';

/** Reserved independently of real workspace ids on every picker host. */
export const PROJECTLESS_CHAT_OPTION_KEY = 'workspace-dropdown:no-project';

export interface ProjectlessChatOptionProps extends Omit<
  PickerMenuOptionProps,
  'children'
> {
  readonly label?: string;
  readonly availability?: 'available' | 'pending' | 'unavailable';
}

/** Shared destination row; the host owns provisioning and context authority. */
export function ProjectlessChatOption({
  label = 'Chat without a project',
  availability = 'available',
  selected = false,
  onClick,
  ...props
}: ProjectlessChatOptionProps): JSX.Element {
  return (
    <PickerMenuOption
      {...props}
      role="option"
      selected={selected}
      aria-selected={selected}
      aria-disabled={availability !== 'available'}
      aria-busy={availability === 'pending'}
      onClick={availability === 'available' ? onClick : undefined}
    >
      <PickerMenuOptionLeading tone="primary">
        <ProjectAvatarBadge kind="cowork" />
      </PickerMenuOptionLeading>
      <PickerMenuOptionContent>
        <PickerMenuOptionLabel>
          <span className="truncate">{label}</span>
        </PickerMenuOptionLabel>
      </PickerMenuOptionContent>
      <PickerMenuOptionCheck selected={selected} />
    </PickerMenuOption>
  );
}
