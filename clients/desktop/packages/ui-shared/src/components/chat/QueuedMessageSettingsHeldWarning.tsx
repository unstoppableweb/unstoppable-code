import type { JSX } from 'react';
import type { SettingsHeldChange } from '@canopy/protocol/remote-control/shell';
import { WarningIcon } from '../../icons/AppIcons';
import { ActionTooltip } from '../ActionTooltip';

export const QUEUED_MESSAGE_SETTINGS_HELD_TITLE = 'New settings are waiting';

/** How the tooltip names each held setting, mid-sentence. */
export const SETTINGS_HELD_CHANGE_LABELS: Readonly<
  Record<SettingsHeldChange, string>
> = {
  model: 'model',
  thinking_level: 'thinking level',
  agent: 'agent',
  plan_mode: 'plan mode',
  plugins: 'plugins',
  tools: 'tools',
  instructions: 'agent instructions',
  approval_rules: 'approval rules',
  delegation: 'delegation',
  codex_preferences: 'Codex preferences',
  account: 'account',
  organization: 'organization',
};

const STEER_EFFECT =
  'Steer adds this message to the current reply without them.';

/** `a`, `a and b`, `a, b and c`. */
function joinLabels(labels: readonly string[]): string {
  return labels.length < 2
    ? (labels[0] ?? '')
    : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * What Steer and Interrupt do on a queued message while the chat's changed
 * settings wait for live background work. Steer joins the running reply on
 * the settings it already has; Interrupt stops that reply, and the message
 * then waits for the work like any other send. Names what changed when the
 * host says, and only the actions the row offers.
 */
export function queuedMessageSettingsHeldDescription({
  changes = [],
  steer,
  interrupt,
}: {
  readonly changes?: readonly SettingsHeldChange[];
  readonly steer: boolean;
  readonly interrupt: boolean;
}): string {
  const changed = joinLabels(
    changes.map((change) => SETTINGS_HELD_CHANGE_LABELS[change]),
  );
  return [
    changed
      ? `Changed: ${changed}. Background work is still running, so these changes wait until it finishes.`
      : 'Background work is still running, and your new settings wait until it finishes.',
    steer ? STEER_EFFECT : null,
    interrupt
      ? `Interrupt stops the ${steer ? '' : 'current '}reply, but this message still waits for the background work.`
      : null,
  ]
    .filter((sentence) => sentence !== null)
    .join(' ');
}

/**
 * Warning beside a queued message's Steer and Interrupt while the chat's
 * changed settings wait for live background work. Pure display: the host
 * decides when to mount it from its own queue state.
 */
export function QueuedMessageSettingsHeldWarning({
  changes,
  steer,
  interrupt,
}: {
  readonly changes?: readonly SettingsHeldChange[];
  readonly steer: boolean;
  readonly interrupt: boolean;
}): JSX.Element {
  const description = queuedMessageSettingsHeldDescription({
    changes,
    steer,
    interrupt,
  });
  return (
    <ActionTooltip
      title={QUEUED_MESSAGE_SETTINGS_HELD_TITLE}
      description={description}
    >
      {/* Focusable so keyboard users can open the explanation. */}
      <span
        role="img"
        tabIndex={0}
        aria-label={QUEUED_MESSAGE_SETTINGS_HELD_TITLE}
        aria-description={description}
        data-testid="queued-message-settings-held-warning"
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-full fg-warning"
      >
        <WarningIcon size="sm" aria-hidden />
      </span>
    </ActionTooltip>
  );
}
