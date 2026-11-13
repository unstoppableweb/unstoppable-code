import type { PluginsAPI } from '@canopy/execution-engine/types/plugins';
import type { SkillsAPI } from '../../types/skills';

/**
 * What a shared skill, plugin or collection import reads and installs
 * through. The renderer passes its preload APIs; Electron main passes the
 * owners those APIs reach (CAN-6003), so both import the same way.
 */
export interface SharedImportPort {
  skills: Pick<
    SkillsAPI,
    | 'getShared'
    | 'installCapabilityPackage'
    | 'installSkills'
    | 'loadSkills'
    | 'readRawSkill'
    | 'recordShareOrigin'
    | 'writeRawSkill'
  >;
  plugins: Pick<
    PluginsAPI,
    | 'addMarketplace'
    | 'installBuiltInPlugin'
    | 'installPlugin'
    | 'loadMarketplaces'
    | 'loadMarketplacesCacheOnly'
    | 'refreshMarketplaces'
  >;
  /** Whether shared skills carry receipts: the organization-projects flag. */
  receiptsEnforced(): boolean;
}

/** A function's parameters after the port, for callers that bind one. */
export type AfterPort<T extends unknown[]> = T extends [
  SharedImportPort,
  ...infer Rest,
]
  ? Rest
  : never;
