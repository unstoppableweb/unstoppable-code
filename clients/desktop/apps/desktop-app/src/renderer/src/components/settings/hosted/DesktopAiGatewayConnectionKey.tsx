import { useCallback, useEffect, useState, type JSX } from 'react';
import type { AiGatewayConnectionKeyProps } from '@canopy/ui-app/settings/host';
import {
  AiGatewayConnectionSlot,
  type AiGatewayKeyState,
} from '@canopy/ui-app/settings/ai-gateway/AiGatewayConnectionSlot';
import { normalizeModelGatewayBaseUrl } from '@canopy/protocol/canopy-server';
import { notifyModelGatewayCredentialChanged } from '@/lib/integrationConnectionEvents';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';

/** Shared credential presentation; the host alone loads and writes the secret. */
export function DesktopAiGatewayConnectionKey({
  organizationId,
  baseUrl,
  revision,
  label,
  onReadinessChange,
}: AiGatewayConnectionKeyProps): JSX.Element {
  const [state, setState] = useState<AiGatewayKeyState>({ kind: 'loading' });
  const [changes, setChanges] = useState(0);
  useEffect(
    () =>
      window.api.onModelGatewayCredentialChanged?.((changed) => {
        if (changed === organizationId) setChanges((count) => count + 1);
      }),
    [organizationId],
  );
  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    void window.api.loadModelGatewayCredential(organizationId, baseUrl).then(
      (stored) => {
        if (cancelled) return;
        if (stored.secureStorageFailure || !stored.storageAvailable) {
          setState({ kind: 'unavailable' });
          onReadinessChange?.(false);
          return;
        }
        const matches =
          normalizeModelGatewayBaseUrl(stored.baseUrlAtSave) ===
          normalizeModelGatewayBaseUrl(baseUrl);
        const ready = Boolean(stored.apiKey && matches && !stored.lastError);
        onReadinessChange?.(ready);
        const prefix = /^[a-z]{2,4}-/i.exec(stored.apiKey)?.[0] ?? '';
        setState(
          stored.apiKey && matches
            ? {
                kind: 'stored',
                suffix: `${prefix}…${stored.apiKey.slice(-4)}`,
                failed: Boolean(stored.lastError),
              }
            : { kind: 'missing' },
        );
      },
      () => {
        if (!cancelled) {
          setState({ kind: 'unavailable' });
          onReadinessChange?.(false);
        }
      },
    );
    return (): void => {
      cancelled = true;
    };
  }, [organizationId, baseUrl, revision, changes, onReadinessChange]);
  const save = useCallback(
    async (apiKey: string): Promise<string | null> => {
      try {
        // This existing repair operation remains available to members and when setup is off.
        const result = await window.api.saveModelGatewayCredential({
          organizationId,
          baseUrl,
          apiKey,
        });
        if (result.secureStorageFailure)
          return "Couldn't save your key. Unlock secure storage and try again.";
        if (!result.valid)
          return "Couldn't validate your API key. Check the key and try again.";
        notifyModelGatewayCredentialChanged();
        setChanges((count) => count + 1);
        return null;
      } catch (cause) {
        // Preserve IPC linkage with the caught value. appErrorException emits only
        // catalog summary/code and permitted native frames, never transport messages or secrets.
        reportClientAppError(cause, {
          surface: 'inline',
        });
        return "Couldn't save your API key. Try again.";
      }
    },
    [organizationId, baseUrl],
  );
  return (
    <AiGatewayConnectionSlot
      key={`${organizationId}/${baseUrl}`}
      state={state}
      label={label}
      save={save}
      replayBlock={REPLAY_BLOCK_CLASS}
    />
  );
}
