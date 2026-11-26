'use client';

import {
  useEffect,
  useState,
  type ComponentType,
  type JSX,
  type ReactNode,
} from 'react';
import type { ShareablePluginRef } from '@canopy/protocol/plugins';
import type { UnifiedPluginEntry } from '../lib/unified-plugin-entry';
import { REPLAY_BLOCK_CLASS, REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import { AgentInstructionsMarkdown } from './AgentDefinitionSummary';
import { CapabilityDetailLayout } from './CapabilityDetailLayout';
import { ComponentSection } from './ComponentSection';
import { DataTable } from '../primitives/DataTable';
import { DetailFact } from './DetailFact';
import { CustomizeInstalledList } from './CustomizeInstalledList';
import { CustomizeInstalledRow } from './CustomizeInstalledRow';
import { TabBar } from '../primitives/TabBar';
import { MacbookIcon } from '../icons/AppIcons';
import { HelpHint } from './HelpHint';
import type { McpServerLogoProps } from './McpServerLogo';
import { DetailEntityTypeProvider } from './MarketplaceTypeLabel';

export interface AgentReadDetailItem {
  readonly key: string;
  readonly label: string;
}

/**
 * A shared agent's plugins and skills as rows, worded as a local agent's
 * (`Skill: …`, `Plugin: …`), on desktop and the Portal alike.
 */
export function sharedAgentDetailItems(
  plugins: readonly ShareablePluginRef[],
): AgentReadDetailItem[] {
  return plugins.map((ref) => ({
    key: JSON.stringify(ref),
    label:
      ref.type === 'skill'
        ? `Skill: ${ref.skill_name}`
        : `Plugin: ${ref.plugin_name}`,
  }));
}

const DEFAULT_MODEL_HINT =
  'The model this preset starts with. You can change it from the model menu while you chat.';

const SOURCE_HINTS: Readonly<Partial<Record<string, string>>> = {
  Local: 'Saved on this computer. Only you can use it until you share it.',
  // The owner reads their own share's page too, so it names no sharer.
  Shared: 'Shared with you or by you. Install it to use it in your chats.',
};

/** "Skill: review" as its kind and its name; any other label as a name. */
function splitItemLabel(label: string): { type: string; name: string } {
  const at = label.indexOf(': ');
  return at > 0
    ? { type: label.slice(0, at), name: label.slice(at + 2) }
    : { type: '', name: label };
}

type AgentDetailTab = 'instructions' | 'items';

/**
 * Agents, by their entry id, whose Plugins & skills tab opened one of its
 * items, so the page lands back on that tab when the person comes back with
 * the back arrow. A fresh visit to the agent still opens on Instructions.
 */
const tabToRestore = new Map<string, AgentDetailTab>();

/**
 * Forgets every tab a back arrow would restore. The host calls it when the
 * agent pages are left some other way than the back arrow (a breadcrumb, or
 * another page of the app), so reopening an agent from the list is a fresh
 * visit on Instructions.
 */
export function clearAgentDetailTabRestore(): void {
  tabToRestore.clear();
}

/**
 * The plugins and skills an agent uses: the Customize list's tiles when the
 * host resolved them, each opening its own page; otherwise Type and Name rows.
 */
function AgentItems({
  items,
  entries,
  unresolved,
  onOpen,
  McpServerLogoComponent,
}: {
  items: readonly AgentReadDetailItem[];
  entries: readonly UnifiedPluginEntry[] | undefined;
  unresolved: readonly string[] | undefined;
  onOpen: ((entry: UnifiedPluginEntry) => void) | undefined;
  McpServerLogoComponent: ComponentType<McpServerLogoProps> | undefined;
}): JSX.Element {
  if (!entries) {
    return (
      <DataTable
        caption="Plugins and skills"
        testId="agent-detail-items"
        rows={items}
        rowKey={(item) => item.key}
        emptyLabel="No plugins or skills required"
        columns={[
          {
            key: 'type',
            header: 'Type',
            render: (item) => (
              <span className="fg-secondary">
                {splitItemLabel(item.label).type}
              </span>
            ),
          },
          {
            key: 'name',
            header: 'Name',
            overflow: 'wrap',
            // Skill and plugin names come from the user's own setup.
            render: (item) => (
              <span className={`font-medium ${REPLAY_BLOCK_CLASS}`}>
                {splitItemLabel(item.label).name}
              </span>
            ),
          },
        ]}
      />
    );
  }
  return (
    <div data-testid="agent-detail-items" className="flex flex-col gap-3">
      {entries.length === 0 && (unresolved?.length ?? 0) === 0 ? (
        <p className="text-s fg-secondary">No plugins or skills required</p>
      ) : (
        <CustomizeInstalledList
          sectionId="agent-items"
          entries={[...entries]}
          renderRow={(entry) => (
            <CustomizeInstalledRow
              entry={entry}
              sectionId="agent-items"
              discovery
              showEntryType
              onSelect={(picked) => onOpen?.(picked)}
              {...(McpServerLogoComponent ? { McpServerLogoComponent } : {})}
            />
          )}
        />
      )}
      {(unresolved?.length ?? 0) > 0 && (
        <p
          data-testid="agent-detail-items-unresolved"
          className={`text-xs fg-tertiary ${REPLAY_BLOCK_CLASS}`}
        >
          {`Not in Customize any more: ${unresolved?.join(', ')}`}
        </p>
      )}
    </div>
  );
}

export interface AgentReadDetailProps {
  /** The tile's name and description, so the header matches the list row. */
  readonly name: string;
  /**
   * The tile's entry id. It keys the tab the back arrow restores, so another
   * agent with the same name (a local one and a share) never lands on it.
   * Without one, every visit opens on Instructions.
   */
  readonly entityId?: string;
  readonly description?: string;
  readonly logo: ReactNode;
  readonly publisher?: ReactNode;
  /** `[⋯] [Edit] [Share] [Installed]`, as a `DetailActionBar`. */
  readonly actions?: ReactNode;
  readonly actionsNotice?: ReactNode;
  /** Where it comes from: Local, Shared. */
  readonly source?: string;
  /** The model it runs on, as `describeAgentBaseModel` words it. */
  readonly baseModel?: string;
  /** Its provider's logo, as the model picker draws it. */
  readonly baseModelIcon?: ReactNode;
  /** A failure of the page's own reads, said under the facts. */
  readonly notice?: ReactNode;
  /** The plugins and skills it uses, as rows when no tiles can be shown. */
  readonly items: readonly AgentReadDetailItem[];
  /**
   * The Customize tiles of the plugins and skills it uses, which open their
   * own pages. Shown on the Plugins & skills tab in place of the rows.
   */
  readonly itemEntries?: readonly UnifiedPluginEntry[];
  /** Selections that no tile stands for, said under the tiles. */
  readonly unresolvedItems?: readonly string[];
  readonly onOpenItem?: (entry: UnifiedPluginEntry) => void;
  readonly McpServerLogoComponent?: ComponentType<McpServerLogoProps>;
  /** Its instructions, on the first tab. */
  readonly instructions: string;
  /**
   * Shown in place of the tabs while the agent loads or when it can't be
   * read.
   */
  readonly contentsNotice?: ReactNode;
  readonly settings?: ReactNode;
  readonly related?: ReactNode;
  readonly dataTestId?: string;
}

/**
 * New Customize's agent page on the shared detail layout, for a local agent
 * and a team share on desktop and the Portal.
 */
export function AgentReadDetail({
  name,
  entityId,
  description,
  logo,
  publisher,
  actions,
  actionsNotice,
  source,
  baseModel,
  baseModelIcon,
  notice,
  items,
  itemEntries,
  unresolvedItems,
  onOpenItem,
  McpServerLogoComponent,
  instructions,
  contentsNotice,
  settings,
  related,
  dataTestId = 'agent-detail',
}: AgentReadDetailProps): JSX.Element {
  // The tab belongs to the agent shown: another agent in the same mounted
  // page starts on Instructions.
  const identity = entityId ?? name;
  const [picked, setPicked] = useState<{
    readonly identity: string;
    readonly tab: AgentDetailTab;
  }>(() => ({
    identity,
    tab:
      (entityId === undefined ? undefined : tabToRestore.get(entityId)) ??
      'instructions',
  }));
  const tab = picked.identity === identity ? picked.tab : 'instructions';
  const setTab = (next: AgentDetailTab): void => {
    setPicked({ identity, tab: next });
  };
  useEffect(() => {
    if (entityId !== undefined) tabToRestore.delete(entityId);
  }, [entityId]);
  const openItem = onOpenItem
    ? (entry: UnifiedPluginEntry): void => {
        if (entityId !== undefined) tabToRestore.set(entityId, 'items');
        onOpenItem(entry);
      }
    : undefined;
  const sourceHint = source === undefined ? undefined : SOURCE_HINTS[source];
  return (
    <DetailEntityTypeProvider kind="agent">
      <CapabilityDetailLayout
        dataTestId={dataTestId}
        // A monogram shows the agent name's first letter: masked with it.
        logo={
          <span className={`inline-flex shrink-0 ${REPLAY_MASK_CLASS}`}>
            {logo}
          </span>
        }
        // An agent's name is its author's own.
        title={<span className={REPLAY_MASK_CLASS}>{name}</span>}
        titleId="plugin-detail-title"
        publisher={publisher}
        actions={actions}
        actionsNotice={actionsNotice}
        description={description || undefined}
        descriptionReplay="block"
        factsFooter={notice}
        facts={{
          source: source ? (
            <DetailFact label="Source" testId="agent-detail-source">
              <span className="inline-flex min-w-0 items-center gap-1.5">
                {source === 'Local' && (
                  <MacbookIcon
                    size={14}
                    aria-hidden="true"
                    className="shrink-0 fg-secondary"
                  />
                )}
                {source}
                {sourceHint !== undefined && (
                  <HelpHint
                    label="Source"
                    help={sourceHint}
                    testId="agent-detail-source-hint"
                  />
                )}
              </span>
            </DetailFact>
          ) : undefined,
          entity: baseModel ? (
            <DetailFact label="Default model" testId="agent-detail-base-model">
              <span className="inline-flex min-w-0 items-center gap-1.5">
                {baseModelIcon}
                {baseModel}
                <HelpHint
                  label="Default model"
                  help={DEFAULT_MODEL_HINT}
                  testId="agent-detail-base-model-hint"
                />
              </span>
            </DetailFact>
          ) : undefined,
        }}
        contents={
          contentsNotice ? (
            <ComponentSection title="Plugins and skills">
              {contentsNotice}
            </ComponentSection>
          ) : (
            <div data-testid="agent-detail-tabs-section">
              <TabBar
                items={[
                  {
                    id: 'instructions',
                    label: 'Instructions',
                    dataTestId: 'agent-detail-tab-instructions',
                    tabId: 'agent-detail-tab-instructions-id',
                    panelId: 'agent-detail-panel',
                  },
                  {
                    id: 'items',
                    label: 'Plugins & skills',
                    // What the tab lists: its tiles (which fold a plugin
                    // listed twice) and the selections no tile stands for.
                    count: itemEntries
                      ? itemEntries.length + (unresolvedItems?.length ?? 0)
                      : items.length,
                    dataTestId: 'agent-detail-tab-items',
                    tabId: 'agent-detail-tab-items-id',
                    panelId: 'agent-detail-panel',
                  },
                ]}
                value={tab}
                onChange={setTab}
                label="Model preset details"
                panelId="agent-detail-panel"
                dataTestId="agent-detail-tabs"
              />
              <div
                id="agent-detail-panel"
                role="tabpanel"
                aria-labelledby={`agent-detail-tab-${tab}-id`}
                className="pt-4"
              >
                {tab === 'instructions' ? (
                  // Instructions are prompt content: blocked.
                  <div className={REPLAY_BLOCK_CLASS}>
                    <AgentInstructionsMarkdown
                      instructions={instructions}
                      dataTestId="agent-detail-instructions"
                      scroll={false}
                    />
                  </div>
                ) : (
                  <AgentItems
                    items={items}
                    entries={itemEntries}
                    unresolved={unresolvedItems}
                    onOpen={openItem}
                    McpServerLogoComponent={McpServerLogoComponent}
                  />
                )}
              </div>
            </div>
          )
        }
        settings={settings}
        related={related}
      />
    </DetailEntityTypeProvider>
  );
}
