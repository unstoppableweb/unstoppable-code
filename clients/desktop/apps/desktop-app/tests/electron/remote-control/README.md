# Direct Remote Control E2E harness

Headless end-to-end specs for Remote Control over the encrypted device relay
(CAN-5985). The harness in `harness/` boots `apps/web` against a dedicated
Postgres database and seeds accounts; the specs add a real relay. They run in
the Playwright `portal` project and the CI `portal` lane, not the Electron
lane.
These runs are headless; do not pass `--headed`, `--debug` or `--ui` unless a
headed run is explicitly requested.

| Spec                  | Covers                                                                                                                                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hosted-mcp.spec.mjs` | Hosted agents: SSE pairing with desktop approval and the direct Tasks tools on `/api/v1/mcp/tasks`.                                                                                                                                                               |
| `direct-web.spec.mjs` | Web `/chat` in Chromium over the production connection owner: link and code pairing, a streamed chat turn, offline and reconnect, host refusals, owner lifecycle (tabs, hidden suspend, leader takeover, key store, device cap), script review, sign-out, revoke. |

| Module                 | Provides                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `relay.mjs`            | `startDeviceRelay()`: the production relay entry point on an ephemeral loopback port with a generated token secret. Exposes `url`, `secret`, `connectedDeviceIds()`, `connectionCount()`, `connectionsOpenedBy(deviceId)`, `refusedOverLimit()`, `waitFor(predicate)` (from the relay's own logs), `signToken(claims)` and `stop()`. `maxDevicesPerAccount` lowers the device cap.                                                                                       |
| `relayCappedEntry.mjs` | The production relay server with a per-account device cap the spec chooses; started by `startDeviceRelay({ maxDevicesPerAccount })`.                                                                                                                                                                                                                                                                                                                                     |
| `directWebHarness.mjs` | `directWebServerOptions({ relay })` for `remoteControlServerManager.acquire`, `launchRemoteControlDesktop({ relay, seeded })` (signed in, Remote Control on, connected to the relay; `quit()` and `relaunch()` keep its data), hosted pairing (`startHostedPairing`, `pairHostedAgents`, `answerDesktopPairingPrompt`) and database readers.                                                                                                                             |
| `hostedController.mjs` | Test-driven `@canopy/remote-session` clients: unseal the account's hosted root, open delegated sessions with a chosen expiry, attempt raw handshakes, connect relay devices for any account and pair a browser-kind controller by link (`pairTestBrowserController`).                                                                                                                                                                                                    |
| `mcpAgent.mjs`         | `connectTasksAgent(page, seeded)`: a real OAuth grant through the consent page, and `call` / `ok` for `/api/v1/mcp/tasks` tools.                                                                                                                                                                                                                                                                                                                                         |
| `harness/`             | The web server and accounts: `fixtures.mjs` (`test` with the worker-scoped `remoteControlServerManager`), `config.mjs` (ports, origins, database URL), `db.mjs` (`truncateWebTestState`, `withRemoteControlDbClient`), `web-server.mjs` (`startRemoteControlWebServer`, `warmRemoteControlRoutes`), `seedWebUser.mjs` (`seedRemoteControlWebUser`: an API key and a signed session cookie) and `portalHarness.mjs` (`ensureRemoteControlSchema`, `seededSessionCookie`). |

Remote Control needs no flag or Labs opt-in. `directWebServerOptions` adds
the hosted MCP opt-ins and the canonical MCP origin.

Prerequisites: `pnpm run build:e2e` (the desktop main bundle must contain the
`CANOPY_E2E_CLOUD_BASE_URL` seam), a pgvector Postgres reachable through
`CANOPY_PORTAL_E2E_PG_ADMIN_URL` (defaults to the local dev credentials in
`harness/config.mjs`; the harness creates `canopy_portal_e2e_<worker>` and
enables `vector` itself), and `pnpm run prisma:generate:web`. Run a registered spec with:

```bash
pnpm run test:electron:built apps/desktop-app/tests/electron/remote-control/hosted-mcp.spec.mjs --reporter=list
```

Only [golden tests](../../../../../docs/golden-tests.md) are committed. Write
other scenarios under the gitignored `.playwright/<slug>/`.
