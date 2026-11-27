import {
  IPC_CHANNELS,
  type GlobalFocusShortcutStatus,
  type GlobalFocusShortcutUpdateRequest,
  type GlobalFocusShortcutUpdateResponse,
  type PreferencesData,
} from '@canopy/desktop-shared/types';
import {
  toShortcutPlatform,
  validateGlobalShortcut,
} from '@canopy/desktop-shared/lib/global-shortcut-accelerator';
import { getGlobalFocusShortcutService } from '../lifecycle/global-focus-shortcut';
import { broadcastPreferencesSynced } from '../lib/preferences-broadcast';
import {
  projectPreferencesForRuntime,
  readPreferencesFile,
  updatePreferencesFile,
} from '../lib/preferences-store';
import { registerIpcHandler } from './register';

/**
 * IPC surface for the OS focus shortcut (CAN-1963). `update` is
 * try-then-save for the chord: a new chord is registered with the OS first
 * and persisted only once that succeeded, so a refused chord never becomes
 * the saved one and the previously working binding stays active. The
 * `enabled` flag is the user's intent and always persists.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeUpdateRequest(
  value: unknown,
): GlobalFocusShortcutUpdateRequest {
  if (!isRecord(value)) {
    throw new Error('Invalid focus shortcut request: expected an object.');
  }
  const request: GlobalFocusShortcutUpdateRequest = {};
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') {
      throw new Error(
        'Invalid focus shortcut request: enabled must be a boolean.',
      );
    }
    request.enabled = value.enabled;
  }
  if (value.accelerator !== undefined) {
    if (typeof value.accelerator !== 'string') {
      throw new Error(
        'Invalid focus shortcut request: accelerator must be a string.',
      );
    }
    request.accelerator = value.accelerator;
  }
  return request;
}

interface GlobalFocusShortcutConfig {
  enabled: boolean;
  accelerator: string;
}

/** The config on disk right now, falling back to `fallback` if it cannot be read. */
async function readPersistedConfig(
  fallback: GlobalFocusShortcutConfig,
): Promise<GlobalFocusShortcutConfig> {
  try {
    const persisted = await readPreferencesFile();
    return {
      enabled: persisted.globalFocusShortcutEnabled,
      accelerator: persisted.globalFocusShortcut,
    };
  } catch {
    return fallback;
  }
}

export function handleGetGlobalFocusShortcutStatus(): GlobalFocusShortcutStatus {
  return getGlobalFocusShortcutService().getStatus();
}

export async function handleUpdateGlobalFocusShortcut(
  value: unknown,
): Promise<GlobalFocusShortcutUpdateResponse> {
  const request = normalizeUpdateRequest(value);
  const service = getGlobalFocusShortcutService();
  if (request.accelerator !== undefined) {
    // Refuse an explicitly supplied chord the validator rejects regardless of
    // `enabled`: the service's disabled branch would otherwise substitute the
    // default, and persisting that under `ok: true` would silently replace a
    // good saved chord.
    const validation = validateGlobalShortcut(
      request.accelerator,
      toShortcutPlatform(process.platform),
    );
    if (!validation.ok) {
      return {
        ok: false,
        reason: validation.reason,
        accelerator: request.accelerator,
        status: service.getStatus(),
      };
    }
  }
  const saved = await readPreferencesFile();
  const savedConfig = {
    enabled: saved.globalFocusShortcutEnabled,
    accelerator: saved.globalFocusShortcut,
  };
  const next = {
    enabled: request.enabled ?? savedConfig.enabled,
    accelerator: request.accelerator ?? savedConfig.accelerator,
  };
  const result = service.apply(next);
  const chordChanged =
    request.accelerator !== undefined &&
    next.accelerator !== savedConfig.accelerator;
  if (!result.ok && chordChanged) {
    // A refused NEW chord never replaces the saved one. The service already
    // restored the previous OS registration; re-applying the config that is
    // on disk NOW (not the pre-await snapshot, which an overlapping accepted
    // update may have superseded) makes the reported status describe it.
    const restored = service.apply(await readPersistedConfig(savedConfig));
    return {
      ok: false,
      reason: result.reason,
      accelerator: result.accelerator,
      status: restored.status,
    };
  }
  // Either the OS accepted the config, or only `enabled` changed and the
  // saved chord itself was refused. The latter still persists: there is no
  // prior working binding to protect, and saving the user's intent keeps the
  // status (and the checklist row) in the recoverable "blocked" state instead
  // of silently snapping the toggle back to off.
  //
  // Fields the request did not name are read from the store's `current`
  // inside the updater, not from the earlier snapshot, so an overlapping
  // update that landed in between is not clobbered.
  let normalized: PreferencesData;
  try {
    normalized = await updatePreferencesFile((current) => ({
      globalFocusShortcutEnabled:
        request.enabled ?? current.globalFocusShortcutEnabled,
      globalFocusShortcut: result.ok
        ? result.status.accelerator
        : current.globalFocusShortcut,
    }));
  } catch (error) {
    // The OS already holds the new registration. Put the persisted config
    // back before surfacing the write failure, or this process would run an
    // unsaved chord while the next launch re-applies the old one.
    service.apply(await readPersistedConfig(savedConfig));
    throw error;
  }
  // `updatePreferencesFile` does not broadcast; renderer preference mirrors
  // (Settings, the checklist) must see the new value without a reload.
  broadcastPreferencesSynced(normalized, projectPreferencesForRuntime);
  return result;
}

/**
 * The corrective write after a committed chord was refused: puts the working
 * chord back only while the refused one is still stored, so a newer choice
 * that landed meanwhile wins. Resolves true when it wrote.
 */
export async function correctRefusedFocusShortcut(
  refused: string,
  restored: string,
): Promise<boolean> {
  let corrected = false;
  const persisted = await updatePreferencesFile(
    (current) =>
      current.globalFocusShortcut === refused
        ? { globalFocusShortcut: restored }
        : null,
    () => {
      corrected = true;
    },
  );
  // The corrective broadcast follows the save's optimistic one, which
  // renderer mirrors tolerate.
  if (corrected)
    broadcastPreferencesSynced(persisted, projectPreferencesForRuntime);
  return corrected;
}

export function registerGlobalFocusShortcutHandlers(): void {
  registerIpcHandler<[], GlobalFocusShortcutStatus>(
    IPC_CHANNELS.globalFocusShortcutGetStatus,
    () => handleGetGlobalFocusShortcutStatus(),
  );
  registerIpcHandler<[unknown], GlobalFocusShortcutUpdateResponse>(
    IPC_CHANNELS.globalFocusShortcutUpdate,
    (_event, request) => handleUpdateGlobalFocusShortcut(request),
  );
}
