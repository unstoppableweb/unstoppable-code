/** A person's consent for one exact installed Claude plugin content tree. */
export interface ClaudeModAdmission {
  pluginId: string;
  contentDigest: string;
  admittedAt: string;
}

/** A browser-safe explanation that a Mod did not participate in a launch. */
export interface SkippedClaudeMod {
  pluginId: string;
  source: 'selected' | 'ambient';
  contentDigest: string | null;
  reason:
    | 'not-admitted'
    | 'digest-changed'
    | 'kill-switch'
    | 'authority-unreadable'
    | 'inspection-failed'
    | 'install-list-unreadable'
    | 'projection-failed';
}

export function isClaudeModContentDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

export function isClaudeModPluginId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[^@\s/\\]{1,200}@[^@\s\\]{1,200}$/.test(value) &&
    !value.endsWith('@inline')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isClaudeModAdmission(
  value: unknown,
): value is ClaudeModAdmission {
  if (!isRecord(value)) {
    return false;
  }
  if (
    !isClaudeModPluginId(value.pluginId) ||
    !isClaudeModContentDigest(value.contentDigest) ||
    typeof value.admittedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.admittedAt)
  ) {
    return false;
  }
  const admittedAt = new Date(value.admittedAt);
  return (
    Number.isFinite(admittedAt.getTime()) &&
    admittedAt.toISOString() === value.admittedAt
  );
}

export function isSkippedClaudeMod(value: unknown): value is SkippedClaudeMod {
  if (!isRecord(value)) {
    return false;
  }
  const validReason =
    value.reason === 'not-admitted' ||
    value.reason === 'digest-changed' ||
    value.reason === 'kill-switch' ||
    value.reason === 'authority-unreadable' ||
    value.reason === 'inspection-failed' ||
    value.reason === 'install-list-unreadable' ||
    value.reason === 'projection-failed';
  return (
    (isClaudeModPluginId(value.pluginId) ||
      (typeof value.pluginId === 'string' &&
        value.pluginId.endsWith('@inline'))) &&
    (value.source === 'selected' || value.source === 'ambient') &&
    (value.contentDigest === null ||
      isClaudeModContentDigest(value.contentDigest)) &&
    validReason
  );
}
