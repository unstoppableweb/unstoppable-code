'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import type { ComposerMenuController } from '@canopy/ui-rich/editor';
import {
  limitSlashResults,
  normalizeSearchText,
  searchSlashCommands,
} from '@canopy/ui-rich/plugins';
import type {
  FileMentionOption,
  SlashCommandOption,
} from '@canopy/ui-rich/types';
import {
  ComposerPlusMenuPresentation,
  type ComposerActionRow,
} from '@canopy/ui-shared/components';
import {
  CommandIcon,
  FileIcon,
  LinearIcon,
  SkillIcon,
} from '@canopy/ui-shared/icons/AppIcons';

/** One host action row in the Add, Current settings or View section. */
export interface ComposerMenuItem {
  id: string;
  label: string;
  description?: string;
  /**
   * The section the row sits in: `settings` (Current settings) for modes
   * like Workflow, `view` (View) for the chat's interface modes, otherwise
   * Add (Plan mode sits there, as a row the composer adds to the chat).
   */
  group?: 'settings' | 'view';
  value?: string;
  /** The row opens a submenu (`menu`); see also {@link popupRole}. */
  opensMenu?: boolean;
  /** The surface the row opens, announced on the row. Wins over `opensMenu`. */
  popupRole?: 'dialog' | 'menu';
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  selected?: boolean;
  ariaChecked?: boolean;
  /** One of a set of exclusive choices: the chosen row shows a check. */
  checked?: boolean;
  dataTestId?: string;
  disabledTooltip?: {
    title: string;
    description: string;
  };
}

/**
 * A row of the host's command catalog. `composerAction` names a composer
 * action the row runs in place of inserting its text: `plan` toggles the
 * host's `plan-mode` item, `help` and `commands` browse the whole catalog,
 * and any other action is handed to `onSelectCommand`.
 */
export interface ComposerMenuCommand extends SlashCommandOption {
  composerAction?: string;
}

/**
 * How a command pick the host finished asynchronously ended. `done` closes
 * the menu. The others keep it open and say what happened: `failed` with a
 * way to try again, `unavailable` (enabling cannot work in this composer)
 * without one, and `skipped` when the command was enabled but not added
 * because the text it was picked from changed meanwhile.
 */
export type ComposerMenuCommandOutcome =
  | 'done'
  | 'failed'
  | 'unavailable'
  | 'skipped';

/**
 * One command pick handed to the host. `signal` aborts when the person
 * dismisses the menu (or its session ends) before the pick settles: the host
 * then inserts nothing, however the work it started ends.
 */
export interface ComposerMenuPick {
  signal: AbortSignal;
}

/** A plugin this chat can use now; the host omits any it cannot load. */
export interface ComposerMenuPlugin {
  marketplaceId: string;
  pluginName: string;
  label: string;
  description?: string;
  icon: ReactNode;
  /** Already selected for this chat. */
  enabled: boolean;
}

/** A connected Linear account; `null` or omitted hides the row. */
export interface ComposerMenuLinear {
  available: boolean;
  /** What the row says: what it does, or why it is unavailable. */
  description: string;
}

export interface ComposerMenuProps<
  TCommand extends ComposerMenuCommand = ComposerMenuCommand,
> {
  controller?: ComposerMenuController;
  /**
   * The composer box the menu attaches to: the menu spans the box's width
   * and opens against its edge. Without one, a `controller` anchors it.
   */
  composerAnchorRef?: RefObject<HTMLElement | null>;
  /** Space between the composer box and the menu. */
  gap?: number;
  placement?: 'top-left' | 'bottom-left';
  allowFlip?: boolean;
  searchFiles?: (query: string) => FileMentionOption[];
  onSelectFile?: (file: FileMentionOption) => void;
  /**
   * Files come from more than one repository (the condition under which a
   * picked file's pill carries its repository name): each file row names
   * its repository before its path. Rows that span several repositories
   * name it either way.
   */
  multiRepo?: boolean;
  /** Opens the host's file picker / attaches a file. */
  onPickAttachment?: () => void;
  /** Opens the Linear ticket picker. Only invoked when Linear is available. */
  onPickLinear?: () => void;
  linear?: ComposerMenuLinear | null;
  /** Disables the trigger button entirely (e.g. terminal mode). */
  disabled?: boolean;
  /** Prefix for every `data-testid` this component renders. */
  dataTestIdPrefix: string;
  onOpenChange?: (open: boolean) => void;
  /** Optional composer-specific actions rendered after attachment actions. */
  additionalItems?: ComposerMenuItem[];
  commands?: readonly TCommand[];
  /** Whether a command row shows the skill glyph rather than the command one. */
  isSkillCommand?: (command: TCommand) => boolean;
  /** Home lets a new task browse capabilities from both + and /. */
  includeCommandsInAddMenu?: boolean;
  /**
   * Plugin rows for the Add menu. Hosts load them lazily: the menu reports
   * through `onPluginsNeededChange` while it shows them.
   */
  plugins?: readonly ComposerMenuPlugin[];
  onPluginsNeededChange?: (needed: boolean) => void;
  /**
   * A whole-plugin row was picked. `enabled` reports whether the plugin was
   * already selected for this chat so the host can skip re-enabling it; the
   * host inserts the `@` mention pill (`label`) either way.
   */
  onSelectPlugin?: (
    ref: { marketplaceId: string; pluginName: string },
    meta: { label: string; enabled: boolean },
  ) => void;
  /**
   * A command row was picked. A host that must do work first (enable an
   * "Available · enable" skill or plugin, then insert its resolved text)
   * returns a promise: until it settles the row shows it is enabling and the
   * menu stays open, holding the session (`holdSelection`), and a `failed`
   * outcome keeps the menu open with an error. A host that inserts at once
   * returns nothing and the menu closes. Escape or a press outside abandons
   * a running pick and aborts `pick.signal`.
   */
  onSelectCommand?: (
    command: TCommand,
    pick: ComposerMenuPick,
  ) => void | Promise<ComposerMenuCommandOutcome>;
  /**
   * A command's identity across catalog loads, so a running or failed pick
   * still finds its row when the host reloads the catalog. Defaults to its
   * name, namespace and section.
   */
  commandKey?: (command: TCommand) => string;
  /**
   * Renders the menu without its `+`, for a composer that hides its toolbar
   * while `/` and `@` in the draft still open the menu.
   */
  hideTrigger?: boolean;
  /**
   * Hide the `+` while the Add menu has nothing it could list: no action
   * rows, plugins, files or commands. Rows the host supplies later bring it
   * back.
   */
  hideTriggerWhenEmpty?: boolean;
  isRefreshing?: boolean;
  /**
   * The chat and Home composers' 32px capsule: a flat subtle fill with a
   * one-device-pixel inset rim, the same in every composer.
   */
  capsuleTrigger?: boolean;
  /** 44px trigger below `lg` for touch hosts. */
  tapTarget?: 'compact' | 'touch';
  /** Highlights the trigger when an active action has collapsed into the menu. */
  active?: boolean;
  /** Accessible description appended while `active`. */
  activeLabel?: string;
  /**
   * Receives the trigger element. Consumers that open their own floating
   * surface from a menu row need it as a `returnFocusRef`, so dismissing that
   * surface restores focus to the `+` rather than dropping it on `<body>`.
   */
  triggerRef?: RefObject<HTMLButtonElement | null>;
}

/** Hover tooltip and accessible name for the `+` trigger. */
const COMPOSER_PLUS_MENU_LABEL = 'More actions';
/** What the menu is for, shown on hover beside its @ shortcut. */
const COMPOSER_PLUS_MENU_TOOLTIP = 'Add files and more';
const NO_COMMANDS: readonly never[] = [];
const NO_ITEMS: ComposerMenuItem[] = [];
const NO_PLUGINS: readonly ComposerMenuPlugin[] = [];
/** A command row's description while the host enables it. */
const ENABLING_DESCRIPTION = 'Turning on…';

/** The menu's error when the host could not enable a picked command. */
function enableErrorMessage(label: string): string {
  return `Couldn't turn on ${label}. You can also turn it on in Plugins.`;
}

/** The menu's error when enabling cannot work in this composer. */
function enableUnavailableMessage(label: string): string {
  return `Couldn't turn on ${label} in this chat. Turn it on in Plugins instead.`;
}

/** The menu's notice when a command was enabled but not added. */
const SKIPPED_MESSAGE =
  "The text it was picked from changed, so it wasn't added.";

function defaultCommandKey(command: SlashCommandOption): string {
  return [command.name, command.namespace ?? '', command.section ?? ''].join(
    '\u0000',
  );
}

/** A pick that did not run: the menu's rows ignore activation meanwhile. */
function ignorePick(): void {}
const ROW_DESCRIPTIONS: Record<string, string> = {
  plugins: 'Choose capabilities for this chat',
  commands: 'Browse skills and commands',
  'plan-mode': 'Plan before making changes',
  schedule: 'Send this message later',
};

/**
 * The composer's `+` menu, which typing `@` (Add) or `/` and `$` (commands)
 * in the draft also opens, pre-filtered by what follows the trigger. One
 * session of {@link ComposerMenuController} drives it; without a controller
 * the `+` opens it with its own search state.
 *
 * Rows: the host's attachment, Linear and composer actions, the plugins this
 * chat can use, the command catalog (ranked, capped on a typed search with
 * Show all), and matching files. Every source is a host prop, so a host that
 * cannot supply one simply omits its rows.
 */
export function ComposerMenu<TCommand extends ComposerMenuCommand>({
  controller,
  composerAnchorRef,
  gap,
  placement = 'top-left',
  allowFlip = true,
  searchFiles,
  onSelectFile,
  multiRepo = false,
  onPickAttachment,
  onPickLinear,
  linear = null,
  disabled = false,
  dataTestIdPrefix,
  onOpenChange,
  additionalItems = NO_ITEMS,
  commands = NO_COMMANDS,
  isSkillCommand,
  includeCommandsInAddMenu = false,
  plugins = NO_PLUGINS,
  onPluginsNeededChange,
  onSelectPlugin,
  onSelectCommand,
  isRefreshing = false,
  capsuleTrigger = false,
  tapTarget,
  active = false,
  activeLabel = 'Active composer action',
  triggerRef,
  commandKey = defaultCommandKey,
  hideTrigger = false,
  hideTriggerWhenEmpty = false,
}: ComposerMenuProps<TCommand>): JSX.Element {
  const [localOpen, setLocalOpen] = useState(false);
  const isOpen = controller?.open ?? localOpen;
  const variant = controller?.variant ?? 'add';
  const isAddMenu = variant === 'add';
  const isToolbarMenu = !controller || controller.origin === 'toolbar';
  const setIsOpen = controller?.onOpenChange ?? setLocalOpen;
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const [localQuery, setLocalQuery] = useState('');
  const query = controller?.query ?? localQuery;
  const setQuery = controller?.setQuery ?? setLocalQuery;
  // The plugin catalog is only needed once the Add menu is open; the
  // composer is mounted on every chat surface, so keep the load off startup.
  const pluginsNeeded = isOpen && isAddMenu && !!onSelectPlugin;
  useLayoutEffect(() => {
    onPluginsNeededChange?.(pluginsNeeded);
  }, [pluginsNeeded, onPluginsNeededChange]);

  useEffect(() => {
    if (!isOpen) {
      if (!controller) setLocalQuery('');
    }
  }, [isOpen, controller]);

  // The key of a command pick the host is still finishing (enabling it
  // first), and how the last unfinished one ended. Only one pick runs at a
  // time. Keys, not row objects, so a catalog reload keeps both on their row.
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const pendingRef = useRef<{
    token: symbol;
    abort: AbortController;
    /** Ends the session's hold on the pick; safe to call more than once. */
    release: () => void;
  } | null>(null);
  const [failure, setFailure] = useState<{
    key: string;
    command: TCommand;
    label: string;
    query: string;
    outcome: Exclude<ComposerMenuCommandOutcome, 'done'>;
  } | null>(null);
  // The menu closed (Escape, a press outside, a new scope): a running pick
  // is abandoned, and a late outcome must not close or annotate a later
  // session.
  useEffect(() => {
    if (isOpen) return;
    pendingRef.current?.release();
    pendingRef.current?.abort.abort();
    pendingRef.current = null;
    setPendingKey(null);
    setFailure(null);
  }, [isOpen]);
  // The editor's session outlives this menu (a host can move the menu,
  // remounting it): an unmount mid-pick abandons the pick and releases the
  // session's hold, or the session would keep holding Enter and the arrows.
  useEffect(
    () => (): void => {
      pendingRef.current?.release();
      pendingRef.current?.abort.abort();
      pendingRef.current = null;
    },
    [],
  );
  const setTriggerRef = useCallback(
    (node: HTMLButtonElement | null): void => {
      buttonRef.current = node;
      if (triggerRef) triggerRef.current = node;
    },
    [triggerRef],
  );

  const linearAvailable = linear?.available ?? false;
  // CAN-2706: one purpose-shaped name for both the tooltip and the accessible
  // name. Naming the contents ("Attach a file or Linear ticket") goes stale
  // every time the menu changes, and CAN-2710 is actively reconsidering what
  // belongs in here.
  const triggerAriaLabel = active
    ? `${COMPOSER_PLUS_MENU_LABEL}, ${activeLabel}`
    : COMPOSER_PLUS_MENU_LABEL;

  useEffect(() => {
    onOpenChange?.(isOpen);
  }, [isOpen, onOpenChange]);

  function handlePickAttachment(): void {
    controller?.prepareAction();
    setIsOpen(false);
    onPickAttachment?.();
  }

  function handlePickLinear(): void {
    if (!linearAvailable) return;
    controller?.prepareAction();
    setIsOpen(false);
    onPickLinear?.();
  }

  function handleAdditionalItem(item: ComposerMenuItem): void {
    if (item.disabled) return;
    controller?.prepareAction();
    setIsOpen(false);
    item.onSelect();
  }

  const actionRows: ComposerActionRow[] = [
    ...(onPickAttachment
      ? [
          {
            id: 'attachment',
            label: 'Files and folders',
            description: 'Add an attachment',
            icon: <FileIcon />,
            group: 'Add',
            popupRole: 'dialog' as const,
            onSelect: handlePickAttachment,
            dataTestId: `${dataTestIdPrefix}-plus-attachment`,
          },
        ]
      : []),
    // CAN-2709: connecting Linear is account-level and lives in Account
    // settings. Only the per-message action (attaching a ticket) belongs
    // beside the input, and only once the host reports a connection.
    ...(onPickLinear && linear
      ? [
          {
            id: 'linear',
            label: 'Linear',
            description: linear.description,
            icon: <LinearIcon size="md" />,
            group: 'Add',
            disabled: !linearAvailable,
            popupRole: 'dialog' as const,
            onSelect: handlePickLinear,
            dataTestId: `${dataTestIdPrefix}-plus-linear`,
          },
        ]
      : []),
    ...additionalItems
      .filter((item) => item.id !== 'commands')
      .map((item) => ({
        ...item,
        popupRole:
          item.popupRole ?? (item.opensMenu ? ('menu' as const) : undefined),
        group:
          item.group === 'settings'
            ? 'Current settings'
            : item.group === 'view'
              ? 'View'
              : 'Add',
        description: item.disabled
          ? (item.disabledTooltip?.description ??
            item.description ??
            ROW_DESCRIPTIONS[item.id])
          : (item.description ?? ROW_DESCRIPTIONS[item.id]),
        onSelect: () => handleAdditionalItem(item),
      })),
  ];
  const planToggle = additionalItems.find((item) => item.id === 'plan-mode');
  const addMenuEmpty =
    hideTriggerWhenEmpty &&
    actionRows.length === 0 &&
    onSelectPlugin === undefined &&
    searchFiles === undefined &&
    !(includeCommandsInAddMenu && commands.length > 0);
  const visibleActions = !isAddMenu
    ? []
    : actionRows.filter((row) =>
        `${row.label} ${row.description ?? ''} ${row.value ?? ''}`
          .toLowerCase()
          .includes(query.toLowerCase().trim()),
      );
  const composerCommandNames = useMemo(
    () =>
      new Set(
        commands
          .filter((command) => command.composerAction)
          .map((command) => command.name),
      ),
    [commands],
  );
  // Home also exposes capability members from +. Composer actions remain in
  // the Add menu's existing action rows rather than appearing a second time.
  const catalog = useMemo((): TCommand[] => {
    const listed: readonly TCommand[] = isOpen ? commands : NO_COMMANDS;
    return listed.filter((command) => {
      if (command.composerAction === 'plan' && !planToggle) return false;
      if (!isAddMenu)
        return (
          !command.browseNamespace &&
          (!!command.composerAction || !composerCommandNames.has(command.name))
        );
      return (
        includeCommandsInAddMenu &&
        isToolbarMenu &&
        !command.browseNamespace &&
        !command.composerAction &&
        !composerCommandNames.has(command.name)
      );
    });
  }, [
    isOpen,
    commands,
    isAddMenu,
    includeCommandsInAddMenu,
    isToolbarMenu,
    composerCommandNames,
    planToggle,
  ]);
  const rankedCommands = useMemo(
    () => searchSlashCommands(catalog, query),
    [catalog, query],
  );
  // Typed searches show a capped first view; Show all expands it for this
  // query only, so editing the query or closing the menu collapses it.
  const isTypedSearch = normalizeSearchText(query).length > 0;
  const [expandedQuery, setExpandedQuery] = useState<string | null>(null);
  useEffect(() => {
    setExpandedQuery(null);
  }, [isOpen, query]);
  function runCommand(command: TCommand, label: string): void {
    if (pendingRef.current !== null) return;
    controller?.beginSelection();
    const abort = new AbortController();
    const result = onSelectCommand?.(command, { signal: abort.signal });
    if (!(result instanceof Promise)) {
      setFailure(null);
      setIsOpen(false);
      return;
    }
    const token = Symbol('composer-menu-pick');
    const releaseHold = controller?.holdSelection();
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      releaseHold?.();
    };
    pendingRef.current = { token, abort, release };
    const key = commandKey(command);
    setPendingKey(key);
    const pickedQuery = query;
    const settle = (outcome: ComposerMenuCommandOutcome): void => {
      if (pendingRef.current?.token !== token) return;
      pendingRef.current = null;
      release();
      setPendingKey(null);
      if (outcome !== 'done') {
        setFailure({ key, command, label, query: pickedQuery, outcome });
        return;
      }
      setFailure(null);
      setIsOpen(false);
    };
    result.then(settle, () => settle('failed'));
  }

  const allCommandRows: ComposerActionRow[] = rankedCommands.map(
    (command, index) => {
      const toggle = command.composerAction === 'plan' ? planToggle : undefined;
      const label = command.displayName ?? command.name;
      const busy = pendingKey !== null && commandKey(command) === pendingKey;
      return {
        id: `command:${command.name}:${index}`,
        label,
        description: busy
          ? ENABLING_DESCRIPTION
          : (toggle?.description ??
            command.disabledReason ??
            command.description),
        available: command.section === 'available',
        busy,
        ariaChecked: toggle?.ariaChecked,
        value: toggle?.value,
        icon:
          toggle?.icon ??
          (isSkillCommand?.(command) ? <SkillIcon /> : <CommandIcon />),
        group: command.composerAction
          ? 'Commands'
          : command.section === 'available'
            ? 'Available to turn on'
            : 'Skills and commands',
        disabled: toggle?.disabled || !!command.disabledReason,
        dataTestId: `${dataTestIdPrefix}-capability-${command.name}`,
        completion: !command.composerAction,
        onSelect: (): void => {
          if (toggle) {
            handleAdditionalItem(toggle);
            return;
          }
          if (
            command.composerAction === 'help' ||
            command.composerAction === 'commands'
          ) {
            setQuery('');
          } else {
            runCommand(command, label);
          }
        },
      };
    },
  );
  const files = useMemo(
    () => (isOpen && isAddMenu ? (searchFiles?.(query) ?? []) : []),
    [isOpen, isAddMenu, searchFiles, query],
  );
  // The same path can exist in several repositories: name the repository
  // whenever the files can come from more than one.
  const filesSpanRepos =
    multiRepo || new Set(files.map((file) => file.repoId)).size > 1;
  const fileRows: ComposerActionRow[] = files.map((file) => ({
    id: `file:${file.absolutePath}`,
    label: file.filename,
    description:
      filesSpanRepos && file.repoName
        ? `${file.repoName} · ${file.relativePath}`
        : file.relativePath,
    group:
      file.kind === 'note'
        ? 'Notes'
        : file.kind === 'prompt'
          ? 'Prompts'
          : file.kind === 'attachment'
            ? 'Attachments'
            : 'Files',
    icon: <FileIcon />,
    dataTestId: `${dataTestIdPrefix}-file-result`,
    completion: true,
    onSelect: (): void => {
      onSelectFile?.(file);
      setIsOpen(false);
    },
  }));
  const normalizedQuery = query.toLowerCase().trim();
  const pluginRows: ComposerActionRow[] =
    isOpen && isAddMenu && onSelectPlugin
      ? plugins
          .filter((plugin) =>
            `${plugin.label} ${plugin.description ?? ''}`
              .toLowerCase()
              .includes(normalizedQuery),
          )
          .map((plugin) => ({
            id: `plugin:${plugin.marketplaceId}:${plugin.pluginName}`,
            label: plugin.label,
            description: plugin.description ?? 'Use this plugin for this chat',
            icon: plugin.icon,
            group: 'Plugins',
            ariaChecked: plugin.enabled,
            value: plugin.enabled ? 'Turned on' : undefined,
            dataTestId: `${dataTestIdPrefix}-plugin-${plugin.marketplaceId}-${plugin.pluginName}`,
            completion: true,
            onSelect: (): void => {
              // No `prepareAction()` here: like file rows, the host's pill
              // insertion consumes the trigger when it drops the pill.
              onSelectPlugin(
                {
                  marketplaceId: plugin.marketplaceId,
                  pluginName: plugin.pluginName,
                },
                { label: plugin.label, enabled: plugin.enabled },
              );
              setIsOpen(false);
            },
          }))
      : [];
  const { visible: commandRows, hiddenCount } =
    isTypedSearch && expandedQuery !== query
      ? limitSlashResults(allCommandRows, (row) => row.group)
      : { visible: allCommandRows, hiddenCount: 0 };
  const firstHiddenRowId =
    hiddenCount > 0
      ? allCommandRows.find((row) => !commandRows.includes(row))?.id
      : undefined;
  const pendingHighlightRef = useRef<string | null>(null);
  useEffect(() => {
    // After Show all, highlight the first previously hidden row; focus stays
    // in the composer.
    const rowId = pendingHighlightRef.current;
    if (rowId === null || expandedQuery !== query) return;
    pendingHighlightRef.current = null;
    const button = Array.from(
      controller?.menuRef.current?.querySelectorAll<HTMLElement>(
        '[data-row-id]',
      ) ?? [],
    ).find((row) => row.dataset.rowId === rowId);
    if (!button) return;
    controller?.setActiveId(button.id);
    button.scrollIntoView({ block: 'nearest' });
  }, [expandedQuery, query, controller]);
  const showAll =
    hiddenCount > 0
      ? {
          label: `Show all ${allCommandRows.length}`,
          dataTestId: `${dataTestIdPrefix}-show-all`,
          onSelect: (): void => {
            pendingHighlightRef.current = firstHiddenRowId ?? null;
            setExpandedQuery(query);
          },
        }
      : undefined;
  const listedRows = [
    ...visibleActions,
    ...pluginRows,
    ...commandRows,
    ...fileRows,
  ];
  // While a pick runs, no other row (or Show all) may start another.
  const picking = pendingKey !== null;
  const rows = picking
    ? listedRows.map((row) => ({ ...row, onSelect: ignorePick }))
    : listedRows;
  const shownFailure =
    failure !== null && failure.query === query ? failure : null;
  // Try again picks the row as the catalog lists it now, when it still does.
  const retryCommand = (shown: NonNullable<typeof failure>): TCommand =>
    commands.find((command) => commandKey(command) === shown.key) ??
    shown.command;

  const handleTriggerKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
  ): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setIsOpen(true);
    }
  };

  return (
    <ComposerPlusMenuPresentation
      isOpen={isOpen}
      setIsOpen={setIsOpen}
      rows={rows}
      triggerRef={setTriggerRef}
      onTriggerKeyDown={handleTriggerKeyDown}
      openOnArrowKeys={false}
      disabled={disabled}
      capsuleTrigger={capsuleTrigger}
      {...(tapTarget === undefined ? {} : { tapTarget })}
      active={active}
      triggerAriaLabel={triggerAriaLabel}
      tooltipLabel={
        controller ? COMPOSER_PLUS_MENU_TOOLTIP : COMPOSER_PLUS_MENU_LABEL
      }
      shortcut={controller ? '@' : undefined}
      hideTrigger={hideTrigger || addMenuEmpty}
      menuId={menuId}
      anchorRef={composerAnchorRef ?? controller?.anchorRef ?? buttonRef}
      gap={gap}
      placement={placement}
      allowFlip={allowFlip}
      outsidePressBoundaryRef={controller?.editorRef}
      returnFocusRef={controller?.editorRef ?? buttonRef}
      dataTestIdPrefix={dataTestIdPrefix}
      variant={variant}
      fullWidth={!!(controller || composerAnchorRef)}
      menuRef={controller?.menuRef}
      activeId={controller?.activeId}
      onActiveIdChange={controller?.setActiveId}
      onHoveredIdChange={controller?.setHoveredId}
      loading={isRefreshing}
      flat={isTypedSearch && !isAddMenu}
      showAll={
        picking && showAll ? { ...showAll, onSelect: ignorePick } : showAll
      }
      error={
        shownFailure === null
          ? null
          : shownFailure.outcome === 'skipped'
            ? {
                tone: 'attention',
                title: `Turned on ${shownFailure.label}`,
                message: SKIPPED_MESSAGE,
              }
            : shownFailure.outcome === 'unavailable'
              ? { message: enableUnavailableMessage(shownFailure.label) }
              : {
                  message: enableErrorMessage(shownFailure.label),
                  onRetry: (): void =>
                    runCommand(retryCommand(shownFailure), shownFailure.label),
                  retrying: picking,
                }
      }
    />
  );
}
