'use client';

import type { JSX } from 'react';
import type { LedgerEntryType } from '@canopy/protocol/canopy-core';
import { LedgerEntryTypeIcon } from '../../icons/LedgerEntryTypeIcon';
import { LEDGER_ENTRY_TYPE_LABELS } from '../../lib/ledger-display';
import { DisplayAvatar } from '../../primitives/DisplayAvatar';
import { HoverCard } from '../../primitives/HoverCard';
import {
  LEDGER_DISPLAY_AVATAR_SIZE,
  type LedgerActorAvatarSize,
} from './LedgerActorAvatar';

export interface LedgerEntryTypeLabelProps {
  readonly type: LedgerEntryType;
  /**
   * False names the type without its glyph, where the glyph already shows:
   * on a row, whose avatar is the type. Defaults to true.
   */
  readonly icon?: boolean;
}

/** An entry's type: its glyph, then its name, in the surrounding text style. */
export function LedgerEntryTypeLabel({
  type,
  icon = true,
}: LedgerEntryTypeLabelProps): JSX.Element {
  return (
    <span
      data-testid="ledger-entry-type"
      data-type={type}
      className="inline-flex min-w-0 items-center gap-1"
    >
      {icon && <LedgerEntryTypeIcon type={type} />}
      <span className="truncate">{LEDGER_ENTRY_TYPE_LABELS[type]}</span>
    </span>
  );
}

export interface LedgerEntryTypeAvatarProps {
  readonly type: LedgerEntryType;
  readonly size: LedgerActorAvatarSize;
}

/**
 * A main entry's avatar: its type's glyph in the shared avatar shell, so a
 * column of rows reads by what kind of entry each is. A resting row shows no
 * type name, so the avatar carries it: as its accessible name and in a hover
 * card.
 */
export function LedgerEntryTypeAvatar({
  type,
  size,
}: LedgerEntryTypeAvatarProps): JSX.Element {
  const label = LEDGER_ENTRY_TYPE_LABELS[type];
  const avatarSize = LEDGER_DISPLAY_AVATAR_SIZE[size];
  return (
    <HoverCard
      content={label}
      deferUntilInteraction
      dataTestId="ledger-entry-type-tooltip"
    >
      <DisplayAvatar
        name={label}
        alt={label}
        size={avatarSize}
        testId="ledger-entry-type-avatar"
        data-type={type}
        glyph={
          // Both ledger avatar sizes draw the type glyph at Lucide's compact
          // 14px tier, which also catches 16px requests.
          <LedgerEntryTypeIcon type={type} size="sm" />
        }
      />
    </HoverCard>
  );
}
