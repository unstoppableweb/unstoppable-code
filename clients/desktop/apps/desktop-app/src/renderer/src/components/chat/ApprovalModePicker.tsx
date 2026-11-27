import { memo, type JSX } from 'react';
import {
  ComposerAccessPicker,
  type ComposerAccessPickerProps,
  type ComposerAccessOption,
  type MenuItemIconTone,
} from '@canopy/ui-shared';
import {
  ApprovalAskIcon,
  ApprovalAutoIcon,
  ShieldAccessIcon,
  type AppIcon,
  type IconSize,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  APPROVAL_MODES,
  type ApprovalMode,
} from '@canopy/desktop-shared/types';
import {
  APPROVAL_MODE_DESCRIPTIONS,
  APPROVAL_MODE_MENU_LABELS,
} from './approval-mode-labels';

export type ApprovalModePickerProps = Omit<
  ComposerAccessPickerProps<ApprovalMode>,
  'options'
>;

/**
 * One glyph per mode so the composer communicates the active posture at a
 * glance instead of relying on the (hidden in compact rails) text label: a
 * raised hand stops and asks, a shield approves on your behalf, and the
 * shield with a mark approves everything.
 */
const APPROVAL_MODE_ICONS: Record<ApprovalMode, AppIcon> = {
  ask: ApprovalAskIcon,
  auto: ApprovalAutoIcon,
  'full-access': ShieldAccessIcon,
};

/**
 * Only the risky mode takes a color (DESIGN.md: color only when it means
 * something). Ask and Auto rest in the neutral secondary ink.
 */
const APPROVAL_MODE_COLOR_CLASSES: Record<ApprovalMode, string> = {
  ask: 'fg-secondary',
  auto: 'fg-secondary',
  'full-access': 'fg-destructive',
};

/** The same inks for the menu's icon slot, which takes a typed tone. */
const APPROVAL_MODE_ICON_TONES: Record<ApprovalMode, MenuItemIconTone> = {
  ask: 'secondary',
  auto: 'secondary',
  'full-access': 'destructive',
};

export interface ApprovalModeGlyphProps {
  mode: ApprovalMode;
  size: IconSize;
}

export function ApprovalModeGlyph({
  mode,
  size,
}: ApprovalModeGlyphProps): JSX.Element {
  const Icon = APPROVAL_MODE_ICONS[mode];
  return (
    <span className={`inline-flex ${APPROVAL_MODE_COLOR_CLASSES[mode]}`}>
      <Icon size={size} />
    </span>
  );
}

const OPTIONS: readonly ComposerAccessOption<ApprovalMode>[] =
  APPROVAL_MODES.map((value) => ({
    value,
    label: APPROVAL_MODE_MENU_LABELS[value],
    description: APPROVAL_MODE_DESCRIPTIONS[value],
    icon: APPROVAL_MODE_ICONS[value],
    tone: APPROVAL_MODE_ICON_TONES[value],
    className: APPROVAL_MODE_COLOR_CLASSES[value],
  }));

export const ApprovalModePicker = memo(function ApprovalModePicker(
  props: ApprovalModePickerProps,
): JSX.Element {
  return <ComposerAccessPicker {...props} options={OPTIONS} />;
});
