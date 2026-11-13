import { type JSX } from 'react';
import { type ChatComposerToolbarChipConfig } from '@canopy/ui-shared';
import {
  AutoIcon,
  ChatIcon,
  FastModeIcon,
  PlanModeIcon,
  PluginsIcon,
  ScheduleIcon,
  TerminalBorderedIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import type { ChatInterfaceMode } from '@canopy/desktop-shared/types';
import type { ComposerPlusMenuItem } from '@/components/shared/ComposerPlusMenu';
import {
  CHAT_INTERFACE_MODE_DESCRIPTIONS,
  CHAT_INTERFACE_MODE_NAMES,
  type ChatInterfaceModeOption,
} from './chatInterfaceModes';
import type { ComposerMenuController } from '@/hooks/useComposerMenu';
import type { ComposerAction } from '@/lib/composerCommands';

export * from '@canopy/ui-shared/components/ComposerLayout';

export interface ChatComposerPlusItemsOptions {
  /** Opens the plugins dialog, when the chat's selections can change. */
  onOpenPlugins?: () => void;
  hasPluginSelections: boolean;
  /** Plan mode, when the chat's harness supports it. */
  plan?: {
    on: boolean;
    /** Cursor calls it read-only mode. */
    readOnly: boolean;
    disabled: boolean;
    onToggle: () => void;
  };
  /** Opens the schedule dialog, when scheduled sends are available. */
  onSchedule?: () => void;
  /**
   * A Claude chat's interface modes, as exclusive choices under View: the
   * app's chat, Auto, or the Claude Code terminal.
   */
  interfaceModes?: {
    options: readonly ChatInterfaceModeOption[];
    onSelect: (mode: ChatInterfaceMode) => void;
  };
}

const CHAT_INTERFACE_MODE_ICONS: Record<ChatInterfaceMode, JSX.Element> = {
  canopy: <ChatIcon size="sm" />,
  auto: <AutoIcon size="sm" />,
  'claude-code': <TerminalBorderedIcon size="sm" />,
};

/** The chat composer's own rows in the + menu, after the attachment rows. */
export function buildChatComposerPlusItems({
  onOpenPlugins,
  hasPluginSelections,
  plan,
  onSchedule,
  interfaceModes,
}: ChatComposerPlusItemsOptions): ComposerPlusMenuItem[] {
  const items: ComposerPlusMenuItem[] = [];
  if (onOpenPlugins) {
    items.push({
      id: 'plugins',
      label: 'Plugins',
      icon: <PluginsIcon size="sm" />,
      onSelect: onOpenPlugins,
      ariaChecked: hasPluginSelections,
      dataTestId: 'chat-plugins-button',
    });
  }
  if (plan) {
    items.push({
      id: 'plan-mode',
      label: plan.readOnly ? 'Read-only mode' : 'Plan mode',
      description: plan.on ? 'Turn off' : 'Turn on',
      value: plan.on ? 'On' : undefined,
      icon: <PlanModeIcon size="sm" active={plan.on} />,
      onSelect: plan.onToggle,
      disabled: plan.disabled,
      selected: false,
      ariaChecked: plan.on,
      dataTestId: 'chat-input-plan-mode-button',
    });
  }
  if (onSchedule) {
    items.push({
      id: 'schedule',
      label: 'Schedule message',
      icon: <ScheduleIcon size="sm" />,
      onSelect: onSchedule,
      dataTestId: 'chat-input-schedule-button',
    });
  }
  for (const option of interfaceModes?.options ?? []) {
    const name = CHAT_INTERFACE_MODE_NAMES[option.mode];
    items.push({
      id: `interface-mode-${option.mode}`,
      group: 'view',
      label: name,
      description: CHAT_INTERFACE_MODE_DESCRIPTIONS[option.mode],
      icon: CHAT_INTERFACE_MODE_ICONS[option.mode],
      onSelect: (): void => {
        if (!option.active) interfaceModes?.onSelect(option.mode);
      },
      disabled: option.disabled,
      ...(option.busyReason
        ? { disabledTooltip: { title: name, description: option.busyReason } }
        : {}),
      checked: option.active,
      ariaChecked: option.active,
      dataTestId: `chat-interface-mode-option-${option.mode}`,
    });
  }
  return items;
}

/**
 * Plan's chip once the plan-approval prompt is closed while the plan still
 * waits: it names the state and reopens the prompt. Approving, running it as
 * a pipeline, or telling the agent what to change all happen there.
 */
export function buildPlanReadyChip({
  onOpen,
  compact = false,
}: {
  onOpen: () => void;
  compact?: boolean;
}): ChatComposerToolbarChipConfig {
  return {
    onClick: onOpen,
    active: true,
    activeTone: 'warning',
    ariaLabel: 'Plan ready, review it',
    title: 'Review the plan',
    icon: <PlanModeIcon size="sm" active />,
    ...(compact ? {} : { label: 'Plan ready' }),
    variant: 'capsule',
    dataTestId: 'chat-input-plan-ready-chip',
  };
}

/** What each composer action does in a given host; unsupported ones are absent. */
export type ComposerActionHandlers = Partial<
  Record<ComposerAction, () => void>
>;

/**
 * Runs a composer action picked from the / or + menu. `help` and
 * `commands` reopen the menu on the full command list; every other action
 * clears the typed trigger, syncs the draft, and runs the host's handler.
 * An action this host cannot perform reports back instead of doing nothing.
 */
export function runComposerAction(
  action: ComposerAction,
  {
    controller,
    handlers,
    syncDraft,
    onUnavailable,
  }: {
    controller: ComposerMenuController;
    handlers: ComposerActionHandlers;
    syncDraft: () => void;
    onUnavailable: () => void;
  },
): void {
  if (action === 'help' || action === 'commands') {
    controller.consumeTrigger();
    controller.onOpenChange(true);
    syncDraft();
    return;
  }
  const handler = handlers[action];
  if (!handler) {
    onUnavailable();
    return;
  }
  controller.consumeTrigger();
  syncDraft();
  handler();
}

/**
 * The fast-mode toggle in the settings row under the composer, beside
 * effort, for models that offer it. The label names the on state only (like
 * the Plan chip) and drops away in a compact row.
 */
export function buildFastModeChip({
  on,
  disabled,
  compact,
  onToggle,
}: {
  on: boolean;
  disabled: boolean;
  compact: boolean;
  onToggle: () => void;
}): ChatComposerToolbarChipConfig {
  return {
    onClick: onToggle,
    disabled,
    active: on,
    ariaPressed: on,
    activeStyle: {
      backgroundColor: 'var(--codex-fast-mode-background)',
      color: 'var(--codex-fast-mode-foreground)',
    },
    ariaLabel: 'Toggle fast mode',
    title: 'Fast mode consumes 2x usage.',
    tooltipDelay: 'long',
    icon: (
      // The bolt spans almost its whole 24 grid, so at 16px it stood about
      // 1px taller than the effort glyph beside it, and at 14px it read too
      // small (it is narrow). 15px in the same 16px slot splits the
      // difference; the stroke scales up by 16/15 to keep the composer's
      // rendered weight.
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
        <FastModeIcon size="sm" active={on} />
      </span>
    ),
    // The label folds in and out with the toggle, and away in compact rows.
    label: 'Fast',
    labelCollapsed: !on || compact,
    variant: 'capsule',
    dataTestId: 'chat-input-fast-mode-button',
  };
}
