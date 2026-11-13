'use client';

import {
  CapabilityTileLayoutProvider,
  Stack,
} from '@canopy/ui-shared/components';
import { StepRow } from '@canopy/ui-shared/components/chat';
import {
  memo,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { AgentIcon } from '@canopy/ui-shared/icons';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

export interface AgentActivitySectionProps {
  /**
   * Create/update artifacts (`CapabilityTile`s). The section draws them as
   * rows under its header.
   */
  readonly artifactItems?: readonly ReactNode[];
  /** Pipeline run rows, full width below the artifact cards. */
  readonly pipelineRunItems?: readonly ReactNode[];
  /** Watched GitHub workflow run rows, full width at the end. */
  readonly githubRunItems?: readonly ReactNode[];
  readonly variant: 'active' | 'completed';
  readonly defaultExpanded?: boolean;
}

const EMPTY_ITEMS: readonly ReactNode[] = [];

/**
 * A turn's agent activity: its capability tiles and the runs placed in it.
 * Background agents, tasks and live runs are the composer's background
 * drawer's. Hosts supply the cards; this owns the header, collapse, count
 * and the replay-blocked item list.
 */
export const AgentActivitySection = memo(function AgentActivitySection({
  artifactItems = EMPTY_ITEMS,
  pipelineRunItems = EMPTY_ITEMS,
  githubRunItems = EMPTY_ITEMS,
  variant,
  defaultExpanded = true,
}: AgentActivitySectionProps): JSX.Element | null {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const previousDefaultExpanded = useRef(defaultExpanded);
  useEffect(() => {
    if (previousDefaultExpanded.current === defaultExpanded) return;
    previousDefaultExpanded.current = defaultExpanded;
    setExpanded(defaultExpanded);
  }, [defaultExpanded]);
  const itemCount =
    artifactItems.length + pipelineRunItems.length + githubRunItems.length;
  if (itemCount === 0) return null;
  // The section reads as part of the turn (AA1): its header is a step row,
  // its items are rows under the header's words, and nothing draws a card.
  // A live turn's section is pinned below the transcript, so it keeps that
  // dock's top hairline.
  return (
    <section
      className={
        variant === 'active'
          ? 'mx-auto w-full max-w-[var(--chat-composer-shell-width)] chat-width-transition shrink-0 border-t bg-base px-4 py-2'
          : 'flex flex-col px-3'
      }
      data-testid={`agent-activity-${variant}`}
    >
      <StepRow
        icon={<AgentIcon size="sm" />}
        label="Agent activity"
        detail={`· ${String(itemCount)} ${itemCount === 1 ? 'item' : 'items'}`}
        expandable
        chevronAtRest
        isOpen={expanded}
        onToggle={(): void => setExpanded((value) => !value)}
        ariaLabel={`${expanded ? 'Collapse' : 'Expand'} agent activity`}
      />
      {expanded ? (
        // The items are conversation content (artifacts, runs): blocked from
        // session replay. The header stays recorded.
        <div
          className={`${REPLAY_BLOCK_CLASS} flex flex-col gap-2 ${variant === 'active' ? 'max-h-[min(240px,35vh)] overflow-y-auto' : ''}`}
          data-testid="agent-activity-items"
        >
          {artifactItems.length > 0 ? (
            // Under the header's words: each row's icon on its text line.
            <div
              className="flex flex-col pl-5.5"
              data-testid="agent-activity-artifact-items"
            >
              <CapabilityTileLayoutProvider layout="row">
                {artifactItems}
              </CapabilityTileLayoutProvider>
            </div>
          ) : null}
          {pipelineRunItems.length > 0 ? (
            <Stack gap="inline" data-testid="agent-activity-pipeline-run-items">
              {pipelineRunItems}
            </Stack>
          ) : null}
          {githubRunItems.length > 0 ? (
            <Stack gap="inline" data-testid="agent-activity-github-run-items">
              {githubRunItems}
            </Stack>
          ) : null}
        </div>
      ) : null}
    </section>
  );
});
