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
  findSecretMaterialRule,
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
 * A skill name or file path as a refusal may show it. The name comes from the
 * skill's own text, so one that itself looks like a secret is never echoed.
 */
function displayableFindingLabel(label: string, redacted: string): string {
  return findSharedTextCredentialRule(label) === null ? label : redacted;
}

/**
 * The first file of a skill whose text looks like it holds a secret, or
 * null. Pure: no I/O, network or logging, so desktop and the hosted service
 * run the same check (CAN-7226). The skill's name is shared too, so a name
 * that looks like a secret is refused even when no file is; it reads as
 * [redacted name], and a path that looks like one as [redacted path].
 */
export function scanSharedSkillForSecrets(skill: {
  readonly skillName: string;
  readonly files: readonly SharedSkillFile[];
}): SharedSkillSecretFinding | null {
  const nameRule = findSharedTextCredentialRule(skill.skillName);
  const named =
    nameRule === null
      ? { skillName: skill.skillName }
      : { skillName: '[redacted name]', nameRule };
  for (const file of skill.files) {
    const rule = findSharedTextCredentialRule(file.text);
    if (rule !== null)
      return {
        ...named,
        file: displayableFindingLabel(file.path, '[redacted path]'),
        rule,
      };
  }
  return nameRule === null
    ? null
    : { ...named, file: SKILL_NAME_FINDING_FILE, rule: nameRule };
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
  // A placeholder in an authorization header is still refused (CAN-7314),
  // so that rule's advice is to drop the value rather than swap it.
  const nextStep =
    finding.rule === 'auth_header'
      ? 'Remove the header line, or say which header to send without writing its value'
      : 'Remove it, or replace it with a placeholder such as ${{ secrets.NAME }}';
  return `The skill "${finding.skillName}" looks like it contains a secret (${sharedSkillSecretRuleLabel(finding.rule)} in ${finding.file}). ${nextStep}, then share again.`;
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

function stripControlCharacters(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code > 0x1f && code !== 0x7f) result += character;
  }
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
      findSecretMaterialRule(inner) === null
        ? '""'
        : text.slice(open, close + 2);
    position = close + 2;
  }
  return result + text.slice(position);
}

/**
 * The secret rule a package file's text trips, read as the desktop package
 * analysis reads it, or null. The desktop analysis before an upload
 * and the hosted check at commit both call this, so a package the desktop
 * lets a person share is never refused on upload. Pure (CAN-7226).
 */
export function findPackageTextCredentialRule(
  text: string,
): SecretMaterialRule | null {
  return findSecretMaterialRule(
    blankPlainPipelineExpressions(stripControlCharacters(text)).replace(
      PACKAGE_PLACEHOLDER_ASSIGNMENT_PATTERN,
      neutralizePlaceholderAssignment,
    ),
  );
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
): SecretMaterialRule | null {
  return findPackageTextCredentialRule(decodePackageFile(bytes));
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
 * a member file, read with findPackageFileCredentialRule.
 */
export function findPackageEntryCredential(entry: {
  readonly definitionDocument: boolean;
  readonly bytes: Uint8Array;
}): PackageEntryCredentialFinding | null {
  if (entry.definitionDocument) {
    const parsed = parseSharedContainerDefinitionDocument(entry.bytes, {
      placeholderContents: 'checked',
    });
    if (parsed.ok) {
      return firstJsonFinding(parsed.value, (text, kind, path) =>
        kind === 'key' && findSecretMaterialRule(text) !== null
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
  const raw = findPackageFileCredentialRule(entry.bytes);
  if (raw !== null) return { rule: raw };
  if (!entry.definitionDocument) return null;
  const decoded = parseJson(decodePackageFile(entry.bytes));
  if (!decoded.ok) return null;
  return firstJsonFinding(decoded.value, (text, kind) => {
    const rule =
      kind === 'key'
        ? findSecretMaterialRule(text)
        : findPackageTextCredentialRule(text);
    return rule === null ? null : { rule };
  });
}
