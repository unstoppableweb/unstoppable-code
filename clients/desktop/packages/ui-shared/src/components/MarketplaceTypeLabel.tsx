'use client';

import { createContext, useContext, useMemo } from 'react';
import type { JSX, ReactNode } from 'react';
import type { UnifiedEntryKind } from '@canopy/protocol/unified-entry';
import {
  AgentIcon,
  BundleIcon,
  McpServerIcon,
  PipelineIcon,
  PluginsIcon,
  SingleRepoWorkspaceIcon,
  SkillIcon,
  StorefrontIcon,
} from '../icons/AppIcons';
import { UnstoppableDomainsIcon } from '../icons/UnstoppableDomainsIcon';
import { WORKFLOW_ITEM_LABEL } from '../lib/workflow-labels';
import { MODEL_PRESET_LABEL } from '../lib/model-preset-labels';
import { Tooltip } from '../primitives/Tooltip';
import { useItemStateMarks } from './ItemStateMark';

interface MarketplaceTypeLabelProps {
  /** The Customize kind, which picks the mark. Omit with `glyph`. */
  readonly kind?: UnifiedEntryKind;
  /** A mark for a part a kind has none for (a command, a hook). */
  readonly glyph?: ReactNode;
  readonly label: string;
  readonly dataTestId?: string;
}

const MARKETPLACE_TYPE_GLYPHS: Readonly<Record<UnifiedEntryKind, JSX.Element>> =
  {
    plugin: <PluginsIcon size="xs" ariaHidden />,
    app: <McpServerIcon size="xs" ariaHidden />,
    skill: <SkillIcon size="xs" ariaHidden />,
    pipeline: <PipelineIcon size="xs" ariaHidden />,
    // Automations are workflows in the UX (CAN-4651), so they share its mark.
    automation: <PipelineIcon size="xs" ariaHidden />,
    collection: <BundleIcon size="xs" ariaHidden />,
    agent: <AgentIcon size="xs" ariaHidden />,
    blueprint: <SingleRepoWorkspaceIcon size="xs" ariaHidden />,
  };

/** The kind a detail page is showing, so every header labels it the same way. */
export const DetailEntityTypeContext = createContext<{
  readonly kind: UnifiedEntryKind;
  readonly label: string;
} | null>(null);

const DETAIL_ENTITY_TYPE_LABELS: Partial<Record<UnifiedEntryKind, string>> = {
  plugin: 'Plugin',
  app: 'MCP server',
  skill: 'Skill',
  agent: MODEL_PRESET_LABEL,
  collection: 'Collection',
  blueprint: 'Template',
};

/**
 * Kinds that carry a type label only on New Customize's shared detail page,
 * so other pages keep their headers.
 */
const NEW_CUSTOMIZE_TYPE_LABELS: Partial<Record<UnifiedEntryKind, string>> = {
  pipeline: WORKFLOW_ITEM_LABEL,
  automation: WORKFLOW_ITEM_LABEL,
};

/** Labels every header on a detail page with the kind it shows. */
export function DetailEntityTypeProvider({
  kind,
  children,
}: {
  kind: UnifiedEntryKind;
  children: ReactNode;
}): JSX.Element {
  const newCustomize = useItemStateMarks();
  const label =
    DETAIL_ENTITY_TYPE_LABELS[kind] ??
    (newCustomize ? NEW_CUSTOMIZE_TYPE_LABELS[kind] : undefined);
  const value = useMemo(() => (label ? { kind, label } : null), [kind, label]);
  return (
    <DetailEntityTypeContext.Provider value={value}>
      {children}
    </DetailEntityTypeContext.Provider>
  );
}

/** The detail page's type label, beside its title. Nothing outside a page. */
export function DetailEntityType(): JSX.Element | null {
  const type = useContext(DetailEntityTypeContext);
  if (!type) return null;
  return (
    <MarketplaceTypeLabel
      kind={type.kind}
      label={type.label}
      dataTestId="detail-entity-type"
    />
  );
}

/** A quiet icon-and-text label for a Customize resource kind. */
export function MarketplaceTypeLabel({
  kind,
  glyph,
  label,
  dataTestId,
}: MarketplaceTypeLabelProps): JSX.Element {
  return (
    <span
      data-testid={dataTestId}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs fg-tertiary"
    >
      {glyph ?? (kind ? MARKETPLACE_TYPE_GLYPHS[kind] : null)}
      <span>{label}</span>
    </span>
  );
}

/** A marketplace page's type label, in the same quiet style. */
export function MarketplaceKindLabel(): JSX.Element {
  return (
    <span
      data-testid="detail-entity-type"
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs fg-tertiary"
    >
      <StorefrontIcon size="xs" ariaHidden />
      <span>Marketplace</span>
    </span>
  );
}

export const CURATED_SOURCE_TOOLTIP = 'Curated by Unstoppable Domains';

interface CuratedSourceLabelProps {
  readonly entryId: string;
  readonly dataTestId: string;
}

/** The quiet Curated source label and its attributed brand mark. */
export function CuratedSourceLabel({
  entryId,
  dataTestId,
}: CuratedSourceLabelProps): JSX.Element {
  return (
    <span
      data-testid={dataTestId}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs"
    >
      <Tooltip label={CURATED_SOURCE_TOOLTIP}>
        <span
          data-testid={`plugins-card-curated-mark-${entryId}`}
          role="img"
          aria-label="Curated by Unstoppable Domains"
          className="inline-flex shrink-0 fg-primary"
        >
          <UnstoppableDomainsIcon size={12} tone="mono" />
        </span>
      </Tooltip>
      <span className="fg-tertiary">Curated</span>
    </span>
  );
}
