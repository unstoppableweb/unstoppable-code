import { ControlButton } from '@canopy/ui-shared/components';
import { memo, useRef, useState, type JSX, type ReactNode } from 'react';
import { getDocument } from '@canopy/ui-shared/panels';
import {
  INLINE_CHIP_ICON_CLASS,
  PREVIEW_CARD_SURFACE,
  ReferenceHoverCard,
  HoverCard,
} from '@canopy/ui-shared/components';
import { SkillIcon } from '@canopy/ui-shared/icons/AppIcons';
import type { InvocableInventoryEntry } from '@canopy/desktop-shared/types';
import type { InvocableMentionTarget } from '@/lib/invocableMentionIndex';
import { useInvocableMentionContent } from '@/hooks/useInvocableMentionContent';
import { InvocableDetailsModal } from './InvocableDetailsModal';

const DESCRIPTION_LIMIT = 200;

/** What the card names the item as, by its inventory kind. */
const KIND_LABEL: Partial<Record<InvocableInventoryEntry['kind'], string>> = {
  plugin_command: 'Command',
  inherited_command: 'Command',
};

/** The chip itself: the tooltip's wrapper has no box (`contents`). */
function chipInsideTrigger(trigger: HTMLElement): Element | null {
  return trigger.firstElementChild;
}

function truncateDescription(description: string): string {
  const normalized = description.trim().replace(/\s+/g, ' ');
  if (normalized.length <= DESCRIPTION_LIMIT) return normalized;
  return `${normalized.slice(0, DESCRIPTION_LIMIT).trimEnd()}...`;
}

interface InvocableMentionProps {
  target: InvocableMentionTarget;
  children: ReactNode;
}

export const InvocableMention = memo(function InvocableMention({
  target,
  children,
}: InvocableMentionProps): JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { content, loading } = useInvocableMentionContent(target, detailsOpen);

  const description = truncateDescription(
    content?.description || target.entry.description,
  );

  return (
    <>
      {/* The whole chip opens the details, like every other chip in prose.
          The preview is portaled out of the transcript's and composer's
          replay blocks: the skill's name and description are recorded. */}
      <HoverCard
        content={
          <ReferenceHoverCard
            testId="invocable-mention-card"
            replayBlock={false}
            icon={SkillIcon}
            lead={target.label}
            trailing={KIND_LABEL[target.entry.kind] ?? 'Skill'}
            title={description || undefined}
          />
        }
        {...PREVIEW_CARD_SURFACE}
        triggerDisplay="contents"
        getPlacementAnchor={chipInsideTrigger}
      >
        <ControlButton
          ref={triggerRef}
          type="button"
          presentation="prose-mention"
          aria-label={`Open ${target.label} details`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setDetailsOpen(true);
          }}
        >
          <SkillIcon
            aria-hidden="true"
            className={INLINE_CHIP_ICON_CLASS}
            exactSize
          />
          {children}
        </ControlButton>
      </HoverCard>

      {detailsOpen && typeof document !== 'undefined' ? (
        <InvocableDetailsModal
          target={target}
          content={content}
          loading={loading}
          ownerDocument={getDocument(triggerRef.current)}
          onClose={() => setDetailsOpen(false)}
        />
      ) : null}
    </>
  );
});
