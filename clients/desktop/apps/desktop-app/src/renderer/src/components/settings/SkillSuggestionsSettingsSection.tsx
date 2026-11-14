import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { SKILL_SUGGESTION_COPY } from '@canopy/ui-app';
import {
  Button,
  Count,
  ErrorBanner,
  ToggleSwitch,
} from '@canopy/ui-shared/components';
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/SettingsLayout';
import {
  useOpenSkillSuggestions,
  useSkillSuggestionStore,
  useSkillSuggestionsFlagEnabled,
} from '@/stores/skillSuggestionStore';

const SECTION_TITLE = 'Skill suggestions';
const LABEL = 'Suggest skills for repeated requests';
const HELPER =
  'Get an offer to turn tasks you repeat into a skill. Works only while Settings → General → Show suggestions is on. Your request history stays on this computer and is only used to spot patterns, which may use AI Credits.';
const VIEW_LABEL = 'Open suggestions';
const VIEW_HELPER = 'See every open suggestion and create or dismiss it.';
const SAVE_ERROR_MESSAGE = "Couldn't save this setting. Try again.";
const SWITCH_ID = 'settings-skill-suggestions-switch';

/** On unless the user turned it off; main normalizes it to a boolean. */
function readSuggestionsEnabled(
  preferences: Pick<PreferencesData, 'skillSuggestionsEnabled'>,
): boolean {
  return preferences.skillSuggestionsEnabled !== false;
}

/**
 * Settings → Plugins → "Skill suggestions" (CAN-385).
 *
 * Hidden while `canopy-desktop-skill-suggestions` is off. The switch persists
 * `PreferencesData.skillSuggestionsEnabled`; turning it off deletes the local
 * request history main keeps for suggestions. "View suggestions" opens the
 * modal with every open suggestion and carries their count.
 */
export function SkillSuggestionsSettingsSection(): JSX.Element | null {
  const flagEnabled = useSkillSuggestionsFlagEnabled();
  return flagEnabled ? (
    <SettingsSection
      title={SECTION_TITLE}
      dataTestId="settings-skill-suggestions"
    >
      <SettingsGroup>
        <SkillSuggestionsRows />
      </SettingsGroup>
    </SettingsSection>
  ) : null;
}

function SkillSuggestionsRows(): JSX.Element {
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const enabledRef = useRef(enabled);
  // While a save is in flight its result is authoritative.
  const savingRef = useRef(false);
  const suggestions = useOpenSkillSuggestions(true);
  const openModal = useSkillSuggestionStore((state) => state.setModalOpen);
  const count = suggestions?.length ?? 0;

  const applyEnabled = useCallback((next: boolean): void => {
    enabledRef.current = next;
    setEnabled(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.api
      .loadPreferences()
      .then((preferences) => {
        if (cancelled || savingRef.current) return;
        applyEnabled(readSuggestionsEnabled(preferences));
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return (): void => {
      cancelled = true;
    };
  }, [applyEnabled]);

  useEffect(
    () =>
      window.api.onPreferencesSynced((preferences) => {
        if (savingRef.current) return;
        applyEnabled(readSuggestionsEnabled(preferences));
        setLoaded(true);
      }),
    [applyEnabled],
  );

  const handleToggle = useCallback(
    (next: boolean): void => {
      const previous = enabledRef.current;
      applyEnabled(next);
      savingRef.current = true;
      setSaving(true);
      setSaveError(null);
      void window.api
        .savePreferences({ skillSuggestionsEnabled: next })
        .then((preferences) => {
          applyEnabled(readSuggestionsEnabled(preferences));
        })
        .catch(() => {
          applyEnabled(previous);
          setSaveError(SAVE_ERROR_MESSAGE);
        })
        .finally(() => {
          savingRef.current = false;
          setSaving(false);
        });
    },
    [applyEnabled],
  );

  return (
    <>
      <SettingsRow
        label={LABEL}
        htmlFor={SWITCH_ID}
        description={HELPER}
        dataTestId="skill-suggestions-settings-row"
        control={
          <ToggleSwitch
            id={SWITCH_ID}
            checked={enabled}
            disabled={!loaded || saving}
            label={LABEL}
            onChange={handleToggle}
            dataTestId="skill-suggestions-settings-toggle"
          />
        }
      >
        <ErrorBanner
          errorSource="skill-suggestions-rows-save"
          className=""
          error={saveError}
        />
      </SettingsRow>
      <SettingsRow
        label={VIEW_LABEL}
        description={VIEW_HELPER}
        control={
          <Button
            variant="secondary"
            size="compact"
            data-testid="skill-suggestions-settings-view"
            onClick={() => openModal(true)}
          >
            <span className="inline-flex items-center gap-3">
              {SKILL_SUGGESTION_COPY.viewSuggestions}
              {count > 0 ? (
                <span
                  className="inline-flex"
                  data-testid="skill-suggestions-settings-badge"
                  aria-label={`${String(count)} open`}
                >
                  <Count value={count} />
                </span>
              ) : null}
            </span>
          </Button>
        }
      />
    </>
  );
}
