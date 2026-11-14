import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import type { NavigationMode } from '@canopy/desktop-shared/types';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  useNavigationMode,
  useNavigationModeStore,
} from '@/stores/navigationModeStore';
import { SettingsRow, SettingsSegmentedControl } from './SettingsLayout';
import { ErrorBanner } from '@canopy/ui-shared/components';

interface ModeOption {
  id: NavigationMode;
  label: string;
  description: string;
}

/**
 * Code first: it is the default, so the preselected option is the first one
 * read (docs/ux-writing.md, "A default is a statement").
 */
const MODE_OPTIONS: readonly ModeOption[] = [
  {
    id: 'code',
    label: 'Code',
    description: 'Show repositories, branches, and worktrees everywhere',
  },
  {
    id: 'work',
    label: 'Work',
    description: 'Plain language, with developer controls one step away',
  },
];

/**
 * Lets the user view and override the Code vs Work navigation mode seeded
 * from their onboarding role (CAN-1817). Reads and writes through the
 * renderer mirror store so every mode-aware surface updates immediately.
 */
export function NavigationModeSection(): JSX.Element {
  const mode = useNavigationMode();
  const hydrated = useNavigationModeStore((state) => state.hydrated);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Selections can overlap; only the latest one may report its outcome so a
  // stale failure never paints an error over a newer, persisted choice.
  const selectionGeneration = useRef(0);

  useEffect(() => {
    void useNavigationModeStore.getState().hydrate();
  }, []);

  const handleSelect = useCallback((next: NavigationMode): void => {
    const generation = ++selectionGeneration.current;
    setSaveError(null);
    useNavigationModeStore
      .getState()
      .setMode(next)
      .catch(() => {
        if (generation !== selectionGeneration.current) return;
        setSaveError("Couldn't save the mode. Try again.");
      });
  }, []);

  useCurrentUiStateReporter('settings.navigationMode', {
    loaded: hydrated,
    mode,
  });

  const selected =
    MODE_OPTIONS.find((option) => option.id === mode) ?? MODE_OPTIONS[0];
  return (
    <SettingsRow
      label="Mode"
      labelId="settings-navigation-mode-heading"
      description={selected.description}
      dataTestId="settings-navigation-mode"
      control={
        <SettingsSegmentedControl
          label="Mode"
          value={mode}
          onChange={handleSelect}
          options={MODE_OPTIONS.map((option) => ({
            value: option.id,
            label: option.label,
            dataTestId: `settings-navigation-mode-${option.id}`,
          }))}
        />
      }
    >
      <ErrorBanner
        errorSource="settings-navigation-mode-error"
        className=""
        error={saveError}
        testId="settings-navigation-mode-error"
      />
    </SettingsRow>
  );
}
