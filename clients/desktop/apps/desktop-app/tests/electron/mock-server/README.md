# Shared UI-automation mock server

`start.mjs` runs **once for the whole Playwright suite** (started via the
`webServer` block in `playwright.config.mjs` — Doc 4 §0). It serves the
deterministic stand-ins the app is redirected to under an E2E build:

- `GET /healthz` → `{ ok: true }`
- the `/__mock/*` **control plane** (this document)
- the Canopy Cloud surface (`routes/cloud.mjs`)
- later phases: LLM / auth-usage / GitHub / Linear surfaces (Docs 5/6/8/9)

Because the suite runs with `--workers=2`, the single server is shared across
concurrently-executing tests. To stop tests from colliding on shared mock
state, **all per-test state is namespaced by a credential `key`**. Each test
registers its scenario under a key it controls, and every mock surface resolves
that key off the incoming request before answering.

## Why keying matters

A surface must never read process-global mutable state to decide what to
return, because two workers can be mid-request at the same time. Instead it:

1. Extracts the key from the request (see **Key extraction** below).
2. Looks up the scenario with `getScenario(key)` (from `control-plane.mjs`).
3. Renders its own slice of that scenario (or its inert default when the slice
   is absent / the key is unregistered).

The default scenario for an unregistered key is frozen, so a surface that keeps
state must not write into it. If a route throws anyway, `request-guard.mjs`
logs the error and answers `500` (or closes a response whose headers were
already sent) so one bad route cannot exit the shared server, which Playwright
does not restart. `POST /__mock/route-error` fails deliberately so
`start.test.mjs` can check that the entrypoint keeps this guard.

## Control-plane HTTP API

All routes are under `/__mock/`. Bodies and responses are JSON.

| Method   | Path                 | Body                | Effect                                                   |
| -------- | -------------------- | ------------------- | -------------------------------------------------------- |
| `POST`   | `/__mock/state`      | `{ key, scenario }` | Register `scenario` under `key`. `scenario` optional.    |
| `GET`    | `/__mock/state/:key` | —                   | Return `{ key, scenario }` (default scenario if unset).  |
| `DELETE` | `/__mock/state/:key` | —                   | Clear the scenario for `key`. Returns `{ ok, cleared }`. |
| `POST`   | `/__mock/reset`      | —                   | Clear **all** scenarios. Returns `{ ok: true }`.         |

Notes:

- `POST /__mock/state` with a missing or non-string `key` returns `400`.
- Malformed / empty JSON bodies are parsed safely and treated as no body
  (yielding `400` for `/__mock/state`, which requires a `key`).
- `:key` is URL-decoded, so keys may contain reserved characters when encoded.
- Unknown `/__mock/*` routes return `404` but are still "handled" (the control
  plane owns the whole `/__mock/*` namespace).

### Typical test lifecycle

```js
// register before the app drives the surface
await fetch(`${base}/__mock/state`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ key: 'csk_test_42', scenario: { cloud: {} } }),
});

// ... run the test; the app's requests carry `csk_test_42` ...

// clean up (or POST /__mock/reset in a global teardown)
await fetch(`${base}/__mock/state/csk_test_42`, { method: 'DELETE' });
```

## Scenario object shape (the contract)

A scenario is a plain JSON object. Every field is optional; each surface fills
its own slice and ignores the rest. The control plane treats slices as opaque.

```jsonc
{
  "cloud": {
    /* Canopy Cloud surface overrides (routes/cloud.mjs) */
  },
  "llm": {
    /* LLM surface: canned conversation, helpers, usage  — WP-MOCK-LLM */
    "steps": [{ "text": "History-indexed reply" }],
    "stepsByRequestTag": {
      /* [Canopy-Mock-Request:later] selects this regardless of provider history shape. */
      "later": { "text": "Exact tagged reply" },
    },
  },
  "github": {
    /* GitHub REST: PR / check-run / user state          — WP-MOCK-GITHUB */
  },
  "linear": {
    /* Linear GraphQL: viewer / issueSearch / issue      — WP-MOCK-LINEAR */
  },
  "authUsage": {
    /* Provider auth + usage cards                       — WP-MOCK-AUTHUSAGE */
  },
}
```

### Personal cloud project identity (CAN-5190)

`routes/cloud-projects.mjs` serves the cloud project identity routes
(`/api/v1/projects/personal` create and its CAN-5192 device list,
`/personal/match`, `/:id/manifest`, `/:id/events`, `/:id/instances/claim`,
`/instances/:id/complete`, `/instances/:id/detach` and
`/instances/:id/repositories`) for keys whose scenario has a `cloudProjects`
slice; other keys, and organization claims, fall through to `routes/cloud.mjs`.
The account also needs `project-identity-v1`, for example through
`cloud.extraCapabilities`. Creates, manifest updates, claims, completions and
selections mutate the slice and record activity (`cloudProjectCreate`,
`cloudProjectClaim:<projectId>`, `cloudProjectManifestUpdate:<projectId>`,
...), so a spec reads the result from `GET /__mock/state/:key`. Matching
compares remote keys only.

```jsonc
{
  "cloud": { "extraCapabilities": ["project-identity-v1"] },
  "cloudProjects": {
    "projects": [
      /* CloudProjectManifest objects */
    ],
    "instances": [],
    "events": {
      /* projectId → CloudProjectLifecycleEvent[] */
    },
  },
}
```

### Shared-container / billing knobs (CAN-2551)

Two overrides exist specifically so a spec can reproduce a billing-lapsed
account and a genuine listing failure. Both are inert when unset, so existing
specs are unaffected.

```jsonc
{
  "cloud": {
    // Replaces the hardcoded `teamsEntitled: true` default in the
    // `/api/v1/desktop-app/account` payload. Symmetric with the existing
    // `organizations` override, and normally set alongside it so the ids
    // match. Without this every account looks entitled, and a "lapsed" spec
    // would pass vacuously against unmodified code.
    "orgBillingStates": [
      {
        "organizationId": "…",
        "organizationName": "…",
        "teamsEntitled": false,
      },
    ],
  },
  "sharedContainers": {
    // Scripts a failure for GET /api/v1/shared-containers/shared-with-me only
    // (`shared-by-me` always 200s). Either the shorthand string, which sends
    // the real 403 + `code: "blocked-by-org-billing"` body the server returns
    // for a lapsed org, or an explicit `{ status, body }` for a transport
    // failure such as `{ "status": 500 }`.
    "sharedWithMeError": "blocked-by-org-billing",
  },
}
```

### Recoverable share removal (CAN-4052)

`DELETE /api/v1/shared-containers/:id/dismiss` moves the share and its grants
into `sharedContainersState.dismissed` instead of dropping them:

- `GET /api/v1/shared-containers/dismissed` lists them newest first, scoped by
  `organizationId` like `shared-with-me` and paged by `limit` / `cursor`. Each
  container carries `dismissedAt`. Activity: `sharedContainersListDismissed`.
- `POST /api/v1/shared-containers/:id/restore` puts the share back and answers
  `{ container }`; restoring a share that is already live is a no-op `200`.
  Activity: `sharedContainersRestore` (successes only).
- Anything else answers `404` with
  `code: "shared-container-dismissal-not-found"`: an unknown id, a mismatched
  `organizationId`, or a share the owner revoked after it was removed.
- To model "the owner revoked me", call the owner revoke route for the removed
  share: `DELETE …/:id/grants/:grantId` when the share has a grant row, or the
  by-user `DELETE …/:id/recipients/:userId` for a seeded share that has none.
- The owner's `GET …/:id/recipients` keeps listing a removed recipient, with
  `dismissedAt`.

```jsonc
{
  "cloud": {
    // Drops `shared-container-dismissals-v1` from `/.well-known/*` and the
    // account payload, modelling a Canopy Cloud deployed before this change.
    // The routes above still exist; the desktop must not call them.
    "withholdSharedContainerDismissalsCapability": true,
  },
}
```

### Shared plans (`routes/shared-plans.mjs`)

The `sharedPlans` slice serves the desktop owner's shared-plan client:
`GET`/`PUT /api/v1/<ns>/plans/:id` and `GET /api/v1/<ns>/plans/:id/stream`
(`plan.detail` SSE, framed like `apps/web/src/lib/realtime/sse-core.ts`). A key
without the slice answers `404`, so other specs keep the old behavior. Seed it
through `registerSharedPlanScenario` in `seeders/sharedPlanCloud.mjs`.

```jsonc
{
  "sharedPlans": {
    "stream": "enabled", // or "disabled" → the stream answers 404
    "enforceSnapshotHash": true, // PUT answers 409 on a stale expectedSnapshotHash
    "signalOnPut": false, // true appends a plan.detail event per PUT
    "getDelayMs": 0,
    "getError": null, // or { "status": 503, "body": { … } }
    "putError": null,
    // Partial SharedPlanDetail seeds; missing fields default to a team share
    // owned by the `shareMembership.mjs` team.
    "plans": [{ "id": "<remote id>", "content": "…", "snapshotHash": "…" }],
  },
}
```

A `PUT` records its body, merges `commentThreads` like the web (upsert by id,
never delete), and bumps `remoteRevisionNumber` only when `snapshotHash`
changes. Runtime state lives on the registered scenario as
`sharedPlansState`. Registering the key again resets that state and its
activity counters, so change a running scenario only through these routes
(JSON bodies; `signal` defaults to `true` and appends one `plan.detail` event):

| Method | Path                                                     | Body                   | Effect                                                   |
| ------ | -------------------------------------------------------- | ---------------------- | -------------------------------------------------------- |
| `POST` | `/__mock/shared-plans/:key/:planId/threads`              | `{ thread, signal? }`  | Add a teammate thread (`409` if the id exists).          |
| `POST` | `/__mock/shared-plans/:key/:planId/threads/:id/comments` | `{ comment, signal? }` | Add a reply (`404` unknown thread, `409` duplicate id).  |
| `POST` | `/__mock/shared-plans/:key/:planId/threads/:id/status`   | `{ status, signal? }`  | Resolve (`resolved`) or reopen (`open`) a thread.        |
| `POST` | `/__mock/shared-plans/:key/:planId/signal`               | `{}`                   | Emit a `plan.detail` signal without a change.            |
| `POST` | `/__mock/shared-plans/:key/:planId/faults`               | `{ getError }`         | Fail this plan's `GET` (`null` restores it).             |
| `POST` | `/__mock/shared-plans/:key/:planId/streams/close`        | `{}`                   | End its open streams, like a dropped connection.         |
| `GET`  | `/__mock/shared-plans/:key/:planId/requests`             | —                      | `{ puts, gets, streamConnections, openStreams, events }` |
| `GET`  | `/__mock/shared-plans/:key/:planId`                      | —                      | The current server detail.                               |

A stream without `Last-Event-ID` or `?after` starts at the current head. Run
the route tests with
`node --test apps/desktop-app/tests/electron/mock-server/routes/shared-plans.test.mjs`.

### Hosted settings (`routes/hosted-settings.mjs`)

The `hostedSettings` slice serves the desktop hosted settings bridge
(`apps/desktop-app/src/main/canopy-cloud/settings-session.ts` and
`settings-client.ts`): the auth-link mint and consume, `settings.bootstrap`,
`settings.pageData`, the `SETTINGS_OPERATIONS` entries the settings flows use,
Better Auth `POST /api/auth/change-password` and `/api/auth/sign-out`, and the
organization feed SSE at `/api/account/organizations/:id/stream`. A key
without the slice keeps the cloud surface's static auth-link mint.

After the mint (Bearer `csk_` key), every request is authenticated by the
minted `better-auth.session_token` cookie; without it the answer is `401`.
`/api/auth/*` also needs `Origin` equal to the server origin. Payment routes
(setup intent, payment method, subscription, top-up, automatic top-up, seat
quote) answer `404` and are logged with `financial: true`.

Seed it with `registerHostedSettingsScenario(apiKey, name)` from
`seeders/hostedSettingsCloud.mjs`. Every scenario seeds a Personal
organization, a team the viewer owns, a team where the viewer is a member and
a lapsed team, and mirrors them into the `cloud` account payload. The viewer
id is the `/api/v1/<ns>/account` id (`cloud.account.id` or `account-e2e`).

| Scenario                                 | Behavior                                               |
| ---------------------------------------- | ------------------------------------------------------ |
| `hosted-settings-signed-in`              | Everything succeeds; one feed item arrives live.       |
| `hosted-settings-long-timeline`          | As signed in, with 40 Timeline items in the owner org. |
| `hosted-settings-two-factor-user`        | Consume also sets the two-factor proof cookie.         |
| `hosted-settings-two-factor-pending`     | Mint answers `403 { error }`.                          |
| `hosted-settings-rate-limited`           | Mint answers `429` with `Retry-After: 60`.             |
| `hosted-settings-consume-rejected`       | Consume redirects to `/login`.                         |
| `hosted-settings-integrations-disabled`  | Bootstrap reports Integrations off; its page 404s.     |
| `hosted-settings-unsupported-server`     | Bootstrap and page data answer `404`.                  |
| `hosted-settings-viewer-mismatch`        | Bootstrap names another viewer.                        |
| `hosted-settings-feed-reconnect`         | First stream drops; the `Last-Event-ID` resume works.  |
| `hosted-settings-feed-reconnect-denied`  | First stream drops; the reconnect answers `403`.       |
| `hosted-settings-feed-reconnect-expired` | First stream drops; the reconnect answers `401`.       |

```jsonc
{
  "hostedSettings": {
    "mint": "ok", // "two-factor-pending" | "rate-limited" | { status, body } | [per attempt]
    "consume": "ok", // or "login"
    "twoFactorUser": false,
    "bootstrap": "ok", // "unsupported" | "viewer-mismatch"
    "integrationsEnabled": true, // false: Integrations off, its page data 404s
    "incomingInvitations": [
      {
        "id": "incoming-invite-id",
        "organization": {
          /* full defaultHostedSettingsOrganizations() entry, without viewer membership */
        },
        "role": "MEMBER",
        "organizationTeamName": null,
        "invitedByName": "Casey",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "expiresAt": "2099-01-01T00:00:00.000Z",
      },
    ],
    "operationErrors": { "organization.members.remove": { "status": 409 } },
    "operationDelaysMs": { "settings.pageData": 500 },
    "feed": {
      "organizationId": "…", // default: the team the viewer owns
      "items": [], // already in the feed
      "scriptedItems": [], // appended when the first stream opens
      "dropAfterScripted": false,
      "reconnect": "allow", // "unauthorized" | "forbidden"
      "stream": "enabled", // or "disabled"
    },
  },
}
```

Successful create, delete, leave and invitation acceptance synchronize the
scenario's `cloud.organizations` and `cloud.orgBillingStates`, so subsequent
account probes observe membership changes. Personal is excluded from the
team list; unrelated cloud configuration, organization fields and existing
billing states are retained. A leave removes only the viewer's membership,
keeps the organization and its other members, and closes its viewer feed.
Delete requires OWNER; leave rejects the last OWNER. Rejected writes change
neither settings nor account fixtures.

`incomingInvitations` defaults to `[]`. Each entry supplies a full organization
fixture plus the invitation fields shown above. Pending invitations appear in
both incoming-list and organization-list page data; accepting adds membership
once, while declining only consumes the invitation. Repeated responses to a
consumed invitation return 404. Registering another key keeps its data isolated.
Both invitation projections include `organizationId` from the fixture's
`organization.id`: the organization's external id used in organization routes,
not an internal database id. The shared contract keeps this field optional for
compatibility with older hosted servers.

Mint arrays count every mint for the key, including auth links the desktop
opens externally. Runtime state lives on the scenario as
`hostedSettingsState`; registering the key again resets it and ends every
session minted for it.

| Method | Path                                           | Effect                                                             |
| ------ | ---------------------------------------------- | ------------------------------------------------------------------ |
| `GET`  | `/__mock/hosted-settings/:key/requests`        | `{ requests, mints, consumes, signOuts, activeSessions, feeds }`   |
| `GET`  | `/__mock/hosted-settings/:key/state`           | Current profile, preferences, API keys, invites and organizations. |
| `POST` | `/__mock/hosted-settings/:key/sessions/expire` | Later session requests answer `401` (`session.rejected`).          |
| `POST` | `/__mock/hosted-settings/:key/feed`            | `{ organizationId?, items }` appends live feed items.              |
| `POST` | `/__mock/hosted-settings/:key/feed/close`      | `{ organizationId? }` drops open streams.                          |
| `GET`  | `/__mock/hosted-settings-unauthenticated`      | Session-route requests that carried no known session cookie.       |

Each logged request has `method`, `path`, `operation` (the table entry name),
`authenticated`, `origin`, `lastEventId`, `financial`, `status` and its JSON
`body` (passwords redacted). `GET /__mock/activity/:key` also counts
`hostedSettings:<operation>`. Run the route tests, which validate every
fixture against the protocol zod schemas through `tsx`, with
`node --test apps/desktop-app/tests/electron/mock-server/routes/hosted-settings.test.mjs`.

The **benign default** (returned for any unregistered key) is `{}`: all slices
absent, so every surface falls back to its inert default behaviour. Surface WPs
document the inner shape of their own slice; they must not change this top-level
shape or the control-plane semantics.

## Key extraction

`control-plane.mjs` provides the helpers surfaces use to derive the key from a
request. A surface picks whichever matches how its real provider authenticates:

| Helper                                   | Source                                            | Used by (intended)        |
| ---------------------------------------- | ------------------------------------------------- | ------------------------- |
| `keyFromBearer(request)`                 | `Authorization: Bearer <key>` or `token <key>`    | Cloud, GitHub, auth/usage |
| `keyFromApiKey(request, { header })`     | a named request header (case-insensitive)         | Linear API key, x-api-key |
| `keyFromApiKey(request, { query, url })` | a named query parameter                           | callback-style URLs       |
| `markerFromText(text)`                   | a `[Canopy-C<id>]` marker embedded in prompt text | LLM (per-conversation)    |

`markerFromText` returns the full marker id (e.g. `Canopy-C7`) so a surface can
key its scenario off it directly. Each helper returns `undefined` when nothing
matches; pass that straight to `getScenario`, which returns the default
scenario for `undefined`/unregistered keys.

When an LLM prompt carries no marker, the LLM route also tries each user-message
line (with XML-style wrapper tags removed) as a `prompt:<line>` key. Demo videos
register their scripted reply under `prompt:<the exact typed prompt>` so neither
the prompt nor the helper requests it triggers (branch naming, chat titles)
shows a marker; `helperStepsById` on that scenario scripts the helpers.

## `control-plane.mjs` exports

- `registerScenario(key, scenario)` — register (falsy key is a no-op).
- `getScenario(key)` — registered scenario, or the frozen `DEFAULT_SCENARIO`.
- `clearScenario(key)` — remove one key; returns whether it existed.
- `resetAll()` — clear everything.
- `keyFromBearer`, `keyFromApiKey`, `markerFromText` — key extraction.
- `handleControlPlaneRequest(request, response, url)` — async; returns `true`
  if it handled a `/__mock/*` route.
- `DEFAULT_SCENARIO` — the frozen `{}` default.

### GitHub reference preview reads

Transcript reference previews (CAN-3979) read
`GET /repos/:owner/:repo/issues/:number` and `GET /repos/:owner/:repo`.
`github.issues` maps `owner/repo/number` to the issue (or pull request)
payload; an unlisted item answers `404`. `github.repositories` maps
`owner/repo` to fields merged over the merge-capability body below; an
unlisted repository keeps that body. Each read records
`githubIssue:<owner>/<repo>/<n>` or `githubRepository:<owner>/<repo>` in
`GET /__mock/activity/:key`.

`POST /__mock/github/reference-holds/:key` with `{ "held": true }` makes that
key's reference reads wait until `{ "held": false }` releases them;
`GET` on the same path returns `{ held, waiting }`. A spec uses this to keep a
read in flight without timing, and must release its holds in `finally`. See
`transcript-github-previews.spec.mjs`.

### GitHub PR merge fixtures

`github.graphqlPullRequests` opts a PAT-isolated scenario into `POST /graphql` for
Octokit requests. Keys are PR numbers; values override `isMergeQueueEnabled`,
`isInMergeQueue`, `mergeQueueEntry`, and `reviewThreads` on the matching PR.
An empty map defaults to empty review threads and false queue flags. The request
variables (`owner`, `repo`, `number`) must identify a PR in `github.pulls` or the
selected preset; otherwise `pullRequest` is null. Existing `github.mergeQueue`
fixtures retain their prior behavior, and non-Octokit GraphQL traffic is ignored.

`PUT /repos/:owner/:repo/pulls/:number/merge` records every direct merge attempt in
`github.mergeRequests`, including its body (`sha`, `merge_method`) and repository/PR
identity. It rejects a mismatched head SHA with HTTP 409 and a missing PR with 404;
success returns `merged: true` and updates the fixture's closed/merged state for
subsequent refreshes. Queue handoff tests can assert
`(scenario.github.mergeRequests ?? []).length === 0`; standard-merge tests must
assert an observed successful request. These fixtures never mutate live GitHub.

The merge fixtures also serve repository merge-method capabilities at
`GET /repos/:owner/:repo`. Successful merge refreshes include the REST
`merged: true` flag used by the real merge verifier. `enqueuePullRequest`
mutations record `github.enqueueRequests`, reject stale `expectedHeadOid`,
and mark the PR in-queue. The unchanged upstream baseline uses this route;
new chat handoff tests assert zero enqueue requests as well as zero direct
merge requests.

## Deterministic LLM lifecycle controls (C1 v2)

Existing scripts keep their history-derived cursor behavior. These optional
fields apply after the helper, request-tag, resume, or history cursor selects a
step, uniformly on Messages, Responses, Chat Completions, and Responses WS:

| Step field                               | Meaning                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stepId: string`                         | Stable identifier; required with `attempts`.                                                                                                                                                                                                                                                                                                                   |
| `attempts: Step[]`                       | Nonempty ordered alternatives, consumed per scenario key and `stepId`; the last alternative repeats. Alternative fields override the parent step. Observation `attempt` is one-based and saturates at the final alternative.                                                                                                                                   |
| `waitFor: string`                        | Emit nothing until this scenario's named barrier is released.                                                                                                                                                                                                                                                                                                  |
| `barrierTimeoutMs: number`               | Barrier timeout, default `30000`; failure class `mock_barrier_timeout`.                                                                                                                                                                                                                                                                                        |
| `delayMs: number`                        | Delay after the barrier, before the first structural frame or JSON response.                                                                                                                                                                                                                                                                                   |
| `error: { kind, status?, afterFrames? }` | `status`: HTTP status error (default `500`), WS `response.failed`; `disconnect`: close before any frames; `midstream`: close after `afterFrames` structural frames (default `1`, `0` closes before frames). JSON transports close without a complete response for either close directive. Existing error strings and objects keep their prior status behavior. |

A top-level scenario `strict: true` replaces the benign unmatched fallback with
`mock_unmatched`: HTTP `500` JSON `error.code` / `error.type`, or WS
`response.failed` with `response.error.code`. Unregistered scenarios remain
benign. Marker/prompt scenario selection takes priority; a request's Bearer or
API-key credential can select a scenario when no marker/prompt scenario matches.

### Hosted no-billing refusal (CAN-5348)

Register a marker-scoped scenario with
`{ llm: { steps: [{ error: 'no_billing_source' }] } }` to refuse the first
provider request. `{ error: { type: 'no_billing_source' } }` is equivalent.
HTTP requests receive `402` JSON instead of a provider stream, including the
hosted `canopy_proxy` marker, `no_billing_source` code, canonical refusal message,
and a correlation id matching `x-canopy-request-id`. The response fixture is
checked against `@canopy/protocol` by the LLM route tests. Responses WebSocket
requests use the existing `response.failed` transport with the same error code
and message; they do not produce an HTTP 402.

To refuse after agent activity, register a two-step conversation:

```json
{
  "llm": {
    "steps": [
      {
        "text": "Checking the workspace.",
        "toolCalls": [{ "name": "Bash", "input": { "command": "pwd" } }],
        "stopReason": "tool_use"
      },
      { "error": "no_billing_source" }
    ]
  }
}
```

The existing history cursor selects the refusal when the provider sends the tool
result. For a successful resend, replace that marker's LLM scenario with the
desired reply after independently updating the cloud eligibility fixture. The
refusal never changes the credit balance or auto-retries a turn. These server
tests cover both Anthropic and OpenAI HTTP proxy routes; composer restoration
and the decision to skip restoration after activity require separate UI tests.

Additional JSON control-plane routes:

- `POST /__mock/barrier` with `{ key, name }` returns `{ ok: true, key, name }` and releases
  all waiters. Release persists, including when it precedes the first wait.
- `GET /__mock/barrier?key=<encoded-key>` returns
  `{ barriers: [{ name, waiting, released }] }`. `waiting` counts blocked requests.
- `GET /__mock/requests?key=<encoded-key>` returns
  `{ requests: [{ index, transport, route, stepId?, attempt?, tag?, toolNames, toolResultIds, errorClass? }] }`.
  `index` starts at zero and follows request resolution/arrival order within the
  key. `transport` is `http` or `ws`; both Responses paths use the canonical route
  `/v1/responses`. Tool metadata contains offered tool names and incoming tool
  result identifiers, never prompt, arguments, or content text. `tag` is the
  latest `[Canopy-Mock-Request:<tag>]` marker. Error metadata is updated when a
  pending request fails; close directives use `mock_disconnect` / `mock_midstream`.

Replacing a scenario with `POST /__mock/state`, deleting it, or resetting all
scenarios rejects its pending barrier waiters with `mock_scenario_reset` and
clears its barriers, attempts, and observations. An in-flight request does not
repopulate cleared observations. Requests wait independently: releasing one
barrier does not advance another request or serialize a WebSocket connection.

Run the lifecycle coverage with:

```bash
node --test apps/desktop-app/tests/electron/mock-server/routes/lifecycle.test.mjs
```
