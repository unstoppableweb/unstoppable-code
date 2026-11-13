import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import { useMarketplaceList } from '@/hooks/useMarketplaceList';
import { pluginNeedsInstall } from '@/lib/pluginInstallStatus';
import { useSafeRemoteImageUrl } from '@/lib/remote-image';
import {
  getUnsupportedReason,
  type PluginSelectorProviderScope,
} from './pluginSelectorScope';
import type { ComposerMenuController } from '@/hooks/useComposerMenu';
import type { ComposerCommand } from '@/lib/composerCommands';
import { useMemo, useState, type JSX } from 'react';
import {
  ComposerMenu,
  type ComposerMenuItem,
  type ComposerMenuLinear,
  type ComposerMenuPlugin,
  type ComposerMenuProps,
} from '@canopy/ui-app';
import { PluginsIcon } from '@canopy/ui-shared/icons/AppIcons';
import { useLinearAvailability } from '@/hooks/useLinearStatus';
import { useSettingsLocationLabel } from '@/lib/navigation/settings-destinations';

export type ComposerPlusMenuItem = ComposerMenuItem;

export interface ComposerPlusMenuProps extends Omit<
  ComposerMenuProps<ComposerCommand>,
  | 'controller'
  | 'linear'
  | 'plugins'
  | 'onPluginsNeededChange'
  | 'onSelectPlugin'
  | 'isSkillCommand'
  | 'commandKey'
> {
  controller?: ComposerMenuController;
  providerScope?: PluginSelectorProviderScope;
  pluginSelections?: ChatTabPluginSelections;
  /**
   * A whole-plugin row was picked. `enabled` reports whether the plugin was
   * already selected for this chat so the host can skip re-enabling it; the
   * host inserts the `@` mention pill (`label`) either way.
   */
  onSelectPlugin?: (
    ref: ChatTabPluginSelections['pluginRefs'][number],
    meta: { label: string; enabled: boolean },
  ) => void;
}

const isSkillCommand = (command: ComposerCommand): boolean =>
  command.inventoryEntry?.kind.includes('skill') ?? false;

/** An inventory row is its entry; the catalog rebuilds the row objects. */
const commandKey = (command: ComposerCommand): string =>
  `${command.name}\u0000${command.inventoryEntry?.id ?? ''}`;

/**
 * The desktop host of the shared composer menu (`@canopy/ui-app`
 * `ComposerMenu`), used by the Home composer, `ChatInput` and the
 * configuration composers. It supplies what only the desktop knows: the
 * Linear connection, the installed plugin catalog (filtered to what this
 * chat's model can load), and plugin logos behind the safe image resolver.
 *
 * Owns Linear availability internally — loads the token and validates it via
 * `useLinearStatus`, exactly like the old `HomeLinearAttach` did at mount —
 * so consumers don't need to duplicate that token-load dance just to decide
 * whether to render a Linear option. The row's PRESENCE follows the stored
 * token rather than a validated status, and its enabled state follows
 * validation: connecting Linear is an account-level integration that lives in
 * Settings → Account (CAN-2709), so the menu never offers a connect
 * affordance — but it must not make an existing connection disappear either.
 */
/** Skip Linear token reads entirely for configuration composers without attachments. */
export function ComposerPlusMenu(props: ComposerPlusMenuProps): JSX.Element {
  return props.onPickLinear ? (
    <ComposerPlusMenuWithLinear {...props} />
  ) : (
    <ComposerPlusMenuContent {...props} linear={null} />
  );
}

function ComposerPlusMenuWithLinear(props: ComposerPlusMenuProps): JSX.Element {
  const linearAvailability = useLinearAvailability();
  const available = linearAvailability.available;
  // Only read once a token is stored, and a non-empty stored token implies
  // the load finished — so `tokenLoaded` cannot discriminate here.
  const statusPending = linearAvailability.status === null;
  // The App Advisor window renders this same composer but has no Account tab
  // in its own settings modal (Defaults / Instructions / Advanced only), so
  // "Settings → Account" is not a reachable instruction there. The removed
  // `Connect Linear` row used to carry this same surface check.
  const settingsReachableHere =
    typeof document === 'undefined' ||
    document.body.dataset.rendererSurface !== 'app-advisor';
  const settingsLocation = useSettingsLocationLabel('integrations');
  // "Exists" means a stored token (`tokenPresent`), not a validated one.
  const linear: ComposerMenuLinear | null =
    linearAvailability.tokenPresent || available
      ? {
          available,
          description: available
            ? 'Attach an issue'
            : statusPending
              ? 'Checking your Linear connection'
              : settingsReachableHere
                ? `Check your Linear API key. Update it in ${settingsLocation}.`
                : 'Check your Linear API key. Update it in Account settings in the main window.',
        }
      : null;
  return <ComposerPlusMenuContent {...props} linear={linear} />;
}

function ComposerPlusMenuContent({
  providerScope = 'mixed',
  pluginSelections,
  onSelectPlugin,
  linear,
  ...props
}: ComposerPlusMenuProps & {
  linear: ComposerMenuLinear | null;
}): JSX.Element {
  // The catalog is only needed once the Add menu is open; the composer is
  // mounted on every chat and Home surface, so keep the load off startup.
  const [pluginsNeeded, setPluginsNeeded] = useState(false);
  const { cache: pluginCatalog } = useMarketplaceList({
    enabled: pluginsNeeded,
  });
  const plugins = useMemo(
    (): ComposerMenuPlugin[] =>
      pluginsNeeded
        ? (pluginCatalog?.marketplaces ?? []).flatMap((marketplace) =>
            marketplace.plugins
              .filter(
                (plugin) =>
                  // The composer menu is a quick picker for what THIS chat
                  // can use right now: plugins that still need installing and
                  // plugins the selected model cannot load are omitted
                  // outright rather than listed disabled (the full Plugins
                  // picker keeps every row with its reason and install
                  // affordance).
                  !pluginNeedsInstall(plugin) &&
                  getUnsupportedReason(
                    plugin.providerSupport,
                    providerScope,
                  ) === null,
              )
              .map((plugin) => ({
                marketplaceId: marketplace.id,
                pluginName: plugin.name,
                label: plugin.displayName ?? plugin.name,
                ...(plugin.description === undefined
                  ? {}
                  : { description: plugin.description }),
                icon: <ComposerPluginLogo logoUrl={plugin.logoUrl} />,
                enabled: !!pluginSelections?.pluginRefs.some(
                  (ref) =>
                    ref.marketplaceId === marketplace.id &&
                    ref.pluginName === plugin.name,
                ),
              })),
          )
        : [],
    [pluginsNeeded, pluginCatalog, providerScope, pluginSelections],
  );
  return (
    <ComposerMenu
      {...props}
      linear={linear}
      isSkillCommand={isSkillCommand}
      commandKey={commandKey}
      plugins={plugins}
      onPluginsNeededChange={setPluginsNeeded}
      onSelectPlugin={onSelectPlugin}
    />
  );
}

/** Keep remote images behind the existing safe image resolver. */
function ComposerPluginLogo({ logoUrl }: { logoUrl?: string }): JSX.Element {
  const src = useSafeRemoteImageUrl(logoUrl);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return src && src !== failedSrc ? (
    <img
      src={src}
      alt=""
      width={16}
      height={16}
      className="shrink-0 object-contain"
      onError={() => setFailedSrc(src)}
    />
  ) : (
    <PluginsIcon />
  );
}
