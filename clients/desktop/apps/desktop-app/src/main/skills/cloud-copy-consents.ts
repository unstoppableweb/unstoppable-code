import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CloudCopyAudience } from '@canopy/desktop-shared/types';

/**
 * What a person agreed to when a custom skill was added to the cloud
 * (CAN-6176, D32): the copy it went to, whether to keep that copy up to date,
 * and the files that may travel. A republish that would carry another file,
 * or leave out one more, needs the consent dialog again.
 */
export interface CloudCopyConsent {
  accountId: string;
  remoteId: string;
  keepInStep: boolean;
  consentedAt: string;
  selectedOptionalResourceIds: string[];
  /** `resourceId|provider|root/path` of every consented file. */
  files: string[];
  /** `assetId/relativePath` of every file left out at consent. */
  withheld: string[];
  /**
   * Who the person agreed would see the copy. Absent from consents recorded
   * before the audience gate, which therefore ask again before a republish.
   */
  audience?: CloudCopyAudience;
  /**
   * For a skill installed from GitHub, a URL or a local folder (CAN-6943):
   * the fingerprint of its whole folder when the copy was made. Any other
   * folder, or none recorded, shows the copy as out of date.
   */
  sourceFingerprint?: string;
}

const AUDIENCES: readonly CloudCopyAudience[] = [
  'private',
  'public_link',
  'team',
  'organization',
];

const isAudience = (value: unknown): value is CloudCopyAudience =>
  AUDIENCES.some((audience) => audience === value);

const CONSENTS_FILE = '.cloud-copy-consents.json';

/** The file's format: entries in an envelope. A bare map is version 0. */
const FILE_VERSION = 1;

/**
 * The file's entries, or 'newer' when a later version of the app wrote it:
 * this one then reads nothing and never overwrites it.
 */
function readEntries(filePath: string): Record<string, unknown> | 'newer' {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
  if (!isPlainRecord(parsed)) return {};
  if (!('version' in parsed)) return { ...parsed };
  if (parsed.version !== FILE_VERSION) return 'newer';
  return isPlainRecord(parsed.entries) ? { ...parsed.entries } : {};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const NEWER_FILE_MESSAGE =
  'A newer version of the app wrote this file, so it is left as it is.';

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

function parseConsent(value: unknown): CloudCopyConsent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const record: Record<string, unknown> = { ...value };
  const {
    accountId,
    remoteId,
    keepInStep,
    consentedAt,
    selectedOptionalResourceIds,
    files,
    withheld,
    audience,
    sourceFingerprint,
  } = record;
  if (
    typeof accountId !== 'string' ||
    typeof remoteId !== 'string' ||
    typeof keepInStep !== 'boolean' ||
    typeof consentedAt !== 'string' ||
    !isStringArray(selectedOptionalResourceIds) ||
    !isStringArray(files) ||
    !isStringArray(withheld)
  )
    return null;
  return {
    accountId,
    remoteId,
    keepInStep,
    consentedAt,
    selectedOptionalResourceIds,
    files,
    withheld,
    ...(isAudience(audience) ? { audience } : {}),
    ...(typeof sourceFingerprint === 'string' ? { sourceFingerprint } : {}),
  };
}

/** The consents beside the skills' share links, keyed by local skill id. */
export class CloudCopyConsentStore {
  constructor(private readonly filePath: string) {}

  static inSkillsRoot(skillsRoot: string): CloudCopyConsentStore {
    return new CloudCopyConsentStore(path.join(skillsRoot, CONSENTS_FILE));
  }

  /**
   * An unreadable file, or one a newer app wrote, reads as no consent, which
   * never republishes.
   */
  read(): Record<string, CloudCopyConsent> {
    const entries = readEntries(this.filePath);
    if (entries === 'newer') return {};
    const consents: Record<string, CloudCopyConsent> = {};
    for (const [localId, value] of Object.entries(entries)) {
      const consent = parseConsent(value);
      if (consent !== null) consents[localId] = consent;
    }
    return consents;
  }

  get(localId: string): CloudCopyConsent | null {
    return this.read()[localId] ?? null;
  }

  set(localId: string, consent: CloudCopyConsent): void {
    this.write({ ...this.read(), [localId]: consent });
  }

  /** Forgets every consent for a cloud copy, as removing it does. */
  clearByRemoteId(remoteId: string): void {
    const consents = this.read();
    const kept = Object.fromEntries(
      Object.entries(consents).filter(
        ([, consent]) => consent.remoteId !== remoteId,
      ),
    );
    if (Object.keys(kept).length !== Object.keys(consents).length)
      this.write(kept);
  }

  private write(consents: Record<string, CloudCopyConsent>): void {
    if (readEntries(this.filePath) === 'newer')
      throw new Error(NEWER_FILE_MESSAGE);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify({ version: FILE_VERSION, entries: consents }, null, 2)}\n`,
      'utf8',
    );
    try {
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true });
      throw error;
    }
  }
}
