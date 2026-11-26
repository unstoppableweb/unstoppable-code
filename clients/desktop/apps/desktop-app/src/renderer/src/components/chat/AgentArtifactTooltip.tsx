import { Badge } from '@canopy/ui-shared/components';
import { Badge as SharedBadge } from '@canopy/ui-shared/primitives/Badge';
import { PipelineSourceLabel } from '@canopy/ui-shared/components/EntrySourceLabel';
import { memo, type JSX, type ReactNode } from 'react';
import type {
  AutomationArtifactReceiptV1,
  PipelineArtifactReceiptV1,
  SkillArtifactReceiptV1,
} from '@canopy/desktop-shared/types';
import type {
  AgentDefinitionArtifactReceiptV1,
  AutomationRunArtifactReceiptV1,
  CapabilityReferenceArtifactReceiptV1,
} from '@canopy/protocol/agent-artifacts';
import {
  capabilityTileModel,
  capabilityTileStatusText,
  Fact as ListFact,
  FactList,
  type CapabilityTileModel,
  type CapabilityTileReceipt,
} from '@canopy/ui-shared/components';
import {
  AgentIcon,
  AppAdvisorIcon,
  AutomationsIcon,
  BuildingIcon,
  ChatIcon,
  CommandIcon,
  PersonIcon,
  PipelineIcon,
  ScheduleIcon,
  SkillIcon,
} from '@canopy/ui-shared/icons';
import { formatDateTime } from '@canopy/ui-shared/lib';
import { PIPELINE_EXECUTION_SCOPE_META } from '@/components/pipeline/pipeline-execution-scope-meta';
import { PIPELINE_SOURCE_META } from '@/components/pipeline/pipeline-source-meta';
import {
  PIPELINE_SCOPE_META,
  normalizePipelineShareScope,
} from '@/components/pipeline/pipeline-scope-badge-helpers';
import { PIPELINE_TRIGGER_GLYPHS } from '@/components/pipeline/PipelineTriggerBadge';
import { TRIGGER_META } from '@/components/pipeline/pipeline-trigger-meta';

const SKILL_SOURCE_META: Record<
  SkillArtifactReceiptV1['source'],
  { label: string }
> = {
  installed: { label: 'Installed' },
  shared: { label: 'Shared' },
};

interface HeaderProps {
  icon: ReactNode;
  name: string;
  description?: string;
}

interface BadgesProps {
  children: ReactNode;
}

interface FactsProps {
  children: ReactNode;
}

interface FactProps {
  label: string;
  children: ReactNode;
}

interface PipelineTooltipProps {
  receipt: PipelineArtifactReceiptV1;
}

interface SkillTooltipProps {
  receipt: SkillArtifactReceiptV1;
}

interface AutomationTooltipProps {
  receipt: AutomationArtifactReceiptV1;
}

interface CapabilityTooltipProps {
  receipt:
    | AutomationRunArtifactReceiptV1
    | AgentDefinitionArtifactReceiptV1
    | CapabilityReferenceArtifactReceiptV1;
  /** The card's live-resolved model; without it the receipt snapshot. */
  model?: CapabilityTileModel;
}

interface AgentArtifactTooltipProps {
  receipt: CapabilityTileReceipt;
  /** The card's live-resolved model, so the card and its tile agree. */
  model?: CapabilityTileModel;
}

function Header({ icon, name, description }: HeaderProps): JSX.Element {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-px shrink-0 fg-secondary" aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="font-medium break-words fg-primary">{name}</div>
        {description ? (
          <div className="mt-0.5 leading-snug break-words fg-secondary">
            {description}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Badges({ children }: BadgesProps): JSX.Element {
  return <div className="flex flex-wrap items-center gap-1">{children}</div>;
}

function Facts({ children }: FactsProps): JSX.Element {
  return (
    <FactList
      labelWidth="3.5rem"
      size="inherit"
      columnGap="2"
      rowGap="1"
      labelTone="secondary"
      divided
    >
      {children}
    </FactList>
  );
}

function Fact({ label, children }: FactProps): JSX.Element {
  return (
    <ListFact label={label} fit="inline">
      {children}
    </ListFact>
  );
}

function PipelineTooltip({ receipt }: PipelineTooltipProps): JSX.Element {
  const sourceMeta = PIPELINE_SOURCE_META[receipt.source];
  const id = receipt.localId ?? receipt.sharedRemoteId;
  return (
    <>
      <Header
        icon={<PipelineIcon size="sm" />}
        name={receipt.name}
        {...(receipt.description ? { description: receipt.description } : {})}
      />
      <Badges>
        <PipelineSourceLabel>{sourceMeta.label}</PipelineSourceLabel>
        {receipt.enabled ? null : <SharedBadge>Disabled</SharedBadge>}
      </Badges>
      <Facts>
        <Fact label="Scope">
          {receipt.scopes.length > 0
            ? receipt.scopes.map((scope) => (
                <Badge key={scope}>
                  {PIPELINE_EXECUTION_SCOPE_META[scope].label}
                </Badge>
              ))
            : '—'}
        </Fact>
        <Fact label="Triggers">
          {receipt.runModes.length > 0
            ? receipt.runModes.map((mode) => (
                <span
                  key={mode}
                  role="img"
                  aria-label={TRIGGER_META[mode].label}
                  className={`inline-flex h-5 w-5 shrink-0 items-center justify-center ${TRIGGER_META[mode].badgeClass}`}
                >
                  {PIPELINE_TRIGGER_GLYPHS[mode]}
                </span>
              ))
            : '—'}
        </Fact>
        <Fact label="Steps">
          {receipt.jobCount} jobs · {receipt.stepCount} steps
        </Fact>
        {id ? (
          <Fact label="ID">
            <span className="truncate font-mono text-3xs fg-secondary">
              {id}
            </span>
          </Fact>
        ) : null}
      </Facts>
    </>
  );
}

function skillOwnerLabel(receipt: SkillArtifactReceiptV1): string | null {
  if (receipt.source === 'installed') return null;
  if (!receipt.owner) return 'Unknown';
  return receipt.owner.name ?? `${receipt.owner.type} ${receipt.owner.id}`;
}

function SkillTooltip({ receipt }: SkillTooltipProps): JSX.Element {
  const sourceMeta = SKILL_SOURCE_META[receipt.source];
  const shareScope = normalizePipelineShareScope(receipt.shareScope);
  const scopeMeta = PIPELINE_SCOPE_META[shareScope];
  const owner = skillOwnerLabel(receipt);
  return (
    <>
      <Header
        icon={<SkillIcon size="sm" />}
        name={receipt.name}
        {...(receipt.description ? { description: receipt.description } : {})}
      />
      <Badges>
        <span className="text-2xs fg-tertiary">{sourceMeta.label}</span>
        <SharedBadge>{scopeMeta.label}</SharedBadge>
        {receipt.canUpdate ? null : <SharedBadge>Read only</SharedBadge>}
      </Badges>
      {owner ? (
        <Facts>
          <Fact label="Owner">
            <span aria-hidden="true" className="fg-secondary">
              {receipt.owner?.type === 'organization' ? (
                <BuildingIcon size="sm" />
              ) : (
                <PersonIcon size="sm" />
              )}
            </span>
            <span className="min-w-0 break-words">{owner}</span>
          </Fact>
        </Facts>
      ) : null}
    </>
  );
}

function automationActionIcon(actionKind: string): JSX.Element {
  if (actionKind.includes('pipeline')) return <PipelineIcon size="sm" />;
  if (actionKind === 'app_advisor_prompt') return <AppAdvisorIcon size="sm" />;
  return <ChatIcon size="sm" />;
}

function AutomationTooltip({ receipt }: AutomationTooltipProps): JSX.Element {
  return (
    <>
      <Header icon={<AutomationsIcon size="sm" />} name={receipt.name} />
      <Badges>
        {receipt.running ? (
          <SharedBadge tone="info">Running</SharedBadge>
        ) : (
          <SharedBadge tone={receipt.enabled ? 'success' : 'neutral'}>
            {receipt.enabled ? 'Enabled' : 'Disabled'}
          </SharedBadge>
        )}
        {receipt.ifCommandConfigured ? (
          <span className="inline-flex items-center gap-1 text-2xs fg-tertiary">
            <span aria-hidden="true">
              <CommandIcon size="sm" />
            </span>
            If command
          </span>
        ) : null}
      </Badges>
      <Facts>
        <Fact label="Schedule">
          <span aria-hidden="true" className="fg-secondary">
            <ScheduleIcon size="sm" />
          </span>
          <span className="min-w-0 break-words">{receipt.schedule}</span>
        </Fact>
        {receipt.nextRunAt ? (
          <Fact label="Next run">{formatDateTime(receipt.nextRunAt)}</Fact>
        ) : null}
        <Fact label="Runs">
          <span aria-hidden="true" className="fg-secondary">
            {automationActionIcon(receipt.actionKind)}
          </span>
          <span className="min-w-0 break-words">{receipt.targetSummary}</span>
        </Fact>
      </Facts>
    </>
  );
}

const RUN_TRIGGER_LABELS: Record<
  AutomationRunArtifactReceiptV1['trigger'],
  string
> = {
  manual: 'Manual',
  scheduled: 'Scheduled',
  catch_up: 'Catch-up',
};

/** Runs, agents and capability references reuse the tile's own wording. */
function CapabilityTooltip({
  receipt,
  model: liveModel,
}: CapabilityTooltipProps): JSX.Element {
  const model = liveModel ?? capabilityTileModel(receipt);
  const description =
    receipt.kind === 'automation_run' ? undefined : receipt.description;
  return (
    <>
      <Header
        icon={
          receipt.kind === 'agent' ? (
            <AgentIcon size="sm" />
          ) : (
            <AutomationsIcon size="sm" />
          )
        }
        name={receipt.name}
        {...(description ? { description } : {})}
      />
      <Badges>
        <SharedBadge>{model.kindLabel}</SharedBadge>
        {model.state ? (
          <SharedBadge>{capabilityTileStatusText(model.state)}</SharedBadge>
        ) : null}
        {model.external ? (
          <span className="text-2xs fg-tertiary">External</span>
        ) : null}
      </Badges>
      <Facts>
        {receipt.kind === 'automation_run' ? (
          <>
            <Fact label="Trigger">{RUN_TRIGGER_LABELS[receipt.trigger]}</Fact>
            <Fact label="Started">{formatDateTime(receipt.startedAt)}</Fact>
            {receipt.completedAt ? (
              <Fact label="Ended">{formatDateTime(receipt.completedAt)}</Fact>
            ) : null}
          </>
        ) : null}
        {receipt.kind === 'agent' && receipt.model ? (
          <Fact label="Model">{receipt.model}</Fact>
        ) : null}
        {model.sourceLabel ? (
          <Fact label="Source">{model.sourceLabel}</Fact>
        ) : null}
        {model.reason ? <Fact label="Why">{model.reason}</Fact> : null}
      </Facts>
    </>
  );
}

/**
 * Hover detail for an agent-activity artifact card. The card itself is the
 * affordance for opening the artifact, so this surface stays purely
 * informational — badges and glyphs mirror the pipelines / automations
 * surfaces the artifact links to.
 */
export const AgentArtifactTooltip = memo(function AgentArtifactTooltip({
  receipt,
  model,
}: AgentArtifactTooltipProps): JSX.Element {
  return (
    <div className="flex flex-col text-xs gap-2">
      {receipt.kind === 'pipeline' ? (
        <PipelineTooltip receipt={receipt} />
      ) : receipt.kind === 'skill' ? (
        <SkillTooltip receipt={receipt} />
      ) : receipt.kind === 'automation' ? (
        <AutomationTooltip receipt={receipt} />
      ) : (
        <CapabilityTooltip receipt={receipt} {...(model ? { model } : {})} />
      )}
    </div>
  );
});
