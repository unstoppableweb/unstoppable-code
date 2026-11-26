// Mock-server control plane (per-test scenario keying).
//
// The shared mock server (see ./start.mjs) runs ONCE for the whole Playwright
// suite (Doc 4 §0) while tests run with `--workers=2`. To keep concurrent tests
// from colliding on shared mock state, every per-test scenario is registered
// under a credential `key` and each surface resolves the key off the incoming
// request (Authorization token / API key / `[Canopy-C<id>]` marker).
// Unregistered keys resolve to a benign default scenario so untouched surfaces
// stay inert.
//
// ── Scenario object shape (the single JSON contract all surfaces code against) ──
//
//   {
//     // Canopy Cloud surface slice (account / capabilities overrides).
//     cloud?:     object,
//     // LLM surface slice (canned conversation selection, helper fingerprints,
//     // streaming/usage/stop-reason overrides) — WP-MOCK-LLM.
//     llm?:       object,
//     // GitHub REST surface slice (PR / check-run / user state) — WP-MOCK-GITHUB.
//     github?:    object,
//     // Linear GraphQL surface slice (viewer / issueSearch / issue) —
//     // WP-MOCK-LINEAR.
//     linear?:    object,
//     // Provider auth + usage surface slice (Claude/Codex auth + usage cards) —
//     // WP-MOCK-AUTHUSAGE.
//     authUsage?: object,
//   }
//
// Every field is optional. Each surface WP owns and documents the inner shape of
// its own slice in a later phase; the control plane treats slices as opaque
// JSON and only guarantees registration/resolution/reset semantics.
//
// See ./README.md for the HTTP control-plane API and full contract.

/**
 * The benign default scenario returned for any unregistered key. All slices are
 * absent so each surface falls back to its own inert default behaviour.
 *
 * @type {Readonly<{}>}
 */
export const DEFAULT_SCENARIO = Object.freeze({});

/** @type {Map<string, object>} */
const scenarios = new Map();

/** @type {Map<string, Record<string, number>>} */
const scenarioActivity = new Map();

/** @type {Map<string, Map<string, { released: boolean, waiters: Set<object> }>>} */
const scenarioBarriers = new Map();

/** @type {Map<string, Map<string, number>>} */
const stepAttempts = new Map();

/** @type {Map<string, object[]>} */
const requestObservations = new Map();

/** @type {Map<string, object[]>} */
const inferenceJournals = new Map();

const INFERENCE_JOURNAL_STRING_FIELDS = [
  'transport',
  'route',
  'model',
  'tag',
  'helper',
];

const OBSERVATION_STRING_FIELDS = [
  'model',
  'transport',
  'route',
  'stepId',
  'tag',
  'errorClass',
];

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function scenarioKey(key) {
  return typeof key === 'string' ? key : '';
}

function discardScenarioRuntime(key) {
  const barriers = scenarioBarriers.get(key);
  if (barriers) {
    for (const barrier of barriers.values()) {
      for (const waiter of barrier.waiters) {
        clearTimeout(waiter.timeout);
        waiter.reject(
          codedError(
            'mock_scenario_reset',
            `Mock scenario ${JSON.stringify(key)} was reset while waiting for a barrier.`,
          ),
        );
      }
      barrier.waiters.clear();
    }
  }
  scenarioBarriers.delete(key);
  stepAttempts.delete(key);
  requestObservations.delete(key);
  scenarioActivity.delete(key);
}

function getBarrierMap(key) {
  let barriers = scenarioBarriers.get(key);
  if (!barriers) {
    barriers = new Map();
    scenarioBarriers.set(key, barriers);
  }
  return barriers;
}

function getOrCreateBarrier(key, name) {
  const barriers = getBarrierMap(key);
  let barrier = barriers.get(name);
  if (!barrier) {
    barrier = { released: false, waiters: new Set() };
    barriers.set(name, barrier);
  }
  return barrier;
}

function releaseBarrier(key, name) {
  const barrier = getOrCreateBarrier(key, name);
  if (barrier.released) {
    return;
  }
  barrier.released = true;
  for (const waiter of barrier.waiters) {
    clearTimeout(waiter.timeout);
    waiter.resolve();
  }
  barrier.waiters.clear();
}

function getBarrierSnapshots(key) {
  const barriers = scenarioBarriers.get(key);
  if (!barriers) {
    return [];
  }
  return [...barriers.entries()].map(([name, barrier]) => ({
    name,
    waiting: barrier.waiters.size,
    released: barrier.released,
  }));
}

function fixtureAuthenticationFields(input) {
  if (!Object.hasOwn(input, 'fixtureCredentialLabel')) return {};
  return {
    fixtureCredentialLabel:
      input.fixtureCredentialLabel === 'initial' ||
      input.fixtureCredentialLabel === 'replacement'
        ? input.fixtureCredentialLabel
        : null,
    brokerAuthenticated: input.brokerAuthenticated === true,
  };
}

function snapshotObservation(observation) {
  const snapshot = {
    index: observation.index,
    ...fixtureAuthenticationFields(observation),
  };
  for (const field of OBSERVATION_STRING_FIELDS) {
    if (typeof observation[field] === 'string') {
      snapshot[field] = observation[field];
    }
  }
  if (Number.isSafeInteger(observation.attempt) && observation.attempt > 0) {
    snapshot.attempt = observation.attempt;
  }
  snapshot.toolNames = Array.isArray(observation.toolNames)
    ? observation.toolNames.filter((value) => typeof value === 'string')
    : [];
  snapshot.toolResultIds = Array.isArray(observation.toolResultIds)
    ? observation.toolResultIds.filter((value) => typeof value === 'string')
    : [];
  if (observation.body !== undefined)
    snapshot.body = structuredClone(observation.body);
  return snapshot;
}

function getRequestSnapshots(key) {
  return (requestObservations.get(key) ?? []).map(snapshotObservation);
}

/**
 * Register a per-test scenario under a credential key. A falsy key is ignored.
 *
 * @param {string} key
 * @param {object} scenario
 */
export function registerScenario(key, scenario) {
  if (!key) {
    return;
  }
  discardScenarioRuntime(key);
  scenarios.set(key, scenario ?? {});
}

/**
 * Resolve the scenario registered under `key`, or the benign default scenario
 * when nothing is registered (including for a falsy key).
 *
 * @param {string} [key]
 * @returns {object}
 */
export function getScenario(key) {
  if (!key) {
    return DEFAULT_SCENARIO;
  }
  return scenarios.get(key) ?? DEFAULT_SCENARIO;
}

/**
 * Increment one observed activity counter for a registered scenario key.
 * Activity is test-only evidence that the provider-facing request arrived; it
 * is kept outside the scripted scenario so the mock response stays stateless.
 *
 * @param {string | undefined} key
 * @param {string} field
 */
export function recordScenarioActivity(key, field) {
  if (!key || !field) {
    return;
  }
  const activity = scenarioActivity.get(key) ?? {};
  activity[field] = (activity[field] ?? 0) + 1;
  scenarioActivity.set(key, activity);
}

/**
 * Return observed activity counters for a scenario key.
 *
 * @param {string | undefined} key
 * @returns {Record<string, number>}
 */
export function getScenarioActivity(key) {
  if (!key) {
    return {};
  }
  return { ...(scenarioActivity.get(key) ?? {}) };
}

/**
 * Remove the scenario registered under `key`.
 *
 * @param {string} key
 * @returns {boolean} whether a scenario was removed
 */
export function clearScenario(key) {
  if (!key) {
    return false;
  }
  discardScenarioRuntime(key);
  return scenarios.delete(key);
}

/** Remove every registered scenario. */
export function resetAll() {
  for (const key of scenarioBarriers.keys()) {
    discardScenarioRuntime(key);
  }
  scenarios.clear();
  scenarioActivity.clear();
  scenarioBarriers.clear();
  stepAttempts.clear();
  requestObservations.clear();
  inferenceJournals.clear();
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Open, or empty, a named inference journal. Until it is closed, every
 * inference request the mock serves is appended to it, whatever its prompt,
 * marker or credential, so a fixture can audit requests no scenario claims.
 * One journal at a time: no request says which fixture caused it, so a
 * second open journal with a live owner is refused. A dead owner's journal
 * (a killed test worker) is dropped.
 *
 * @param {string} name
 * @param {number} ownerPid the opening process, on this host
 * @returns {string | undefined} the open journal that refused this one
 */
export function openInferenceJournal(name, ownerPid) {
  for (const [other, journal] of inferenceJournals) {
    if (other === name) continue;
    if (processAlive(journal.ownerPid)) return other;
    inferenceJournals.delete(other);
  }
  inferenceJournals.set(name, { ownerPid, entries: [] });
  return undefined;
}

/**
 * @param {string} name
 * @returns {boolean} whether the journal was open
 */
export function closeInferenceJournal(name) {
  return inferenceJournals.delete(name);
}

/**
 * @param {string} name
 * @returns {object[] | undefined} the entries, or undefined when not open
 */
export function getInferenceJournal(name) {
  return inferenceJournals.get(name)?.entries.map((entry) => ({ ...entry }));
}

/**
 * Append one content-free entry to every open journal. Credentials appear only
 * as the synthetic fixture label of the scenario they are registered under.
 *
 * @param {object} fields
 */
export function recordInferenceJournalEntry(fields) {
  if (inferenceJournals.size === 0) return;
  const input = fields && typeof fields === 'object' ? fields : {};
  const entry = {
    ...fixtureAuthenticationFields({
      fixtureCredentialLabel: input.fixtureCredentialLabel,
      brokerAuthenticated: input.brokerAuthenticated,
    }),
  };
  for (const field of INFERENCE_JOURNAL_STRING_FIELDS) {
    entry[field] = typeof input[field] === 'string' ? input[field] : null;
  }
  for (const { entries } of inferenceJournals.values())
    entries.push({ index: entries.length, ...entry });
}

/**
 * Select the scripted alternative for this invocation of a step.
 * Attempts are tracked per scenario key and step id and remain on the final
 * alternative after the script is exhausted.
 *
 * @param {string | undefined} key
 * @param {object} step
 * @returns {{ step: object, attempt?: number }}
 */
export function resolveStepAttempt(key, step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) {
    return { step };
  }
  if (!Object.hasOwn(step, 'attempts')) {
    return { step };
  }

  const { attempts } = step;
  if (
    !Array.isArray(attempts) ||
    attempts.length === 0 ||
    attempts.some(
      (alternative) =>
        !alternative ||
        typeof alternative !== 'object' ||
        Array.isArray(alternative),
    ) ||
    typeof step.stepId !== 'string' ||
    !step.stepId.trim()
  ) {
    throw codedError(
      'mock_invalid_step',
      'A step with attempts must have a nonempty stepId and a nonempty array of object alternatives.',
    );
  }

  const keyForStep = scenarioKey(key);
  let scenarioAttempts = stepAttempts.get(keyForStep);
  if (!scenarioAttempts) {
    scenarioAttempts = new Map();
    stepAttempts.set(keyForStep, scenarioAttempts);
  }

  const count = (scenarioAttempts.get(step.stepId) ?? 0) + 1;
  scenarioAttempts.set(step.stepId, count);
  const attempt = Math.min(count, attempts.length);
  const { attempts: _ignored, ...baseFields } = step;
  return {
    step: { ...baseFields, ...attempts[attempt - 1] },
    attempt,
  };
}

/**
 * Wait until a named barrier is released for this scenario key.
 *
 * @param {string} key
 * @param {string} name
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<void>}
 */
export function waitForBarrier(key, name, timeoutMs = 30000) {
  if (
    typeof key !== 'string' ||
    !key.trim() ||
    typeof name !== 'string' ||
    !name.trim() ||
    typeof timeoutMs !== 'number' ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0
  ) {
    return Promise.reject(
      codedError(
        'mock_invalid_barrier',
        'A barrier requires nonempty key and name strings and a nonnegative timeout.',
      ),
    );
  }

  const keyForBarrier = scenarioKey(key);
  const barrier = getOrCreateBarrier(keyForBarrier, name);
  if (barrier.released) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timeout: undefined };
    barrier.waiters.add(waiter);
    waiter.timeout = setTimeout(() => {
      if (barrier.waiters.delete(waiter)) {
        reject(
          codedError(
            'mock_barrier_timeout',
            `Timed out waiting for mock barrier ${JSON.stringify(name)}.`,
          ),
        );
      }
    }, timeoutMs);
  });
}

/**
 * Record a filtered, content-free observation for a scenario key.
 * The returned live object may have its `errorClass` filled in by the route
 * after an error; control-plane reads always clone its whitelisted fields.
 *
 * @param {string | undefined} key
 * @param {object} fields
 * @returns {object}
 */
export function recordRequest(key, fields = {}) {
  const keyForRequest = scenarioKey(key);
  const observations = requestObservations.get(keyForRequest) ?? [];
  const input = fields && typeof fields === 'object' ? fields : {};
  const observation = {
    index: observations.length,
    ...fixtureAuthenticationFields(input),
  };

  for (const field of OBSERVATION_STRING_FIELDS) {
    if (typeof input[field] === 'string') {
      observation[field] = input[field];
    }
  }
  if (Number.isSafeInteger(input.attempt) && input.attempt > 0) {
    observation.attempt = input.attempt;
  }
  observation.toolNames = Array.isArray(input.toolNames)
    ? input.toolNames.filter((value) => typeof value === 'string')
    : [];
  observation.toolResultIds = Array.isArray(input.toolResultIds)
    ? input.toolResultIds.filter((value) => typeof value === 'string')
    : [];

  observations.push(observation);
  requestObservations.set(keyForRequest, observations);
  return observation;
}

/**
 * Extract the credential key from an Authorization header.
 *
 * Most Canopy mock surfaces use `Bearer`, but Octokit sends classic PAT/OAuth
 * tokens as `token <key>`. Accept both so GitHub UI automation can key mock
 * scenarios off the same token the app passes to the real Octokit client.
 *
 * @param {import('node:http').IncomingMessage} request
 * @returns {string | undefined}
 */
export function keyFromBearer(request) {
  const authorization = request.headers?.authorization ?? '';
  const match = /^(?:Bearer|token)\s+(.+)$/i.exec(authorization.trim());
  return match ? match[1].trim() : undefined;
}

/**
 * Extract the credential key from an API-key header or query parameter.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {{ header?: string, query?: string, url?: URL }} [options]
 *   `header` — request header name to read (case-insensitive).
 *   `query` — query-parameter name to read (requires `url`).
 *   `url` — parsed request URL used for query lookups.
 * @returns {string | undefined}
 */
export function keyFromApiKey(request, options = {}) {
  const { header, query, url } = options;

  if (header) {
    const raw = request.headers?.[header.toLowerCase()];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value) {
      return value.trim();
    }
  }

  if (query && url) {
    const value = url.searchParams.get(query);
    if (value) {
      return value.trim();
    }
  }

  return undefined;
}

/**
 * Extract a `[Canopy-C<id>]` marker key from arbitrary text (e.g. an LLM prompt
 * or system message). Returns the full marker (e.g. `Canopy-C7`) so surfaces can
 * key scenarios off it directly.
 *
 * @param {string} [text]
 * @returns {string | undefined}
 */
export function markerFromText(text) {
  if (typeof text !== 'string') {
    return undefined;
  }
  const match = /\[(Canopy-C[A-Za-z0-9_-]+)\]/.exec(text);
  return match ? match[1] : undefined;
}

// Routes sharing /graphql may inspect a request and then decline it. Retain
// the parsed body so the next route does not wait on an already-ended stream.
const jsonRequestBodies = new WeakMap();

/**
 * Read and JSON-parse a request body. Returns `undefined` on empty or invalid
 * JSON so callers can respond with a 400 instead of throwing.
 *
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<object | undefined>}
 */
export function readJsonBody(request) {
  const existing = jsonRequestBodies.get(request);
  if (existing) return existing;
  const body = new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      if (!raw.trim()) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(undefined);
      }
    });
    request.on('error', () => resolve(undefined));
  });
  jsonRequestBodies.set(request, body);
  return body;
}

function jsonResponse(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/**
 * Handle a `/__mock/*` control-plane request.
 *
 *   POST   /__mock/state        body `{ key, scenario }` → register a scenario
 *   GET    /__mock/state/:key                            → the scenario for key
 *   GET    /__mock/activity/:key                         → activity counters
 *   DELETE /__mock/state/:key                            → clear the scenario
 *   POST   /__mock/reset                                 → clear all scenarios
 *   POST   /__mock/barrier       body `{ key, name }`     → persist a release
 *   GET    /__mock/barrier?key=…                         → barrier status
 *   GET    /__mock/requests?key=…                        → content-free request observations
 *   POST   /__mock/inference-journal  body `{ name, ownerPid }` → open or empty a journal (409 while another is open)
 *   GET    /__mock/inference-journal?name=…              → its entries (404 when not open)
 *   DELETE /__mock/inference-journal?name=…              → close it
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {URL} url
 * @returns {Promise<boolean>} `true` if a `/__mock/*` route was handled
 */
export async function handleControlPlaneRequest(request, response, url) {
  const { pathname } = url;
  if (!pathname.startsWith('/__mock/')) {
    return false;
  }

  const method = request.method;

  if (method === 'POST' && pathname === '/__mock/reset') {
    resetAll();
    jsonResponse(response, 200, { ok: true });
    return true;
  }

  if (method === 'POST' && pathname === '/__mock/state') {
    const body = await readJsonBody(request);
    if (!body || typeof body.key !== 'string' || !body.key) {
      jsonResponse(response, 400, {
        error: 'Expected JSON body { key: string, scenario?: object }.',
      });
      return true;
    }
    registerScenario(body.key, body.scenario ?? {});
    jsonResponse(response, 200, { ok: true, key: body.key });
    return true;
  }

  if (method === 'POST' && pathname === '/__mock/barrier') {
    const body = await readJsonBody(request);
    if (
      !body ||
      typeof body.key !== 'string' ||
      !body.key.trim() ||
      typeof body.name !== 'string' ||
      !body.name.trim()
    ) {
      jsonResponse(response, 400, {
        error:
          'Expected JSON body { key: nonempty string, name: nonempty string }.',
      });
      return true;
    }
    releaseBarrier(body.key, body.name);
    jsonResponse(response, 200, { ok: true, key: body.key, name: body.name });
    return true;
  }

  if (method === 'GET' && pathname === '/__mock/barrier') {
    const key = url.searchParams.get('key');
    if (!key || !key.trim()) {
      jsonResponse(response, 400, {
        error: 'Expected query parameter key with a nonempty string.',
      });
      return true;
    }
    jsonResponse(response, 200, { barriers: getBarrierSnapshots(key) });
    return true;
  }

  if (method === 'GET' && pathname === '/__mock/requests') {
    const key = url.searchParams.get('key');
    if (!key || !key.trim()) {
      jsonResponse(response, 400, {
        error: 'Expected query parameter key with a nonempty string.',
      });
      return true;
    }
    jsonResponse(response, 200, { requests: getRequestSnapshots(key) });
    return true;
  }

  if (pathname === '/__mock/inference-journal') {
    const body = method === 'POST' ? await readJsonBody(request) : undefined;
    const name = method === 'POST' ? body?.name : url.searchParams.get('name');
    if (typeof name !== 'string' || !name.trim()) {
      jsonResponse(response, 400, {
        error: 'Expected a nonempty journal name.',
      });
      return true;
    }
    if (method === 'POST') {
      const ownerPid = body?.ownerPid;
      if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
        jsonResponse(response, 400, {
          error: 'Expected a positive integer ownerPid.',
        });
        return true;
      }
      const refusedBy = openInferenceJournal(name, ownerPid);
      if (refusedBy !== undefined)
        jsonResponse(response, 409, {
          error: `Inference journal ${JSON.stringify(refusedBy)} is open: journal specs must run alone against this mock server.`,
        });
      else jsonResponse(response, 200, { ok: true, name });
      return true;
    }
    if (method === 'DELETE') {
      jsonResponse(response, 200, {
        ok: true,
        closed: closeInferenceJournal(name),
      });
      return true;
    }
    if (method === 'GET') {
      const requests = getInferenceJournal(name);
      // An unopened journal fails loudly rather than reading as no requests.
      if (!requests)
        jsonResponse(response, 404, {
          error: `Inference journal ${JSON.stringify(name)} is not open.`,
        });
      else jsonResponse(response, 200, { requests });
      return true;
    }
  }

  const stateMatch = /^\/__mock\/state\/(.+)$/.exec(pathname);
  if (stateMatch) {
    const key = decodeURIComponent(stateMatch[1]);

    if (method === 'GET') {
      jsonResponse(response, 200, { key, scenario: getScenario(key) });
      return true;
    }

    if (method === 'DELETE') {
      const cleared = clearScenario(key);
      jsonResponse(response, 200, { ok: true, cleared });
      return true;
    }
  }

  const activityMatch = /^\/__mock\/activity\/(.+)$/.exec(pathname);
  if (activityMatch && method === 'GET') {
    const key = decodeURIComponent(activityMatch[1]);
    jsonResponse(response, 200, {
      key,
      activity: getScenarioActivity(key),
    });
    return true;
  }

  jsonResponse(response, 404, {
    error: `Unhandled control-plane route: ${method} ${pathname}`,
  });
  return true;
}
