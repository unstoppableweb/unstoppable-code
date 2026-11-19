// An outside agent on the hosted MCP Tasks server: a real OAuth grant through
// the consent page (pre-registered `cursor` client, PKCE, loopback callback)
// and JSON-RPC `tools/call` requests to `/api/v1/mcp/tasks`. Test-only.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { REMOTE_CONTROL_WEB_ORIGIN } from './harness/config.mjs';
import { seededSessionCookie } from './harness/remoteControlHarness.mjs';

const LOOPBACK_CALLBACK = 'http://localhost:8787/callback';
const TASKS_RESOURCE = `${REMOTE_CONTROL_WEB_ORIGIN}/api/v1/mcp/tasks`;
const MCP_TIMEOUT_MS = 60_000;

function parseRpcResponse(text) {
  const dataLines = text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim());
  return JSON.parse(dataLines.length > 0 ? dataLines.join('\n') : text);
}

/**
 * Grants a Tasks connection for the signed-in account through the consent
 * page in `page`, allowing every connected device, and exchanges the code.
 */
export async function connectTasksAgent(page, seeded, { webServer } = {}) {
  await page.context().addCookies([
    seededSessionCookie(seeded, {
      webServer,
      webServerOrigin: REMOTE_CONTROL_WEB_ORIGIN,
    }),
  ]);
  const verifier = randomBytes(32).toString('base64url');
  const state = randomUUID();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: 'cursor',
    redirect_uri: LOOPBACK_CALLBACK,
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: TASKS_RESOURCE,
    scope: 'account:read tasks:read tasks:write',
  });
  const callbackPattern = `${new URL(LOOPBACK_CALLBACK).origin}/**`;
  await page.route(callbackPattern, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><title>OAuth callback captured</title>',
    }),
  );
  try {
    await page.goto(
      `${REMOTE_CONTROL_WEB_ORIGIN}/api/v1/oauth/authorize?${params.toString()}`,
      { waitUntil: 'domcontentloaded' },
    );
    await page
      .getByTestId('consent-page')
      .waitFor({ state: 'visible', timeout: 180_000 });
    const write = page
      .getByTestId('agent-access-level-tasks')
      .getByRole('button', { name: 'Write', exact: true });
    await write.waitFor({ state: 'visible', timeout: 30_000 });
    if ((await write.getAttribute('aria-pressed')) !== 'true') {
      await write.click();
    }
    const allDevices = page
      .getByTestId('consent-hosts')
      .getByTestId('consent-devices-all');
    await allDevices.waitFor({ state: 'visible', timeout: 30_000 });
    if (!(await allDevices.isChecked())) await allDevices.check();

    const callback = page.waitForRequest(
      (request) => request.url().startsWith(`${LOOPBACK_CALLBACK}?`),
      { timeout: 60_000 },
    );
    await page.getByTestId('consent-connect').click();
    const callbackUrl = new URL((await callback).url());
    if (callbackUrl.searchParams.get('state') !== state) {
      throw new Error('The OAuth callback state did not match.');
    }
    const code = callbackUrl.searchParams.get('code');
    if (!code) throw new Error('The OAuth callback omitted its code.');
    const response = await page.request.post(
      `${REMOTE_CONTROL_WEB_ORIGIN}/api/v1/oauth/token`,
      {
        form: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: LOOPBACK_CALLBACK,
          client_id: 'cursor',
          code_verifier: verifier,
          resource: TASKS_RESOURCE,
        },
        timeout: MCP_TIMEOUT_MS,
      },
    );
    if (!response.ok()) {
      throw new Error(
        `OAuth token exchange failed: ${response.status()} ${await response.text()}`,
      );
    }
    const token = await response.json();
    if (typeof token.access_token !== 'string') {
      throw new Error('The OAuth token response omitted its access token.');
    }
    return createTasksAgent(page.request, token.access_token);
  } finally {
    await page.unroute(callbackPattern);
  }
}

/** A Tasks MCP client over one access token. */
export function createTasksAgent(request, accessToken) {
  /**
   * One `tools/call`. Resolves `{ isError, structuredContent, ms }`; protocol
   * or HTTP failures throw.
   */
  async function call(name, args) {
    const startedAt = Date.now();
    const response = await request.post(TASKS_RESOURCE, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
      },
      data: {
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'tools/call',
        params: { name, arguments: args },
      },
      timeout: MCP_TIMEOUT_MS,
    });
    const text = await response.text();
    if (!response.ok()) {
      throw new Error(`MCP ${name} failed: ${response.status()} ${text}`);
    }
    const message = parseRpcResponse(text);
    if (message.error) {
      throw new Error(`MCP ${name} error: ${JSON.stringify(message.error)}`);
    }
    return {
      isError: message.result?.isError === true,
      structuredContent: message.result?.structuredContent ?? null,
      ms: Date.now() - startedAt,
    };
  }

  /** A call that must succeed; returns its structured content. */
  async function ok(name, args) {
    const result = await call(name, args);
    if (result.isError) {
      throw new Error(
        `MCP ${name} returned an error: ${JSON.stringify(result.structuredContent)}`,
      );
    }
    return result.structuredContent;
  }

  return { accessToken, call, ok };
}
