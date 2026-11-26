import { memo, useMemo, type JSX, type ReactNode } from 'react';
import { InlineMention } from '@canopy/ui-shared';
import {
  PREVIEW_CARD_SURFACE,
  ReferenceHoverCard,
  HoverCard,
  type InlineMentionIcon,
} from '@canopy/ui-shared/components';
import { PluginsIcon } from '@canopy/ui-shared/icons';
import type { PluginMentionTarget } from '@/lib/pluginMentionIndex';
import { usePluginMentionDetails } from '@/hooks/usePluginMentionDetails';
import { McpServerLogo } from '@/components/shared/McpServerLogo';

interface PluginMentionProps {
  target: PluginMentionTarget;
  children: ReactNode;
}

/** The chip anchors the card: the tooltip's wrapper has no box. */
function chipInsideTrigger(trigger: HTMLElement): Element | null {
  return trigger.firstElementChild;
}

/**
 * The plugin's own logo in the glyph's box, or the puzzle while the
 * marketplace is read and for a plugin without one.
 */
function pluginGlyph(logoUrl: string | undefined): InlineMentionIcon {
  if (!logoUrl) return PluginsIcon;
  return function PluginLogoGlyph({ className }): JSX.Element {
    return (
      <span
        className={`inline-flex items-center justify-center ${className ?? ''}`}
      >
        <McpServerLogo
          logoUrl={logoUrl}
          size={14}
          shape="squircle"
          fit="contain"
          chrome="transparent"
        />
      </span>
    );
  };
}

/**
 * Inline chip for a whole-plugin `@` mention inside a sent user message —
 * the transcript counterpart of the composer's plugin pill. Display-only:
 * unlike `FilePathMention` there is nothing to open; hovering shows the
 * plugin's card.
 */
export const PluginMention = memo(function PluginMention({
  target,
  children,
}: PluginMentionProps): JSX.Element {
  const details = usePluginMentionDetails(
    target.marketplaceId,
    target.pluginName,
  );
  const logoUrl = details?.logoUrl;
  const icon = useMemo(() => pluginGlyph(logoUrl), [logoUrl]);
  return (
    <HoverCard
      content={
        <ReferenceHoverCard
          testId="plugin-mention-card"
          // Recorded: the label is the plugin's catalog name, which the
          // composer's plugin pill inserted, and the description is catalog
          // text; neither is conversation content.
          replayBlock={false}
          icon={icon}
          lead={target.label}
          trailing="Plugin"
          title={details?.description}
        />
      }
      {...PREVIEW_CARD_SURFACE}
      triggerDisplay="contents"
      getPlacementAnchor={chipInsideTrigger}
    >
      <InlineMention
        icon={icon}
        data-testid="plugin-mention"
        data-plugin-name={target.pluginName}
      >
        {children}
      </InlineMention>
    </HoverCard>
  );
});
