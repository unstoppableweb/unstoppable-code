import type { CopilotModelEntry } from '@canopy/execution-engine/types/copilot-models';
import type { CopilotAccount } from '@canopy/protocol/preferences';

export type { CopilotAccount } from '@canopy/protocol/preferences';

export interface CopilotConnectionStatus {
  supported: boolean;
  installed: boolean;
  enabled: boolean;
  version: string;
  phase:
    | 'idle'
    | 'downloading'
    | 'verifying'
    | 'installing'
    | 'authorizing'
    | 'checking'
    | 'connected';
  percent?: number;
  archiveBytes?: number;
  account?: CopilotAccount | null;
  /** Device-flow code the user enters on GitHub; present only while authorizing. */
  userCode?: string;
  verificationUri?: string;
  expiresAt?: string;
}

export interface CopilotAccountUsage {
  account: CopilotAccount;
  limits: Array<{
    id: string;
    label: string;
    usedPercent?: number;
    resetsAt?: string;
    unlimited: boolean;
  }>;
}

export interface CopilotConnectionApi {
  usage(): Promise<CopilotAccountUsage>;
  status(): Promise<CopilotConnectionStatus>;
  connect(): Promise<CopilotConnectionStatus>;
  cancel(): Promise<void>;
  disconnect(): Promise<void>;
  account(): Promise<CopilotAccount | null>;
  changeAccount(): Promise<CopilotConnectionStatus>;
  listModels(): Promise<CopilotModelEntry[]>;
  onProgress(callback: (status: CopilotConnectionStatus) => void): () => void;
}
