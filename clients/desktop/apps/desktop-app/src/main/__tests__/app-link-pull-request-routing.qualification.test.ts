/**
 * Pull request links clicked in the app open in the system browser, whatever
 * the built-in browser setting says. Cited by
 * behavior-inventory/app-link-pull-request-routing.yaml. Preferences, the
 * external open and the renderer are faked; the renderer accepts every
 * request, so a link it is asked about would open in the built-in browser.
 */
import {
  IPC_CHANNELS,
  type AppLinkBrowserEvent,
} from '@canopy/desktop-shared/types';
import {
  resetAppLinkRouterForTests,
  resolveAppLinkRequest,
  routeAppLink,
} from '../browser/app-link-router';

const mockOpenExternal = jest.fn<Promise<void>, [string]>(() =>
  Promise.resolve(),
);
const mockRendererRequests: Array<{
  channel: string;
  event: AppLinkBrowserEvent;
}> = [];

jest.mock(
  '../lib/open-external',
  (): { openExternalGuarded: (url: string) => Promise<void> } => ({
    openExternalGuarded: (url: string): Promise<void> => mockOpenExternal(url),
  }),
);
jest.mock(
  '../lib/preferences-store',
  (): { readPreferencesFile: () => Promise<Record<string, boolean>> } => ({
    readPreferencesFile: (): Promise<Record<string, boolean>> =>
      Promise.resolve({ openAppLinksInBuiltInBrowser: true }),
  }),
);
jest.mock(
  '../lib/web-contents-send',
  (): {
    sendToWebContents: (
      target: unknown,
      channel: string,
      event: AppLinkBrowserEvent,
    ) => void;
  } => ({
    sendToWebContents: (
      _target: unknown,
      channel: string,
      event: AppLinkBrowserEvent,
    ): void => {
      mockRendererRequests.push({ channel, event });
    },
  }),
);
jest.mock(
  '../canopy-cloud/config',
  (): { getCanopyCloudBaseUrl: () => string } => ({
    getCanopyCloudBaseUrl: (): string => 'https://cloud.example.test',
  }),
);

const sender = { id: 1, isDestroyed: (): boolean => false, send: jest.fn() };

/** Routes a link while a renderer that accepts every request answers it. */
async function route(
  url: string,
  source: 'app-link' | 'system-default',
): Promise<string> {
  const pending = routeAppLink({ url, sender, source });
  for (;;) {
    const settled = await Promise.race([
      pending.then(() => true),
      new Promise<false>((resolve) => setImmediate(() => resolve(false))),
    ]);
    if (settled) return pending;
    const event = mockRendererRequests.at(-1)?.event;
    if (event?.type !== 'app-link-open-requested') continue;
    const { requestId } = event;
    resolveAppLinkRequest(sender, {
      requestId,
      phase: 'acknowledge',
      handled: true,
    });
    if (event.awaitCompletion) {
      resolveAppLinkRequest(sender, {
        requestId,
        phase: 'reserve',
        handled: true,
      });
      resolveAppLinkRequest(sender, {
        requestId,
        phase: 'complete',
        handled: true,
      });
    }
    return pending;
  }
}

beforeEach(() => {
  mockOpenExternal.mockClear();
  mockRendererRequests.length = 0;
  resetAppLinkRouterForTests();
});

it.each([
  'https://github.com/acme/app/pull/12',
  'https://github.com/acme/app/pull/12/files',
  'https://github.com/acme/app/pull/12#issuecomment-1',
  'http://github.com/acme/app/pull/12',
])('opens %s in the system browser with in-app links on', async (url) => {
  await expect(route(url, 'app-link')).resolves.toBe('external');
  expect(mockOpenExternal).toHaveBeenCalledWith(url);
  expect(mockRendererRequests).toHaveLength(0);
});

it('keeps other GitHub pages in the built-in browser', async () => {
  await expect(
    route('https://github.com/acme/app/issues/3', 'app-link'),
  ).resolves.toBe('in-app');
  expect(mockOpenExternal).not.toHaveBeenCalled();
  expect(mockRendererRequests.map((request) => request.channel)).toEqual([
    IPC_CHANNELS.browserEvent,
  ]);
});

it('leaves OS-delivered pull request links to the default-browser setting', async () => {
  await route('https://github.com/acme/app/pull/12', 'system-default');
  expect(mockRendererRequests).toHaveLength(1);
});
