import type { SettingsOperationName } from '@canopy/protocol/settings';
import { ORGANIZATION_SETTINGS_OPERATIONS } from '@canopy/protocol/settings/operations-organization';
import type { ProjectSetupSettingsCalls } from '../organization-capabilities/web-core-calls';
import type { SettingsOrchestratedOperation } from './account-organization-settings';
import { projectDefaultsSettingsError } from './organization-project-defaults-settings';

// ---------------------------------------------------------------------------
// The shared project setup panel on desktop (CAN-6239).
//
// Its two settings table entries name a web compatibility route; desktop
// main answers them through `core.catalog.projectSetup.get` / `.update` on
// the web core instead, as the signed-in account, like the Project defaults
// page (CAN-6237). A refusal becomes the settings error the web route would
// have answered.
// ---------------------------------------------------------------------------

const READ = 'organization.projects.setup';
const UPDATE = 'organization.projects.setup.update';

/** The project a validated project setup save is for, or null. */
export function projectSetupUpdateProjectId(
  name: SettingsOperationName,
  validatedInput: unknown,
): string | null {
  if (name !== UPDATE) return null;
  const input =
    ORGANIZATION_SETTINGS_OPERATIONS[UPDATE].input.safeParse(validatedInput);
  return input.success ? input.data.projectId : null;
}

/**
 * The web core call that answers a project setup table entry, or null for
 * any other entry. `getCalls` is lazy so the web core client loads only
 * when the panel is opened.
 */
export function projectSetupOrchestration(
  name: SettingsOperationName,
  validatedInput: unknown,
  getCalls: () => Promise<ProjectSetupSettingsCalls>,
): SettingsOrchestratedOperation | null {
  if (name === READ) {
    const input =
      ORGANIZATION_SETTINGS_OPERATIONS[READ].input.safeParse(validatedInput);
    if (!input.success) return null;
    return async (): Promise<unknown> => {
      try {
        return await (await getCalls()).read(input.data.projectId);
      } catch (error) {
        throw projectDefaultsSettingsError(error, false);
      }
    };
  }
  if (name === UPDATE) {
    const input =
      ORGANIZATION_SETTINGS_OPERATIONS[UPDATE].input.safeParse(validatedInput);
    if (!input.success) return null;
    return async (): Promise<unknown> => {
      try {
        return await (await getCalls()).update(input.data);
      } catch (error) {
        throw projectDefaultsSettingsError(error, true);
      }
    };
  }
  return null;
}
