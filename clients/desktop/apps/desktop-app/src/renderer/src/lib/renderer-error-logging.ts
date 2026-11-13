function serializeUnknownForLogging(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return Object.prototype.toString.call(value);
    }
  }

  return value;
}

/**
 * Fold a structured details payload into the single log string.
 *
 * Each value is serialized individually first: `JSON.stringify` renders an
 * `Error` as `{}`, so a details record carrying one would otherwise lose the
 * name/message/stack that made it worth logging.
 */
function formatDetailsForLogging(details: Record<string, unknown>): string {
  const serialized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    serialized[key] = serializeUnknownForLogging(value);
  }

  try {
    return JSON.stringify(serialized);
  } catch {
    // `serializeUnknownForLogging` already collapses circular and
    // unserializable objects, so reaching here means something exotic
    // (a BigInt, a throwing `toJSON`). Never lose the message over it.
    return Object.prototype.toString.call(details);
  }
}

/**
 * Log a renderer diagnostic that main captures into `app-events`.
 *
 * `details` is serialized INTO the message string rather than passed as a
 * second `console.error` argument. Electron's renderer console-message capture
 * only forwards the formatted message, stringifying everything after the first
 * argument, so `console.error(message, details)` landed in `app-events` as the
 * literal text `[renderer] ... [object Object]` and threw away every field the
 * payload existed to carry.
 */
export function reportRendererConsoleError(
  message: string,
  details?: Record<string, unknown>,
): void {
  if (details) {
    // eslint-disable-next-line no-console
    console.error(`[renderer] ${message} ${formatDetailsForLogging(details)}`);
    return;
  }

  // eslint-disable-next-line no-console
  console.error(`[renderer] ${message}`);
}

/**
 * Log a promise rejection that nothing handled, as the window's
 * `unhandledrejection` listener does.
 */
export function reportUnhandledRendererRejection(reason: unknown): void {
  reportRendererConsoleError('Unhandled renderer promise rejection', {
    reason: serializeUnknownForLogging(reason),
  });
}

export function installRendererErrorLogging(): () => void {
  const handleError = (event: ErrorEvent): void => {
    reportRendererConsoleError('Unhandled renderer error', {
      message: event.message,
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
      error: serializeUnknownForLogging(event.error),
    });
  };

  const handleUnhandledRejection = (event: PromiseRejectionEvent): void => {
    reportUnhandledRendererRejection(event.reason);
  };

  window.addEventListener('error', handleError);
  window.addEventListener('unhandledrejection', handleUnhandledRejection);

  return (): void => {
    window.removeEventListener('error', handleError);
    window.removeEventListener('unhandledrejection', handleUnhandledRejection);
  };
}
