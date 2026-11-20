import type {
  RemoteControlAction,
  SettingsAction,
} from '@canopy/agent-actions';

/** A shared action a legacy Orchestrator name stands for. */
export type LegacyRemoteControlAliasStep = RemoteControlAction | SettingsAction;

/**
 * CAN-7298: the `canopy_portal.*` dialog names kept for one desktop release
 * as aliases of the shared actions, in the order they run. Each step is
 * built here; no field of the incoming action is carried into it.
 * CAN-7345 removes the aliases.
 */
export function resolveLegacyRemoteControlAlias(action: {
  type: string;
}): readonly LegacyRemoteControlAliasStep[] | null {
  switch (action.type) {
    case 'canopy_portal.open':
      return [{ type: 'remote_control.open_dialog' }];
    case 'canopy_portal.close':
      return [{ type: 'remote_control.close_dialog' }];
    case 'canopy_portal.open_account_settings':
      return [
        { type: 'remote_control.close_dialog' },
        {
          type: 'settings.open',
          destination: { scope: 'account', page: 'account' },
        },
      ];
    default:
      return null;
  }
}
