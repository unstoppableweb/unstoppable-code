import type { PreferencesModelFacts } from '@canopy/protocol/preferences';

let installedEnvironment: PreferencesModelFacts | undefined;

/** Replaces the process-wide model facts. Hosts call it before normalizing. */
export function installPreferencesNormalizationEnvironment(
  facts: PreferencesModelFacts,
): void {
  installedEnvironment = facts;
}

/**
 * The installed model facts. Throws
 * `Error('Preferences normalization has no host environment; call installPreferencesNormalizationEnvironment first.')`
 * when none is installed.
 */
export function preferencesNormalizationEnvironment(): PreferencesModelFacts {
  if (installedEnvironment === undefined) {
    throw new Error(
      'Preferences normalization has no host environment; call installPreferencesNormalizationEnvironment first.',
    );
  }
  return installedEnvironment;
}
