/**
 * Secret checks for shared skill and package text (CAN-7226).
 *
 * There is one pattern list: SECRET_RULES in capability-files, read through
 * findSecretMaterialRule. Two profiles wrap it, and they differ only in how
 * they neutralize placeholders and in two extra checks:
 *
 * - scanSharedSkillForSecrets, the stricter profile, for collection skill
 *   text and cloud-copied SKILL.md files. It neutralizes named placeholders
 *   (shared-container rules), then also refuses literal environment
 *   assignments (`API_KEY=value`) and passwords in URLs or `-u user:pw`.
 * - findPackageTextCredentialRule, the package profile, for capability
 *   package files: the desktop package analysis before an upload, and the
 *   hosted check at commit, which must accept whatever that analysis lets
 *   through. It strips control characters, blanks plain `${{ }}` expressions
 *   and the package placeholder forms, and has no extra checks. Both sides
 *   read a file's bytes through findPackageFileCredentialRule.
 *
 * In both, a placeholder is neutralized only when its own contents trip no
 * SECRET_RULES pattern (neutralizePlaceholderAssignment), so a real value
 * written in brackets, such as `token: <ghp_…>`, is still refused.
 *
 * Neither profile adds a pattern of its own to SECRET_RULES. Both are pure:
 * no I/O, network or logging. Every regex in both stays linear in the input
 * length.
 */
import {
  asWrittenThenSpaced,
  displayableLabel,
  ESCAPES_AS_WRITTEN,
  findSecretMaterialRule,
  type EscapeReadingOptions,
  type SecretMaterialRule,
} from '../capability-files';
import { SECRET_ASSIGNMENT_KEYS_SOURCE } from '../secret-redaction';
import { WORKSPACE_TEMPLATE_SHARE_LABEL_LOWER } from '../workspace-templates';
import {
  credentialPathSegment,
  findSharedTextCredentialRule,
  sharedContainerCredentialErrorField,
  sharedContainerCredentialErrorNextStep,
  isSharedContainerDefinitionKind,
  neutralizePlaceholderAssignment,
  parseSharedContainerDefinitionDocument,
  sharedTextLabelCheck,
  SHARED_CONTAINER_DEFINITION_DOCUMENT_PATH,
  type SharedTextCredentialRule,
} from '../shared-containers/capability-definitions';

/** The error code every host returns when a shared skill holds a secret. */
export const SHARED_SKILL_SECRET_DETECTED_CODE =
  'collection_skill_secret_detected';

/** One file of a skill being shared: its path in the skill and its text. */
export interface SharedSkillFile {
  readonly path: string;
  readonly text: string;
}

/**
 * Where a shared skill looks like it holds a secret. It names the skill, the
 * file and the rule, never the matched text or where in the file it is.
 */
export interface SharedSkillSecretFinding {
  readonly skillName: string;
  readonly file: string;
  readonly rule: SharedTextCredentialRule;
  /**
   * Set when the skill's name itself looks like a secret: the rule it trips.
   * The name then reads as [redacted name] and the message asks for a rename.
   */
  readonly nameRule?: SharedTextCredentialRule;
}

/** The file field of a finding whose only secret is the skill's name. */
const SKILL_NAME_FINDING_FILE = '[skill name]';

/**
 * The first file of a skill whose text looks like it holds a secret, or
 * null. Pure: no I/O, network or logging, so desktop and the hosted service
 * run the same check (CAN-7226). The skill's name is shared too, so a name
 * that looks like a secret is refused even when no file is; it reads as
 * [redacted name], and a path that looks like one as [redacted path]. The
 * name and every file are checked as written first, and only then with each
 * escape written as text read as a space (CAN-7627).
 */
export function scanSharedSkillForSecrets(
  skill: {
    readonly skillName: string;
    readonly files: readonly SharedSkillFile[];
  },
  options: EscapeReadingOptions = {},
): SharedSkillSecretFinding | null {
  return asWrittenThenSpaced(options, (read) => {
    const nameRule = findSharedTextCredentialRule(
      read(skill.skillName),
      ESCAPES_AS_WRITTEN,
    );
    const named = {
      skillName: displayableLabel(
        skill.skillName,
        '[redacted name]',
        sharedTextLabelCheck,
      ),
      ...(nameRule === null ? {} : { nameRule }),
    };
    for (const file of skill.files) {
      const rule = findSharedTextCredentialRule(
        read(file.text),
        ESCAPES_AS_WRITTEN,
      );
      if (rule !== null)
        return {
          ...named,
          file: displayableLabel(
            file.path,
            '[redacted path]',
            sharedTextLabelCheck,
          ),
          rule,
        };
    }
    return nameRule === null
      ? null
      : { ...named, file: SKILL_NAME_FINDING_FILE, rule: nameRule };
  });
}

/** The rule a shared-container definition document's credential check trips. */
export const DEFINITION_CREDENTIAL_RULE = 'shared_container_credential';

/** Every rule id a secret refusal can name, on any host. */
export type SecretRuleId =
  | SharedTextCredentialRule
  | typeof DEFINITION_CREDENTIAL_RULE;

const RULE_LABELS: Readonly<Record<SecretRuleId, string>> = {
  private_key: 'a private key',
  jwt: 'a signed token',
  github_token: 'a GitHub token',
  slack_token: 'a Slack token',
  npm_token: 'an npm token',
  aws_access_key: 'an AWS access key',
  api_key_prefix: 'an API key',
  auth_header: 'an authorization header',
  bearer_token: 'a bearer token',
  credential_assignment: 'a credential value',
  env_assignment: 'a credential variable',
  url_credentials: 'a password in a URL',
  shared_container_credential: 'a credential in a definition field',
};

/** A plain name for a rule, for messages. */
export function sharedSkillSecretRuleLabel(rule: SecretRuleId): string {
  return RULE_LABELS[rule];
}

// A placeholder in an authorization header is still refused (CAN-7314), so
// that rule's advice is to drop the value rather than swap it.
function secretNextStep(rule: SecretRuleId): string {
  return rule === 'auth_header'
    ? 'Remove the header line, or say which header to send without writing its value'
    : 'Remove it, or replace it with a placeholder such as ${{ secrets.NAME }}';
}

/**
 * Why sharing stopped. It says something looks like a secret; it never
 * claims a skill is free of secrets, and it never quotes the match.
 */
export function sharedSkillSecretMessage(
  finding: SharedSkillSecretFinding,
): string {
  // The name can't be shown, so the message never quotes or redacts it.
  if (finding.nameRule !== undefined)
    return `This skill's name looks like it contains a secret (${sharedSkillSecretRuleLabel(finding.nameRule)}). Rename the skill, then share again.`;
  return `The skill "${finding.skillName}" looks like it contains a secret (${sharedSkillSecretRuleLabel(finding.rule)} in ${finding.file}). ${secretNextStep(finding.rule)}, then share again.`;
}

/**
 * Why sharing a collection stopped. A skill whose name looks like a secret
 * can't be named, so the message says it's one of the collection's skills.
 */
export function collectionSkillSecretMessage(
  finding: SharedSkillSecretFinding,
): string {
  if (finding.nameRule !== undefined)
    return `One of this collection's skills has a name that looks like it contains a secret (${sharedSkillSecretRuleLabel(finding.nameRule)}). Rename it, then share again.`;
  return sharedSkillSecretMessage(finding);
}

/**
 * Why a package upload stopped for a custom skill it carries, which may not
 * be the item being shared. The wording for a secret-looking name is chosen
 * here alone.
 */
export function packagedSkillSecretMessage(
  finding: SharedSkillSecretFinding,
): string {
  if (finding.nameRule !== undefined)
    return `A skill it uses has a name that looks like it contains a secret (${sharedSkillSecretRuleLabel(finding.nameRule)}). Rename that skill, then share again.`;
  return sharedSkillSecretMessage(finding);
}

/**
 * Why a plugin's cloud copy stopped for its own plugin.json (CAN-7226). The
 * plugin is named as sharing names a skill, and a name that looks like a
 * secret is never shown.
 */
export function pluginSecretMessage(finding: SharedSkillSecretFinding): string {
  if (finding.nameRule !== undefined)
    return `This plugin's name looks like it contains a secret (${sharedSkillSecretRuleLabel(finding.nameRule)}). Rename the plugin, then share again.`;
  return `The plugin "${finding.skillName}" looks like it contains a secret (${sharedSkillSecretRuleLabel(finding.rule)} in ${finding.file}). ${secretNextStep(finding.rule)}, then share again.`;
}

/**
 * What a package file belongs to, as a share names it: a skill or plugin, or
 * a workflow's asset, pipeline, child pipeline or pipeline action (CAN-7492).
 */
export interface PackageFileOwner {
  readonly kind:
    | 'skill'
    | 'plugin'
    | 'asset'
    | 'pipeline'
    | 'child pipeline'
    | 'pipeline action';
  /** Its name; one that looks like a secret is never passed. */
  readonly name: string;
  /** The pipeline an asset belongs to, when known; never one that looks like a secret. */
  readonly within?: string;
}

const ownerPhrase = (owner: PackageFileOwner): string =>
  `${owner.kind} "${owner.name}"${owner.within === undefined ? '' : ` in "${owner.within}"`}`;

/**
 * Why a share stopped for a package file whose content looks like a secret:
 * the owner, the rule and the file, never the value. A skill or plugin keeps
 * its own wording.
 */
export function packageFileSecretMessage(
  owner: PackageFileOwner,
  file: string,
  rule: SharedSkillSecretFinding['rule'],
): string {
  const finding = { skillName: owner.name, file, rule };
  if (owner.kind === 'skill') return sharedSkillSecretMessage(finding);
  if (owner.kind === 'plugin') return pluginSecretMessage(finding);
  return `The ${ownerPhrase(owner)} looks like it contains a secret (${sharedSkillSecretRuleLabel(rule)} in ${file}). ${secretNextStep(rule)}, then share again.`;
}

/**
 * Why a share stopped for a file whose own name looks like a secret
 * (CAN-7476). The name would travel in the package, so it is never shown.
 */
export function packageFileNameSecretMessage(
  owner: PackageFileOwner,
  rule: SecretRuleId,
): string {
  return `A file in the ${owner.kind} "${owner.name}" has a name that looks like it contains a secret (${sharedSkillSecretRuleLabel(rule)}). Rename the file, then share again.`;
}

/**
 * Why a share stopped for a JSON file too deeply nested to check for a
 * hidden secret (CAN-7476).
 */
export function packageFileUncheckedMessage(
  owner: PackageFileOwner,
  file: string,
): string {
  return `The ${ownerPhrase(owner)} has a file, ${file}, that is nested too deeply to check for secrets. Simplify it, then share again.`;
}

/**
 * Why installing a shared template stopped. The installer can't edit the
 * template, so it points them to whoever shared it, and a name that looks
 * like a secret is never shown.
 */
export function templateInstallSkillSecretMessage(
  finding: SharedSkillSecretFinding,
): string {
  if (finding.nameRule !== undefined)
    return `Couldn't install this ${WORKSPACE_TEMPLATE_SHARE_LABEL_LOWER} because one of its skills has a name that looks like it contains a secret (${sharedSkillSecretRuleLabel(finding.nameRule)}). Ask the person who shared it to rename it, then try again.`;
  return `Couldn't install this ${WORKSPACE_TEMPLATE_SHARE_LABEL_LOWER} because its skill "${finding.skillName}" looks like it contains a secret (${sharedSkillSecretRuleLabel(finding.rule)} in ${finding.file}). Ask the person who shared it to remove it, then try again.`;
}

// A placeholder such as `token: <value>` or `api_key=$API_KEY` names a value
// the run supplies, as the desktop package analysis has always read it. The
// bracketed forms hold at most 256 characters, so a run of unclosed `<` or
// `{{` can't make each match attempt scan to the end of the line; unbounded,
// they were quadratic. A longer bracketed value is no longer a placeholder.
/** Exported for the linear-growth golden only; skills/index.ts doesn't re-export it. */
export const PACKAGE_PLACEHOLDER_ASSIGNMENT_PATTERN = new RegExp(
  `\\b(?:${SECRET_ASSIGNMENT_KEYS_SOURCE})\\s*(?:=|:)\\s*(?:<[^>\\r\\n]{1,256}>|\\{\\{?[^}\\r\\n]{1,256}\\}?\\}|\\$[A-Za-z_][A-Za-z0-9_]*|\\$\\{[A-Za-z_][A-Za-z0-9_]*\\})`,
  'gi',
);

function isControlCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code <= 0x1f || code === 0x7f;
}

function stripControlCharacters(value: string): string {
  let result = '';
  for (const character of value)
    if (!isControlCharacter(character)) result += character;
  return result;
}

// Stripping every control character joins a line that ends in a letter or
// digit to the next, so a token at the start of that line loses the word
// boundary its rule needs (CAN-7626). This copy keeps line breaks and tabs
// and reads every other control character as a space.
function keepLineBoundaries(value: string): string {
  let result = '';
  for (const character of value)
    result +=
      isControlCharacter(character) &&
      character !== '\t' &&
      character !== '\n' &&
      character !== '\r'
        ? ' '
        : character;
  return result;
}

/**
 * Blanks each `${{ … }}` pipeline expression whose inner text holds no secret,
 * as a lazy `\$\{\{[\s\S]*?\}\}` replace would, but in one pass: a run of
 * openers with no closer after them can't make it rescan from every start.
 */
function blankPlainPipelineExpressions(text: string): string {
  let result = '';
  let position = 0;
  for (;;) {
    const open = text.indexOf('${{', position);
    if (open === -1) break;
    const close = text.indexOf('}}', open + 3);
    if (close === -1) break;
    const inner = text.slice(open + 3, close);
    result += text.slice(position, open);
    result +=
      findSecretMaterialRule(inner, ESCAPES_AS_WRITTEN) === null
        ? '""'
        : text.slice(open, close + 2);
    position = close + 2;
  }
  return result + text.slice(position);
}

function packageReadingRule(reading: string): SecretMaterialRule | null {
  return findSecretMaterialRule(
    blankPlainPipelineExpressions(reading).replace(
      PACKAGE_PLACEHOLDER_ASSIGNMENT_PATTERN,
      neutralizePlaceholderAssignment,
    ),
    ESCAPES_AS_WRITTEN,
  );
}

/**
 * The secret rule a package file's text trips, read as the desktop package
 * analysis reads it, or null. The desktop analysis before an upload
 * and the hosted check at commit both call this, so a package the desktop
 * lets a person share is never refused on upload. Pure (CAN-7226).
 *
 * It reads the text twice: with control characters stripped, so a token they
 * split is still found, and with line boundaries kept (CAN-7626). Either
 * reading tripping refuses, and the stripped one runs first, so it only ever
 * refuses more than the stripped reading alone and names the same rule.
 * Text that trips neither is checked once more, both ways, with each escape
 * written as text read as a space (asWrittenThenSpaced, CAN-7627).
 */
export function findPackageTextCredentialRule(
  text: string,
  options: EscapeReadingOptions = {},
): SecretMaterialRule | null {
  return asWrittenThenSpaced(options, (read) => {
    const reading = read(text);
    return (
      packageReadingRule(stripControlCharacters(reading)) ??
      packageReadingRule(keepLineBoundaries(reading))
    );
  });
}

// Built per call, not at module load: @canopy/protocol loads in test and
// browser environments that have no TextDecoder global until one is used.
function decodePackageFile(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/**
 * The secret rule a package file's bytes trip, or null: every file, binary
 * or not, read as lenient UTF-8 and checked with the package profile. The
 * desktop package analysis and the hosted commit both call this, so they
 * read the same bytes the same way. An ASCII secret survives a lenient
 * decode of any byte-oriented encoding; UTF-16 and other NUL-interleaved
 * encodings are not decoded (CAN-7294).
 */
export function findPackageFileCredentialRule(
  bytes: Uint8Array,
  options: EscapeReadingOptions = {},
): SecretMaterialRule | null {
  return findPackageTextCredentialRule(decodePackageFile(bytes), options);
}

const TEXT_ESCAPE =
  /\\(?:u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|x([0-9A-Fa-f]{2})|\/)/g;

/**
 * A copy of text with its `\uXXXX`, `\UXXXXXXXX`, `\xNN` and `\/` escapes
 * decoded, or null when it has none. YAML double-quoted strings and many
 * config formats decode these, so an escaped key could hide a credential
 * from the raw text. The copy is only checked, never kept or uploaded
 * (CAN-7226). An escape that names no character, such as `\U00110000`, is
 * malformed and stays as written.
 */
export function escapeDecodedCopy(text: string): string | null {
  let decodedAny = false;
  const decoded = text.replace(
    TEXT_ESCAPE,
    (
      escape: string,
      four: string | undefined,
      eight: string | undefined,
      two: string | undefined,
    ): string => {
      const hex = four ?? eight ?? two;
      const codePoint = hex === undefined ? 0x2f : Number.parseInt(hex, 16);
      if (codePoint > 0x10ffff) return escape;
      decodedAny = true;
      return String.fromCodePoint(codePoint);
    },
  );
  return decodedAny ? decoded : null;
}

/** The rule text's escape-decoded copy trips with the shared check, or null. */
function escapeDecodedSecretRule(
  text: string,
): SharedTextCredentialRule | null {
  const decoded = escapeDecodedCopy(text);
  return decoded === null
    ? null
    : findSharedTextCredentialRule(decoded, ESCAPES_AS_WRITTEN);
}

/**
 * The rule a JSON text trips with the shared check once decoded, or null;
 * null too for text that isn't JSON. It names the rule only, never the
 * text. An escape such as `\/` or `\u0070` hides a credential from the raw
 * text, so the decoded text is checked whole, then each key, each string
 * value and each key beside its primitive value (CAN-7226). Text too deeply
 * nested to re-serialize can't be checked, so it reads as `unreadable`. The
 * walk is iterative, and the file was already capped at
 * PIPELINE_PACKAGE_MAX_FILE_BYTES.
 */
function decodedJsonSecretRule(
  text: string,
): SharedTextCredentialRule | 'unreadable' | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  let decoded: string;
  try {
    decoded = JSON.stringify(parsed);
  } catch {
    return 'unreadable';
  }
  const whole = findSharedTextCredentialRule(decoded, ESCAPES_AS_WRITTEN);
  if (whole !== null) return whole;
  const pending: unknown[] = [parsed];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') {
      const rule = findSharedTextCredentialRule(value, ESCAPES_AS_WRITTEN);
      if (rule !== null) return rule;
    } else if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        const keyRule = findSharedTextCredentialRule(key, ESCAPES_AS_WRITTEN);
        if (keyRule !== null) return keyRule;
        if (
          typeof item === 'string' ||
          typeof item === 'number' ||
          typeof item === 'boolean'
        ) {
          const pairRule =
            findSharedTextCredentialRule(
              `${key}: ${String(item)}`,
              ESCAPES_AS_WRITTEN,
            ) ??
            findSharedTextCredentialRule(
              `${key}=${String(item)}`,
              ESCAPES_AS_WRITTEN,
            );
          if (pairRule !== null) return pairRule;
        }
        pending.push(item);
      }
    }
  }
  return null;
}

/**
 * The secret rule a supporting file of a shared skill or plugin trips, or
 * null: the package profile first, then the stricter shared check on the
 * text, its decoded JSON and its escape-decoded copy. `unreadable` means the
 * file is JSON too deeply nested to check. The desktop analysis runs this on
 * every member file of a share or cloud copy, so the hosted side can run the
 * same check (CAN-7482). That whole sequence runs as written first, and
 * only then on the text with each escape written as text read as a space
 * (CAN-7627).
 */
export function findSharedMemberFileCredentialRule(
  bytes: Uint8Array,
  options: EscapeReadingOptions = {},
): SecretMaterialRule | SharedTextCredentialRule | 'unreadable' | null {
  const text = decodePackageFile(bytes);
  return asWrittenThenSpaced(options, (read) => {
    const reading = read(text);
    return (
      findPackageTextCredentialRule(reading, ESCAPES_AS_WRITTEN) ??
      findSharedTextCredentialRule(reading, ESCAPES_AS_WRITTEN) ??
      decodedJsonSecretRule(reading) ??
      escapeDecodedSecretRule(reading)
    );
  });
}

/** Which secret check a package entry tripped. */
export type PackageEntryCredentialRule =
  | SecretMaterialRule
  | typeof DEFINITION_CREDENTIAL_RULE;

/** Where and why a package entry looks like it holds a secret. */
export interface PackageEntryCredentialFinding {
  readonly rule: PackageEntryCredentialRule;
  /** For a definition document, the field that holds it; never the value. */
  readonly field?: string;
  /** For a definition document, what to do next, in a plain sentence. */
  readonly nextStep?: string;
}

/**
 * The definition document of a pipeline, automation, Agent or hook
 * definition resource, located exactly as the desktop locates it when it
 * installs a package: a definition-kind resource with one tree holding one
 * read-only entry at definition.json. Anything else, including a file named
 * definition.json anywhere else, is a member file (CAN-7226).
 */
export function packageDefinitionDocumentEntry<
  Entry extends { readonly path: string; readonly mode: string },
>(resource: {
  readonly kind: string;
  readonly trees: readonly { readonly entries: readonly Entry[] }[];
}): Entry | null {
  if (!isSharedContainerDefinitionKind(resource.kind)) return null;
  const tree = resource.trees.length === 1 ? resource.trees[0] : undefined;
  const entry =
    tree !== undefined && tree.entries.length === 1
      ? tree.entries[0]
      : undefined;
  return entry !== undefined &&
    entry.path === SHARED_CONTAINER_DEFINITION_DOCUMENT_PATH &&
    entry.mode === 'read'
    ? entry
    : null;
}

/**
 * Walks every string value and object key of decoded JSON without
 * recursion, so a deeply nested document can't exhaust the stack. Returns the
 * first finding the visitor reports.
 */
function firstJsonFinding<Finding>(
  root: unknown,
  visit: (text: string, kind: 'key' | 'value', path: string) => Finding | null,
): Finding | null {
  const stack: { value: unknown; path: string }[] = [{ value: root, path: '' }];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const { value, path } = next;
    if (typeof value === 'string') {
      const finding = visit(value, 'value', path);
      if (finding !== null) return finding;
    } else if (Array.isArray(value)) {
      value.forEach((item: unknown, index) =>
        stack.push({ value: item, path: `${path}[${index}]` }),
      );
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        const finding = visit(key, 'key', path);
        if (finding !== null) return finding;
        const segment = credentialPathSegment(key);
        stack.push({
          value: item,
          path: path === '' ? segment : `${path}.${segment}`,
        });
      }
    }
  }
  return null;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

/**
 * Whether a package entry looks like it holds a secret, read as the desktop
 * package analysis reads it before it shares a package, or null (CAN-7226).
 *
 * A definition document (packageDefinitionDocumentEntry) is checked the way
 * the desktop checks one it is sharing: parseSharedContainerDefinitionDocument
 * with placeholder contents checked, whose stricter profile runs on every
 * field it accepts. It accepts no unknown fields and only canonical bytes, so
 * no string escapes it; object keys, which it does not check, are checked for
 * secret material here. A document that does not parse or validate is
 * checked as raw bytes and, when it is JSON, on every decoded string and key,
 * so neither escapes nor unknown fields can hide a value. Every other entry is
 * a member file, read with findPackageFileCredentialRule. All of that runs on
 * the bytes as written first, and only then on the text with each escape
 * written as text read as a space (CAN-7627).
 */
export function findPackageEntryCredential(
  entry: {
    readonly definitionDocument: boolean;
    readonly bytes: Uint8Array;
  },
  options: EscapeReadingOptions = {},
): PackageEntryCredentialFinding | null {
  const text = decodePackageFile(entry.bytes);
  return asWrittenThenSpaced(options, (read) => {
    const reading = read(text);
    return packageEntryFinding(
      entry.definitionDocument,
      reading === text ? entry.bytes : new TextEncoder().encode(reading),
    );
  });
}

function packageEntryFinding(
  definitionDocument: boolean,
  bytes: Uint8Array,
): PackageEntryCredentialFinding | null {
  if (definitionDocument) {
    const parsed = parseSharedContainerDefinitionDocument(bytes, {
      placeholderContents: 'checked',
      escapes: 'as-written',
    });
    if (parsed.ok) {
      return firstJsonFinding(parsed.value, (text, kind, path) =>
        kind === 'key' &&
        findSecretMaterialRule(text, ESCAPES_AS_WRITTEN) !== null
          ? { rule: DEFINITION_CREDENTIAL_RULE, field: path || 'document' }
          : null,
      );
    }
    for (const error of parsed.errors) {
      const field = sharedContainerCredentialErrorField(error);
      const nextStep = sharedContainerCredentialErrorNextStep(error);
      if (field !== null && nextStep !== null)
        return { rule: DEFINITION_CREDENTIAL_RULE, field, nextStep };
    }
  }
  const raw = findPackageFileCredentialRule(bytes, ESCAPES_AS_WRITTEN);
  if (raw !== null) return { rule: raw };
  if (!definitionDocument) return null;
  const decoded = parseJson(decodePackageFile(bytes));
  if (!decoded.ok) return null;
  return firstJsonFinding(decoded.value, (text, kind) => {
    const rule =
      kind === 'key'
        ? findSecretMaterialRule(text, ESCAPES_AS_WRITTEN)
        : findPackageTextCredentialRule(text, ESCAPES_AS_WRITTEN);
    return rule === null ? null : { rule };
  });
}
