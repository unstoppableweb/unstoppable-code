/**
 * Default base URL for the shared mock server. The CI workflow and
 * `playwright.config.mjs` normally bind the server to the default loopback
 * origin; `CANOPY_E2E_MOCK_BASE_URL` can override it.
 */
export const DEFAULT_MOCK_BASE_URL = (
  process.env.CANOPY_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:4011'
).replace(/\/+$/, '');

const MOCK_CONTROL_PLANE_ATTEMPTS = 20;
const MOCK_CONTROL_PLANE_RETRY_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Register a per-test scenario with the shared mock server's control plane.
 *
 * POSTs `{ key, scenario }` to `<baseUrl>/__mock/state`. The control plane
 * (`apps/desktop-app/tests/electron/mock-server/control-plane.mjs`) stores the
 * scenario under `key`; each mock surface resolves the key from the inbound
 * request's credential/marker so concurrent tests stay isolated.
 *
 * @param {string} [baseUrl] mock server origin; defaults to
 *   {@link DEFAULT_MOCK_BASE_URL}
 * @param {string} key per-test credential/marker key (e.g. `csk_<testId>`)
 * @param {unknown} [scenario] scenario object (optional per the control-plane
 *   contract)
 * @returns {Promise<{ ok: boolean, key: string }>} parsed control-plane reply
 */
export async function registerScenario(baseUrl, key, scenario) {
  const origin = (baseUrl ?? DEFAULT_MOCK_BASE_URL).replace(/\/+$/, '');
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('registerScenario requires a non-empty string key');
  }

  let lastError;
  for (let attempt = 1; attempt <= MOCK_CONTROL_PLANE_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${origin}/__mock/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, scenario }),
      });

      if (!response.ok) {
        throw new Error(
          `registerScenario: ${origin}/__mock/state responded ${response.status}: ${await response.text()}`,
        );
      }

      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt === MOCK_CONTROL_PLANE_ATTEMPTS) {
        break;
      }
      await sleep(MOCK_CONTROL_PLANE_RETRY_MS);
    }
  }

  throw new Error(
    `registerScenario: failed after ${MOCK_CONTROL_PLANE_ATTEMPTS} attempts: ${formatError(lastError)}`,
  );
}

/**
 * Clear one registered scenario without disturbing scenarios owned by other
 * Playwright workers.
 *
 * @param {string} [baseUrl] mock server origin; defaults to
 *   {@link DEFAULT_MOCK_BASE_URL}
 * @param {string} key scenario key to clear
 * @returns {Promise<{ ok: boolean, cleared: boolean }>} parsed reply
 */
export async function clearScenario(baseUrl, key) {
  const origin = (baseUrl ?? DEFAULT_MOCK_BASE_URL).replace(/\/+$/, '');
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('clearScenario requires a non-empty string key');
  }

  const url = `${origin}/__mock/state/${encodeURIComponent(key)}`;
  const options = {
    method: 'DELETE',
    headers: { connection: 'close' },
    signal: AbortSignal.timeout(10_000),
  };
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    // An idle pooled socket can reset on reuse. Only this idempotent DELETE
    // gets one retry; retire its connection and keep the original deadline.
    if (
      options.signal.aborted ||
      (error?.code !== 'ECONNRESET' && error?.cause?.code !== 'ECONNRESET')
    ) {
      throw error;
    }
    response = await fetch(url, options);
  }

  if (!response.ok) {
    throw new Error(
      `clearScenario: ${origin}/__mock/state/${encodeURIComponent(key)} responded ${response.status}: ${await response.text()}`,
    );
  }

  return response.json();
}

/**
 * Read observed provider activity for one registered mock scenario.
 *
 * @param {string} [baseUrl] mock server origin; defaults to
 *   {@link DEFAULT_MOCK_BASE_URL}
 * @param {string} key scenario key to inspect
 * @param {{ signal?: AbortSignal }} [options] optional diagnostic cancellation
 * @returns {Promise<{ key: string, activity: Record<string, number> }>}
 */
export async function getScenarioActivity(baseUrl, key, options = {}) {
  const origin = (baseUrl ?? DEFAULT_MOCK_BASE_URL).replace(/\/+$/, '');
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('getScenarioActivity requires a non-empty string key');
  }

  const response = await fetch(
    `${origin}/__mock/activity/${encodeURIComponent(key)}`,
    { signal: options.signal },
  );
  if (!response.ok) {
    throw new Error(
      `getScenarioActivity: ${origin}/__mock/activity/${encodeURIComponent(key)} responded ${response.status}: ${await response.text()}`,
    );
  }
  return response.json();
}

/**
 * Clear all registered scenarios on the shared mock server.
 *
 * POSTs to `<baseUrl>/__mock/reset`.
 *
 * @param {string} [baseUrl] mock server origin; defaults to
 *   {@link DEFAULT_MOCK_BASE_URL}
 * @returns {Promise<{ ok: boolean }>} parsed control-plane reply
 */
export async function resetScenarios(baseUrl) {
  const origin = (baseUrl ?? DEFAULT_MOCK_BASE_URL).replace(/\/+$/, '');
  const response = await fetch(`${origin}/__mock/reset`, { method: 'POST' });

  if (!response.ok) {
    throw new Error(
      `resetScenarios: ${origin}/__mock/reset responded ${response.status}`,
    );
  }

  return response.json();
}
