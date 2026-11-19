import type { RemoteControlEventEnvelope } from './index';

const REPLACEMENT_CHARACTER = '\ufffd';

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function containsUnstorableString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0) return true;

    if (isHighSurrogate(codeUnit)) {
      if (isLowSurrogate(value.charCodeAt(index + 1))) {
        index += 1;
      } else {
        return true;
      }
    } else if (isLowSurrogate(codeUnit)) {
      return true;
    }
  }
  return false;
}

/**
 * Remove characters PostgreSQL cannot store and repair malformed UTF-16 while
 * preserving valid surrogate pairs. Clean strings take the allocation-free
 * path and are returned unchanged.
 */
export function sanitizeStorableString(value: string): string {
  if (!containsUnstorableString(value)) return value;

  let output = '';
  let unchangedStart = 0;

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0) {
      output += value.slice(unchangedStart, index);
      unchangedStart = index + 1;
      continue;
    }

    if (isHighSurrogate(codeUnit)) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (isLowSurrogate(nextCodeUnit)) {
        index += 1;
        continue;
      }
      output += value.slice(unchangedStart, index) + REPLACEMENT_CHARACTER;
      unchangedStart = index + 1;
      continue;
    }

    if (isLowSurrogate(codeUnit)) {
      output += value.slice(unchangedStart, index) + REPLACEMENT_CHARACTER;
      unchangedStart = index + 1;
    }
  }

  return unchangedStart === 0 ? value : output + value.slice(unchangedStart);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const RECURSIVE_JSON_DEPTH_LIMIT = 256;

type JsonContainer = unknown[] | Record<string, unknown>;

function isJsonContainer(value: unknown): value is JsonContainer {
  return Array.isArray(value) || isPlainObject(value);
}

interface RemoteControlToolIdentitySanitization {
  dropOccurrence: boolean;
  dropOutputLocator: boolean;
  dropNestedResultOutputLocator: boolean;
}

const NO_REMOTE_CONTROL_TOOL_IDENTITY_DROPS: RemoteControlToolIdentitySanitization =
  {
    dropOccurrence: false,
    dropOutputLocator: false,
    dropNestedResultOutputLocator: false,
  };

function hasUnstorableLocatorMessageId(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const messageId = value.messageId;
  return (
    typeof messageId === 'string' &&
    sanitizeStorableString(messageId) !== messageId
  );
}

function remoteControlToolIdentitySanitization(
  value: Record<string, unknown>,
): RemoteControlToolIdentitySanitization {
  const kind = value.kind ?? value.type;
  if (kind !== 'tool_use' && kind !== 'tool_result') {
    return NO_REMOTE_CONTROL_TOOL_IDENTITY_DROPS;
  }

  const occurrence = isPlainObject(value.occurrence)
    ? value.occurrence
    : undefined;
  const occurrenceId = occurrence?.id;
  const dropOccurrence =
    typeof occurrenceId === 'string' &&
    sanitizeStorableString(occurrenceId) !== occurrenceId;
  const data = isPlainObject(value.data) ? value.data : undefined;
  const result = data && isPlainObject(data.result) ? data.result : undefined;

  return {
    dropOccurrence,
    dropOutputLocator:
      dropOccurrence || hasUnstorableLocatorMessageId(value.outputLocator),
    dropNestedResultOutputLocator:
      dropOccurrence || hasUnstorableLocatorMessageId(result?.outputLocator),
  };
}

function shouldDropRemoteControlToolIdentityField(
  key: string,
  sanitization: RemoteControlToolIdentitySanitization,
): boolean {
  return (
    (sanitization.dropOccurrence && key === 'occurrence') ||
    (sanitization.dropOutputLocator && key === 'outputLocator')
  );
}

function withoutNestedResultOutputLocator(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const result = value.result;
  if (
    !isPlainObject(result) ||
    !Object.prototype.hasOwnProperty.call(result, 'outputLocator')
  ) {
    return value;
  }

  const resultWithoutLocator = { ...result };
  delete resultWithoutLocator.outputLocator;
  return { ...value, result: resultWithoutLocator };
}

function containsUnstorableJson(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return containsUnstorableString(value);

  if (Array.isArray(value)) {
    if (depth >= RECURSIVE_JSON_DEPTH_LIMIT) return true;
    for (const entry of value) {
      if (containsUnstorableJson(entry, depth + 1)) return true;
    }
    return false;
  }

  if (!isPlainObject(value)) return false;
  if (depth >= RECURSIVE_JSON_DEPTH_LIMIT) return true;

  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (
      containsUnstorableString(key) ||
      containsUnstorableJson(value[key], depth + 1)
    ) {
      return true;
    }
  }
  return false;
}

function sanitizeDeeplyNestedJson(value: JsonContainer): unknown {
  const pending: JsonContainer[] = [value];
  const postOrder: JsonContainer[] = [];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    postOrder.push(current);
    const entries = Array.isArray(current) ? current : Object.values(current);
    for (const entry of entries) {
      if (isJsonContainer(entry)) {
        pending.push(entry);
      }
    }
  }

  const sanitizedValues = new WeakMap<object, unknown>();
  for (let index = postOrder.length - 1; index >= 0; index -= 1) {
    const current = postOrder[index];
    if (!current) continue;

    if (Array.isArray(current)) {
      let changed = false;
      const sanitized = current.map((entry) => {
        const next = isJsonContainer(entry)
          ? (sanitizedValues.get(entry) ?? entry)
          : typeof entry === 'string'
            ? sanitizeStorableString(entry)
            : entry;
        changed ||= next !== entry;
        return next;
      });
      sanitizedValues.set(current, changed ? sanitized : current);
      continue;
    }

    let changed = false;
    const identitySanitization = remoteControlToolIdentitySanitization(current);
    const entries: Array<readonly [string, unknown]> = [];
    for (const key of Object.keys(current)) {
      if (shouldDropRemoteControlToolIdentityField(key, identitySanitization)) {
        changed = true;
        continue;
      }

      const sanitizedKey = sanitizeStorableString(key);
      const entry = current[key];
      let sanitizedEntry: unknown = isJsonContainer(entry)
        ? (sanitizedValues.get(entry) ?? entry)
        : typeof entry === 'string'
          ? sanitizeStorableString(entry)
          : entry;
      if (
        key === 'data' &&
        identitySanitization.dropNestedResultOutputLocator
      ) {
        sanitizedEntry = withoutNestedResultOutputLocator(sanitizedEntry);
      }
      changed ||= sanitizedKey !== key || sanitizedEntry !== entry;
      entries.push([sanitizedKey, sanitizedEntry]);
    }
    if (!changed) {
      sanitizedValues.set(current, current);
      continue;
    }

    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of entries) {
      Object.defineProperty(sanitized, key, {
        configurable: true,
        enumerable: true,
        value: entry,
        writable: true,
      });
    }
    sanitizedValues.set(current, sanitized);
  }

  return sanitizedValues.get(value) ?? value;
}

function sanitizeStorableJsonAtDepth(value: unknown, depth: number): unknown {
  if (depth >= RECURSIVE_JSON_DEPTH_LIMIT && isJsonContainer(value)) {
    return sanitizeDeeplyNestedJson(value);
  }
  if (!containsUnstorableJson(value, depth)) return value;

  if (typeof value === 'string') return sanitizeStorableString(value);

  if (Array.isArray(value)) {
    let changed = false;
    const sanitized = value.map((entry) => {
      const next = sanitizeStorableJsonAtDepth(entry, depth + 1);
      changed ||= next !== entry;
      return next;
    });
    return changed ? sanitized : value;
  }

  if (!isPlainObject(value)) return value;

  let changed = false;
  const identitySanitization = remoteControlToolIdentitySanitization(value);
  const entries: Array<readonly [string, unknown]> = [];
  for (const key of Object.keys(value)) {
    if (shouldDropRemoteControlToolIdentityField(key, identitySanitization)) {
      changed = true;
      continue;
    }

    const sanitizedKey = sanitizeStorableString(key);
    const entry = value[key];
    let sanitizedEntry = sanitizeStorableJsonAtDepth(entry, depth + 1);
    if (key === 'data' && identitySanitization.dropNestedResultOutputLocator) {
      sanitizedEntry = withoutNestedResultOutputLocator(sanitizedEntry);
    }
    changed ||= sanitizedKey !== key || sanitizedEntry !== entry;
    entries.push([sanitizedKey, sanitizedEntry]);
  }
  if (!changed) return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of entries) {
    Object.defineProperty(sanitized, key, {
      configurable: true,
      enumerable: true,
      value: entry,
      writable: true,
    });
  }
  return sanitized;
}

/**
 * Sanitize JSON arrays and plain objects with structural sharing. If sanitized
 * keys collide, normal JavaScript property order applies and the later source
 * property wins. This is intentionally lossy so a poison event cannot retry
 * forever.
 */
export function sanitizeStorableJson<T>(value: T): T {
  // Most Portal events are already clean. Detect that case without building
  // mapped arrays or object-entry tuples so a clean envelope stays genuinely
  // allocation-free all the way through its payload.
  return sanitizeStorableJsonAtDepth(value, 0) as T;
}

function sanitizeEnvelopeString<T>(value: T): T {
  return typeof value === 'string'
    ? (sanitizeStorableString(value) as T)
    : value;
}

/** Sanitize every Portal event field persisted as text or JSON. */
export function sanitizeRemoteControlEventEnvelope<
  T extends RemoteControlEventEnvelope,
>(event: T): T {
  const eventId = sanitizeEnvelopeString(event.eventId);
  const clientEventId = sanitizeEnvelopeString(event.clientEventId);
  const commandId = sanitizeEnvelopeString(event.commandId);
  const type = sanitizeEnvelopeString(event.type);
  const payload = sanitizeStorableJson(event.payload);

  if (
    eventId === event.eventId &&
    clientEventId === event.clientEventId &&
    commandId === event.commandId &&
    type === event.type &&
    payload === event.payload
  ) {
    return event;
  }

  return {
    ...event,
    eventId,
    ...(clientEventId === undefined ? {} : { clientEventId }),
    ...(commandId === undefined ? {} : { commandId }),
    type,
    payload,
  };
}
