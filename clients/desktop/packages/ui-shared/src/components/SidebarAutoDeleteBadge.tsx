'use client';

import type { JSX } from 'react';
import type { WorkEntryAutoDeleteRowState } from '@canopy/protocol';
import { ArchiveIcon, TrashIcon } from '../icons/AppIcons';
import { RailIconButton } from './RailIconButton';
import { Dot } from '../primitives/Badge';
import { ActionTooltip } from '../primitives/ActionTooltip';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';

export interface SidebarAutoDeleteBadgeProps {
  readonly autoDelete: WorkEntryAutoDeleteRowState;
  readonly onActivate?: () => void;
  readonly readOnly?: boolean;
}

/** Persistent removal intent; never competes with the row's live status. */
export function SidebarAutoDeleteBadge({
  autoDelete,
  onActivate,
  readOnly = false,
}: SidebarAutoDeleteBadgeProps): JSX.Element {
  const attention = autoDelete.state === 'awaiting-branch-confirmation';
  const archive = autoDelete.mode === 'archive';
  const Glyph = archive ? ArchiveIcon : TrashIcon;
  const disabled = readOnly || onActivate === undefined;
  const branches = autoDelete.unmergedBranches ?? [];
  // Branch names and the arming chat's title are user content: mask only them
  // in session replay, so the explanation stays readable.
  const branchDescription =
    branches.length > 0 ? (
      <>
        {branches.length === 1 ? 'Branch' : 'Branches'}{' '}
        {branches.map((branch, index) => (
          <span key={branch}>
            {index > 0 ? ', ' : ''}“
            <span className={REPLAY_MASK_CLASS}>{branch}</span>”
          </span>
        ))}{' '}
        {branches.length === 1 ? 'has' : 'have'} unmerged commits.
      </>
    ) : (
      'The branch has unmerged commits.'
    );
  const origin = autoDelete.armedByChatTitle ? (
    <>
      An agent armed this in “
      <span className={REPLAY_MASK_CLASS}>{autoDelete.armedByChatTitle}</span>”.
    </>
  ) : (
    'An agent armed this.'
  );
  const waiting = autoDelete.waitingFor
    ? ` Waiting for: ${autoDelete.waitingFor}.`
    : '';
  const description = attention ? (
    <>
      {branchDescription}
      {disabled ? '' : ' Click to choose what happens to it.'}
    </>
  ) : (
    <>
      {origin} It runs when no agents, workflows, or background work are active.
      {waiting}
      {disabled ? '' : ' Click to turn it off.'}
    </>
  );
  return (
    <span className="relative inline-flex h-7 w-7 shrink-0 pointer-coarse:h-11 pointer-coarse:w-11">
      <ActionTooltip
        title={
          attention
            ? 'Auto-delete needs your answer'
            : archive
              ? 'Archives when idle'
              : 'Deletes when idle'
        }
        description={description}
      >
        <RailIconButton
          icon={Glyph}
          iconSize={14}
          tone={attention ? 'warning' : 'armed'}
          tooltipLabel=""
          coarsePointerTarget
          disabled={disabled}
          aria-label={
            attention
              ? 'Choose what happens to the branch'
              : archive
                ? 'Turn off auto-archive'
                : 'Turn off auto-delete'
          }
          onClick={(event): void => {
            event.stopPropagation();
            onActivate?.();
          }}
          onPointerDown={(event): void => event.stopPropagation()}
          onKeyDown={(event): void => {
            if (event.key === 'Enter' || event.key === ' ')
              event.stopPropagation();
          }}
        />
      </ActionTooltip>
      {attention && (
        <Dot
          tone="attention"
          className="pointer-events-none absolute right-1 top-1"
        />
      )}
    </span>
  );
}
