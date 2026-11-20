// An Antigravity session launches as a Canopy-defined custom agent that
// inherits nothing from the repository and exposes only host-gated tools; the
// committed isolation evidence records this for the child launch shape. A
// break either hides Google delegates that are safe to run or admits them on
// a host or flag state where Antigravity is unavailable.
const mockHarnessEnabled = jest.fn<boolean, []>();
const mockHostOperatingSystem = jest.fn<string, []>();

jest.mock('../feature-flag', () => ({
  isAntigravityHarnessEnabled: (): boolean => mockHarnessEnabled(),
}));
jest.mock('@canopy/core-platform/host-platform', () => ({
  hostOperatingSystem: (): string => mockHostOperatingSystem(),
}));

import {
  antigravityChildAdmission,
  antigravityDelegateRawModel,
  antigravityNativeDiscoveryIsolation,
} from '../delegation-admission';

describe('Antigravity delegate admission', () => {
  beforeEach(() => {
    mockHarnessEnabled.mockReturnValue(true);
    mockHostOperatingSystem.mockReturnValue('darwin');
  });

  it('admits Antigravity delegates once native discovery isolation is qualified', () => {
    expect(antigravityNativeDiscoveryIsolation()).toEqual({ qualified: true });
    expect(antigravityChildAdmission()).toEqual({ admitted: true });
  });

  it('stays unavailable when the harness flag is off', () => {
    mockHarnessEnabled.mockReturnValue(false);
    expect(antigravityChildAdmission()).toEqual({
      admitted: false,
      reason: 'Antigravity is unavailable. Choose another model.',
    });
  });

  it('stays unavailable on a non-darwin host', () => {
    mockHostOperatingSystem.mockReturnValue('linux');
    expect(antigravityChildAdmission()).toEqual({
      admitted: false,
      reason:
        "Antigravity delegates aren't available on this platform yet. Choose another model.",
    });
  });

  it('keeps the Google subscription model rule', () => {
    expect(
      antigravityDelegateRawModel('antigravity/claude-sonnet-5-5'),
    ).toBeUndefined();
  });
});
