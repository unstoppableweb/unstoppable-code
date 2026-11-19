import { readFile, realpath, stat } from 'node:fs/promises';
import {
  AGENT_SECRET_REDACTION_MIN_LENGTH,
  agentSecretValueForms,
} from '@canopy/protocol/agent-secrets';
import { MergedSecretRedactor } from './merged-redactor';
import { getChatSecretStore } from './chat-secret-store';

/*
 * Content-based protection for what Canopy shows of a worktree: file views,
 * previews, document bytes, the Portal's file reads, diffs and patches.
 * Every view goes through {@link secretSafeView}, the one place the check
 * happens (`check:secret-view-boundary` keeps it that way). It looks at the
 * exact text or bytes the view is about to show, never a second read of the
 * file, and either redacts them whole or withholds the view.
 *
 * Its values are every agent secret value the app has recorded (each chat's
 * live, revoked and replaced values, and the values written to secrets
 * files), whatever path holds them, so a renamed or copied file reads
 * redacted too. Every worktree's values apply to every view: work entries can
 * share one folder under different ids, and masking another worktree's value
 * costs nothing.
 *
 * It covers Canopy's own views only. A command an agent runs, or a native
 * read of the file, sees the plain text; WriteSecretsFile's warning says so.
 *
 * Every kind finds values the same way, through one {@link SecretDetector}:
 * each value whole, with LF or CRLF line endings, without the whitespace
 * that ends it, and each line of a value spanning lines; each in every
 * encoded form the redactor matches.
 *
 * Fails closed: when the store can't be read, or a value can't be read back,
 * the view is refused rather than shown unredacted.
 */

/** What a withheld view shows instead. */
export const SECRET_VIEW_HIDDEN_NOTICE =
  'Hidden: this file contains agent secrets.';

/** Thrown when a view can't be shown without risking a secret. */
export class SecretViewUnavailableError extends Error {
  constructor(
    message = "This may show secrets an agent was given, and they couldn't be hidden, so it is not shown.",
  ) {
    super(message);
    this.name = 'SecretViewUnavailableError';
  }
}

/** A view withheld because what it shows holds agent secrets. */
export class SecretViewHiddenError extends SecretViewUnavailableError {
  constructor() {
    super(SECRET_VIEW_HIDDEN_NOTICE);
    this.name = 'SecretViewHiddenError';
  }
}

/** A marker the redactor puts in place of a value. */
const SECRET_MARKER = /\[secret:[A-Z_][A-Z0-9_]{0,63}\]/g;

/** The largest file a save reads whole to check. */
const SAVE_CHECK_MAX_BYTES = 16 * 1024 * 1024;

interface SecretViewBase {
  /**
   * The files the view shows, when known: a secrets file whose values a
   * damaged store lost is withheld, and a diff or patch of any secrets file
   * is withheld.
   */
  readonly paths?: readonly string[];
}

/**
 * What a Canopy view is about to show:
 * - `text`: a file's text, whole or (`cut`) its start only. Redacted whole;
 *   a cut text also loses any end that could be the start of a value.
 * - `bytes`: an image, document or binary view, as raw bytes, base64 or a
 *   base64 data URL. Can't be redacted, so withheld when it holds a value.
 * - `diff`: both sides of a file and its image preview. Withheld when either
 *   side holds a value, or when a side was cut while any value is recorded.
 * - `patch`: a unified diff. Withheld when it, or either side it shows,
 *   holds a value.
 * "Holds a value" means the same for every kind: what {@link SecretDetector}
 * finds.
 */
export type SecretView =
  | (SecretViewBase & {
      readonly kind: 'text';
      readonly text: string;
      readonly cut: boolean;
    })
  | (SecretViewBase & {
      readonly kind: 'bytes';
      readonly bytes: Uint8Array | string;
    })
  | (SecretViewBase & {
      readonly kind: 'diff';
      readonly oldValue: string;
      readonly newValue: string;
      readonly truncated: boolean;
      readonly imagePreview?: {
        readonly oldDataUrl?: string;
        readonly newDataUrl?: string;
      };
    })
  | (SecretViewBase & { readonly kind: 'patch'; readonly patch: string });

/**
 * The view to show in place of `view`: a `text` view with every recorded
 * value replaced by `[secret:NAME]`, any other kind unchanged. Throws
 * {@link SecretViewHiddenError} when the view must be withheld, and
 * {@link SecretViewUnavailableError} when the values can't be read.
 */
export async function secretSafeView<View extends SecretView>(
  view: View,
): Promise<View> {
  const store = getChatSecretStore();
  let groups: Array<Record<string, string>>;
  try {
    await store.ensureLoaded();
    groups = store.viewRedactionGroups();
  } catch {
    throw new SecretViewUnavailableError();
  }
  for (const path of view.paths ?? []) {
    const target = await realpath(path).catch(() => path);
    // Nothing can redact a file whose values the store lost.
    if (store.secretFileValuesLost(target)) throw new SecretViewHiddenError();
    if (
      (view.kind === 'diff' || view.kind === 'patch') &&
      store.isSecretFile(target)
    )
      throw new SecretViewHiddenError();
  }
  if (!groups.length) return view;
  const detector = new SecretDetector(groups);
  switch (view.kind) {
    case 'text': {
      // A cut text first loses any end that starts a value, while it is
      // still the text as read: a redacted end can no longer be matched.
      const text = detector.redact(
        view.cut ? withoutCutValue(view.text, detector.forms) : view.text,
      );
      return text === view.text ? view : { ...view, text };
    }
    case 'bytes':
      if (detector.holdsBytes(view.bytes)) throw new SecretViewHiddenError();
      return view;
    case 'diff':
      for (const url of [
        view.imagePreview?.oldDataUrl,
        view.imagePreview?.newDataUrl,
      ])
        if (url && detector.holdsBytes(url)) throw new SecretViewHiddenError();
      // A cut side isn't the whole file and can end inside a value.
      if (view.truncated) throw new SecretViewHiddenError();
      if (detector.holds(view.oldValue) || detector.holds(view.newValue))
        throw new SecretViewHiddenError();
      return view;
    case 'patch': {
      // The patch itself holds each line it shows; its sides hold a value
      // spanning lines, which the line markers split.
      const sides = patchSides(view.patch);
      if (
        detector.holds(view.patch) ||
        detector.holds(sides.old) ||
        detector.holds(sides.new)
      )
        throw new SecretViewHiddenError();
      return view;
    }
  }
}

/**
 * True when a view must not save `saving` over the file: the file holds a
 * recorded value, or is a secrets file whose values a damaged store lost,
 * so its view is redacted and a save would write markers over the values;
 * or `saving` holds more `[secret:NAME]` markers than the file does, so it
 * was shown redacted (by values since removed, perhaps) and saving it would
 * write those markers over whatever the file holds. Call it only once the
 * path is known to be allowed. A regular file too large to read whole, or
 * one that can't be read, counts as holding one; anything else isn't a file
 * a view shows, so holds none.
 */
export async function secretViewFileHoldsSecrets(
  absolutePath: string,
  saving = '',
): Promise<boolean> {
  const store = getChatSecretStore();
  let groups: Array<Record<string, string>>;
  try {
    await store.ensureLoaded();
    groups = store.viewRedactionGroups();
  } catch {
    throw new SecretViewUnavailableError();
  }
  const target = await realpath(absolutePath).catch(() => absolutePath);
  if (store.secretFileValuesLost(target)) return true;
  const markers = secretMarkers(saving);
  if (!groups.length && !markers.size) return false;
  const stats = await stat(target).catch(() => null);
  if (!stats?.isFile()) return false;
  if (stats.size > SAVE_CHECK_MAX_BYTES) return true;
  const text = await readFile(target, 'utf8').catch(() => null);
  if (text === null) return true;
  const kept = secretMarkers(text);
  for (const [marker, count] of markers)
    if (count > (kept.get(marker) ?? 0)) return true;
  return groups.length > 0 && new SecretDetector(groups).holds(text);
}

/** How many times each `[secret:NAME]` marker occurs in `text`. */
function secretMarkers(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [marker] of text.matchAll(SECRET_MARKER))
    counts.set(marker, (counts.get(marker) ?? 0) + 1);
  return counts;
}

/**
 * `text` for a Canopy view with every recorded value, in any of its forms,
 * replaced by `[secret:NAME]`. For tests and {@link secretSafeView} only.
 */
export async function redactSecretView(text: string): Promise<string> {
  return (await secretSafeView({ kind: 'text', text, cut: false })).text;
}

/**
 * The old and new text a unified diff's hunks show, without their line
 * markers: what a patch reveals of each side, so a value it shows (one
 * spanning lines too) can be matched.
 */
export function patchSides(patch: string): { old: string; new: string } {
  const old: string[] = [];
  const next: string[] = [];
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
      old.push('');
      next.push('');
      continue;
    }
    if (line.startsWith('diff --git ')) inHunk = false;
    if (!inHunk) continue;
    if (line.startsWith(' ')) {
      old.push(line.slice(1));
      next.push(line.slice(1));
    } else if (line.startsWith('-')) old.push(line.slice(1));
    else if (line.startsWith('+')) next.push(line.slice(1));
  }
  return { old: old.join('\n'), new: next.join('\n') };
}

/**
 * What a view finds of the recorded values, the one routine every kind
 * uses: each value whole; with its line endings as LF and as CRLF; without
 * the whitespace that ends it (git output loses it); and, for a value
 * spanning lines, each of its lines of at least the redaction minimum, since
 * a view can show part of such a value. Each piece is matched in every
 * encoded form the redactor knows, under its secret's name.
 */
class SecretDetector {
  private readonly groups: Array<Record<string, string>> = [];
  /** Every encoded form of every piece, for bytes and cut ends. */
  readonly forms: readonly string[];

  constructor(groups: ReadonlyArray<Readonly<Record<string, string>>>) {
    for (const group of groups)
      for (const [name, value] of Object.entries(group))
        for (const piece of valuePieces(value))
          addPiece(this.groups, name, piece);
    const forms = new Set<string>();
    for (const group of this.groups)
      for (const piece of Object.values(group))
        for (const form of agentSecretValueForms(piece)) forms.add(form);
    this.forms = [...forms];
  }

  /** `text` with every piece replaced by `[secret:NAME]`. */
  redact(text: string): string {
    return new MergedSecretRedactor(this.groups).redact(text);
  }

  /** True when `text` holds any piece. */
  holds(text: string): boolean {
    if (!text) return false;
    const redactor = new MergedSecretRedactor(this.groups);
    redactor.redact(text);
    return redactor.redactions > 0;
  }

  /** True when raw bytes, base64 or a base64 data URL hold any piece. */
  holdsBytes(content: Uint8Array | string): boolean {
    const buffer =
      typeof content === 'string'
        ? Buffer.from(
            content.startsWith('data:')
              ? content.slice(content.indexOf(',') + 1)
              : content,
            'base64',
          )
        : Buffer.from(content.buffer, content.byteOffset, content.byteLength);
    return this.forms.some((form) =>
      buffer.includes(Buffer.from(form, 'utf8')),
    );
  }
}

function valuePieces(value: string): string[] {
  const pieces = new Set<string>([value]);
  const trimmed = value.trimEnd();
  if (trimmed.length >= AGENT_SECRET_REDACTION_MIN_LENGTH) pieces.add(trimmed);
  const lf = value.replace(/\r\n/g, '\n');
  if (lf.includes('\n')) {
    pieces.add(lf);
    pieces.add(lf.replace(/\n/g, '\r\n'));
    for (const line of lf.split('\n')) {
      const piece = line.trim();
      if (piece.length >= AGENT_SECRET_REDACTION_MIN_LENGTH) pieces.add(piece);
    }
  }
  return [...pieces];
}

/** Adds a piece under `name`; each group takes a name at most once. */
function addPiece(
  groups: Array<Record<string, string>>,
  name: string,
  piece: string,
): void {
  if (groups.some((group) => group[name] === piece)) return;
  const group = groups.find((candidate) => !(name in candidate));
  if (group) group[name] = piece;
  else groups.push({ [name]: piece });
}

/**
 * A cut text, as read, without any end that could be the start of a value
 * form: the rest of the value lies past the cut, so its start is dropped
 * rather than shown. A byte cut can also end inside a character, which
 * decodes as U+FFFD; that goes too.
 */
function withoutCutValue(text: string, forms: readonly string[]): string {
  let cut = text.replace(/�+$/, '');
  for (;;) {
    let longest = 0;
    for (const form of forms)
      for (
        let length = Math.min(form.length, cut.length);
        length > longest;
        length--
      )
        if (cut.endsWith(form.slice(0, length))) {
          longest = length;
          break;
        }
    if (!longest) return cut;
    cut = cut.slice(0, cut.length - longest);
  }
}
