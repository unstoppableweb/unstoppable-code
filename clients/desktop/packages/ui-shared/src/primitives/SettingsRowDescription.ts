import { createContext, useContext } from 'react';

/**
 * Id of the description of the Settings row a control sits in. Its own module
 * so `ToggleSwitch` can read it without importing the row kit, which imports
 * `ToggleSwitch`.
 */
export const SettingsRowDescriptionContext = createContext<string | undefined>(
  undefined,
);

/** The enclosing Settings row's description id, for `aria-describedby`. */
export function useSettingsRowDescriptionId(): string | undefined {
  return useContext(SettingsRowDescriptionContext);
}
