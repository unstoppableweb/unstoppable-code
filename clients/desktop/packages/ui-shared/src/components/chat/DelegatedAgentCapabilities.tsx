import { Button } from '../../primitives/Button';
import { memo, useId, useState, type JSX } from 'react';
import {
  DELEGATION_CAPABILITY_LIMITS,
  type DelegationCapabilitySummary,
} from '@canopy/protocol/delegation';
import {
  DELEGATED_AGENT_CAPABILITIES_HIDE_LABEL,
  DELEGATED_AGENT_CAPABILITIES_LABEL,
  DELEGATED_AGENT_CAPABILITIES_SHOW_LABEL,
  DELEGATED_AGENT_CAPABILITIES_SKIPPED_LABEL,
  DELEGATED_AGENT_CAPABILITY_SOURCE_ORDER,
  delegatedAgentCapabilityCountsLabel,
  delegatedAgentCapabilityKindLabel,
  delegatedAgentCapabilitySkipReasonLabel,
  delegatedAgentCapabilitySourceLabel,
  delegatedAgentOmittedLabel,
} from './delegated-agent-copy';
import { Fact } from '../../primitives/FactList';

export interface DelegatedAgentCapabilitiesProps {
  summary: DelegationCapabilitySummary;
}

export const DelegatedAgentCapabilities = memo(
  function DelegatedAgentCapabilities({
    summary,
  }: DelegatedAgentCapabilitiesProps): JSX.Element {
    const [open, setOpen] = useState(false);
    const detailsId = useId();
    const items = summary.items.slice(
      0,
      DELEGATION_CAPABILITY_LIMITS.summaryItems,
    );
    const skipped = summary.skipped.slice(
      0,
      DELEGATION_CAPABILITY_LIMITS.summarySkipped,
    );
    const omittedItems = summary.omittedItems ?? 0;
    const omittedSkipped = summary.omittedSkipped ?? 0;
    const showSkipped = skipped.length > 0 || omittedSkipped > 0;

    const groups = DELEGATED_AGENT_CAPABILITY_SOURCE_ORDER.map((source) => ({
      source,
      items: items.filter((item): boolean => item.source === source),
    })).filter((group): boolean => group.items.length > 0);
    const lastGroup = groups.at(-1)?.source;

    return (
      <>
        <Fact
          label={DELEGATED_AGENT_CAPABILITIES_LABEL}
          dataTestId="delegated-agent-capabilities"
        >
          <div className="flex min-w-0 items-baseline gap-x-2">
            <span className="min-w-0 break-words">
              {delegatedAgentCapabilityCountsLabel(summary)}
            </span>
            <Button
              variant="link"
              className="shrink-0"
              data-testid="delegated-agent-capabilities-toggle"
              aria-expanded={open}
              aria-controls={detailsId}
              aria-label={
                open
                  ? DELEGATED_AGENT_CAPABILITIES_HIDE_LABEL
                  : DELEGATED_AGENT_CAPABILITIES_SHOW_LABEL
              }
              onClick={(): void => setOpen((current): boolean => !current)}
            >
              {open ? 'Hide' : 'Show'}
            </Button>
          </div>
        </Fact>
        {/* Each source is one more fact in the parent list (design call 8A,
            2026-10-31); the wrapper adds no box of its own. */}
        {open ? (
          <div id={detailsId} className="contents">
            {groups.map(
              (group): JSX.Element => (
                <Fact
                  key={group.source}
                  label={delegatedAgentCapabilitySourceLabel(group.source)}
                  testId={`delegated-agent-capability-${group.source}`}
                >
                  <ul className="list-none flex flex-col gap-0.5 p-0">
                    {group.items.map(
                      (item, index): JSX.Element => (
                        <li key={`${index}-${item.name}`}>
                          <span>
                            {item.name.slice(
                              0,
                              DELEGATION_CAPABILITY_LIMITS.nameCharacters,
                            )}
                          </span>{' '}
                          <span className="fg-tertiary">
                            · {delegatedAgentCapabilityKindLabel(item.kind)}
                          </span>
                        </li>
                      ),
                    )}
                    {group.source === lastGroup && omittedItems > 0 ? (
                      <li className="fg-tertiary">
                        {delegatedAgentOmittedLabel(omittedItems)}
                      </li>
                    ) : null}
                  </ul>
                </Fact>
              ),
            )}
            {groups.length === 0 && omittedItems > 0 ? (
              // Every item was trimmed to fit: the count is all there is.
              <Fact
                label={DELEGATED_AGENT_CAPABILITIES_LABEL}
                testId="delegated-agent-capability-omitted"
                valueTone="secondary"
              >
                {delegatedAgentOmittedLabel(omittedItems)}
              </Fact>
            ) : null}
            {showSkipped ? (
              <Fact
                label={DELEGATED_AGENT_CAPABILITIES_SKIPPED_LABEL}
                testId="delegated-agent-capability-skipped"
              >
                <ul className="list-none flex flex-col gap-0.5 p-0">
                  {skipped.map(
                    (item, index): JSX.Element => (
                      <li key={`${index}-${item.name}`}>
                        <span>
                          {item.name.slice(
                            0,
                            DELEGATION_CAPABILITY_LIMITS.nameCharacters,
                          )}
                        </span>{' '}
                        <span className="fg-tertiary">
                          · {delegatedAgentCapabilityKindLabel(item.kind)}
                        </span>
                        <span className="fg-tertiary">
                          {' · '}
                          {delegatedAgentCapabilitySkipReasonLabel(item.reason)}
                        </span>
                      </li>
                    ),
                  )}
                  {omittedSkipped > 0 ? (
                    <li className="fg-tertiary">
                      {delegatedAgentOmittedLabel(omittedSkipped)}
                    </li>
                  ) : null}
                </ul>
              </Fact>
            ) : null}
          </div>
        ) : null}
      </>
    );
  },
);
