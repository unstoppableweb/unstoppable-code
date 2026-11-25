'use client';

import { useState, type JSX } from 'react';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_CARD_GROUP_CLASS,
  SETTINGS_CARD_ROW_CLASS,
  SETTINGS_CARD_SUBTITLE_CLASS,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import {
  Badge,
  ErrorBanner,
  Heading,
  ToggleSwitch,
  type BadgeTone,
} from '@canopy/ui-shared/components';
import {
  useSettingsAiGatewayDeviceKey,
  useSettingsAiGatewayDeviceUse,
  type AiGatewayDeviceKeyStatus,
} from '../host';
import type { CloudChatsKeyState } from './CloudChatsKeySection';

type SurfaceState = 'active' | 'add-key' | 'replace-key' | 'old-url' | 'off';

// One word or short phrase per state; the key sections below say how to fix it.
const STATE_BADGE: Record<SurfaceState, { tone: BadgeTone; label: string }> = {
  active: { tone: 'success', label: 'Active' },
  'add-key': { tone: 'warning', label: 'Add a key' },
  'replace-key': { tone: 'warning', label: 'Add a new key' },
  'old-url': { tone: 'warning', label: 'Key is for an old URL' },
  off: { tone: 'neutral', label: 'Off' },
};

function deviceState(
  enabled: boolean,
  key: AiGatewayDeviceKeyStatus,
): SurfaceState | null {
  if (!enabled) return 'off';
  switch (key) {
    case 'saved':
      return 'active';
    case 'rejected':
      return 'replace-key';
    case 'missing':
      return 'add-key';
    case 'old-url':
      return 'old-url';
    case 'not-used':
      return 'off';
    // Not known yet, or secure storage can't be read: no claim either way.
    case 'loading':
    case 'unavailable':
      return null;
  }
}

function cloudState(
  enabled: boolean,
  key: CloudChatsKeyState,
): SurfaceState | null {
  if (key === 'off') return null;
  if (!enabled) return 'off';
  switch (key) {
    case 'saved':
      return 'active';
    case 'rejected':
      return 'replace-key';
    case 'none':
      return 'add-key';
    case 'stale_url':
      return 'old-url';
  }
}

interface SurfaceUse {
  readonly label: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (next: boolean) => void;
}

function SurfaceRow({
  label,
  state,
  testId,
  use,
}: {
  readonly label: string;
  readonly state: SurfaceState | null;
  readonly testId: string;
  /** The "Use on" switch for this place, Personal gateway only. */
  readonly use?: SurfaceUse;
}): JSX.Element {
  return (
    <div
      className={SETTINGS_CARD_ROW_CLASS}
      data-testid={testId}
      data-state={state ?? 'unknown'}
    >
      <span className="text-s font-medium fg-primary">{label}</span>
      <div className="flex items-center gap-3">
        {state === null ? null : (
          <Badge tone={STATE_BADGE[state].tone}>
            {STATE_BADGE[state].label}
          </Badge>
        )}
        {use ? (
          <ToggleSwitch
            label={use.label}
            checked={use.checked}
            disabled={use.disabled}
            dataTestId={`${testId}-use`}
            onChange={use.onChange}
          />
        ) : null}
      </div>
    </div>
  );
}

/** The Personal gateway's "Use on" choice; a team gateway has none. */
export interface AiGatewayUseOn {
  /** "Use only my AI gateway" is on, which applies everywhere. */
  readonly locked: boolean;
  /** A save is running or the gateway is off. */
  readonly disabled: boolean;
  readonly onUseInCloudChatsChange: (next: boolean) => void;
}

/**
 * Where this gateway works right now. The switch is shared, but each place
 * needs its own key: this device, where the host has one, and cloud chats,
 * where the account takes a cloud key.
 */
export function AiGatewaySurfaceStatus({
  organizationId,
  baseUrl,
  enabled,
  cloudEnabled,
  revision,
  cloudKey,
  useOn,
}: {
  readonly organizationId: string;
  readonly baseUrl: string;
  readonly enabled: boolean;
  /** Whether cloud chats use the gateway while it is on. */
  readonly cloudEnabled: boolean;
  readonly revision: number;
  /** `null` while unknown; `off` where cloud chats take no key. */
  readonly cloudKey: CloudChatsKeyState | null;
  readonly useOn?: AiGatewayUseOn;
}): JSX.Element | null {
  const deviceKey = useSettingsAiGatewayDeviceKey({
    organizationId,
    baseUrl,
    revision,
  });
  const deviceUse = useSettingsAiGatewayDeviceUse(organizationId);
  const [deviceSaving, setDeviceSaving] = useState(false);
  const [deviceFailed, setDeviceFailed] = useState(false);
  const showCloud = cloudKey !== null && cloudKey !== 'off';
  if (deviceKey === null && !showCloud) return null;
  const locked = useOn?.locked === true;
  const usedHere = locked || deviceUse?.used !== false;
  const usedInCloud = locked || cloudEnabled;
  const deviceSwitch: SurfaceUse | undefined =
    useOn && deviceUse
      ? {
          label: 'Use on this computer',
          checked: usedHere,
          disabled:
            locked || useOn.disabled || deviceSaving || deviceUse.used === null,
          onChange: (next) => {
            setDeviceSaving(true);
            setDeviceFailed(false);
            deviceUse.setUsed(next).then(
              () => setDeviceSaving(false),
              () => {
                setDeviceSaving(false);
                setDeviceFailed(true);
              },
            );
          },
        }
      : undefined;
  const cloudSwitch: SurfaceUse | undefined = useOn
    ? {
        label: 'Use in cloud chats',
        checked: usedInCloud,
        disabled: locked || useOn.disabled,
        onChange: useOn.onUseInCloudChatsChange,
      }
    : undefined;
  return (
    <section
      className={SETTINGS_CARD_CLASS}
      data-testid="ai-gateway-surface-status"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <Heading level={2} variant="section">
          Where it works
        </Heading>
        <p className={SETTINGS_CARD_SUBTITLE_CLASS}>
          {useOn
            ? 'Choose where to use it. Each place uses its own key.'
            : 'Each place uses its own key.'}
        </p>
        {locked ? (
          <p
            className="text-xs text-pretty fg-secondary"
            data-testid="ai-gateway-use-on-locked"
          >
            Use only my AI gateway applies everywhere.
          </p>
        ) : null}
      </div>
      <ErrorBanner
        errorSource="ai-gateway-use-on-device"
        error={
          deviceFailed
            ? "Couldn't save the choice for this computer. Try again."
            : undefined
        }
      />
      <div className={SETTINGS_CARD_GROUP_CLASS}>
        {deviceKey === null ? null : (
          <SurfaceRow
            label="This computer"
            state={deviceState(enabled && usedHere, deviceKey)}
            testId="ai-gateway-surface-device"
            use={deviceSwitch}
          />
        )}
        {showCloud ? (
          <SurfaceRow
            label="Cloud chats"
            state={cloudState(enabled && usedInCloud, cloudKey)}
            testId="ai-gateway-surface-cloud"
            use={cloudSwitch}
          />
        ) : null}
      </div>
    </section>
  );
}
