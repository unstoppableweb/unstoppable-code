/** Shared facet precedence; readers decide whether malformed content is fatal. */
export function readPluginManifest<T>(
  provider: 'claude' | 'codex',
  read: (relativePath: string) => T | null,
): T | null {
  if (provider === 'codex') return read('.codex-plugin/plugin.json');
  return (
    read('.claude-plugin/plugin.json') ?? read('.codex-plugin/plugin.json')
  );
}
