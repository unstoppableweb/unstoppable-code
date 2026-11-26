'use client';

import type { JSX } from 'react';
import { CHAT_DETAILS, type ChatDetail } from '@canopy/protocol/chat-detail';
import { SegmentedControl } from '../primitives/SegmentedControl';

export const CHAT_DETAIL_LABEL = 'Chat detail';

/** Each level's segment label and the row description it shows when chosen. */
export const CHAT_DETAIL_COPY: Readonly<
  Record<ChatDetail, { readonly label: string; readonly description: string }>
> = {
  detailed: {
    label: 'Detailed',
    description: 'Every step the agent takes gets its own row.',
  },
  recent: {
    label: 'Recent',
    description:
      'Steps fold into one row, like “Ran 3 commands”. While an agent works, its latest 3 steps stay in view.',
  },
  compact: {
    label: 'Compact',
    description:
      'Steps fold into one row, like “Ran 3 commands”. Open a row to see each step.',
  },
};

/**
 * The "Chat detail" picker (Detailed / Recent / Compact), shared by desktop
 * Display → Appearance and web Account → Appearance. Each host puts it in
 * its own settings row with `CHAT_DETAIL_COPY[value].description` under the
 * label, and owns where the choice is saved.
 */
export function ChatDetailControl({
  value,
  onChange,
}: {
  /** The saved level, or `null` while it loads. */
  readonly value: ChatDetail | null;
  readonly onChange: (next: ChatDetail) => void;
}): JSX.Element {
  return (
    <SegmentedControl
      label={CHAT_DETAIL_LABEL}
      value={value}
      onChange={onChange}
      width="control"
      options={CHAT_DETAILS.map((detail) => ({
        value: detail,
        label: CHAT_DETAIL_COPY[detail].label,
        dataTestId: `chat-detail-${detail}`,
      }))}
    />
  );
}
