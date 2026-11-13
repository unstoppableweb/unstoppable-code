import type { CopilotReceiptStorage } from '@canopy/copilot-recipient/receipt-storage';
import {
  writeFileAtomically,
  syncDirectory,
} from '@canopy/execution-engine/node/lib/atomic-file';

export const copilotReceiptStorage: CopilotReceiptStorage = {
  write: (path, contents): Promise<void> =>
    writeFileAtomically(path, contents, { mode: 0o600, durable: true }),
  syncDirectory,
};
