/**
 * An added account's own cleanup (CAN-6226). When its sign-in fails, the
 * desktop removes the account it added, but only while it never connected:
 * a sign-in that finished as the poll failed must keep the account and its
 * grant. The cleanup goes to its own route, which a server that predates it
 * answers 404 without changing anything, so no replica of any version reads
 * it as a removal or a disconnect. Remove on an account row still removes it
 * outright.
 */
const mockRequests: string[] = [];
let mockRefusal: { status: number; serverCode?: string } | null = null;

jest.mock('../client', () => {
  class CanopyCloudClientError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status?: number,
      readonly serverCode?: string,
    ) {
      super(message);
    }
  }
  return {
    CanopyCloudClientError,
    resolveCanopyCloudCredentialContext: (): Promise<{
      apiKey: string;
      baseUrl: string;
    }> => Promise.resolve({ apiKey: 'key', baseUrl: 'https://cloud.test' }),
    assertCanopyCloudCapability: (): Promise<void> => Promise.resolve(),
    requestCanopyCloudJson: (
      path: string,
      init: RequestInit,
    ): Promise<unknown> => {
      mockRequests.push(`${init.method ?? 'GET'} ${path}`);
      return mockRefusal
        ? Promise.reject(
            new CanopyCloudClientError(
              'http-error',
              'refused',
              mockRefusal.status,
              mockRefusal.serverCode,
            ),
          )
        : Promise.resolve({ ok: true });
    },
  };
});
jest.mock('../../mcp/account-mcp-server-accounts', () => ({
  forgetAccountMcpServerAccounts: (): void => undefined,
}));
jest.mock('../../mcp/oauth-client', () => ({
  openExternalUrl: (): Promise<void> => Promise.resolve(),
}));

import { removeAccountMcpConnection } from '../mcp-connections';

const ID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';

beforeEach(() => {
  mockRequests.length = 0;
  mockRefusal = null;
});

test('Remove on an account row deletes it outright', async () => {
  await expect(removeAccountMcpConnection(ID)).resolves.toEqual({
    removed: true,
  });
  expect(mockRequests).toEqual([
    `DELETE /api/v1/mcp-connections/${ID}?remove=1`,
  ]);
});

test('a failed sign-in’s cleanup goes to its own route, never a removal', async () => {
  await expect(
    removeAccountMcpConnection(ID, { unlessConnected: true }),
  ).resolves.toEqual({ removed: true });
  expect(mockRequests).toEqual([`POST /api/v1/mcp-connections/${ID}/abandon`]);
  // No request an older server would honor as a removal or a disconnect.
  expect(mockRequests.some((request) => request.startsWith('DELETE'))).toBe(
    false,
  );
});

test('the cloud keeps an account that connected before the cleanup ran', async () => {
  mockRefusal = { status: 409, serverCode: 'connection_connected' };
  await expect(
    removeAccountMcpConnection(ID, { unlessConnected: true }),
  ).resolves.toEqual({ removed: false });
});

test('a server without the cleanup route changes nothing', async () => {
  // An older replica has no such route: a bare 404, not the handler's
  // `not_found` for a connection that is already gone.
  mockRefusal = { status: 404 };
  await expect(
    removeAccountMcpConnection(ID, { unlessConnected: true }),
  ).resolves.toEqual({ removed: false });
  mockRefusal = { status: 404, serverCode: 'not_found' };
  await expect(
    removeAccountMcpConnection(ID, { unlessConnected: true }),
  ).resolves.toEqual({ removed: true });
  expect(mockRequests).toEqual([
    `POST /api/v1/mcp-connections/${ID}/abandon`,
    `POST /api/v1/mcp-connections/${ID}/abandon`,
  ]);
});
