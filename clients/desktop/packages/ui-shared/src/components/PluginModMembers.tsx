import type { JSX } from 'react';

/**
 * One Claude Mod of a plugin: a module its hooks file loads. Both
 * `PluginModInfo` (plugin details) and `RemoteControlPluginCatalogModMember` (the
 * Portal member inventory) have this shape.
 */
export interface PluginModMember {
  readonly module: string;
  readonly hooksFile: string;
}

/** A Mod row with a stable key, in the order the hooks files list them. */
export interface PluginModRow extends PluginModMember {
  readonly key: string;
}

/** What every surface that lists a plugin's Mods says about them. */
export const PLUGIN_MOD_NOTICE =
  "A mod runs code inside Claude Code. It runs in Claude chats only and can't approve tool calls in this app.";

/**
 * Keyed rows for a plugin's Mods. An absent list (an inventory from before
 * Mods were recorded) gives no rows, the same as an empty one. The order is
 * kept: it is the order the hooks files load the modules in.
 */
export function pluginModRows(
  mods: readonly PluginModMember[] | undefined,
): PluginModRow[] {
  return (mods ?? []).map((mod, index) => ({
    key: `${mod.hooksFile}:${mod.module}:${String(index)}`,
    module: mod.module,
    hooksFile: mod.hooksFile,
  }));
}

/** The shared line under a Mods heading. */
export function PluginModNotice(): JSX.Element {
  return (
    <p className="text-xs fg-secondary" data-testid="plugin-mod-notice">
      {PLUGIN_MOD_NOTICE}
    </p>
  );
}
