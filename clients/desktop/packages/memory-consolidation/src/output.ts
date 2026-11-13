import { isPortableFileName } from '@canopy/protocol/memory-sync';
import { isChatHistoryProfileTopic } from './chat-history-profile';
import type { ConsolidationInput, ConsolidationOutput } from './input';
import {
  MAX_TOPIC_BYTES,
  MAX_TOPIC_FILENAME_BYTES,
  MAX_TOPIC_OUTPUT_FILES,
} from './limits';
import { isMemoryIndexWithinLimits } from './memory-index';
import { lineReferencesFileKey } from './pruning';
import { redactMemoryContent } from './redaction';
import { utf8ByteLength } from './text';
import { topicIdentity, type ScopeTopicInventory } from './topic-identity';
import {
  findTopicReferences,
  normalizeOutputTopicFilename,
  type MarkdownReferenceSpan,
} from './topic-reference';

export interface GeneratedConsolidationOutput {
  memoryMd: string;
  topicFiles?: unknown[];
}

export const CONSOLIDATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    memoryMd: { type: 'string' },
    topicFiles: {
      type: 'array',
      maxItems: MAX_TOPIC_OUTPUT_FILES,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          filename: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['filename', 'content'],
      },
    },
  },
  required: ['memoryMd'],
};

export const CONSOLIDATION_RESULT_VALIDATION_SCHEMA = {
  ...CONSOLIDATION_SCHEMA,
  properties: {
    ...CONSOLIDATION_SCHEMA.properties,
    topicFiles: { type: 'array', maxItems: MAX_TOPIC_OUTPUT_FILES, items: {} },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function outputEnvelopeError(value: unknown): string | null {
  if (!isRecord(value)) return 'output: expected an object';
  if (
    Object.keys(value).some((key) => key !== 'memoryMd' && key !== 'topicFiles')
  ) {
    return 'output: unexpected fields';
  }
  if (typeof value.memoryMd !== 'string') return 'memoryMd: expected a string';
  if (value.topicFiles !== undefined && !Array.isArray(value.topicFiles)) {
    return 'topicFiles: expected an array';
  }
  if (
    Array.isArray(value.topicFiles) &&
    value.topicFiles.length > MAX_TOPIC_OUTPUT_FILES
  ) {
    return `topicFiles: exceeds ${MAX_TOPIC_OUTPUT_FILES} entries`;
  }
  return null;
}

export function isConsolidationOutput(
  value: unknown,
): value is GeneratedConsolidationOutput {
  return outputEnvelopeError(value) === null;
}

/**
 * The result check for one model call, remembering the envelope error worth
 * reporting when the call returns nothing: the first one seen, replaced by a
 * later one only when that answer was at least an object.
 */
export function trackOutputEnvelope(): {
  isResult: (value: unknown) => value is GeneratedConsolidationOutput;
  error: () => string | undefined;
} {
  let envelopeError: string | undefined;
  return {
    isResult: (value: unknown): value is GeneratedConsolidationOutput => {
      const error = outputEnvelopeError(value);
      if (error !== null && (envelopeError === undefined || isRecord(value)))
        envelopeError = error;
      return isConsolidationOutput(value);
    },
    error: () => envelopeError,
  };
}

function normalizeContent(value: string): string {
  const normalized = value.replace(/\r\n?/g, '\n').replace(/\0/g, '').trimEnd();
  return normalized.length > 0 ? `${normalized}\n` : '';
}

export interface ValidatedConsolidationOutput {
  output: ConsolidationOutput | null;
  diagnostics: string[];
}

/**
 * The existing topics one helper answer may replace. An answer may always
 * create a topic that does not exist yet, but replacing any other existing
 * topic (one left out of its prompt by the input budget, one the compaction
 * prompt marked read-only, or the generated chat history profile) would
 * overwrite saved memory the helper never saw, so imported or inbox text
 * steering it could corrupt unrelated topics for good.
 */
export interface TopicWritePolicy {
  /** Identities of existing topics this answer may replace. */
  replaceable: ReadonlySet<string>;
  /** Identities of every non-directory entry in `topics/`; others are new. */
  existing: ReadonlySet<string>;
}

/**
 * The run's write set: the topics its prompt included, never the profile.
 * What exists comes from the scope's inventory and never from the input, so
 * a topic the input budget left out is existing without being replaceable.
 * Every host builds its policy here, so no path can read one from the other.
 */
export function consolidationWritePolicy(
  input: ConsolidationInput,
  scope: ScopeTopicInventory,
): TopicWritePolicy {
  return {
    replaceable: new Set(
      input.topicFiles
        .filter((file) => !isChatHistoryProfileTopic(file.filename))
        .map((file) => topicIdentity(file.filename)),
    ),
    existing: scope.identities,
  };
}

/**
 * The compaction retry's write set: the run's own, narrowed to the topics
 * the first answer returned, since the compaction prompt shows only those and
 * marks every other existing topic read-only.
 */
export function compactionWritePolicy(
  runPolicy: TopicWritePolicy,
  output: ConsolidationOutput,
  scope: ScopeTopicInventory,
): TopicWritePolicy {
  const returned = new Set(
    (output.topicFiles ?? []).map((topic) => topicIdentity(topic.filename)),
  );
  return {
    replaceable: new Set(
      Array.from(runPolicy.replaceable).filter((identity) =>
        returned.has(identity),
      ),
    ),
    existing: new Set([
      ...Array.from(runPolicy.existing),
      ...Array.from(scope.identities),
    ]),
  };
}

export function normalizeAndValidateOutput(
  output: unknown,
  policy: TopicWritePolicy,
): ValidatedConsolidationOutput {
  if (!isConsolidationOutput(output)) {
    return {
      output: null,
      diagnostics: [outputEnvelopeError(output) ?? 'output: invalid envelope'],
    };
  }
  const normalizedMemoryMd = redactMemoryContent(
    normalizeContent(output.memoryMd),
  );
  if (normalizedMemoryMd.trim().length === 0) {
    return {
      output: null,
      diagnostics: ['memoryMd: empty after normalization'],
    };
  }
  const memoryMd = normalizedMemoryMd;

  const diagnostics: string[] = [];
  const candidates: Array<{
    filename: string;
    content: string;
    index: number;
  }> = [];
  const identities = new Map<string, number[]>();
  const generatedTopics = output.topicFiles ?? [];
  for (let index = 0; index < generatedTopics.length; index += 1) {
    const topic = generatedTopics[index];
    const field = `topicFiles[${index}]`;
    if (!isRecord(topic)) {
      diagnostics.push(`${field}: expected an object`);
      continue;
    }
    const filename =
      typeof topic.filename === 'string'
        ? normalizeOutputTopicFilename(topic.filename)
        : null;
    if (
      Object.keys(topic).some((key) => key !== 'filename' && key !== 'content')
    ) {
      diagnostics.push(`${field}: unexpected fields`);
      continue;
    }
    if (typeof topic.filename !== 'string') {
      diagnostics.push(`${field}.filename: expected a string`);
      continue;
    }
    if (filename === null) {
      diagnostics.push(
        `${field}.filename: invalid filename; use one Markdown filename without traversal or nested directories`,
      );
      continue;
    }
    if (!isPortableFileName(filename)) {
      diagnostics.push(`${field}.filename: reserved device name`);
      continue;
    }
    if (utf8ByteLength(filename) > MAX_TOPIC_FILENAME_BYTES) {
      diagnostics.push(
        `${field}.filename: exceeds ${MAX_TOPIC_FILENAME_BYTES} UTF-8 bytes including the extension; reserve space for atomic-write suffixes`,
      );
      continue;
    }
    if (typeof topic.content !== 'string') {
      diagnostics.push(`${field}.content: expected a string`);
      continue;
    }
    const content = redactMemoryContent(normalizeContent(topic.content));
    if (content.trim().length === 0) {
      diagnostics.push(`${field}.content: empty after normalization`);
      continue;
    }
    if (utf8ByteLength(content) > MAX_TOPIC_BYTES) {
      diagnostics.push(
        `${field}.content: exceeds ${MAX_TOPIC_BYTES} UTF-8 bytes`,
      );
      continue;
    }
    // Generated from chat titles and replaced on every scan; dropped as
    // keepChatHistoryProfile always has, without failing the answer.
    if (isChatHistoryProfileTopic(filename)) continue;
    const identity = topicIdentity(filename);
    if (policy.existing.has(identity) && !policy.replaceable.has(identity)) {
      diagnostics.push(
        `${field}.filename: existing topic this run may not rewrite`,
      );
      continue;
    }
    identities.set(identity, [...(identities.get(identity) ?? []), index]);
    candidates.push({ filename, content, index });
  }
  const topicFiles: NonNullable<ConsolidationOutput['topicFiles']> = [];
  for (const topic of candidates) {
    if ((identities.get(topicIdentity(topic.filename))?.length ?? 0) > 1) {
      diagnostics.push(
        `topicFiles[${topic.index}].filename: case-insensitive filename collision`,
      );
      continue;
    }
    topicFiles.push({ filename: topic.filename, content: topic.content });
  }
  return {
    output: { memoryMd, topicFiles },
    diagnostics,
  };
}

function canonicalReferenceSource(
  source: string,
  span: MarkdownReferenceSpan,
  matchStart: number,
  encodedPath: string,
  canonicalPath: string,
): string {
  let rendered = '';
  let pathIndex = 0;
  let skipped = decodeURIComponent(encodedPath).startsWith('./') ? 2 : 0;
  for (let index = 0; index < encodedPath.length; ) {
    const end = encodedPath[index] === '%' ? index + 3 : index + 1;
    const character = decodeURIComponent(encodedPath.slice(index, end));
    if (skipped > 0) {
      skipped -= 1;
      index = end;
      continue;
    }
    const raw = source.slice(
      span.offsets[matchStart + index],
      span.offsets[matchStart + end],
    );
    const canonical = canonicalPath[pathIndex];
    rendered +=
      character === canonical &&
      (raw.startsWith('\\') || raw.startsWith('&') || character === '_')
        ? raw
        : canonical;
    pathIndex += 1;
    index = end;
  }
  return rendered;
}

export function resolveOutputIndexReferences(
  output: ConsolidationOutput,
  existingNames: readonly string[],
  diagnostics: string[],
): string {
  const filenames = new Map(
    existingNames.map((filename) => [topicIdentity(filename), filename]),
  );
  for (const topic of output.topicFiles ?? [])
    filenames.set(topicIdentity(topic.filename), topic.filename);
  const source = output.memoryMd;
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  for (const reference of findTopicReferences(source)) {
    const { span, index, encodedPath } = reference;
    const canonical =
      reference.filename === null
        ? undefined
        : filenames.get(topicIdentity(reference.filename));
    const start = span.offsets[index];
    if (canonical === undefined) {
      const line = source.slice(0, start).split('\n').length;
      diagnostics.push(
        `memoryMd line ${line}: topic reference does not resolve`,
      );
      continue;
    }
    replacements.push({
      start,
      end: span.offsets[index + encodedPath.length],
      text: canonicalReferenceSource(
        source,
        span,
        index,
        encodedPath,
        `topics/${canonical}`,
      ),
    });
  }
  let resolved = source;
  for (const replacement of replacements.reverse())
    resolved =
      resolved.slice(0, replacement.start) +
      replacement.text +
      resolved.slice(replacement.end);
  return resolved;
}

export function preservePartialConsolidationSources(
  input: ConsolidationInput,
  output: ConsolidationOutput,
  existingNames: readonly string[],
): ConsolidationOutput {
  const existing = new Set(existingNames.map(topicIdentity));
  const topicFiles = (output.topicFiles ?? []).filter(
    (topic) => !existing.has(topicIdentity(topic.filename)),
  );
  let memoryMd = input.memoryMd;
  for (const topic of topicFiles) {
    const fileKey = `topics/${topic.filename}`;
    if (lineReferencesFileKey(memoryMd, fileKey)) continue;
    const candidate = `${memoryMd}${memoryMd.endsWith('\n') || memoryMd.length === 0 ? '' : '\n'}- ${fileKey}\n`;
    if (isMemoryIndexWithinLimits(candidate)) memoryMd = candidate;
  }
  return { memoryMd, topicFiles };
}

export function mergeCompactedOutput(
  previous: ConsolidationOutput,
  compacted: ConsolidationOutput,
): ConsolidationOutput {
  const topics = new Map<string, { filename: string; content: string }>();
  for (const topic of [
    ...(previous.topicFiles ?? []),
    ...(compacted.topicFiles ?? []),
  ]) {
    topics.set(topicIdentity(topic.filename), topic);
  }
  return {
    memoryMd: compacted.memoryMd,
    topicFiles: Array.from(topics.values()),
  };
}
