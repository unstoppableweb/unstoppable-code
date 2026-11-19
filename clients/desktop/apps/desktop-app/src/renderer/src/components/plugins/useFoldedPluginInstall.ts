import { useCallback, useEffect, useRef, useState } from 'react';
import { CURATED_PLUGIN_MARKETPLACE_ID } from '@canopy/execution-engine/types/plugins';
import {
  linkRecordedError,
  recordedErrorOf,
  type UnifiedEntryFoldedPlugin,
} from '@canopy/ui-shared';
import { installRecommendedPlugin } from '@/lib/plugins/installRecommendedPlugin';
import { curatedPluginKey } from '@/lib/onboarding/curatedOnboardingPlugins';

export interface FoldedPluginInstallState {
  status: 'idle' | 'installing' | 'installed' | 'error';
  message?: string;
  /** Main already recorded this failure, so its banner records nothing. */
  recorded?: true;
}

/**
 * Installs the curated plugin folded into an integration card (REG-3033).
 * Every card with a folded plugin installs it the same way, whether or not
 * it has an app connection: on its own (Install skills only), once a
 * connection exists, or when the host requests it as a provider route starts.
 * Each increment of `installRequest` installs once; `0` requests nothing.
 */
export function useFoldedPluginInstall(
  foldedPlugin: UnifiedEntryFoldedPlugin | undefined,
  installRequest: number,
): {
  pluginInstall: FoldedPluginInstallState;
  installFoldedPlugin: () => Promise<void>;
} {
  const [pluginInstall, setPluginInstall] = useState<FoldedPluginInstallState>({
    status: foldedPlugin?.installed ? 'installed' : 'idle',
  });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  const installFoldedPlugin = useCallback(async (): Promise<void> => {
    // One install at a time: a connector route can request it as it starts
    // and again as it confirms.
    if (
      !foldedPlugin ||
      pluginInstall.status === 'installing' ||
      pluginInstall.status === 'installed'
    )
      return;
    setPluginInstall({ status: 'installing' });
    try {
      await installRecommendedPlugin([
        curatedPluginKey(CURATED_PLUGIN_MARKETPLACE_ID, foldedPlugin.key),
      ]);
      if (mounted.current) setPluginInstall({ status: 'installed' });
    } catch (cause) {
      // Main recorded it; the banner records nothing but links it to this session.
      linkRecordedError(cause, 'mcp-browse-detail-skills-error');
      if (mounted.current)
        setPluginInstall({
          status: 'error',
          message: cause instanceof Error ? cause.message : String(cause),
          ...(recordedErrorOf(cause) ? { recorded: true as const } : {}),
        });
    }
  }, [foldedPlugin, pluginInstall.status]);

  const installRef = useRef(installFoldedPlugin);
  installRef.current = installFoldedPlugin;
  useEffect(() => {
    if (installRequest > 0) void installRef.current();
  }, [installRequest]);

  return { pluginInstall, installFoldedPlugin };
}
