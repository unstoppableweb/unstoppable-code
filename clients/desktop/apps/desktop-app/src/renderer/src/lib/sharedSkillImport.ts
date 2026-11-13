export { sharedSkillReceiptsEnforced } from './sharedImportPort';
import * as shared from '@canopy/desktop-shared/lib/shared-import/shared-skill-import';
import type { AfterPort } from '@canopy/desktop-shared/lib/shared-import/port';
import { rendererSharedImportPort } from './sharedImportPort';

// The import lives in desktop-shared so Electron main imports the same way
// (CAN-6003); the window binds its own preload APIs.
export {
  CUSTOM_SKILL_SOURCE_ID,
  SKILL_FILES_NOT_INSTALLED_LABEL,
  SKILL_FILES_NOT_UPDATED_LABEL,
  describeSharedSkillImportNotice,
  sharedSkillWriteFailureCode,
  type InstalledSharedSkillTarget,
  type LocalImportedSkill,
  type SharedSkillImportSource,
  type SharedSkillInstallLookup,
} from '@canopy/desktop-shared/lib/shared-import/shared-skill-import';

export function importSharedSkill(
  ...args: AfterPort<Parameters<typeof shared.importSharedSkill>>
): ReturnType<typeof shared.importSharedSkill> {
  return shared.importSharedSkill(rendererSharedImportPort(), ...args);
}

export function findInstalledSkillByContentHash(
  ...args: AfterPort<Parameters<typeof shared.findInstalledSkillByContentHash>>
): ReturnType<typeof shared.findInstalledSkillByContentHash> {
  return shared.findInstalledSkillByContentHash(
    rendererSharedImportPort(),
    ...args,
  );
}

export function lookupInstalledSharedSkill(
  ...args: AfterPort<Parameters<typeof shared.lookupInstalledSharedSkill>>
): ReturnType<typeof shared.lookupInstalledSharedSkill> {
  return shared.lookupInstalledSharedSkill(rendererSharedImportPort(), ...args);
}
