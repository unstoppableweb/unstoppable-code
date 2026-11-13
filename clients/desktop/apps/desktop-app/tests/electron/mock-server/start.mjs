// Shared UI-automation mock server.
//
// Runs ONCE for the whole Playwright suite (started via the `webServer` block in
// playwright.config.mjs — Doc 4 §0), serving the deterministic stand-ins the app
// is redirected to under an E2E build. Phase 1 implements only the Canopy Cloud
// surface (replacing the per-test mock previously in canopy-portal.spec.mjs) plus
// a health endpoint and the `/__mock/` control plane (per-test scenario keying —
// see ./control-plane.mjs and ./README.md). Later phases fill the
// LLM / auth-usage / GitHub / Linear surfaces (Docs 5/6/8/9).

import { createServer } from 'node:http';
import {
  handleControlPlaneRequest,
  recordScenarioActivity,
} from './control-plane.mjs';
import { handleCloudRequest } from './routes/cloud.mjs';
import { handleLlmRequest } from './routes/llm.mjs';
import { attachResponsesWebSocket } from './routes/responsesWs.mjs';
import { handleGithubRequest } from './routes/github.mjs';
import { handleLinearRequest } from './routes/linear.mjs';
import { handleAuthUsageRequest } from './routes/authUsage.mjs';
import { handleSharedContainersRequest } from './routes/shared-containers.mjs';
import { handleSharedPlansRequest } from './routes/shared-plans.mjs';
import { handleCloudProjectsRequest } from './routes/cloud-projects.mjs';
import { handleHostedSettingsRequest } from './routes/hosted-settings.mjs';
import { handleMemorySyncRequest } from './routes/memory-sync.mjs';
import { guardRequestHandler } from './request-guard.mjs';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 4011;

function resolvePort() {
  const raw =
    process.env.CANOPY_E2E_MOCK_BASE_URL ?? process.env.CANOPY_CLOUD_BASE_URL;
  if (raw) {
    try {
      const parsed = new URL(raw);
      if (parsed.port) {
        return Number(parsed.port);
      }
    } catch {
      // fall through to default
    }
  }
  return DEFAULT_PORT;
}

function jsonResponse(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function browserFixtureResponse(response, fixtureId) {
  const fixture =
    fixtureId === 'two'
      ? { title: 'Performance Browser Two', color: '#7c3aed' }
      : { title: 'Performance Browser One', color: '#0891b2' };
  const favicon = encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="${fixture.color}"/></svg>`,
  );
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${fixture.title}</title>
    <link rel="icon" href="data:image/svg+xml,${favicon}" />
  </head>
  <body data-browser-fixture="${fixtureId}">
    <main><h1>${fixture.title}</h1><input aria-label="Fixture input" /></main>
  </body>
</html>`);
}

function recordBrowserFixtureActivity(url) {
  const scenarioKey = url.searchParams.get('scenarioKey');
  if (scenarioKey) recordScenarioActivity(scenarioKey, 'browserFixtureGet');
}

export function createMockServer() {
  // One failing route answers 500 instead of exiting the shared server, which
  // Playwright does not restart.
  const server = createServer(guardRequestHandler(handleRequest));
  // Codex 0.138+ drives the Responses API over a WebSocket (`ws://<base>/responses`)
  // rather than HTTP, so Codex-backed helper/pipeline flows need this transport.
  attachResponsesWebSocket(server);
  return server;
}

async function handleRequest(request, response) {
  const url = new URL(
    request.url ?? '/',
    `http://${HOST}:${request.socket.localPort}`,
  );
  const { pathname } = url;

  if (request.method === 'GET' && pathname === '/healthz') {
    jsonResponse(response, 200, { ok: true });
    return;
  }

  // Deliberate route failure so start.test.mjs can prove the entrypoint keeps
  // its request guard. Must run before the control plane's `/__mock/*` routes.
  if (request.method === 'POST' && pathname === '/__mock/route-error') {
    throw new Error('Deliberate mock-server route failure');
  }

  // Organization branding logos (CAN-3522): a solid square per name, so the
  // scope switcher can render a real remote logo without network access.
  const orgLogo = /^\/org-logo\/([a-z0-9-]+)\.svg$/.exec(pathname);
  if (request.method === 'GET' && orgLogo) {
    response.writeHead(200, {
      'content-type': 'image/svg+xml',
      'cache-control': 'no-store',
    });
    response.end(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" data-org="${orgLogo[1]}"><rect width="32" height="32" rx="6" fill="#1f5eff"/></svg>`,
    );
    return;
  }

  if (
    request.method === 'GET' &&
    (pathname === '/browser-fixture/one' || pathname === '/browser-fixture/two')
  ) {
    recordBrowserFixtureActivity(url);
    browserFixtureResponse(response, pathname.endsWith('/two') ? 'two' : 'one');
    return;
  }

  // Provider surfaces. Auth/usage owns `/__mock/claude/*` and `/__mock/codex/*`,
  // so it MUST run before the control plane's `/__mock/*` catch-all (below).
  if (await handleLlmRequest(request, response, url)) {
    return;
  }
  if (await handleGithubRequest(request, response, url)) {
    return;
  }
  if (await handleLinearRequest(request, response, url)) {
    return;
  }
  if (await handleAuthUsageRequest(request, response, url)) {
    return;
  }
  if (await handleSharedContainersRequest(request, response, url)) {
    return;
  }
  // Hosted settings own the session-cookie routes (`/api/v1/settings/*`,
  // `/api/account/*`, `/api/auth/*`, `/api/cloud/github/*`), the auth-link
  // mint/consume for keys with a `hostedSettings` slice (other keys fall
  // through to the cloud surface), and `/__mock/hosted-settings/*`, so they
  // run before the cloud surface and the control plane's catch-all.
  if (await handleHostedSettingsRequest(request, response, url)) {
    return;
  }
  // Shared plans own `/api/v1/<ns>/plans/:id[/stream]` and the
  // `/__mock/shared-plans/*` control routes, so they run before the cloud
  // surface and the control plane's `/__mock/*` catch-all.
  if (await handleSharedPlansRequest(request, response, url)) {
    return;
  }
  // Personal cloud project identity serves keys with a `cloudProjects` slice;
  // other keys, and organization claims, fall through to the cloud surface.
  if (await handleCloudProjectsRequest(request, response, url)) {
    return;
  }
  // Memory sync owns `/api/v1/memory-sync/*` and `/__mock/memory-sync/*`.
  if (await handleMemorySyncRequest(request, response, url)) {
    return;
  }
  if (await handleCloudRequest(request, response, url)) {
    return;
  }

  // Control plane (per-test scenario registration/keying) — last, since it
  // claims any remaining `/__mock/*` route (e.g. `/__mock/state`, `/__mock/reset`).
  if (await handleControlPlaneRequest(request, response, url)) {
    return;
  }

  jsonResponse(response, 404, { error: `Unhandled mock route: ${pathname}` });
}

function main() {
  const port = resolvePort();
  const server = createMockServer();
  server.listen(port, HOST, () => {
    process.stdout.write(`[mock-server] listening on http://${HOST}:${port}\n`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
