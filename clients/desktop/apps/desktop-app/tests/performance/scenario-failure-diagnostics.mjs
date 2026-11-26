const MAX_TEXT_LENGTH = 256;
const MAX_ARRAY_LENGTH = 12;
const MAX_OBJECT_KEYS = 20;

export function boundScenarioFailureValue(
  value,
  depth = 0,
  seen = new WeakSet(),
) {
  if (typeof value === 'string') return value.slice(0, MAX_TEXT_LENGTH);
  if (value === null || typeof value === 'number' || typeof value === 'boolean')
    return value;
  if (depth >= 3) return '[nested]';
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
  }
  if (Array.isArray(value))
    return value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((entry) => boundScenarioFailureValue(entry, depth + 1, seen));
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_OBJECT_KEYS)
        .map(([key, entry]) => [
          key.slice(0, MAX_TEXT_LENGTH),
          boundScenarioFailureValue(entry, depth + 1, seen),
        ]),
    );
  return String(value).slice(0, MAX_TEXT_LENGTH);
}

/** Failure-only evidence. Collection can never change the failing assertion. */
export async function captureScenarioFailure(
  originalError,
  kind,
  collect,
  { timeoutMs = 1_000, write = (line) => process.stdout.write(line) } = {},
) {
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(collect),
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve({ collection: 'timed-out' }),
          timeoutMs,
        );
      }),
    ]);
    write(
      `PERFORMANCE_FAILURE_DIAGNOSTIC ${JSON.stringify({
        diagnosticOnly: true,
        kind,
        evidence: boundScenarioFailureValue(result),
      })}\n`,
    );
  } catch (error) {
    try {
      write(
        `PERFORMANCE_FAILURE_DIAGNOSTIC ${JSON.stringify({
          diagnosticOnly: true,
          kind,
          collection: 'failed',
          reason: boundScenarioFailureValue(
            error instanceof Error ? error.message : String(error),
          ),
        })}\n`,
      );
    } catch {
      // The original scenario assertion remains authoritative.
    }
  } finally {
    clearTimeout(timer);
  }
  throw originalError;
}

/** The result record for a scenario that threw before it could report one. */
export function failedPerformanceScenario(name, durationMs, error) {
  const details = error?.performanceDetails ?? {};
  return {
    name,
    status: 'error',
    durationMs,
    tasks: details.tasks ?? [],
    ...(details.launch ? { launch: details.launch } : {}),
    ...(details.foreground ? { foreground: details.foreground } : {}),
    ...(details.windowEvidence
      ? { windowEvidence: details.windowEvidence }
      : {}),
    // getMainWindow already bounds and redacts this historical event record.
    ...(error?.mainWindowSelection
      ? { mainWindowSelection: error.mainWindowSelection }
      : {}),
    ...(details.monitoring ? { monitoring: details.monitoring } : {}),
    // `--remote-control`: the connection's evidence so far (CAN-7852).
    ...(details.remoteControl ? { remoteControl: details.remoteControl } : {}),
    ...(details.gitAttribution
      ? { gitAttribution: details.gitAttribution }
      : {}),
    ...(details.rendererProcessGone
      ? { rendererProcessGone: details.rendererProcessGone }
      : {}),
    ...(details.crashDumps ? { crashDumps: details.crashDumps } : {}),
    ...(details.userDataDir ? { userDataDir: details.userDataDir } : {}),
    error:
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    ...(error?.cleanupError instanceof Error
      ? { cleanupError: error.cleanupError.message }
      : {}),
  };
}
