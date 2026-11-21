import { isUtf8 } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import type { CloudCopyAudience } from '@canopy/desktop-shared/types';
import { isStorageOutcomeUnknownError } from '@canopy/core-runtime/storage';
import { writeFileAtomicallySync } from '@canopy/execution-engine/node/lib/atomic-file';
import { damagedCopyPath } from '@canopy/execution-engine/node/lib/damaged-copies';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { isErrnoException } from '../lib/type-guards';

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

interface StoredEntries {
  entries: Record<string, unknown>;
  /**
   * The bytes read when the file exists but can't be parsed, so it holds no
   * readable consent; they are what a write first copies aside.
   */
  damagedBytes?: Buffer;
}

/**
 * The file's entries; 'newer' when a later version of the app wrote it, and
 * 'unreadable' when it can't be read at all. Either then reads as no consent
 * and is never written over. A file that can't be parsed holds no consent.
 */
function readEntries(filePath: string): StoredEntries | 'newer' | 'unreadable' {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (error) {
    return isErrnoException(error) && error.code === 'ENOENT'
      ? { entries: {} }
      : 'unreadable';
  }
  const damaged = { entries: {}, damagedBytes: bytes };
  // Decoding would turn a bad byte into U+FFFD and a rewrite would lose it.
  if (!isUtf8(bytes)) return damaged;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return damaged;
  }
  if (!isPlainRecord(parsed)) return damaged;
  if (!('version' in parsed)) return { entries: { ...parsed } };
  if (parsed.version !== FILE_VERSION) return 'newer';
  return isPlainRecord(parsed.entries)
    ? { entries: { ...parsed.entries } }
    : damaged;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const NEWER_FILE_MESSAGE =
  'A newer version of the app wrote this file, so it is left as it is.';
const UNREADABLE_FILE_MESSAGE =
  "The consents file can't be read, so it is left as it is.";

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
    const stored = readEntries(this.filePath);
    if (stored === 'newer' || stored === 'unreadable') return {};
    const consents: Record<string, CloudCopyConsent> = {};
    for (const [localId, value] of Object.entries(stored.entries)) {
      const consent = parseConsent(value);
      if (consent !== null) consents[localId] = consent;
    }
    return consents;
  }

  get(localId: string): CloudCopyConsent | null {
    return this.read()[localId] ?? null;
  }

  set(localId: string, consent: CloudCopyConsent): void {
    const stored = this.storedForWrite();
    this.write({ ...stored.entries, [localId]: consent }, stored.damagedBytes);
  }

  /** Forgets every consent for a cloud copy, as removing it does. */
  clearByRemoteId(remoteId: string): void {
    const stored = readEntries(this.filePath);
    // A newer file is left as it is; unpublish has already removed the copy.
    if (stored === 'newer') return;
    // Refused, so unpublish keeps the link and a retry can finish.
    if (stored === 'unreadable') throw new Error(UNREADABLE_FILE_MESSAGE);
    const { entries } = stored;
    // Judged by the stored remoteId, so an entry this version can't read
    // still goes with its cloud copy; other unreadable entries are kept.
    const kept = Object.fromEntries(
      Object.entries(entries).filter(
        ([, value]) => !isPlainRecord(value) || value.remoteId !== remoteId,
      ),
    );
    if (Object.keys(kept).length !== Object.keys(entries).length)
      this.write(kept, stored.damagedBytes);
  }

  private storedForWrite(): StoredEntries {
    const stored = readEntries(this.filePath);
    if (stored === 'newer') throw new Error(NEWER_FILE_MESSAGE);
    if (stored === 'unreadable') throw new Error(UNREADABLE_FILE_MESSAGE);
    return stored;
  }

  /**
   * Durable and atomic. The bytes of a damaged file, as read when it was judged
   * damaged, are first copied aside durably under an unused name.
   */
  private write(
    entries: Record<string, unknown>,
    damagedBytes: Buffer | undefined,
  ): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (damagedBytes)
      writeFileAtomicallySync(damagedCopyPath(this.filePath), damagedBytes, {
        durable: true,
      });
    try {
      writeFileAtomicallySync(
        this.filePath,
        `${JSON.stringify({ version: FILE_VERSION, entries }, null, 2)}\n`,
        { encoding: 'utf8', durable: true },
      );
    } catch (error) {
      if (!isStorageOutcomeUnknownError(error)) throw error;
      logMainProcessWarn(
        '[skills] Cloud copy consents installed, but their folder flush failed',
        error,
      );
    }
  }
}
