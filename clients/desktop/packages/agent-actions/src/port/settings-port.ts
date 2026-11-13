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

/**
 * - `opened`: the host showed the destination in its UI.
 * - `link`: the host has no UI to navigate (a cloud chat), so it returns the
 *   absolute web settings URL for the destination; the agent gives it to the
 *   user. The URL is built from the validated route, never from the action.
 * - `rejected`: the host refused the route.
 */
export type AgentSettingsOpenResult =
  | { status: 'opened' }
  | { status: 'link'; url: string }
  | { status: 'rejected'; reason: AgentSettingsOpenRejectionReason };

/**
 * The backend `settings.open` runs on. The family validates the route before
 * calling it; the host verifies the account and membership the route needs,
 * fails closed when it cannot, and asks its UI to show the destination or,
 * without a UI, returns a link to it.
 *
 * `aiGateway` serves the `settings.ai_gateway.*` actions. A host that cannot
 * ask the user to confirm a gateway change throws an `AgentPortError` for
 * `connect` and `update` (`missing_capability`), which the family returns
 * as is; any other failure is a generic `execution_failed`.
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
