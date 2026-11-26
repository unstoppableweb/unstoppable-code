// The rules Electron's preferences:save runs today and the open
// core.config.document.update will run, as one table (CAN-7935).
import {
  applyPreferenceSaveRules,
  classifyPreferenceWrite,
  mergeUsageDataPatch,
} from '../core';
import { PREFERENCE_SAVE_RULE_CASES } from '../core/config/testing';

describe('the preference save rules (CAN-7935)', () => {
  it.each(PREFERENCE_SAVE_RULE_CASES.map((rule) => [rule.name, rule]))(
    '%s',
    (_name, { patch, outcome }) => {
      const sent = structuredClone(patch);
      const result = applyPreferenceSaveRules(patch);
      expect(patch).toEqual(sent);
      if ('refused' in outcome) {
        expect(result).toEqual({ refused: outcome.refused });
        return;
      }
      expect(result).toEqual({
        patch: Object.fromEntries(
          Object.entries(patch).filter(
            ([key]) => !outcome.dropped.includes(key),
          ),
        ),
        dropped: outcome.dropped,
      });
    },
  );

  // Internal writers only: a caller-supplied patch is always open.
  it.each(PREFERENCE_SAVE_RULE_CASES.map((rule) => [rule.name, rule]))(
    'an internal write of %s is owner-only exactly when the rules would change it',
    (_name, { patch, outcome }) => {
      expect(classifyPreferenceWrite(patch)).toBe(
        'refused' in outcome || outcome.dropped.length > 0 ? 'owner' : 'open',
      );
    },
  );

  it('an internal write holding a refused key takes the owner path', () => {
    expect(classifyPreferenceWrite({ approvalDefaults: {} })).toBe('owner');
    expect(classifyPreferenceWrite({ navigationMode: 'work' })).toBe('open');
  });

  it('usage data merges per key over the stored switches', () => {
    const stored = { errorReports: true, productAnalytics: false };
    expect(mergeUsageDataPatch(stored, { errorReports: false })).toEqual({
      errorReports: false,
      productAnalytics: false,
    });
    expect(mergeUsageDataPatch(stored, {})).toEqual(stored);
    expect(stored).toEqual({ errorReports: true, productAnalytics: false });
  });
});
