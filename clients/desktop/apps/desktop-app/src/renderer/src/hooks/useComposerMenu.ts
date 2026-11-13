import { useCallback, useMemo } from 'react';
import {
  useComposerMenu as useSharedComposerMenu,
  type ComposerMenuController as SharedComposerMenuController,
} from '@canopy/ui-rich/editor';
import type { ChatEditor } from '@canopy/ui-rich/types';
import { buildFileReferenceDisplayPath } from '@/lib/fileMentionSearch';
import {
  PLUGIN_MENTION_KIND,
  buildPluginMentionAbsolutePath,
  type PluginMentionRef,
} from '@canopy/desktop-shared/lib/plugin-mention';

export interface ComposerMenuController extends SharedComposerMenuController {
  /**
   * Insert a whole-plugin mention pill (kind `plugin`) at the trigger, the
   * way `insertFile` inserts a file pill. `label` is the user-facing plugin
   * name and becomes the pill's display token in the serialized text.
   */
  insertPlugin: (plugin: PluginMentionRef & { label: string }) => void;
}

/**
 * The desktop host of the shared composer menu session (`@canopy/ui-rich`):
 * desktop file pills use its workspace-item display paths, and plugin picks
 * become `plugin://` mention pills.
 */
export function useComposerMenu(
  editor: ChatEditor,
  options: {
    enabled: boolean;
    dollar: boolean;
    scopeKey: string;
    onChange: () => void;
  },
): ComposerMenuController {
  const controller = useSharedComposerMenu(editor, {
    ...options,
    buildFileDisplayPath: buildFileReferenceDisplayPath,
  });
  const { insertPill } = controller;
  const insertPlugin = useCallback(
    (plugin: PluginMentionRef & { label: string }): void =>
      insertPill({
        displayPath: plugin.label,
        absolutePath: buildPluginMentionAbsolutePath(plugin),
        kind: PLUGIN_MENTION_KIND,
      }),
    [insertPill],
  );
  // Memoized like the shared controller, so it changes only with the session.
  return useMemo(
    (): ComposerMenuController => ({ ...controller, insertPlugin }),
    [controller, insertPlugin],
  );
}
