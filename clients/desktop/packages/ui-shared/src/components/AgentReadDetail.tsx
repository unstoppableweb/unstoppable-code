'use client';

import type { JSX, ReactNode } from 'react';
import type { ShareablePluginRef } from '@canopy/protocol/plugins';
import { REPLAY_BLOCK_CLASS, REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import { CapabilityDetailLayout } from './CapabilityDetailLayout';
import { ComponentSection } from './ComponentSection';
import { DataTable } from './DataTable';
import { DetailFact } from './DetailFact';
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

export interface AgentReadDetailProps {
  /** The tile's name and description, so the header matches the list row. */
  readonly name: string;
  readonly description?: string;
  readonly logo: ReactNode;
  readonly publisher?: ReactNode;
  /** `[⋯] [Edit] [Share] [Installed]`, as a `DetailActionBar`. */
  readonly actions?: ReactNode;
  readonly actionsNotice?: ReactNode;
  /** The Status row, first: only when it can't be used here. */
  readonly status?: ReactNode;
  /** Where it comes from: Local, Shared. */
  readonly source?: string;
  /** The model it runs on, as `describeAgentBaseModel` words it. */
  readonly baseModel?: string;
  /** The model id it's picked by, for a local agent. */
  readonly model?: string;
  /** A failure of the page's own reads, said under the facts. */
  readonly notice?: ReactNode;
  /** The plugins and skills it uses. */
  readonly items: readonly AgentReadDetailItem[];
  /** Its instructions; collapsed under Instructions. */
  readonly instructions: string;
  /**
   * Shown in Plugins and skills instead, while the agent loads or when it
   * can't be read; Instructions are left out until it can.
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
  description,
  logo,
  publisher,
  actions,
  actionsNotice,
  status,
  source,
  baseModel,
  model,
  notice,
  items,
  instructions,
  contentsNotice,
  settings,
  related,
  dataTestId = 'agent-detail',
}: AgentReadDetailProps): JSX.Element {
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
          status,
          source: source ? (
            <DetailFact label="Source" testId="agent-detail-source">
              {source}
            </DetailFact>
          ) : undefined,
          entity:
            baseModel || model ? (
              <>
                {baseModel && (
                  <DetailFact
                    label="Base model"
                    testId="agent-detail-base-model"
                  >
                    {baseModel}
                  </DetailFact>
                )}
                {model && (
                  <DetailFact label="Model" testId="agent-detail-model">
                    {/* Derived from the agent's own name: masked with it. */}
                    <span className={`font-mono text-xs ${REPLAY_MASK_CLASS}`}>
                      {model}
                    </span>
                  </DetailFact>
                )}
              </>
            ) : undefined,
        }}
        contents={
          <ComponentSection title="Plugins and skills">
            {contentsNotice ?? (
              <DataTable
                caption="Plugins and skills"
                testId="agent-detail-items"
                rows={items}
                rowKey={(item) => item.key}
                emptyLabel="No plugins or skills required"
                columns={[
                  {
                    key: 'name',
                    header: 'Name',
                    overflow: 'wrap',
                    // Skill and plugin names come from the user's own setup.
                    render: (item) => (
                      <span className={REPLAY_BLOCK_CLASS}>{item.label}</span>
                    ),
                  },
                ]}
              />
            )}
          </ComponentSection>
        }
        docs={
          contentsNotice ? undefined : (
            <ComponentSection title="Instructions" collapsible>
              {/* Instructions are prompt content: blocked. */}
              <p
                className={`${REPLAY_BLOCK_CLASS} whitespace-pre-wrap break-words text-s`}
                data-testid="agent-detail-instructions"
              >
                {instructions || 'No additional instructions.'}
              </p>
            </ComponentSection>
          )
        }
        settings={settings}
        related={related}
      />
    </DetailEntityTypeProvider>
  );
}
