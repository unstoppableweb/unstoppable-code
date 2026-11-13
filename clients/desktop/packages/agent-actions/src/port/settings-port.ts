import type { AiGatewayAction } from '../families/settings/ai-gateway';
import type { AgentJson } from '../response';
import type { SettingsRoute } from '@canopy/protocol/settings';
import type { AgentActionCall } from '../surface/family';

/**
 * Why a host refused to open a settings destination:
 *
 * - `organization_not_member`: the route names an organization outside the
 *   signed-in account's current memberships.
 * - `signed_out`: hosted settings need a signed-in account.
 * - `unavailable`: the host could not determine membership or reach a window
 *   that shows settings. Retrying later may succeed.
 */
export const SETTINGS_OPEN_REJECTION_REASONS = [
  'organization_not_member',
  'signed_out',
  'unavailable',
] as const;

export type AgentSettingsOpenRejectionReason =
  (typeof SETTINGS_OPEN_REJECTION_REASONS)[number];

export type AgentSettingsOpenResult =
  | { status: 'opened' }
  | { status: 'rejected'; reason: AgentSettingsOpenRejectionReason };

/**
 * The backend `settings.open` runs on. The family validates the route before
 * calling it; the host verifies the account and membership the route needs,
 * fails closed when it cannot, and asks its UI to show the destination.
 */
export interface AgentSettingsPort<H> {
  aiGatewayEnabled?(): boolean;
  aiGateway?(
    action: AiGatewayAction,
    call: AgentActionCall<H>,
  ): Promise<AgentJson>;
  open(
    route: SettingsRoute,
    call: AgentActionCall<H>,
  ): Promise<AgentSettingsOpenResult>;
}
