/** @jest-environment jsdom */
/**
 * Harness setup from a remote controller (CAN-6718): a window showing
 * another computer opens sign-in links in this computer's browser, so it
 * opens only https pages on the providers' own sign-in hosts. A controlled
 * computer can't point this browser anywhere else, whether through a
 * device-code page (Copilot) or a link printed in a sign-in terminal.
 */
let mockMode: 'local' | 'remote' = 'remote';
jest.mock('@/stores/remoteControlStore', () => ({
  readRemoteControlContext: (): { mode: string } => ({ mode: mockMode }),
}));

import { openSignInLink } from '../open-sign-in-link';

const open = jest.fn();
const openExternal = jest.fn(() => Promise.resolve());

beforeEach(() => {
  open.mockClear();
  openExternal.mockClear();
  mockMode = 'remote';
  Object.defineProperty(window, 'open', { configurable: true, value: open });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { browser: { openExternal } },
  });
});

it.each([
  'https://github.com/login/device',
  'https://claude.ai/oauth/authorize?code=true',
  'https://console.anthropic.com/oauth/code/callback',
  'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
  'https://auth.openai.com/codex/device',
  'https://cursor.com/loginDeepControl?challenge=c',
])('opens the sign-in page %s on this computer', (url) => {
  expect(openSignInLink(url)).toBe(true);
  expect(open).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer');
});

it.each([
  'https://github.com.example.net/login/device',
  'http://github.com/login/device',
  'https://user:pass@github.com/login/device',
  'https://github.com:8443/login/device',
  'https://example.com/phish',
  'not a url',
])('refuses %s from the other computer', (url) => {
  expect(openSignInLink(url)).toBe(false);
  expect(open).not.toHaveBeenCalled();
});

it('leaves a local window’s links to main’s guarded open', () => {
  mockMode = 'local';
  expect(openSignInLink('https://example.com/docs')).toBe(true);
  expect(openExternal).toHaveBeenCalledWith({
    url: 'https://example.com/docs',
  });
});
