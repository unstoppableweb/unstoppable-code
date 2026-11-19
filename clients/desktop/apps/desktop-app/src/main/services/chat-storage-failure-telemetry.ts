import { failDesktopOperation } from '@canopy/desktop-instrumentation/electron/main';
import { logMainProcessError } from '../lib/main-process-logging';
import {
  chatFormat4FailureReason,
  type ChatFormat4Reason,
} from './chat-format4-telemetry';

export type ChatStorageFailure =
  | { kind: 'load'; error: unknown; newerFormat: boolean }
  | { kind: 'checkpoint' | 'promotion'; error: unknown };

type FailureReason = Exclude<ChatFormat4Reason, 'none'>;

function failureReason(error: unknown): FailureReason {
  try {
    const reason = chatFormat4FailureReason(error);
    switch (reason) {
      case 'disk_full':
      case 'permission':
      case 'io':
      case 'integrity':
        return reason;
      default:
        return 'other';
    }
  } catch {
    // Error getters and proxies are untrusted diagnostic input.
    return 'other';
  }
}

/** Original errors stay local; only fixed failure categories reach telemetry. */
export function recordChatStorageFailure(failure: ChatStorageFailure): void {
  try {
    switch (failure.kind) {
      case 'load':
        logMainProcessError('[chat-state] scope load failed', failure.error);
        break;
      case 'checkpoint':
        logMainProcessError(
          '[chat-state] journal checkpoint failed',
          failure.error,
        );
        break;
      case 'promotion':
        logMainProcessError(
          '[chat-state] format-3 promotion failed',
          failure.error,
        );
        break;
    }
  } catch {
    // A logging failure must not suppress the independent telemetry attempt.
  }
  try {
    const reason = failureReason(failure.error);
    switch (failure.kind) {
      case 'load':
        failDesktopOperation('canopy.chat_storage_load', 'error', {
          context: {
            load_reason: reason,
            is_newer_format: failure.newerFormat,
          },
        });
        break;
      case 'checkpoint':
        failDesktopOperation('canopy.chat_storage_checkpoint', 'error', {
          context: { checkpoint_reason: reason },
        });
        break;
      case 'promotion':
        failDesktopOperation('canopy.chat_storage_promotion', 'error', {
          context: { promotion_reason: reason },
        });
        break;
    }
  } catch {
    // Instrumentation must not change storage results or cleanup.
  }
}
