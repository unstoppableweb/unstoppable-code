/** @jest-environment jsdom */
/**
 * CAN-7991: a `preferences:save` reply marked `__preferencesUnconfirmed`
 * carries defaults standing in for domain preferences main has not read.
 * No renderer listener hears it as saved state, and the App Advisor save
 * does not apply it; an unmarked reply still reaches them.
 */
import { DEFAULT_PREFERENCES } from '@canopy/desktop-shared/node/preferences/defaults';
import type { PreferencesSaveResult } from '@canopy/desktop-shared/types';
import { saveAppAdvisorPreferencePatch } from '../appAdvisorPreferenceSave';
import {
  CANOPY_PREFERENCES_UPDATED_EVENT,
  emitPreferencesUpdated,
  subscribePreferencesUpdated,
} from '../preferences-events';

const STORED = {
  ...DEFAULT_PREFERENCES,
  approvalsUpgradeNoticeDismissed: true,
};

function stubSaveReply(reply: PreferencesSaveResult): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      savePreferences: jest.fn(() => Promise.resolve(reply)),
      loadPreferences: jest.fn(() =>
        Promise.reject(new Error('The daemon is not running.')),
      ),
    },
  });
}

it('a marked save reply reaches no preferences listener; an unmarked one does', () => {
  const listener = jest.fn();
  const raw = jest.fn();
  const unsubscribe = subscribePreferencesUpdated(listener);
  window.addEventListener(CANOPY_PREFERENCES_UPDATED_EVENT, raw);
  try {
    emitPreferencesUpdated({
      ...DEFAULT_PREFERENCES,
      colorMode: 'dark',
      __preferencesUnconfirmed: true,
    });
    expect(listener).not.toHaveBeenCalled();
    expect(raw).not.toHaveBeenCalled();
    emitPreferencesUpdated({ ...STORED, colorMode: 'dark' });
    expect(listener).toHaveBeenCalledWith({ ...STORED, colorMode: 'dark' });
    expect(raw).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribe();
    window.removeEventListener(CANOPY_PREFERENCES_UPDATED_EVENT, raw);
  }
});

it('the App Advisor save keeps its optimistic value over a marked reply', async () => {
  stubSaveReply({ ...DEFAULT_PREFERENCES, __preferencesUnconfirmed: true });
  const onPrefs = jest.fn();
  saveAppAdvisorPreferencePatch(
    STORED,
    { appAdvisorThinkingLevel: 'low' },
    onPrefs,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(onPrefs.mock.calls).toEqual([
    [{ ...STORED, appAdvisorThinkingLevel: 'low' }],
  ]);

  const saved = { ...STORED, appAdvisorThinkingLevel: 'low' as const };
  stubSaveReply(saved);
  onPrefs.mockClear();
  saveAppAdvisorPreferencePatch(
    STORED,
    { appAdvisorThinkingLevel: 'low' },
    onPrefs,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(onPrefs).toHaveBeenLastCalledWith(saved);
  expect(onPrefs).toHaveBeenCalledTimes(2);
});
