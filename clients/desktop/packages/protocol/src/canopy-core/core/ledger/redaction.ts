import { redactSecrets } from '../../../secret-redaction';
import { redactValues } from '../../../value-redaction';
import { LEDGER_LIMITS } from './limits';
import {
  LedgerContentSchema,
  LedgerFileRefSchema,
  LedgerHighlightSchema,
  LedgerTitleSchema,
  type LedgerFileRef,
} from './schemas';

/*
 * Masking an entry's text before any writer stores it (LD02): first the
 * exact values the caller's binding names, such as a pipeline step's
 * configured secrets, whatever their shape, then anything that looks like a
 * secret. Every Ledger writer applies it: the desktop's Ledger service and
 * the web core's cloud writer (CAN-6422).
 */

/** The fields of an entry a writer masks; the others pass through. */
export interface LedgerRedactableText {
  readonly title?: string;
  readonly content: string;
  readonly highlights?: readonly string[];
  readonly referenceFiles?: readonly LedgerFileRef[];
}

/**
 * The masked entry, or the field masking left invalid. A masked value can be
 * longer than the original; rather than truncate silently, a text field
 * reports its limit.
 */
export type LedgerRedaction<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly field: string; readonly limit?: number };

class RedactionRefused extends Error {
  constructor(
    readonly field: string,
    readonly limit?: number,
  ) {
    super(field);
  }
}

function maskText(
  value: string,
  schema: typeof LedgerTitleSchema,
  field: string,
  limit: number,
  secretValues: readonly string[],
  redact: (text: string) => string,
): string {
  const masked =
    secretValues.length === 0 ? value : redactValues(value, secretValues);
  const parsed = schema.safeParse(redact(masked));
  if (!parsed.success) throw new RedactionRefused(field, limit);
  return parsed.data;
}

/**
 * Masks the caller's secret values out of reference files, whose root and
 * path the agent chooses. A reference the masking leaves invalid is refused
 * rather than stored. Paths are not passed through the secret detector.
 */
function maskFileRefs(
  refs: readonly LedgerFileRef[],
  secretValues: readonly string[],
): LedgerFileRef[] {
  if (secretValues.length === 0) return [...refs];
  return refs.map((ref, index): LedgerFileRef => {
    const parsed = LedgerFileRefSchema.safeParse({
      ...ref,
      rootId: redactValues(ref.rootId, secretValues),
      path: redactValues(ref.path, secretValues),
    });
    if (!parsed.success)
      throw new RedactionRefused(`referenceFiles.${String(index)}`);
    return parsed.data;
  });
}

/** Masks an entry's title, content, highlights and reference files. */
export function redactLedgerEntryText<Entry extends LedgerRedactableText>(
  entry: Entry,
  secretValues: readonly string[] = [],
  redact: (text: string) => string = redactSecrets,
): LedgerRedaction<Entry> {
  try {
    return {
      ok: true,
      value: {
        ...entry,
        ...(entry.title === undefined
          ? {}
          : {
              title: maskText(
                entry.title,
                LedgerTitleSchema,
                'title',
                LEDGER_LIMITS.titleMaxCodePoints,
                secretValues,
                redact,
              ),
            }),
        content: maskText(
          entry.content,
          LedgerContentSchema,
          'content',
          LEDGER_LIMITS.contentMaxCodePoints,
          secretValues,
          redact,
        ),
        ...(entry.highlights === undefined
          ? {}
          : {
              highlights: entry.highlights.map((highlight, index) =>
                maskText(
                  highlight,
                  LedgerHighlightSchema,
                  `highlights.${String(index)}`,
                  LEDGER_LIMITS.highlightMaxCodePoints,
                  secretValues,
                  redact,
                ),
              ),
            }),
        ...(entry.referenceFiles === undefined
          ? {}
          : {
              referenceFiles: maskFileRefs(entry.referenceFiles, secretValues),
            }),
      },
    };
  } catch (error) {
    if (!(error instanceof RedactionRefused)) throw error;
    return {
      ok: false,
      field: error.field,
      ...(error.limit === undefined ? {} : { limit: error.limit }),
    };
  }
}
