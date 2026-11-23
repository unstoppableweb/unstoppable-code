'use client';

import type { JSX, ReactNode } from 'react';
import type { SharedAutomationDocument } from '@canopy/protocol/automations';
import { REPLAY_BLOCK_CLASS, REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import { AutomationDefinitionSummary } from './AutomationDefinitionSummary';
import {
  CapabilityDetailLayout,
  DetailVersionUpdateFact,
} from './CapabilityDetailLayout';
import { ComponentSection } from './ComponentSection';
import { DetailFact } from './DetailFact';
import { useItemStateMarks } from './ItemStateMark';
import { DetailEntityTypeProvider } from './MarketplaceTypeLabel';

export interface AutomationReadDetailProps {
  /** The tile's name and description, so the header matches the list row. */
  readonly name: string;
  readonly description?: string;
  readonly logo: ReactNode;
  readonly publisher?: ReactNode;
  /** `[⋯] [Open in Workflows] [Share] [On]`, as a `DetailActionBar`. */
  readonly actions?: ReactNode;
  /** A header action's outcome (On/Off, Add), said beside the actions. */
  readonly actionsNotice?: ReactNode;
  /** Where it comes from: Local, Shared by X, Curated. */
  readonly source?: string;
  /** The Source names a person ("Shared by …"): masked in session replay. */
  readonly sourceIsPerson?: boolean;
  /**
   * When it runs. A share or catalog entry only suggests one: whoever adds
   * it picks their own, so its row says so.
   */
  readonly schedule?: { readonly value: string; readonly suggested?: boolean };
  /** Local automations only: its outcome and time, as `WorkflowLastRunText`. */
  readonly lastRun?: ReactNode;
  /** Formatted; omitted while it's off or when nothing is scheduled. */
  readonly nextRun?: string;
  /**
   * The Version row. Without it the row says the update status is unknown:
   * a host with no status to report still shows where it would be.
   */
  readonly version?: ReactNode;
  /**
   * The host compared an installed copy with its source and found it current.
   * Only says so in the default row; leave it out when no comparison was made.
   */
  readonly verifiedCurrent?: boolean;
  /** A failure of the page's own reads, said under the facts. */
  readonly notice?: ReactNode;
  /** What it does: the definition, when the host has it. */
  readonly definition?: SharedAutomationDocument;
  /** What it does in one line, for a host without the definition. */
  readonly summary?: string;
  /** Shown in "What it does" instead, while it loads or when it can't. */
  readonly contentsNotice?: ReactNode;
  readonly settings?: ReactNode;
  readonly related?: ReactNode;
  readonly dataTestId?: string;
}

/**
 * New Customize's automation page on the shared detail layout, for every
 * source (a local automation, a team share, a catalog entry) on desktop and
 * the Portal.
 */
export function AutomationReadDetail({
  name,
  description,
  logo,
  publisher,
  actions,
  actionsNotice,
  source,
  sourceIsPerson = false,
  schedule,
  lastRun,
  nextRun,
  version,
  verifiedCurrent = false,
  notice,
  definition,
  summary,
  contentsNotice,
  settings,
  related,
  dataTestId = 'automation-detail',
}: AutomationReadDetailProps): JSX.Element {
  const marks = useItemStateMarks();
  return (
    <DetailEntityTypeProvider kind="automation">
      <CapabilityDetailLayout
        dataTestId={dataTestId}
        // A monogram shows the automation name's first letter: masked with it.
        logo={
          <span className={`inline-flex shrink-0 ${REPLAY_MASK_CLASS}`}>
            {logo}
          </span>
        }
        // A user's own automation name; its description quotes the prompt.
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
            <DetailFact label="Source" testId="automation-detail-source">
              <span className={sourceIsPerson ? REPLAY_MASK_CLASS : undefined}>
                {source}
              </span>
            </DetailFact>
          ) : undefined,
          // Flag off, as it was: no row without an update to say.
          version:
            version ??
            (marks ? (
              <DetailVersionUpdateFact
                testId="automation-catalog-update"
                update={{ state: verifiedCurrent ? 'current' : 'unknown' }}
              />
            ) : undefined),
          entity:
            schedule || lastRun || nextRun ? (
              <>
                {schedule && (
                  <DetailFact
                    label={
                      schedule.suggested ? 'Suggested schedule' : 'Schedule'
                    }
                    testId="automation-detail-schedule"
                  >
                    {schedule.value}
                  </DetailFact>
                )}
                {lastRun && (
                  <DetailFact
                    label="Last run"
                    testId="automation-detail-last-run"
                  >
                    {lastRun}
                  </DetailFact>
                )}
                {nextRun && (
                  <DetailFact
                    label="Next run"
                    testId="automation-detail-next-run"
                  >
                    {nextRun}
                  </DetailFact>
                )}
              </>
            ) : undefined,
        }}
        contents={
          // The definition summary carries its own What it does / What it
          // needs sections.
          !contentsNotice && definition ? (
            <AutomationDefinitionSummary automation={definition} />
          ) : (
            <ComponentSection title="What it does">
              {contentsNotice ??
                (summary ? (
                  // It quotes the automation's prompt: blocked.
                  <p
                    className={`${REPLAY_BLOCK_CLASS} text-s fg-secondary`}
                    data-testid="automation-detail-summary"
                  >
                    {summary}
                  </p>
                ) : (
                  <p className="text-s fg-secondary">
                    No summary for this automation yet.
                  </p>
                ))}
            </ComponentSection>
          )
        }
        settings={settings}
        related={related}
      />
    </DetailEntityTypeProvider>
  );
}
