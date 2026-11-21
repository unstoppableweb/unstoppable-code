import type { JSX } from 'react';
import type { ChatInterfaceMode } from '@canopy/desktop-shared/types';
import { CHAT_LABEL } from '@canopy/protocol';
import { SegmentedControl } from '@canopy/ui-shared/components';
import {
  AutoIcon,
  ChatIcon,
  TerminalBorderedIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { useClaudeTuiChatsEnabled } from '@/lib/claude-tui-chats';
import {
  CHAT_INTERFACE_MODE_BUSY_REASONS,
  CHAT_INTERFACE_MODE_DESCRIPTIONS,
  CHAT_INTERFACE_MODE_NAMES,
  resolveChatInterfaceModeOptions,
  type ChatInterfaceModeControl,
} from './chatInterfaceModes';

/**
 * Idle-gated segmented control that switches a Claude-backed chat tab
 * between the Canopy-native chat experience, the managed Claude Code
 * terminal experience, and the hybrid "auto" mode (Canopy viewing, terminal
 * execution).
 *
 * It floats over the managed terminal surface, the way back to the chat; the
 * native composer lists the same modes in its + menu. The caller owns
 * placement.
 *
 * Idle-gating rules live in `resolveChatInterfaceModeOptions`, shared with
 * the composer's menu rows. A busy mode stays focusable so its tooltip can
 * say why. The whole toggle is hidden when the active chat is not
 * Claude-backed.
 */
const TOOLTIP_CANOPY = CHAT_INTERFACE_MODE_NAMES.canopy;
const TOOLTIP_CLAUDE_CODE = CHAT_INTERFACE_MODE_NAMES['claude-code'];
const TOOLTIP_AUTO = `Auto: ${CHAT_INTERFACE_MODE_DESCRIPTIONS.auto}`;
const TOOLTIP_CANOPY_BUSY = CHAT_INTERFACE_MODE_BUSY_REASONS.canopyTurn;
const TOOLTIP_AUTO_BUSY = CHAT_INTERFACE_MODE_BUSY_REASONS.autoCanopyTurn;
const TOOLTIP_TERMINAL_BUSY = CHAT_INTERFACE_MODE_BUSY_REASONS.terminalTurn;

const MODE_SEGMENTS: Record<
  ChatInterfaceMode,
  { readonly label: string; readonly icon: JSX.Element }
> = {
  canopy: {
    label: TOOLTIP_CANOPY,
    icon: <ChatIcon size={16} aria-hidden="true" />,
  },
  auto: {
    label: TOOLTIP_AUTO,
    icon: <AutoIcon size={16} aria-hidden="true" />,
  },
  'claude-code': {
    label: TOOLTIP_CLAUDE_CODE,
    icon: <TerminalBorderedIcon size={16} aria-hidden="true" />,
  },
};

export interface ChatInterfaceModeToggleProps extends ChatInterfaceModeControl {
  /** Recedes over terminal output until hovered or focused. */
  readonly floating?: boolean;
}

export function ChatInterfaceModeToggle({
  floating = false,
  ...control
}: ChatInterfaceModeToggleProps): JSX.Element | null {
  const claudeTuiChatsEnabled = useClaudeTuiChatsEnabled();
  if (!control.providerIsClaude || !claudeTuiChatsEnabled) {
    return null;
  }

  return (
    <SegmentedControl
      semantics="toggle"
      width="content"
      touchTarget
      floating={floating}
      label={`${CHAT_LABEL} interface mode`}
      value={control.mode}
      dataTestId="chat-interface-mode-toggle"
      onChange={(next): void => {
        if (next !== control.mode) control.onChange(next);
      }}
      options={resolveChatInterfaceModeOptions(control).map((option) => ({
        value: option.mode,
        label: MODE_SEGMENTS[option.mode].label,
        icon: MODE_SEGMENTS[option.mode].icon,
        tooltip: option.busyReason ?? MODE_SEGMENTS[option.mode].label,
        unavailable: option.disabled,
        dataTestId: `chat-interface-mode-toggle-${option.mode}`,
      }))}
    />
  );
}

export const CHAT_INTERFACE_MODE_TOGGLE_TOOLTIPS = {
  canopy: TOOLTIP_CANOPY,
  claudeCode: TOOLTIP_CLAUDE_CODE,
  auto: TOOLTIP_AUTO,
  canopyBusy: TOOLTIP_CANOPY_BUSY,
  autoBusy: TOOLTIP_AUTO_BUSY,
  terminalBusy: TOOLTIP_TERMINAL_BUSY,
} as const;
