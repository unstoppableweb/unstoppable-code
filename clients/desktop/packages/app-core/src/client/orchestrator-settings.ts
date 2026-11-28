import type { OrchestratorInstructionsDraft } from '@canopy/protocol/remote-control/shell';

/** Independent settings reads preserve the local dialog's partial availability. */
export interface OrchestratorRetentionSettings {
  readonly archiveRetentionDays?: number | null;
  readonly autoArchiveDays?: number | null;
}

/** Host adapter over existing settings operations; this adds no backend route. */
export interface OrchestratorSettingsDraftClient {
  loadInstructions(): Promise<OrchestratorInstructionsDraft>;
  loadRetention(): Promise<OrchestratorRetentionSettings>;
  saveInstructions(draft: OrchestratorInstructionsDraft): Promise<string>;
  saveRetention(
    patch: OrchestratorRetentionSettings,
  ): Promise<OrchestratorRetentionSettings>;
}
