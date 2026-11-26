import { Badge, type BadgeTone } from '@canopy/ui-shared/primitives/Badge';
import type { JSX } from 'react';
import {
  CodeBlock,
  Stack,
  Heading,
  SettingsRowsGroup,
  SettingsRowsRow,
  SettingsRowsSection,
  SettingsRowsValue,
  Surface,
} from '@canopy/ui-shared/components';
import { CHAT_LABEL, ORCHESTRATOR_LABEL } from '@canopy/protocol';
import type {
  SharedAutomationAction,
  SharedAutomationDetail,
  SharedAutomationTrigger,
} from '@canopy/protocol/automations';
import { getAutomationTriggerLabel } from '@canopy/desktop-shared/lib/automations';
import { buildShareablePluginDisplay } from '@canopy/execution-engine/plugin-refs';
import { DescriptionMarkdown } from '@canopy/ui-shared/components/DescriptionMarkdown';
import { hasMarkdownDescriptionText } from '@canopy/ui-shared/lib/markdown-plain-text';
import { capitalizeFirstLetter } from '@canopy/ui-shared/lib';
import { AutomationPublicShareRow } from './AutomationPublicShareRow';
import { canManagePublicLink } from '@/components/shared/share/canManagePublicLink';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

/**
 * Local relationship between a shared Automation and this machine's
 * activities, derived by the caller from `remote` / `installedFrom` metadata:
 *  - `shared-by-you`: a local activity is the source of this share.
 *  - `installed`: a local copy was installed from this share and is current.
 *  - `update-available`: a local copy was installed from this share and the
 *    server document has changed since (contentHash mismatch).
 */
export type SharedAutomationLocalBadge =
  | 'shared-by-you'
  | 'installed'
  | 'update-available';

interface SharedAutomationPreviewProps {
  detail: SharedAutomationDetail;
  localBadge?: SharedAutomationLocalBadge | null;
}

const BADGE_COPY: Record<SharedAutomationLocalBadge, string> = {
  'shared-by-you': 'Shared by you',
  installed: 'Installed',
  'update-available': 'Update available',
};

const BADGE_TONES: Record<SharedAutomationLocalBadge, BadgeTone> = {
  'shared-by-you': 'neutral',
  installed: 'success',
  'update-available': 'info',
};

/**
 * Render the trigger in the recipient-local timezone. Shared documents pin
 * `timezone: 'local'` by design: a cron fires on the recipient's clock, and a
 * one-time run shows as the local wall-clock instant.
 */
function describeTrigger(trigger: SharedAutomationTrigger): string {
  if (trigger.kind === 'cron') {
    return `${getAutomationTriggerLabel(trigger)} · ${trigger.expression}`;
  }
  return `${getAutomationTriggerLabel(trigger)} · ${new Date(
    trigger.runAt,
  ).toLocaleString()}`;
}

function describeSharedAction(action: SharedAutomationAction): string {
  switch (action.type) {
    case 'app_advisor_prompt':
      return `${ORCHESTRATOR_LABEL} prompt`;
    case 'standalone_prompt':
      return `${CHAT_LABEL} prompt (recipient picks the project)`;
    case 'worktree_prompt':
      return 'Worktree prompt (recipient picks the project)';
    case 'worktree_pipeline':
      switch (action.pipeline.source) {
        case 'bundled':
          return `Workflow · ${action.pipeline.name ?? action.pipeline.pipelineId} (bundled)`;
        case 'curated':
          return `Workflow · ${action.pipeline.name ?? action.pipeline.curatedKey} (curated)`;
        case 'unresolved':
          return `Workflow · ${action.pipeline.name ?? 'a workflow you choose'} (recipient picks the workflow)`;
        // The definition travels with the share, so an absent name must not
        // fall through to the `shared` wording (or render as empty).
        case 'inline':
        case 'packaged':
          return `Workflow · ${action.pipeline.name ?? 'included workflow'} (included in this share)`;
        default:
          return `Workflow · ${action.pipeline.name ?? 'shared workflow'} (shared)`;
      }
  }
}

function promptPreview(action: SharedAutomationAction): string | null {
  if (action.type === 'worktree_pipeline') return null;
  return action.prompt;
}

/**
 * Read-only detail pane for one shared Automation: the portable document
 * rendered field-by-field (trigger in recipient-local time, action summary,
 * portable plugins, input keys) plus ownership, lineage, and the local
 * install/share relationship badge. Pure display — installing is the PR9
 * wizard's job.
 */
export function SharedAutomationPreview({
  detail,
  localBadge,
}: SharedAutomationPreviewProps): JSX.Element {
  const { automation } = detail;
  const plugins =
    automation.action.type === 'worktree_pipeline'
      ? []
      : automation.action.plugins;
  const inputKeys =
    automation.action.type === 'worktree_pipeline'
      ? automation.action.inputKeys
      : [];
  const preview = promptPreview(automation.action);

  return (
    <Surface
      variant="inset"
      gap="group"
      padding="default"
      data-testid="shared-automation-preview"
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <Stack
            gap="tight"
            className="min-w-0"
            data-testid="shared-automation-preview-heading"
          >
            <Heading level={3} variant="section" truncate>
              {automation.name}
            </Heading>
            {hasMarkdownDescriptionText(automation.description) && (
              <DescriptionMarkdown className="" dataTestId="share-description">
                {automation.description}
              </DescriptionMarkdown>
            )}
          </Stack>
          {localBadge && (
            <Badge
              tone={BADGE_TONES[localBadge]}
              data-testid={`shared-automation-badge-${localBadge}`}
            >
              {BADGE_COPY[localBadge]}
            </Badge>
          )}
        </div>

        <SettingsRowsSection title="Details">
          <SettingsRowsGroup>
            <SettingsRowsRow
              fact
              label="Trigger"
              control={
                <SettingsRowsValue dataTestId="shared-automation-preview-trigger">
                  {describeTrigger(automation.trigger)}
                </SettingsRowsValue>
              }
            />
            <SettingsRowsRow
              fact
              label="Action"
              control={
                <SettingsRowsValue dataTestId="shared-automation-preview-action">
                  {describeSharedAction(automation.action)}
                </SettingsRowsValue>
              }
            />
            <SettingsRowsRow
              fact
              label="Owner"
              control={
                <SettingsRowsValue>
                  {/* A person owner's name is blocked from replay; a team's or
                organization's is recorded. */}
                  {'name' in detail.owner && detail.owner.name !== null ? (
                    <span
                      className={
                        detail.owner.type === 'user'
                          ? POSTHOG_REPLAY_BLOCK_CLASS
                          : undefined
                      }
                    >
                      {detail.owner.name}
                    </span>
                  ) : (
                    detail.owner.type
                  )}{' '}
                  · {capitalizeFirstLetter(detail.shareScope)}
                </SettingsRowsValue>
              }
            />
            <SettingsRowsRow
              fact
              label="Shared by"
              control={
                <SettingsRowsValue>
                  {/* The sharer is a person: replay records a box for the name. */}
                  {detail.createdBy.name === null &&
                  detail.createdBy.email === null ? (
                    'Unknown'
                  ) : (
                    <span className={POSTHOG_REPLAY_BLOCK_CLASS}>
                      {detail.createdBy.name ?? detail.createdBy.email}
                    </span>
                  )}
                </SettingsRowsValue>
              }
            />
          </SettingsRowsGroup>
        </SettingsRowsSection>

        {/* The public link belongs to the share, not to the local automation,
          so it is managed from the shared-resource preview — the same
          placement `PipelinePublicShareRow` uses. Both inputs are already on
          the fetched detail, so this costs no extra request. */}
        <AutomationPublicShareRow
          remoteId={detail.id}
          facts={detail}
          name={detail.automation.name}
          initialShare={detail.publicShare ?? null}
          // The author can manage it, and so can an organization admin who
          // may delete a departed creator's share, as in the share dialog.
          canManage={canManagePublicLink(detail)}
        />

        {automation.hasRunCondition && (
          <p
            className="text-xs fg-secondary"
            data-testid="shared-automation-preview-run-condition"
          >
            {automation.runCondition
              ? 'The author included a run-condition command. You review it when installing.'
              : 'The author gated this automation with a run-condition command; the command itself stays on their machine.'}
          </p>
        )}

        {preview && (
          <Stack gap="tight">
            <p className="text-xs fg-secondary">Prompt</p>
            <CodeBlock
              variant="tint"
              font="sans"
              wrap="words"
              tone="primary"
              replay="block"
              className="max-h-40"
              data-testid="shared-automation-preview-prompt"
            >
              {preview}
            </CodeBlock>
          </Stack>
        )}

        {inputKeys.length > 0 && (
          <Stack gap="tight" data-testid="shared-automation-preview-input-keys">
            <p className="text-xs fg-secondary">
              Inputs you provide at install
            </p>
            <div className="flex flex-wrap gap-1.5">
              {inputKeys.map((key) => (
                <Badge key={key}>{key}</Badge>
              ))}
            </div>
          </Stack>
        )}

        {plugins.length > 0 && (
          <Stack gap="tight" data-testid="shared-automation-preview-plugins">
            <p className="text-xs fg-secondary">Plugins</p>
            <ul className="flex flex-col gap-1">
              {plugins.map((ref, index) => {
                const display = buildShareablePluginDisplay(ref);
                return (
                  <li
                    key={`${display.title}-${index}`}
                    className="text-xs fg-primary"
                  >
                    {display.title}
                    <span className="fg-secondary"> · {display.subtitle}</span>
                  </li>
                );
              })}
            </ul>
          </Stack>
        )}

        {detail.savedFrom && (
          <p
            className="text-xs fg-secondary"
            data-testid="shared-automation-preview-lineage"
          >
            Forked from another shared automation.
          </p>
        )}
      </div>
    </Surface>
  );
}
