'use client';

import type { JSX } from 'react';
import type { OrganizationSettingsSubtab } from '@canopy/protocol/settings';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import { canEditOrgEnforcedSettings } from '@canopy/protocol/settings/organization-permissions';
import { TeamBrandingSettingsSection } from '../team-branding-settings-section';
import { TeamDigestSettingsSection } from '../team-digest-settings-section';
import { TeamGitHubConnectionSection } from '../team-github-connection-section';
import {
  TeamDataSharingSection,
  TeamStatisticsVisibilitySection,
} from '../team-usage-settings-section';
import { TeamModelPolicySection } from '../team-model-policy-section';
import { MemberUsageDataCard } from '../MemberUsageDataCard';
import { TeamModelGatewaySection } from '../team-model-gateway-section';
import { OrganizationAiGatewaySection } from '../../ai-gateway/OrganizationAiGatewaySection';
import { TeamAiGatewayRequirementSection } from '../../ai-gateway/TeamAiGatewayRequirementSection';
import { TeamMemorySettingsSection } from '../team-memory-settings-section';
import { TeamSubscriptionPricingSection } from './team-subscription-pricing-section';
import { useOrganizationSettingsSubtabSlots } from './organization-settings-subtab-slots';
import { canManageOrganizationExternalAgents } from './external-agents-policy';
import { TeamBillingSection } from '../../billing/team-billing-section';
import { ProjectDefaultsSection } from './project-defaults-section';
import { TeamDangerZone } from '../team-danger-zone';

interface TeamSettingsSectionProps {
  /**
   * The Settings page to show. The page shell resolves it from `?tab=` with
   * `visibleOrganizationSettingsSubtabs`, the rule the settings rail lists
   * the pages by, so this never receives a page the viewer does not get.
   */
  subtab: OrganizationSettingsSubtab;
  detail: OrganizationDetail;
  /** Each card's mutations return a fresh detail for the page to hold. */
  onDetailChange: (detail: OrganizationDetail) => void;
  onBillingChanged?: () => void;
  /** Whether organization memory is rolled out for this org. */
  memoryEnabled: boolean;
  /** Called after the org is deleted so the page can navigate away. */
  onDeleted: () => void;
  /**
   * Whether outside agents (the hosted MCP servers) are on for this viewer.
   * With it, and a host that supplies `renderExternalAgentsPolicy`, an OWNER
   * of a non-Personal org gets the External agents card in Policies.
   */
  externalAgentsEnabled?: boolean;
  /**
   * AI gateway setup is on: the gateway has its own page, and Policies keeps
   * only the members requirement.
   */
  aiGatewayEnabled?: boolean;
  /**
   * Organization projects are on: the Project defaults page also lists the
   * organization's Agents (CAN-6237, phase 10a).
   */
  projectsEnabled?: boolean;
}

/**
 * One organization Settings page (General, Policies, Project defaults,
 * Integrations, Usage, AI gateway or Billing). Each is its own settings rail row, deep-linkable as `?tab=`, so
 * an admin lands on a short themed page instead of scrolling past unrelated
 * sections to reach the one they came for.
 */
export function TeamSettingsSection({
  subtab,
  detail,
  onDetailChange,
  onBillingChanged,
  memoryEnabled,
  onDeleted,
  externalAgentsEnabled = false,
  aiGatewayEnabled = false,
  projectsEnabled = false,
}: TeamSettingsSectionProps): JSX.Element {
  const { renderExternalAgentsPolicy } = useOrganizationSettingsSubtabSlots();

  // The owner's control over members' outside agents. Only a host that serves
  // the hosted MCP servers supplies the card.
  const showExternalAgents =
    renderExternalAgentsPolicy !== undefined &&
    canManageOrganizationExternalAgents(detail, externalAgentsEnabled);
  // Data sharing, model policy and memory gate on
  // `canEditOrgEnforcedSettings`; memory additionally needs `memoryEnabled`
  // and checks that itself.
  const showEnforcedPolicies = canEditOrgEnforcedSettings(detail.viewerRole);

  /**
   * Renders one page's sections. Only ever called with a page that passed
   * `visibleOrganizationSettingsSubtabs`, so this must NOT re-check the
   * visibility predicates: that rule is the single source of truth, and
   * duplicating it here lets the two copies drift into a silently blank page.
   *
   * The `JSX.Element` return type (not `| null`) is what enforces that: a tab
   * that tries to gate itself here fails to compile rather than degrading to a
   * silently blank panel.
   */
  const renderTab = (tab: OrganizationSettingsSubtab): JSX.Element => {
    switch (tab) {
      case 'general':
        return (
          <>
            <TeamBrandingSettingsSection
              detail={detail}
              onDetailChange={onDetailChange}
            />

            {/*
             * Digest cadences are org-wide config, so they belong beside
             * branding rather than in Policies (which is reserved for the
             * settings an org ENFORCES on its members). The card self-gates on
             * `canEditOrg` — the same predicate that makes this tab visible —
             * and on the digests flag, so a flag-off org sees General exactly
             * as it looks today.
             */}
            <TeamDigestSettingsSection
              orgId={detail.id}
              viewerRole={detail.viewerRole}
            />

            {/* Danger zone stays pinned to the bottom of General. */}
            <TeamDangerZone detail={detail} onDeleted={onDeleted} />
          </>
        );
      case 'billing':
        return (
          <TeamBillingSection
            detail={detail}
            onBillingChanged={onBillingChanged}
          />
        );
      case 'policies':
        return (
          <>
            {showEnforcedPolicies && (
              <>
                <TeamDataSharingSection
                  detail={detail}
                  onDetailChange={onDetailChange}
                />

                {/*
                 * Sits directly after data sharing: the two org-enforced
                 * MEMBER policies belong together, ahead of feature config.
                 */}
                <TeamModelPolicySection detail={detail} />

                {/*
                 * Last of the three member policies: model access says WHICH
                 * models, the gateway says WHERE they run. Reading
                 * availability before the data path matches how admins
                 * describe it.
                 */}
                {aiGatewayEnabled ? (
                  <TeamAiGatewayRequirementSection detail={detail} />
                ) : (
                  <TeamModelGatewaySection detail={detail} />
                )}
              </>
            )}

            {/*
             * Outside the enforced-policies block on purpose: member usage
             * data only narrows. The card checks the role itself.
             */}
            <MemberUsageDataCard detail={detail} />

            {/*
             * After the member policies and before feature config: what
             * members' outside agents may do here is also a rule the org
             * enforces on its members.
             */}
            {showExternalAgents && renderExternalAgentsPolicy?.(detail)}

            {showEnforcedPolicies && (
              <TeamMemorySettingsSection
                orgId={detail.id}
                orgName={detail.name}
                viewerRole={detail.viewerRole}
                memoryEnabled={memoryEnabled}
              />
            )}
          </>
        );
      case 'project-defaults':
        return (
          <ProjectDefaultsSection
            detail={detail}
            agentsAndPipelinesEnabled={projectsEnabled}
          />
        );
      case 'usage':
        return (
          <>
            <TeamStatisticsVisibilitySection
              detail={detail}
              onDetailChange={onDetailChange}
            />

            <TeamSubscriptionPricingSection detail={detail} />
          </>
        );
      case 'ai-gateway':
        return <OrganizationAiGatewaySection detail={detail} />;
      case 'integrations':
        return (
          <TeamGitHubConnectionSection
            detail={detail}
            onDetailChange={onDetailChange}
          />
        );
    }
  };

  return (
    <div className="flex flex-col gap-10" data-testid="team-settings-section">
      {renderTab(subtab)}
    </div>
  );
}
