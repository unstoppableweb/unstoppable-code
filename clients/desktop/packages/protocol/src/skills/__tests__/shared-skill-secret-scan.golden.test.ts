/**
 * CAN-7226: one secret check for shared skill text, run by desktop and the
 * hosted service alike. It names the rule that matched, never the match; it
 * ignores named placeholders; it does no I/O or logging; and every pattern
 * stays linear on adversarial input at the largest file a package may carry.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  containsSecretMaterial,
  displayableLabel,
  ESCAPES_AS_WRITTEN,
  findSecretMaterialRule,
  labelSecretRule,
  type SecretMaterialRule,
} from '../../capability-files';
import { PIPELINE_PACKAGE_MAX_FILE_BYTES } from '../../pipelines/package';
import {
  credentialPathSegment,
  encodeSharedContainerDefinitionDocument,
  findSharedTextCredentialRule,
  parseSharedContainerDefinitionDocument,
  sharedTextLabelCheck,
  validateSharedContainerDefinitionDocument,
} from '../../shared-containers/capability-definitions';
import { SECRET_ASSIGNMENT_KEYS_SOURCE } from '../../secret-redaction';
import {
  DEFINITION_CREDENTIAL_RULE,
  SHARED_SKILL_SECRET_DETECTED_CODE,
  escapeDecodedCopy,
  findPackageEntryCredential,
  findPackageFileCredentialRule,
  findSharedMemberFileCredentialRule,
  packageDefinitionDocumentEntry,
  findPackageTextCredentialRule,
  PACKAGE_PLACEHOLDER_ASSIGNMENT_PATTERN,
  scanSharedSkillForSecrets,
  collectionSkillSecretMessage,
  packagedSkillSecretMessage,
  pluginSecretMessage,
  sharedSkillSecretMessage,
  templateInstallSkillSecretMessage,
} from '../secret-scan';

// Built at runtime so no secret-shaped literal is committed.
const repeat = (text: string, count: number): string => text.repeat(count);
const SAMPLES: readonly (readonly [SecretMaterialRule, string])[] = [
  ['private_key', `-----BEGIN RSA ${'PRIVATE'} KEY-----`],
  ['private_key', `-----BEGIN PGP ${'PRIVATE'} KEY BLOCK-----`],
  ['private_key', `---- BEGIN SSH2 ENCRYPTED ${'PRIVATE'} KEY ----`],
  ['private_key', `PuTTY-User-${'Key'}-File-2: ssh-rsa`],
  ['private_key', `PuTTY-User-${'Key'}-File-3: ssh-ed25519`],
  ['jwt', `ey${'J'}${repeat('a', 12)}.${repeat('b', 12)}.${repeat('c', 12)}`],
  ['github_token', `github_${'pat'}_${repeat('A', 24)}`],
  ['github_token', `gh${'p'}_${repeat('B', 30)}`],
  ['slack_token', `xox${'b'}-${repeat('1', 12)}`],
  ['npm_token', `np${'m'}_${repeat('n', 36)}`],
  ['aws_access_key', `AKI${'A'}${repeat('Z', 16)}`],
  ['api_key_prefix', `s${'k'}-${repeat('k', 20)}`],
  ['auth_header', `Authori${'zation'}: Basic abc`],
  ['bearer_token', `Bear${'er'} ${repeat('t', 16)}`],
  ['credential_assignment', `pass${'word'}: hunter-two`],
  ['credential_assignment', `api_${'key'}=value-one`],
];

describe('shared skill secret scan (CAN-7226)', () => {
  it.each(SAMPLES)(
    'names the rule %s and keeps the boolean check',
    (rule, text) => {
      expect(findSecretMaterialRule(`before ${text} after`)).toBe(rule);
      expect(containsSecretMaterial(`before ${text} after`)).toBe(true);
    },
  );

  it('finds nothing in plain skill text', () => {
    const text =
      '---\nname: notes\ndescription: Take notes.\n---\nWrite tidy notes.\n';
    expect(findSecretMaterialRule(text)).toBeNull();
    expect(containsSecretMaterial(text)).toBe(false);
    expect(containsSecretMaterial('')).toBe(false);
  });

  // npm's own variables and near misses are not an npm token, which is
  // `npm_` and exactly 36 letters and digits, starting a word.
  it.each([
    'npm_config_registry=https://registry.npmjs.org',
    'echo $npm_package_version',
    'Set npm_config_cache before you run npm ci.',
    `np${'m'}_${repeat('n', 35)}`,
    `np${'m'}_${repeat('n', 37)}`,
    `my_np${'m'}_${repeat('n', 36)}`,
  ])('finds no npm token in the ordinary text %j', (text) => {
    expect(findSecretMaterialRule(text)).toBeNull();
    expect(findSharedTextCredentialRule(text)).toBeNull();
    expect(findPackageTextCredentialRule(text)).toBeNull();
  });

  it('refuses a skill holding a bare npm token, naming the rule and never the token', () => {
    const sentinel = `np${'m'}_${repeat('P', 36)}`;
    const finding = scanSharedSkillForSecrets({
      skillName: 'publish-helper',
      files: [
        {
          path: 'SKILL.md',
          text: '---\nname: publish-helper\n---\nPublish.\n',
        },
        { path: 'notes/publish.md', text: `Publish with ${sentinel}.` },
      ],
    });
    expect(finding).toEqual({
      skillName: 'publish-helper',
      file: 'notes/publish.md',
      rule: 'npm_token',
    });
    if (finding === null) throw new Error('expected a finding');
    const message = sharedSkillSecretMessage(finding);
    expect(message).toContain('(an npm token in notes/publish.md)');
    expect(message).not.toContain(sentinel);
  });

  it('ignores named placeholders but still reports env and URL credentials', () => {
    expect(
      findSharedTextCredentialRule('api_key: ${{ secrets.API_KEY }}'),
    ).toBeNull();
    expect(findSharedTextCredentialRule('token: <your token>')).toBeNull();
    expect(
      findSharedTextCredentialRule(`NPM_TOKEN=npm_${repeat('x', 8)}`),
    ).toBe('env_assignment');
    expect(findSharedTextCredentialRule('postgres://admin:pw@db/app')).toBe(
      'url_credentials',
    );
  });

  it('never echoes a skill name or file path that itself looks like a secret', () => {
    const sentinel = `gh${'p'}_${repeat('N', 30)}`;
    const NAME_MESSAGE =
      "This skill's name looks like it contains a secret (a GitHub token). Rename the skill, then share again.";
    const finding = scanSharedSkillForSecrets({
      skillName: `deploy ${sentinel}`,
      files: [{ path: `notes/${sentinel}.md`, text: `Use ${sentinel}.` }],
    });
    expect(finding).toEqual({
      skillName: '[redacted name]',
      file: '[redacted path]',
      rule: 'github_token',
      nameRule: 'github_token',
    });
    if (finding === null) throw new Error('expected a finding');
    // The person-facing message is its own sentence, never the placeholder.
    expect(sharedSkillSecretMessage(finding)).toBe(NAME_MESSAGE);

    // The name is shared too: a secret only in the name is still refused.
    const nameOnly = scanSharedSkillForSecrets({
      skillName: `deploy ${sentinel}`,
      files: [{ path: 'SKILL.md', text: 'Deploy.' }],
    });
    expect(nameOnly).toEqual({
      skillName: '[redacted name]',
      file: '[skill name]',
      rule: 'github_token',
      nameRule: 'github_token',
    });
    if (nameOnly === null) throw new Error('expected a finding');
    expect(sharedSkillSecretMessage(nameOnly)).toBe(NAME_MESSAGE);
    expect(JSON.stringify([finding, nameOnly])).not.toContain(sentinel);
  });

  it.each(['api-key-rotation', 'github-token-helper', 'password-reset-flow'])(
    'lets the ordinary descriptive name %s through, checked by the same detectors as file text',
    (skillName) => {
      expect(findSharedTextCredentialRule(skillName)).toBeNull();
      expect(
        scanSharedSkillForSecrets({
          skillName,
          files: [{ path: 'SKILL.md', text: `# ${skillName}\nRotate keys.\n` }],
        }),
      ).toBeNull();
      const finding = scanSharedSkillForSecrets({
        skillName,
        files: [{ path: 'SKILL.md', text: `Use gh${'p'}_${repeat('D', 30)}.` }],
      });
      expect(finding).toEqual({
        skillName,
        file: 'SKILL.md',
        rule: 'github_token',
      });
    },
  );

  it('words a template install refusal for the installer, never showing a secret-looking name', () => {
    const sentinel = `gh${'p'}_${repeat('T', 30)}`;
    const named = scanSharedSkillForSecrets({
      skillName: 'deploy-helper',
      files: [{ path: 'SKILL.md', text: `Use ${sentinel}.` }],
    });
    const secretName = scanSharedSkillForSecrets({
      skillName: `deploy ${sentinel}`,
      files: [{ path: 'SKILL.md', text: 'Deploy.' }],
    });
    if (named === null || secretName === null)
      throw new Error('expected findings');
    expect(templateInstallSkillSecretMessage(named)).toBe(
      'Couldn\'t install this project template because its skill "deploy-helper" looks like it contains a secret (a GitHub token in SKILL.md). Ask the person who shared it to remove it, then try again.',
    );
    expect(templateInstallSkillSecretMessage(secretName)).toBe(
      "Couldn't install this project template because one of its skills has a name that looks like it contains a secret (a GitHub token). Ask the person who shared it to rename it, then try again.",
    );
  });

  it('words a collection refusal for a secret-looking name as one of its skills', () => {
    const sentinel = `gh${'p'}_${repeat('C', 30)}`;
    const named = scanSharedSkillForSecrets({
      skillName: 'deploy-helper',
      files: [{ path: 'SKILL.md', text: `Use ${sentinel}.` }],
    });
    const secretName = scanSharedSkillForSecrets({
      skillName: `deploy ${sentinel}`,
      files: [{ path: 'SKILL.md', text: 'Deploy.' }],
    });
    if (named === null || secretName === null)
      throw new Error('expected findings');
    expect(collectionSkillSecretMessage(named)).toBe(
      sharedSkillSecretMessage(named),
    );
    expect(collectionSkillSecretMessage(secretName)).toBe(
      "One of this collection's skills has a name that looks like it contains a secret (a GitHub token). Rename it, then share again.",
    );
  });

  it('words a refusal for a skill a package carries without naming it when its name looks like a secret', () => {
    const sentinel = `gh${'p'}_${repeat('P', 30)}`;
    const named = scanSharedSkillForSecrets({
      skillName: 'deploy-helper',
      files: [{ path: 'SKILL.md', text: `Use ${sentinel}.` }],
    });
    const secretName = scanSharedSkillForSecrets({
      skillName: `deploy ${sentinel}`,
      files: [{ path: 'SKILL.md', text: 'Deploy.' }],
    });
    if (named === null || secretName === null)
      throw new Error('expected findings');
    expect(packagedSkillSecretMessage(named)).toBe(
      sharedSkillSecretMessage(named),
    );
    expect(packagedSkillSecretMessage(secretName)).toBe(
      'A skill it uses has a name that looks like it contains a secret (a GitHub token). Rename that skill, then share again.',
    );
    expect(packagedSkillSecretMessage(secretName)).not.toContain(sentinel);
  });

  it('reports the first file that trips, by skill, file and rule only', () => {
    const sentinel = `gh${'p'}_${repeat('S', 30)}`;
    const finding = scanSharedSkillForSecrets({
      skillName: 'deploy-helper',
      files: [
        { path: 'SKILL.md', text: '---\nname: deploy-helper\n---\nDeploy.\n' },
        { path: 'notes/setup.md', text: `Use ${sentinel} to deploy.` },
      ],
    });
    expect(finding).toEqual({
      skillName: 'deploy-helper',
      file: 'notes/setup.md',
      rule: 'github_token',
    });
    if (finding === null) throw new Error('expected a finding');
    const message = sharedSkillSecretMessage(finding);
    expect(message).toContain('deploy-helper');
    expect(message).toContain('notes/setup.md');
    expect(message).toContain('looks like it contains a secret');
    expect(message).not.toContain(sentinel);
    expect(message.toLowerCase()).not.toContain('secret-free');
    expect(SHARED_SKILL_SECRET_DETECTED_CODE).toBe(
      'collection_skill_secret_detected',
    );
  });

  // A placeholder in an authorization header is still refused (CAN-7314), so
  // that refusal tells the person to drop the value, not to swap it.
  it('tells the person to remove an authorization header value, not to use a placeholder', () => {
    const text = `Send Authori${'zation'}: Bearer \${{ secrets.TOKEN }} with each call.`;
    const finding = scanSharedSkillForSecrets({
      skillName: 'api-helper',
      files: [{ path: 'SKILL.md', text }],
    });
    expect(finding).toEqual({
      skillName: 'api-helper',
      file: 'SKILL.md',
      rule: 'auth_header',
    });
    if (finding === null) throw new Error('expected a finding');
    const message = sharedSkillSecretMessage(finding);
    expect(message).toContain('Remove the header line');
    expect(message).not.toContain('placeholder');
    expect(message).not.toContain('—');
    const other = sharedSkillSecretMessage({
      skillName: 'api-helper',
      file: 'SKILL.md',
      rule: 'github_token',
    });
    expect(other).toContain('replace it with a placeholder');
  });

  it('is pure: no logging, network or timers while scanning', () => {
    const spies = [
      jest.spyOn(console, 'log'),
      jest.spyOn(console, 'info'),
      jest.spyOn(console, 'warn'),
      jest.spyOn(console, 'error'),
      jest.spyOn(console, 'debug'),
    ];
    const fetchSpy = jest.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy;
    try {
      scanSharedSkillForSecrets({
        skillName: 'x',
        files: [{ path: 'SKILL.md', text: `token: ${repeat('v', 10)}` }],
      });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      for (const spy of spies) spy.mockRestore();
    }
  });
});

// develop's desktop package check before CAN-7226 moved it here
// (package-analyzer.ts containsPipelinePackageSecretMaterial, with its
// callers' control-character strip), kept verbatim as the reference the
// shared check must agree with.
const REFERENCE_EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
const REFERENCE_PLACEHOLDER = new RegExp(
  `\\b(?:${SECRET_ASSIGNMENT_KEYS_SOURCE})\\s*(?:=|:)\\s*(?:<[^>\\r\\n]+>|\\{\\{?[^}\\r\\n]+\\}?\\}|\\$[A-Za-z_][A-Za-z0-9_]*|\\$\\{[A-Za-z_][A-Za-z0-9_]*\\})`,
  'gi',
);
const isControl = (character: string): boolean => {
  const code = character.charCodeAt(0);
  return code <= 0x1f || code === 0x7f;
};
const stripControls = (text: string): string =>
  Array.from(text, (character) => (isControl(character) ? '' : character)).join(
    '',
  );
// CAN-7626's second reading: line breaks and tabs stay, and every other
// control character becomes a space.
const keepLineBoundaries = (text: string): string =>
  Array.from(text, (character) =>
    isControl(character) && !'\t\n\r'.includes(character) ? ' ' : character,
  ).join('');
// develop's pattern list, read only as written: the reference never reads
// escapes, so CAN-7627's spaced reading shows up as a change against it.
const developMaterial = (text: string): boolean =>
  findSecretMaterialRule(text, ESCAPES_AS_WRITTEN) !== null;
function referenceWithoutExpressions(
  text: string,
  read: (text: string) => string = stripControls,
): string {
  return read(text).replace(
    REFERENCE_EXPRESSION,
    (expression, inner: string) => (developMaterial(inner) ? expression : '""'),
  );
}
function referencePackageCheck(text: string): boolean {
  return developMaterial(
    referenceWithoutExpressions(text).replace(
      REFERENCE_PLACEHOLDER,
      'placeholder=example',
    ),
  );
}
// develop's check with the ONE intended change of SWAN's R2: a placeholder
// whose own contents trip SECRET_RULES is not neutralized, so the real value
// inside it is scanned. Everything else is develop's, unbounded patterns
// included, so the bound (pinned separately) never shows up here.
function r2Check(
  text: string,
  read: (text: string) => string = stripControls,
): boolean {
  return developMaterial(
    referenceWithoutExpressions(text, read).replace(
      REFERENCE_PLACEHOLDER,
      (assignment) =>
        developMaterial(assignment.slice(assignment.search(/[=:]/) + 1))
          ? assignment
          : 'placeholder=example',
    ),
  );
}
// develop plus R2 plus CAN-7626: develop's stripped reading, or a reading
// that keeps line boundaries. Either one tripping refuses, so this only
// ever refuses more than develop plus R2.
function asWrittenPackageCheck(text: string): boolean {
  return r2Check(text) || r2Check(text, keepLineBoundaries);
}
// CAN-7627's spaced reading, written out here: each escape written as text
// reads as a space.
const REFERENCE_ESCAPES =
  /\\(?:[nrtbfv0aeNLP_]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|x[0-9A-Fa-f]{2})|%(?:u[0-9A-Fa-f]{4}|[0-9A-Fa-f]{2})/g;
const spacedReading = (text: string): string =>
  text.replace(REFERENCE_ESCAPES, ' ');
// The whole check again on the spaced reading, only when the text as
// written trips nothing (CAN-7627), so this only ever refuses more.
function intendedPackageCheck(text: string): boolean {
  if (asWrittenPackageCheck(text)) return true;
  const spaced = spacedReading(text);
  return spaced !== text && asWrittenPackageCheck(spaced);
}
// The three intended changes against develop, by which reading explains them.
const placeholderValueChange = (text: string): boolean =>
  r2Check(text) !== referencePackageCheck(text);
const lineBoundaryChange = (text: string): boolean =>
  !r2Check(text) && r2Check(text, keepLineBoundaries);
const escapeReadingChange = (text: string): boolean =>
  !asWrittenPackageCheck(text) && intendedPackageCheck(text);

describe('package text check matches the desktop analysis (CAN-7226)', () => {
  const token = `gh${'p'}_${'R'.repeat(30)}`;
  const PLACEHOLDERS = [
    '<your key>',
    '<a<b>',
    '{name}',
    '{a{b}',
    '{{ name }}',
    '{{a{b}}',
    '$NAME',
    '${NAME}',
  ];
  const KEYS = ['token', 'password', 'api_key', 'secret', 'client_secret'];
  const CORPUS: readonly string[] = [
    '',
    'steps:\n  - run: deploy\n',
    '---\nname: notes\ndescription: Take notes.\n---\nWrite tidy notes.\n',
    // Every rule: bare, inside an expression, and after a placeholder.
    ...SAMPLES.flatMap(([, sample]) => [
      sample,
      `run: echo ${sample}\n`,
      `\${{ ${sample} }}`,
      `token: \${{ secrets.NAME }} ${sample}`,
      `api_key: <your key>\n${sample}`,
    ]),
    // Placeholders of every form, for every key, with both separators.
    ...KEYS.flatMap((key) =>
      PLACEHOLDERS.flatMap((value) => [
        `${key}: ${value}`,
        `${key}=${value}`,
        `${key} = ${value} trailing`,
      ]),
    ),
    'token: ${{ inputs.token }}\n',
    `token: \${{ secrets.${token} }}\n`,
    '${{ password: hunter-two }}',
    '${{ a }} ${{ b ${{ c }} }} ${{ unclosed',
    '${{}}}',
    `export API_KEY=$1\nexport TOKEN=${token}\n`,
    `x\u0001y${token}`,
    'password: <a>b>',
    'password: {{abc}x}}',
    'token: <unclosed\npassword: hunter-two',
    // A real value inside placeholder brackets (R2): every rule's sample.
    ...SAMPLES.flatMap(([, sample]) => [
      `token: <${sample}>`,
      `token: {{${sample}}}`,
      `token: \${{ ${sample} }}`,
      `api_key=<${sample}>`,
    ]),
    // Descriptive placeholders still pass.
    'token: <YOUR_API_KEY>',
    'token: {{ secrets.NAME }}',
    'token: ${{ secrets.TOKEN }}',
    // Every rule's sample at a line start, after a line ending in a word
    // character (CAN-7626), and placeholders a line break splits.
    ...SAMPLES.flatMap(([, sample]) => [
      `echo done\n${sample}`,
      `echo done\r\n${sample}`,
      `echo done\t${sample}`,
      `echo done\u0001${sample}`,
    ]),
    'token: <your\nkey>',
    'token: {{ your\nkey }}',
    'token: ${{ secrets.\nNAME }}',
    // Every rule's sample after an escape written as text (CAN-7627), and an
    // escaped key whose value is a placeholder or a printf format.
    ...SAMPLES.flatMap(([, sample]) => [
      `echo done\\n${sample}`,
      `a: "done\\u000a${sample}"`,
      `done%0A${sample}`,
    ]),
    'Run with NPM\\u005fTOKEN=${LITERAL_VALUE} set.',
    "printf 'username=%s\\npassword=%s\\n'",
  ];
  it.each(CORPUS)(
    'agrees with develop plus R2, CAN-7626 and CAN-7627 on %j',
    (text) => {
      expect(findPackageTextCredentialRule(text) !== null).toBe(
        intendedPackageCheck(text),
      );
    },
  );

  it('differs from develop on the corpus only where a placeholder holds a real value, a secret starts a line, a line break splits a placeholder, or an escape written as text hides a boundary', () => {
    const changed = CORPUS.filter(
      (text) =>
        (findPackageTextCredentialRule(text) !== null) !==
        referencePackageCheck(text),
    );
    expect(changed).toEqual(
      CORPUS.filter(
        (text) =>
          placeholderValueChange(text) ||
          lineBoundaryChange(text) ||
          escapeReadingChange(text),
      ),
    );
    expect(CORPUS.filter(escapeReadingChange).length).toBeGreaterThan(0);
    const atLineStart = (text: string): boolean =>
      SAMPLES.some(
        ([, sample]) =>
          text.endsWith(sample) &&
          ['\t', '\n', '\r', '\u0001'].includes(
            text.at(-sample.length - 1) ?? '',
          ),
      );
    const lineBoundaries = CORPUS.filter(lineBoundaryChange);
    // Three named categories: a placeholder holding a real value, a secret
    // at the start of a line, and a bracketed placeholder a line break
    // splits, which the shared check and the raw text check refuse too.
    expect(CORPUS.filter(placeholderValueChange).length).toBeGreaterThan(0);
    expect(lineBoundaries.filter(atLineStart).length).toBeGreaterThan(0);
    const splitPlaceholders = lineBoundaries.filter(
      (text) => !atLineStart(text),
    );
    expect(splitPlaceholders).toEqual([
      'token: <your\nkey>',
      'token: {{ your\nkey }}',
    ]);
    for (const text of splitPlaceholders) {
      expect(findSharedTextCredentialRule(text)).not.toBeNull();
      expect(findSecretMaterialRule(text)).not.toBeNull();
    }
    // Each change refuses more: develop let it through, the check refuses it.
    for (const text of changed) {
      expect(referencePackageCheck(text)).toBe(false);
      expect(findPackageTextCredentialRule(text)).not.toBeNull();
    }
  });

  const MIX_FRAGMENTS = [
    ...KEYS,
    ...PLACEHOLDERS,
    ...SAMPLES.map(([, sample]) => sample),
    ': ',
    '=',
    ' ',
    '<',
    '>',
    '{',
    '}',
    '{{',
    '}}',
    '${{',
    '$',
    '\n',
    '"',
    'value-one',
    'secrets.NAME',
    'export ',
  ];
  // Each mix's verdict against develop plus R2 and CAN-7626, and any change
  // against develop that neither intended change explains.
  function checkMixes(
    fragments: readonly string[],
    next: (bound: number) => number,
  ): { disagreements: string[]; unexplained: string[]; changed: number } {
    const disagreements: string[] = [];
    const unexplained: string[] = [];
    let changed = 0;
    for (let index = 0; index < 20_000; index += 1) {
      let text = '';
      const parts = 1 + next(8);
      for (let part = 0; part < parts; part += 1)
        text += fragments[next(fragments.length)];
      const verdict = findPackageTextCredentialRule(text) !== null;
      if (verdict !== intendedPackageCheck(text)) disagreements.push(text);
      if (verdict !== referencePackageCheck(text)) changed += 1;
      // A change against develop must be a placeholder holding a real value,
      // a reading that keeps line boundaries tripping, or the spaced reading
      // of an escape written as text tripping.
      if (
        verdict !== referencePackageCheck(text) &&
        !placeholderValueChange(text) &&
        !lineBoundaryChange(text) &&
        !escapeReadingChange(text)
      )
        unexplained.push(text);
    }
    return { disagreements, unexplained, changed };
  }

  it('agrees on 20,000 generated mixes of keys, placeholders, expressions and secrets', () => {
    let seed = 7226;
    const next = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % bound;
    };
    const { disagreements, unexplained } = checkMixes(MIX_FRAGMENTS, next);
    expect(disagreements).toEqual([]);
    expect(unexplained).toEqual([]);
  });

  // The generator above draws from the low bits, which never put a fragment
  // ending in a word character before a line break. This one draws from the
  // high bits and adds a carriage return, a tab and a control character.
  it('agrees on 20,000 generated mixes across line boundaries', () => {
    let seed = 7626;
    const next = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return Math.floor(seed / 65536) % bound;
    };
    const { disagreements, unexplained, changed } = checkMixes(
      [...MIX_FRAGMENTS, '\r\n', '\t', '\u0001'],
      next,
    );
    expect(disagreements).toEqual([]);
    expect(unexplained).toEqual([]);
    expect(changed).toBeGreaterThan(0);
  });

  const ESCAPE_FRAGMENTS = ['\\n', '\\t', '\\0', '\\N', '%0A', '\\u000a'];
  function nextFromSeed(start: number): (bound: number) => number {
    let seed = start;
    return (bound) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return Math.floor(seed / 65536) % bound;
    };
  }

  it('agrees on 20,000 generated mixes across escapes written as text (CAN-7627)', () => {
    const { disagreements, unexplained, changed } = checkMixes(
      [...MIX_FRAGMENTS, ...ESCAPE_FRAGMENTS],
      nextFromSeed(7627),
    );
    expect(disagreements).toEqual([]);
    expect(unexplained).toEqual([]);
    expect(changed).toBeGreaterThan(0);
  });

  // Every check returns develop's result whenever develop's finds anything:
  // the spaced reading only runs when the text as written trips nothing
  // (CAN-7627). Over the corpus and a generated mix set across escapes.
  it("keeps every check's result as written whenever that finds anything (CAN-7627)", () => {
    const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
    const CHECKS: readonly (readonly [
      string,
      (text: string, options?: typeof ESCAPES_AS_WRITTEN) => unknown,
    ])[] = [
      [
        'findSecretMaterialRule',
        (text, options) => findSecretMaterialRule(text, options),
      ],
      [
        'findSharedTextCredentialRule',
        (text, options) => findSharedTextCredentialRule(text, options),
      ],
      [
        'findPackageTextCredentialRule',
        (text, options) => findPackageTextCredentialRule(text, options),
      ],
      [
        'findPackageFileCredentialRule',
        (text, options) => findPackageFileCredentialRule(bytes(text), options),
      ],
      [
        'findSharedMemberFileCredentialRule',
        (text, options) =>
          findSharedMemberFileCredentialRule(bytes(text), options),
      ],
      [
        'findPackageEntryCredential (member file)',
        (text, options) =>
          findPackageEntryCredential(
            { definitionDocument: false, bytes: bytes(text) },
            options,
          ),
      ],
      [
        'findPackageEntryCredential (definition document)',
        (text, options) =>
          findPackageEntryCredential(
            { definitionDocument: true, bytes: bytes(text) },
            options,
          ),
      ],
      [
        'scanSharedSkillForSecrets',
        (text, options) =>
          scanSharedSkillForSecrets(
            { skillName: 'notes', files: [{ path: 'SKILL.md', text }] },
            options,
          ),
      ],
    ];
    const next = nextFromSeed(76270);
    const mixes = Array.from({ length: 2_000 }, () => {
      let text = '';
      const parts = 1 + next(8);
      for (let part = 0; part < parts; part += 1) {
        const fragments = [...MIX_FRAGMENTS, ...ESCAPE_FRAGMENTS];
        text += fragments[next(fragments.length)];
      }
      return text;
    });
    const differences: string[] = [];
    for (const text of [...CORPUS, ...mixes])
      for (const [name, check] of CHECKS) {
        const asWritten = check(text, ESCAPES_AS_WRITTEN);
        if (asWritten !== null && !isDeepStrictEqual(check(text), asWritten))
          differences.push(`${name}: ${JSON.stringify(text)}`);
      }
    expect(differences).toEqual([]);
  });

  // A file's bytes, as develop's desktop analysis read them before CAN-7226:
  // lenient UTF-8, then the text check above. The desktop analysis and the
  // hosted commit now both call findPackageFileCredentialRule, so this one
  // comparison is also desktop against hosted.
  const developFileCheck = (bytes: Uint8Array): boolean =>
    intendedPackageCheck(
      new TextDecoder('utf-8', { fatal: false }).decode(bytes),
    );
  const utf8 = new TextEncoder();
  const asFileBytes = (text: string): readonly Uint8Array[] => {
    const body = utf8.encode(text);
    return [
      body,
      // Latin-1 and other non-UTF-8 bytes around the text.
      new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20, ...body, 0xff, 0xfe]),
      // A binary blob: NUL and control bytes around the text.
      new Uint8Array([0, 1, 2, 0x7f, ...body, 0, 0x80, 0]),
    ];
  };
  it("reads a file's bytes as develop's desktop analysis did (plus R2 and CAN-7626), on every corpus text as UTF-8, Latin-1 and binary", () => {
    const disagreements: string[] = [];
    for (const text of CORPUS) {
      for (const bytes of asFileBytes(text)) {
        if (
          (findPackageFileCredentialRule(bytes) !== null) !==
          developFileCheck(bytes)
        )
          disagreements.push(text);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('refuses a non-UTF-8 text file with a secret and a binary blob with an ASCII key, and passes clean ones', () => {
    const [, latin1Secret, binarySecret] = asFileBytes(`use ${token}`);
    const [, latin1Clean, binaryClean] = asFileBytes('plain notes');
    expect(findPackageFileCredentialRule(latin1Secret)).toBe('github_token');
    expect(findPackageFileCredentialRule(binarySecret)).toBe('github_token');
    expect(findPackageFileCredentialRule(latin1Clean)).toBeNull();
    expect(findPackageFileCredentialRule(binaryClean)).toBeNull();
    expect(
      findPackageFileCredentialRule(new Uint8Array([0, 1, 2, 255, 0])),
    ).toBeNull();
  });

  // The one verdict change: a bracketed placeholder now holds at most 256
  // characters, so a longer one is read as a value. That only refuses more.
  it.each([
    ['<', '>'],
    ['{', '}'],
    ['{{', '}}'],
  ])(
    'reads a %s placeholder over 256 characters as a value, and one of 256 as a placeholder',
    (open, close) => {
      const long = `token: ${open}${'v'.repeat(257)}${close}`;
      expect(referencePackageCheck(long)).toBe(false);
      expect(findPackageTextCredentialRule(long)).toBe('credential_assignment');
      const bounded = `token: ${open}${'v'.repeat(256)}${close}`;
      expect(referencePackageCheck(bounded)).toBe(false);
      expect(findPackageTextCredentialRule(bounded)).toBeNull();
    },
  );

  // Past the bound the check fails closed: the over-long placeholder is not
  // neutralized, so the text inside it is still scanned and a secret there
  // is reported by its own rule.
  it.each([
    ['<', '>'],
    ['{', '}'],
    ['{{', '}}'],
  ])(
    'still scans a secret inside a %s placeholder over 256 characters',
    (open, close) => {
      const padded = `token: ${open}${token}${'v'.repeat(257 - token.length)}${close}`;
      expect(referencePackageCheck(padded)).toBe(false);
      expect(findPackageTextCredentialRule(padded)).toBe('github_token');
    },
  );

  // Where develop's check was slow: runs of unclosed placeholders and
  // expressions. At 32 KB it still answers, so both must agree.
  const fillTo = (unit: string, size: number): string =>
    unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const SLOW_FOR_DEVELOP = [
    ['unclosed angle placeholders', 'token: <'],
    ['unclosed brace placeholders', 'token: {{'],
    ['unclosed single braces', 'password={'],
    ['unclosed expressions', '${{ a '],
    ['expression closers', '}}'],
  ] as const;
  it.each(SLOW_FOR_DEVELOP)('agrees on %s at 32 KB', (_label, unit) => {
    const text = fillTo(unit, 32 * 1024);
    expect(findPackageTextCredentialRule(text) !== null).toBe(
      referencePackageCheck(text),
    );
  });
});

// SWAN's R2: SECRET_RULES runs on a placeholder's contents before it is
// neutralized, in both profiles, so a real value written in placeholder
// brackets is still refused. Descriptive placeholders still pass.
describe('a real value inside placeholder brackets is refused in both profiles (CAN-7226)', () => {
  const token = `gh${'p'}_${repeat('T', 30)}`;
  const jwt = `ey${'J'}${repeat('a', 12)}.${repeat('b', 12)}.${repeat('c', 12)}`;
  const WRAPPED = [
    `token: <${token}>`,
    `token: {{${token}}}`,
    `token: {{ ${token} }}`,
    `token: \${{ ${token} }}`,
    `api_key=<${jwt}>`,
    `password: \${{ ${jwt} }}`,
  ];
  it.each(WRAPPED)('refuses %j in the shared and package profiles', (text) => {
    expect(findSharedTextCredentialRule(text)).not.toBeNull();
    expect(findPackageTextCredentialRule(text)).not.toBeNull();
    expect(
      scanSharedSkillForSecrets({
        skillName: 'x',
        files: [{ path: 'SKILL.md', text }],
      }),
    ).not.toBeNull();
  });
  it('refuses a real value in a placeholder used as a URL password', () => {
    expect(
      findSharedTextCredentialRule(`postgres://admin:<${token}>@db/app`),
    ).not.toBeNull();
  });
  it.each([
    'token: <YOUR_API_KEY>',
    'api_key: <your key>',
    'token: {{ secrets.NAME }}',
    'token: ${{ secrets.TOKEN }}',
    'GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
    'password: $PASSWORD',
    'token=${TOKEN}',
  ])('still passes the descriptive placeholder %j in both profiles', (text) => {
    expect(findSharedTextCredentialRule(text)).toBeNull();
    expect(findPackageTextCredentialRule(text)).toBeNull();
  });
});

// A pipeline, automation, Agent or hook definition document is checked the
// way the desktop analysis checks it before upload: the shared-container
// validator (parseSharedContainerDefinitionDocument), whose stricter profile
// runs on each field. Read as raw package-profile text, the canonical JSON's
// escaped quotes would hide a placeholder and refuse what the desktop shared.
describe('package definition documents are checked as the desktop checks them (CAN-7226)', () => {
  const token = `gh${'p'}_${repeat('D', 30)}`;
  const definitionBytes = (value: string): Uint8Array => {
    const validated = validateSharedContainerDefinitionDocument({
      version: 1,
      kind: 'pipeline_definition',
      references: [],
      name: 'deploy',
      yaml: `steps:\n  - run: deploy\n    env:\n      GITHUB_TOKEN: "${value}"\n`,
    });
    if (!validated.ok) throw new Error(validated.errors.join('; '));
    return encodeSharedContainerDefinitionDocument(validated.value);
  };
  const withValue = (placeholder: string, value: string): Uint8Array =>
    new TextEncoder().encode(
      new TextDecoder()
        .decode(definitionBytes(placeholder))
        .replace(placeholder, value),
    );
  const entry = (
    bytes: Uint8Array,
    definitionDocument = true,
  ): { definitionDocument: boolean; bytes: Uint8Array } => ({
    definitionDocument,
    bytes,
  });
  const written = { placeholderContents: 'checked' } as const;

  it.each([
    '${{ secrets.GITHUB_TOKEN }}',
    '$TOKEN',
    '${TOKEN}',
    '<YOUR_TOKEN>',
    '{{ secrets.TOKEN }}',
  ])(
    'passes a definition naming the placeholder %j, as the desktop does',
    (value) => {
      const bytes = definitionBytes(value);
      expect(parseSharedContainerDefinitionDocument(bytes).ok).toBe(true);
      expect(parseSharedContainerDefinitionDocument(bytes, written).ok).toBe(
        true,
      );
      expect(findPackageEntryCredential(entry(bytes))).toBeNull();
    },
  );

  // A token after an escape written as text in a field (CAN-7627): the
  // field check and the raw check both read it as written, so develop's
  // hosted check passed this stored definition; the spaced pass refuses it.
  it('refuses a stored definition whose field holds a token after an escape written as text (CAN-7627)', () => {
    const validated = validateSharedContainerDefinitionDocument({
      version: 1,
      kind: 'pipeline_definition',
      references: [],
      name: 'deploy',
      yaml: 'steps:\n  - run: echo done\n',
    });
    if (!validated.ok) throw new Error(validated.errors.join('; '));
    const bytes = new TextEncoder().encode(
      new TextDecoder()
        .decode(encodeSharedContainerDefinitionDocument(validated.value))
        .replace('echo done', `echo done\\\\n${token}`),
    );
    expect(
      parseSharedContainerDefinitionDocument(bytes, {
        ...written,
        escapes: 'as-written',
      }).ok,
    ).toBe(true);
    expect(parseSharedContainerDefinitionDocument(bytes, written).ok).toBe(
      false,
    );
    expect(findPackageEntryCredential(entry(bytes))).toEqual({
      rule: 'github_token',
    });
  });

  it('refuses a definition holding a literal token, as the desktop does', () => {
    const bytes = withValue('${{ secrets.GITHUB_TOKEN }}', token);
    expect(parseSharedContainerDefinitionDocument(bytes).ok).toBe(false);
    expect(findPackageEntryCredential(entry(bytes))).toMatchObject({
      rule: DEFINITION_CREDENTIAL_RULE,
      field: 'pipeline_definition.yaml',
    });
  });

  // A bare npm token outside any credential field is caught by the token
  // rule alone. Like any literal token, it is refused where the definition
  // is written or shared and where a stored one is read.
  it('refuses a definition holding a bare npm token, never echoing it', () => {
    const npmToken = `np${'m'}_${repeat('D', 36)}`;
    const bytes = new TextEncoder().encode(
      new TextDecoder()
        .decode(definitionBytes('${{ secrets.GITHUB_TOKEN }}'))
        .replace('run: deploy', `run: echo ${npmToken}`),
    );
    expect(new TextDecoder().decode(bytes)).toContain(npmToken);
    expect(parseSharedContainerDefinitionDocument(bytes).ok).toBe(false);
    const result = parseSharedContainerDefinitionDocument(bytes, written);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.errors.join('\n')).toContain('pipeline_definition.yaml');
    expect(result.errors.join('\n')).not.toContain(npmToken);
    expect(findPackageEntryCredential(entry(bytes))).toMatchObject({
      rule: DEFINITION_CREDENTIAL_RULE,
      field: 'pipeline_definition.yaml',
    });
  });

  it('passes a definition that only uses npm and its own variables', () => {
    const bytes = new TextEncoder().encode(
      new TextDecoder()
        .decode(definitionBytes('${{ secrets.GITHUB_TOKEN }}'))
        .replace(
          'run: deploy',
          'run: npm publish --registry $npm_config_registry',
        ),
    );
    expect(parseSharedContainerDefinitionDocument(bytes).ok).toBe(true);
    expect(parseSharedContainerDefinitionDocument(bytes, written).ok).toBe(
      true,
    );
    expect(findPackageEntryCredential(entry(bytes))).toBeNull();
  });

  it('falls back to the file check for a definition that does not validate, so it is never left unscanned', () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ kind: 'pipeline_definition', note: `use ${token}` }),
    );
    expect(parseSharedContainerDefinitionDocument(bytes).ok).toBe(false);
    expect(findPackageEntryCredential(entry(bytes))).toEqual({
      rule: 'github_token',
    });
  });

  it('reads any other entry as a member file', () => {
    const bytes = new TextEncoder().encode(`use ${token}`);
    expect(findPackageEntryCredential(entry(bytes, false))).toEqual({
      rule: 'github_token',
    });
    // Unrouted, a placeholder definition gets the stricter file check.
    expect(
      findPackageEntryCredential(
        entry(definitionBytes('${{ secrets.GITHUB_TOKEN }}'), false),
      ),
    ).not.toBeNull();
  });

  // SWAN 05:16 (1): only the exact entry the desktop routes is routed.
  it("routes only a definition resource's single read-only definition.json, as the desktop locates it", () => {
    const document = { path: 'definition.json', mode: 'read' };
    const single = (
      entries: { path: string; mode: string }[],
    ): { entries: { path: string; mode: string }[] }[] => [{ entries }];
    expect(
      packageDefinitionDocumentEntry({
        kind: 'pipeline_definition',
        trees: single([document]),
      }),
    ).toBe(document);
    for (const resource of [
      { kind: 'standalone_skill', trees: single([document]) },
      {
        kind: 'pipeline_definition',
        trees: single([document, { path: 'notes.md', mode: 'read' }]),
      },
      {
        kind: 'pipeline_definition',
        trees: single([{ path: 'definition.json', mode: 'execute' }]),
      },
      {
        kind: 'pipeline_definition',
        trees: single([{ path: 'nested/definition.json', mode: 'read' }]),
      },
      {
        kind: 'hook_definition',
        trees: [...single([document]), ...single([document])],
      },
    ])
      expect(packageDefinitionDocumentEntry(resource)).toBeNull();
  });

  // SWAN 05:16 (2): nothing in a routed definition goes unscanned.
  it('refuses a literal token in an extra field of a definition, as the desktop does', () => {
    const text = new TextDecoder().decode(
      definitionBytes('${{ secrets.GITHUB_TOKEN }}'),
    );
    const bytes = new TextEncoder().encode(
      `${text.slice(0, -1)},"zz_extra":"${token}"}`,
    );
    // The desktop refuses it: the validator accepts no unknown field.
    expect(parseSharedContainerDefinitionDocument(bytes).ok).toBe(false);
    expect(findPackageEntryCredential(entry(bytes))).toEqual({
      rule: 'github_token',
    });
  });
  it('refuses a token hidden behind JSON escapes, in a known field and in an extra one', () => {
    // A plain definition, so the raw file check has nothing else to flag.
    const plain = validateSharedContainerDefinitionDocument({
      version: 1,
      kind: 'pipeline_definition',
      references: [],
      name: 'deploy',
      yaml: 'steps: []\n',
    });
    if (!plain.ok) throw new Error(plain.errors.join('; '));
    const text = new TextDecoder().decode(
      encodeSharedContainerDefinitionDocument(plain.value),
    );
    const escaped = `\\u0067${token.slice(1)}`;
    // A known field: the validator decodes it and its profile refuses it.
    const inName = new TextEncoder().encode(
      text.replace('"name":"deploy"', `"name":"${escaped}"`),
    );
    expect(findPackageFileCredentialRule(inName)).toBeNull();
    expect(findPackageEntryCredential(entry(inName))).toMatchObject({
      rule: DEFINITION_CREDENTIAL_RULE,
      field: 'pipeline_definition.name',
    });
    // An extra field fails validation, so only the decoded fallback sees it.
    const inExtra = new TextEncoder().encode(
      `${text.slice(0, -1)},"zz_extra":"${escaped}"}`,
    );
    expect(findPackageFileCredentialRule(inExtra)).toBeNull();
    expect(parseSharedContainerDefinitionDocument(inExtra).ok).toBe(false);
    expect(findPackageEntryCredential(entry(inExtra))).toEqual({
      rule: 'github_token',
    });
  });
  it('refuses a token used as an object key in a valid definition (a DESKTOP GAP: the desktop validator accepts it)', () => {
    const validated = validateSharedContainerDefinitionDocument({
      version: 1,
      kind: 'hook_definition',
      references: [],
      triggerName: 'pr:create',
      target: { kind: 'project' },
      actions: [
        {
          type: 'pipeline',
          pipeline: { source: 'bundled', id: 'review' },
          inputs: { [token]: 'x' },
        },
      ],
    });
    if (!validated.ok) throw new Error(validated.errors.join('; '));
    const bytes = encodeSharedContainerDefinitionDocument(validated.value);
    // Known desktop gap, reported in the PR: keys are not checked there.
    expect(parseSharedContainerDefinitionDocument(bytes, written).ok).toBe(
      true,
    );
    const finding = findPackageEntryCredential(entry(bytes));
    expect(finding).toEqual({
      rule: DEFINITION_CREDENTIAL_RULE,
      field: 'actions[0].inputs',
    });
    expect(JSON.stringify(finding)).not.toContain(token);
  });

  it('never echoes a secret-shaped key in the reported field', () => {
    const key = `${token}_token`;
    const hook = {
      version: 1,
      kind: 'hook_definition',
      references: [],
      triggerName: 'pr:create',
      target: { kind: 'project' },
      actions: [
        {
          type: 'pipeline',
          pipeline: { source: 'bundled', id: 'review' },
          inputs: { [key]: 'value' },
        },
      ],
    };
    const result = validateSharedContainerDefinitionDocument(hook, written);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.errors.join('\n')).not.toContain(token);
    const bytes = new TextEncoder().encode(JSON.stringify(hook));
    const finding = findPackageEntryCredential(entry(bytes));
    expect(finding).not.toBeNull();
    expect(JSON.stringify(finding)).not.toContain(token);
  });

  it('gives the authorization-header next step for a header in a definition', () => {
    const bytes = definitionBytes('${{ secrets.GITHUB_TOKEN }}');
    const text = new TextDecoder()
      .decode(bytes)
      .replace(
        'GITHUB_TOKEN: \\"${{ secrets.GITHUB_TOKEN }}\\"',
        `Authori${'zation'}: Bearer \${{ secrets.TOKEN }}`,
      );
    const header = new TextEncoder().encode(text);
    expect(new TextDecoder().decode(header)).toContain('Bearer');
    const result = parseSharedContainerDefinitionDocument(header, written);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.errors.join('\n')).toContain('Remove the header line');
    expect(findPackageEntryCredential(entry(header))).toEqual({
      rule: DEFINITION_CREDENTIAL_RULE,
      field: 'pipeline_definition.yaml',
      nextStep:
        'Remove the header line, or say which header to send without writing its value.',
    });
  });

  // SWAN 05:02: a shared container definition with a real value in
  // placeholder brackets is refused only where it is written or shared
  // (definitions.ts finalizeDocument, the package analysis, the hosted
  // commit). One already stored still loads and runs: install and the chat
  // conversion read it with the default (install-plan.ts and definitions.ts
  // parseSharedContainerDefinitionDocument calls).
  it('still loads a stored definition with a real value in placeholder brackets', () => {
    const bytes = withValue('<YOUR_TOKEN>', `<${token}>`);
    expect(parseSharedContainerDefinitionDocument(bytes).ok).toBe(true);
  });

  it('refuses that definition where it is written or shared, naming the field and asking for a placeholder, never the value', () => {
    const bytes = withValue('<YOUR_TOKEN>', `<${token}>`);
    const result = parseSharedContainerDefinitionDocument(bytes, written);
    if (result.ok) throw new Error('expected a refusal');
    const message = result.errors.join('\n');
    expect(message).toContain('pipeline_definition.yaml');
    expect(message).toContain('Replace it with a placeholder');
    expect(message).not.toContain(token);
    expect(findPackageEntryCredential(entry(bytes))).toMatchObject({
      rule: DEFINITION_CREDENTIAL_RULE,
      field: 'pipeline_definition.yaml',
    });
  });

  it('accepts a definition with a real placeholder where it is written or shared', () => {
    expect(
      parseSharedContainerDefinitionDocument(
        definitionBytes('${{ secrets.GITHUB_TOKEN }}'),
        written,
      ).ok,
    ).toBe(true);
  });
});

// CAN-7614: env_assignment fails closed. A value is code only when a shape on
// the assignment's own physical line proves it; anything else reads as a
// literal. Every row runs through the shared text check and the shared member
// file check. The rows port every set the rule was reviewed against: the
// ticket's code shapes, the 68 probe shapes, the probe axes, the backquote
// rows, review rounds 1 to 4, the rows that must stay null, the quoted-key
// rows and the probe files. Each row's label names the set it came from or,
// for a stated limit or false positive, its class.
describe('env_assignment reads a value as code only when its own line proves it (CAN-7614)', () => {
  const memberFileRule = (text: string): string | null =>
    findSharedMemberFileCredentialRule(new TextEncoder().encode(text));
  type Row = readonly [string, string, string | null];
  const E = 'env_assignment';
  const C = 'credential_assignment';
  const S = 'Zq7xK9mPw2Lr';
  const L = 'Zq7xxxxxxxxx';
  const pad = (length: number): string => `A${S}`.repeat(20).slice(0, length);

  // Code shapes develop flags: each is proven code on its own line, so
  // each is red on develop.
  const CODE: readonly Row[] = [
    ['68 shapes', 'spring.datasource.password = null', null],
    ['68 shapes', 'DB_PASSWORD = None', null],
    ['68 shapes', 'options.apiKey = getKey()', null],
    ['68 shapes', 'const apiKey = getKey();', null],
    ['68 shapes', 'API_KEY = os.environ["API_KEY"]', null],
    ['68 shapes', 'API_KEY = os.getenv("API_KEY")', null],
    ['68 shapes', 'token = None', null],
    ['68 shapes', 'password = await prompt()', null],
    ['F4 ctl', 'const token = `Bearer ${t}`;', null],
    ['F4 ctl', 'apiKey = `${prefix}-${id}`', null],
    ['axes ctl', 'const token = `x${y}`;', null],
    ['(ii)', 'token = get_key()', null],
    ['(ii)', 'token = f(a, b)', null],
    ['(ii)', "token = env('SECRET')", null],
    ['(ii)', 'token = config.get(x)', null],
    ['(ii)', 'token = self.keys[0]', null],
    ['(ii)', 'token = await fetchToken(x)', null],
    ['(ii)', 'token = new Token(x)', null],
    ['R1', 'Object? token = null,}', null],
    ['R1', 'DB_PASSWORD=None,}', null],
    ['R2', 'MY_TOKEN = []', null],
    ['R2', 'MY_TOKEN = {}', null],
    ['R2', 'MY_TOKEN = ()', null],
    ['R3', 'const MAIN: MigrationProcessToken = Object.freeze({', null],
    ['R4', 'token = createClaim({', null],
    ['R4', 'loadingTask.onPassword = (', null],
    [
      'round 1 I1 ctl',
      'const msg = "${a}"; const DB_PASSWORD = `x${y}`;',
      null,
    ],
    ['round 2 A1 ctl', 'MY_TOKEN = abc || d', null],
    ['round 2 A4 ctl', '.some(token => tokens.has(token));', null],
    ['round 3 B3 FP', 'private readonly secret = randomBytes(32);', null],
    ['LEAD probe-r', 'token = null)', null],
    ['LEAD probe-r', 'DB_PASSWORD = []', null],
    ['LEAD probe-r', 'DB_PASSWORD = {}', null],
    ['LEAD probe-r', 'token = createX({', null],
    ['LEAD probe-r2', 'token => tokens.has(token)', null],
    ['LEAD probe-r2', 'password => password.length > 8', null],
    [
      '#10489 golden',
      "const authToken = randomBytes(32).toString('base64url');",
      null,
    ],
    [
      '#10489 golden',
      'const packageScriptToken = packageManagerCommandPattern.test(command);',
      null,
    ],
    ['#10489 golden', 'let accessToken = await refresh(session);', null],
    ['#10489 golden', 'final token = prefs.getString("t");', null],
    ['#10489 golden', 'private readonly secret = createSecret();', null],
    ['#10489 golden', 'const TOKEN = /^[A-Za-z]+$/;', null],
    ['#10489 golden', 'const token = ++attempt;', null],
    ['#10489 golden', 'owner.token = undefined;', null],
    ['#10489 golden', 'this.apiKey = options.apiKey ?? null;', null],
    ['#10489 golden', 'secret = true;', null],
    [
      '#10489 golden',
      'export type MemoryExportToken = z.output<typeof MemoryExportTokenSchema>;',
      null,
    ],
    ['#10489 golden', 'MY_PASSWORD=null', null],
    ['#10489 golden', 'MY_TOKEN = (a, b)', null],
    ['#10489 golden', 'MY_TOKEN = [a, b]', null],
    ['#10489 golden', 'MY_TOKEN = { a: 1 }', null],
    ['#10489 golden', "MY_TOKEN = ['a']", null],
    ['#10489 golden', 'const token = !value;', null],
    ['#10489 golden', 'let token = --count;', null],
    ['#10489 golden', 'MY_TOKEN = abc ? d : e', null],
    ['#10489 golden', 'MY_TOKEN = abc < d', null],
    ['#10489 golden', 'MY_TOKEN = abc > d', null],
    ['#10489 golden', 'MY_TOKEN = abc && d', null],
    ['#10489 golden', 'MY_TOKEN = abc ?? d', null],
    ['guard (code)', 'token = function (a) { return a; }', null],
    ['guard (code)', 'token = cached ?? fetchToken(x)', null],
    ['#10499 round 3', 'token = (await resolveGitHubToken()).trim();', null],
    ['#10499 round 3', 'token = async (): Promise<T> =>', null],
    ['#10499 round 3', 'token = (a, b) => c', null],
    ['#10499 round 3', 'token = f(x).y;', null],
    ['#10499 round 3', 'privateKey = await subtleCrypto().importKey(', null],
    ['#10499 round 3', 'token = getKey() || fallback', null],
    ['#10499 round 3', "secret = (result.stdout ?? '').trim();", null],
    ['#10499 round 3', 'token = (deps.read ?? read)(', null],
    ['#10499 round 3', 'token = f()[0];', null],
    ['#10499 round 3', "token = cfg.get('a') ?? b;", null],
    ['LEAD probe-a2', 'DB_PASSWORD=None;', null],
    ['LEAD probe-a2', 'DB_PASSWORD=true,', null],
    ['LEAD probe-a2', 'DB_PASSWORD=null)', null],
    ['LEAD probe-a2', 'DB_PASSWORD = null', null],
    ['LEAD probe-a6', 'onPassword = (', null],
    ['LEAD probe-a6', 'SECRET = Object.freeze({', null],
    ['LEAD probe-a6', "const token = signAttributionToken('x', {", null],
    ['LEAD probe-r6', 'DB_PASSWORD = a || b || c;', null],
    ['LEAD probe-r6', 'token = cached ?? null;', null],
    ['LEAD probe-r6', 'token = abc ? d : e', null],
    ['guard (code)', 'token = getKey() ? a : b', null],
    ['#10499 round 3 review', 'token = a || b || c;', null],
    ['#10499 round 3 review', 'token = a ?? b ?? c', null],
    ['#10499 round 3 review', 'token = x ? y : z;', null],
    ['#10499 round 3 review', 'token = a ? b : c || d;', null],
    ['guard (code)', 'token = retries < 10;', null],
    ['guard (code)', 'token = x < 9.5;', null],
  ];
  it.each(CODE)('reads a %s row as code: %j', (_label, text, rule) => {
    expect(findSharedTextCredentialRule(text)).toBe(rule);
    expect(memberFileRule(text)).toBe(rule);
  });

  // The stated limits: one example of every allowlist class that can
  // exempt an identifier-shaped value. Each reads as code although a
  // literal is possible, as the rule states.
  const LIMITS: readonly Row[] = [
    [
      'a template with an unescaped ${',
      `const DB_PASSWORD = \`${S}\${x}\`;`,
      null,
    ],
    ['an open bracket at the line end', `DB_PASSWORD = ${L}(`, null],
    ['an open bracket at the line end', `DB_PASSWORD = ${S}(`, null],
    ['an open bracket at the line end', `DB_PASSWORD = ${S} (`, null],
    ['a closed call with arguments', 'DB_PASSWORD = Pa55(word, x)', null],
    ['a closed call holding a space', `DB_PASSWORD = ${S}(a b)`, null],
    ['a spaced operator', `DB_PASSWORD = ${S} || x`, null],
    ['a spaced ternary', `DB_PASSWORD = ${S} ? a : b`, null],
    ['a closed bracket with content', `DB_PASSWORD = [${S}, 2]`, null],
    ['a closed bracket with content', `DB_PASSWORD = {${S}: 1}`, null],
    ['a closed bracket with content', `DB_PASSWORD = (${S} + 1)`, null],
    ['a method chain', `DB_PASSWORD = ${S}.trim()`, null],
    ['an open bracket at the line end', `DB_PASSWORD = ${S}{`, null],
    ['a declared name with a member chain', `const DB_PASSWORD = ${S}.x`, null],
    [
      'a declared name with a generic call',
      `const DB_PASSWORD = ${S}<T>()`,
      null,
    ],
    [
      'a declared name with an arrow function',
      `const DB_PASSWORD = () => ${S}`,
      null,
    ],
    ['a keyword value with a terminator', 'DB_PASSWORD = None;', null],
    ['a keyword value with a terminator', 'DB_PASSWORD = true,', null],
    ['a keyword value with a terminator', 'DB_PASSWORD = null)', null],
    ['a closed call after =>', `:password => ${S}(x, y)`, null],
    ['a spaced operator after =>', `password => ${S} || x`, null],
    ['an empty closed call', `DB_PASSWORD = ${S}()`, null],
    ['a closed call holding a quote', `DB_PASSWORD = ${S}('x')`, null],
    ['a closed call on a dotted callee', `DB_PASSWORD = a.${S}(x)`, null],
    ['a declared name with a call opener', `const DB_PASSWORD = ${S}(x`, null],
    [
      'a declared name with an index opener',
      `const DB_PASSWORD = ${S}[x`,
      null,
    ],
    [
      'a declared name with a generic opener',
      `const DB_PASSWORD = ${S}<9kL`,
      null,
    ],
    ['a declared name with a starter', `const DB_PASSWORD = !${S}`, null],
    ['a declared name with a starter', `const DB_PASSWORD = ++${S}`, null],
    ['a declared name with a starter', `const DB_PASSWORD = --${S}`, null],
    [
      'a declared name with a regex literal',
      `const DB_PASSWORD = /${S}/;`,
      null,
    ],
    [
      'a declared name with an arrow function',
      `const DB_PASSWORD = ${S} => x`,
      null,
    ],
    [
      'a declared name with a member chain',
      `const DB_PASSWORD = ${S}?.x;`,
      null,
    ],
    ['a typed name with a member chain', `String password = ${S}.x;`, null],
    ['a closed bracket holding a space', `DB_PASSWORD = (${S} x)`, null],
    [
      'a member chain before an open bracket at the line end',
      'DB_PASSWORD = Zq7x.K9mPw2Lr (',
      null,
    ],
    [
      'a closed call before an open bracket at the line end',
      `DB_PASSWORD = ${S}(x) {`,
      null,
    ],
    ['a spaced operator before a number', `DB_PASSWORD = ${S} < 9`, null],
    [
      'a spaced operator before a closed call',
      `DB_PASSWORD = ${S} ?? f(x)`,
      null,
    ],
    ['a keyword expression on a call', `DB_PASSWORD = await ${S}()`, null],
    ['a keyword expression on a call', `DB_PASSWORD = new ${S}(x)`, null],
    ['a keyword value with a terminator', 'DB_PASSWORD = null,}', null],
    ['an index after a closed bracket', `DB_PASSWORD = (a, b)[${S}]`, null],
    [
      'an arrow function returning an identifier',
      `DB_PASSWORD = () => ${S}`,
      null,
    ],
    ['a spaced operator before an identifier', `DB_PASSWORD = ${S} > x`, null],
    [
      'a spaced operator before an identifier',
      `DB_PASSWORD = ${S} > note`,
      null,
    ],
    [
      'a spaced operator before an identifier',
      `DB_PASSWORD = ${S} > ${S}`,
      null,
    ],
    ['an open bracket at the line end', `DB_PASSWORD = ${S} [`, null],
    [
      'a closed call on a dotted callee before an open bracket',
      `DB_PASSWORD = ${S}.x(a) {`,
      null,
    ],
    [
      'a closed call on a dotted callee before an open bracket',
      `DB_PASSWORD = ${S}.x(a).y(b) {`,
      null,
    ],
    [
      'a closed call holding a space',
      `DB_PASSWORD = ${S}(internal note)`,
      null,
    ],
  ];
  it.each(LIMITS)(
    'reads %s as code, a stated limit: %j',
    (_label, text, rule) => {
      expect(findSharedTextCredentialRule(text)).toBe(rule);
      expect(memberFileRule(text)).toBe(rule);
    },
  );

  // Credential variables, as develop reads them. A literal never reads
  // as code: a value with no proven shape on its own line, after a
  // line end of any kind, past the window, or starting with a quote.
  // A bare single-token index followed by a member (`X[0].x`) stays
  // flagged. A former limit is a literal the earlier rule read as
  // code.
  const CREDENTIALS: readonly Row[] = [
    ['68 shapes', `readonly API_TOKEN=${L}`, E],
    ['68 shapes', `declare API_TOKEN=${L}`, E],
    ['68 shapes', `local API_TOKEN=${L}`, E],
    ['68 shapes', `export API_TOKEN=${L}`, E],
    ['68 shapes', `set API_KEY=${L}`, C],
    ['68 shapes', `API_TOKEN=${L} npm publish`, E],
    ['68 shapes', `DB_PASSWORD=${L}!`, E],
    ['68 shapes', 'DB_PASSWORD=Pa55(word)', E],
    ['68 shapes', `DB_PASSWORD=${L},x`, E],
    ['68 shapes', `DB_PASSWORD=None,${L}`, E],
    ['68 shapes', `DB_PASSWORD=true${L}`, E],
    ['68 shapes', `password = ${L}`, E],
    ['68 shapes', `DB_PASSWORD = ${L}`, E],
    ['68 shapes', `DB_PASSWORD = !${L}`, E],
    ['68 shapes', `DB_PASSWORD = ${L}<9kL`, E],
    ['68 shapes', `DB_PASSWORD = ${L}>9kL`, E],
    ['68 shapes', `DB_PASSWORD = ${L}?x`, E],
    ['68 shapes', `DB_PASSWORD = ${L}||x`, E],
    ['68 shapes', `DB_PASSWORD = ${L}&&x`, E],
    ['68 shapes', `DB_PASSWORD = ${L}(x)`, E],
    ['68 shapes', `DB_PASSWORD = ${L}[0]`, E],
    ['68 shapes', `DB_PASSWORD = (${L})`, E],
    ['68 shapes', `DB_PASSWORD = {${L}}`, E],
    ['68 shapes', `DB_PASSWORD = --${L}`, E],
    ['68 shapes', `DB_PASSWORD = ${L};`, E],
    ['68 shapes', `DB_PASSWORD = ${L},`, E],
    [
      'former limit, a camelCase name with a bare value',
      `storePassword = ${L}`,
      E,
    ],
    [
      'former limit, a camelCase name with a bare value',
      `keyPassword = ${L}`,
      E,
    ],
    ['former limit, a camelCase name with a bare value', `apiKey = ${L}`, E],
    ['former limit, an unspaced camelCase value', `storePassword=${L};`, E],
    [
      'former limit, an unspaced camelCase value',
      `storePassword={cipher}${L}`,
      E,
    ],
    ['68 shapes', `spring.datasource.password = ${L}`, E],
    [
      'former limit, a dotted target with a bare value',
      `spring.datasource.password = ${L};`,
      E,
    ],
    ['68 shapes', `spring.datasource.password = ${L}(x`, E],
    ['68 shapes', `spring.datasource.password = ${L}<x`, E],
    ['68 shapes', 'db.password = Pa55(word)', E],
    ['68 shapes', `db.password = ${L}?x`, E],
    ['68 shapes', `spring.datasource.password={cipher}${L}`, C],
    ['68 shapes', `app.api_key=${L}`, C],
    ['68 shapes', `spring.datasource.password = None${L}`, E],
    ['68 shapes', `DB_PASSWORD = NULL${L}`, E],
    ['68 shapes', 'MY_API_KEY=dGVzdEtleQ==', E],
    ['68 shapes', 'MY_API_KEY = dGVzdEtleQ==', E],
    ['68 shapes', 'MY_API_KEY = dGVz==dEtleQ', E],
    ['68 shapes', 'MY_API_KEY = abc==def', E],
    ['68 shapes', `MY_API_KEY = ${L}!=abc`, E],
    ['68 shapes', `- POSTGRES_PASSWORD=${L}`, E],
    ['68 shapes', `  - "MYSQL_ROOT_PASSWORD=${L}"`, E],
    ['68 shapes', `ENV API_TOKEN=${L}`, E],
    ['68 shapes', `--build-arg NPM_TOKEN=${L}`, E],
    ['68 shapes', `docker run -e AWS_SECRET_ACCESS_KEY=${L} img`, E],
    ['68 shapes', `curl -H x https://x?api_key=${L}&y=1`, C],
    ['F4', `const DB_PASSWORD = \`${S}\`;`, E],
    ['F4', `apiKey = \`${S}\``, E],
    ['F4', `export const API_KEY = \`${S}\`;`, E],
    ['F4 unclosed', `const DB_PASSWORD = \`${S}`, E],
    ['F4 escaped', 'const DB_PASSWORD = `Zq7\\`xK9`', E],
    ['axes', 'const DB_PASSWORD = "Pa$$w0rd";', E],
    ['axes', "const DB_PASSWORD = 'Pa$$w0rd';", E],
    ['axes', 'DB_PASSWORD = "pa\\"ss123"', E],
    ['axes', "DB_PASSWORD = 'pa\\'ss123'", E],
    ['axes', `apiKey = "a\`b${S}"`, E],
    ['axes', `const token = "${S}\\n";`, E],
    ['axes', `password = "it's ${S}"`, E],
    ['axes', `password = '${S}' # note`, E],
    ['axes', `password = "${S}" // note`, E],
    ['axes', `const DB_PASSWORD = '${pad(158)}';`, E],
    ['axes', `const DB_PASSWORD = '${pad(159)}';`, E],
    ['axes', `const DB_PASSWORD = '${pad(160)}';`, E],
    ['axes', `const DB_PASSWORD = '${pad(161)}';`, E],
    ['axes', `const DB_PASSWORD = '${pad(260)}';`, E],
    ['axes', `apiKey = "${pad(260)}"`, E],
    ['axes', `${repeat('x', 200)} DB_PASSWORD=${S}`, E],
    [
      'former limit, a declared name with a bare value',
      `${repeat('const ', 30)}DB_PASSWORD = ${S}`,
      E,
    ],
    ['axes', `${repeat('a', 140)}_PASSWORD=${S}`, E],
    ['axes', `Our private deploy key is DEPLOY_TOKEN=${S}`, E],
    ['axes', `Set it like: const DB_PASSWORD=${S}`, E],
    ['axes', `export const API_TOKEN=${S}`, E],
    [
      'former limit, a declared name with a bare value',
      `the type DB_PASSWORD = ${S} here`,
      E,
    ],
    ['axes', `let me know, my API_KEY=${S} thanks`, C],
    ['axes', `public API_KEY=${S}`, C],
    ['axes', `def API_KEY=${S}`, C],
    ['axes', `client.secret = ${S}\r\n`, E],
    ['axes', `DB_PASSWORD = ${S}\r`, E],
    ['axes', `DB_PASSWORD = ${S}\n;`, E],
    ['axes', `DB_PASSWORD = ${S}\n)`, E],
    ['axes', `spring.datasource.password = ${S}\n,`, E],
    ['axes', `DB_PASSWORD =\t${S}`, E],
    ['axes', `DB_PASSWORD\t=\t${S}`, E],
    ['axes', `\tDB_PASSWORD=${S}`, E],
    ['axes', `DB_PASSWORD = \\\n  ${S}`, E],
    ['axes', 'password = value.pass\r\n; c', E],
    ['axes', 'token = self.session\r\n.token', E],
    ['axes joined limit', `const DB_PASSWORD = "${S}" + suffix;`, E],
    ['axes joined limit', `const DB_PASSWORD = "${S}"+suffix;`, E],
    ['axes joined limit', `DB_PASSWORD="${S}"+x`, E],
    ['axes', `DB_PASSWORD = '${S}' . "x"`, E],
    ['bt F4', `DB_PASSWORD = \`${S}\``, E],
    ['bt F4', `DB_PASSWORD=\`${S}\``, E],
    [
      'former limit, a declared name with a bare value',
      `const DB_PASSWORD = ${S}`,
      E,
    ],
    [
      'former limit, a declared name with a bare value',
      `let API_KEY = ${S}`,
      E,
    ],
    [
      'former limit, a declared name with a bare value',
      `then let API_KEY = ${S} in your shell`,
      E,
    ],
    [
      'former limit, a declared name with a bare value',
      `type API_KEY = ${S}`,
      E,
    ],
    [
      'former limit, a declared name with a bare value',
      `val API_KEY = ${S}`,
      E,
    ],
    [
      'former limit, a declared name with a bare value',
      `static API_KEY = ${S}`,
      E,
    ],
    [
      'former limit, a declared name with a bare value',
      `private API_KEY = ${S}`,
      E,
    ],
    ['bt', `const API_KEY = sk_live_${S}`, E],
    ['bt', "let SECRET = 'x'", E],
    ['R3 guard', `const MAIN: ProcessToken = "${L}";`, E],
    ['R3 guard', `const API_KEY: string = "${L}";`, C],
    ['R4 guard', `DB_PASSWORD = ${L}(x`, E],
    ['R4 guard', `DB_PASSWORD = ${L}, `, E],
    ['R4 guard', `DB_PASSWORD = ${repeat('a', 158)}(${repeat('b', 20)}`, E],
    ['round 1 I1', 'String password = "hunter$2";', E],
    ['round 1 I1', 'private readonly API_SECRET = "abc`def";', E],
    ['round 1 I1', 'apiKey = "s3cr$t"', E],
    ['round 1 I1 ctl', 'const DB_PASSWORD = "Pa55w0rd";', E],
    ['round 1 I2', `const DB_PASSWORD = '${L}${repeat('x', 161)}';`, E],
    ['round 1 I2', `const DB_PASSWORD = "${L}${repeat('x', 161)}";`, E],
    ['round 1 I2', `apiKey = '${L}${repeat('x', 161)}'`, E],
    ['round 1 I3', 'Our private deploy key is DEPLOY_TOKEN=abcdef123', E],
    ['round 1 I3', 'Then type DEPLOY_TOKEN=abc123 in the shell', E],
    ['round 1 I3', 'Use a string DEPLOY_TOKEN=abc123 here', E],
    ['round 1 M1', 'client.secret = hunter2\n; comment', E],
    ['round 1 M1', 'password = hunter2\n; comment', E],
    ['round 1 M1 ctl', 'client.secret = hunter2', E],
    ['round 1 edge CRLF', 'client.secret = hunter2\r\n', E],
    ['round 1 edge single $', "password = 'Pa$$w0rd'", E],
    ['round 1 edge tab quoted', `apiKey = \t"${S}"`, E],
    [
      'round 1 edge window 158',
      `const DB_PASSWORD = "${L}${repeat('x', 144)}";`,
      E,
    ],
    [
      'round 1 edge window 159',
      `const DB_PASSWORD = "${L}${repeat('x', 145)}";`,
      E,
    ],
    [
      'round 1 edge window 160',
      `const DB_PASSWORD = "${L}${repeat('x', 146)}";`,
      E,
    ],
    [
      'round 1 edge window 161',
      `const DB_PASSWORD = "${L}${repeat('x', 147)}";`,
      E,
    ],
    ['round 1 edge window 160 camel', `apiKey = "${L}${repeat('x', 146)}"`, E],
    ['round 1 edge window 161 camel', `apiKey = "${L}${repeat('x', 147)}"`, E],
    ['round 2 A1', `DB_PASSWORD = ${S}\n> rotate monthly`, E],
    ['round 2 A1', `DB_PASSWORD = ${S}\n===`, E],
    ['round 2 A1', `DB_PASSWORD = ${S}\n|| fallback`, E],
    ['round 2 A1', `DB_PASSWORD = ${S}\n? a : b`, E],
    ['round 2 A2', `const DB_PASSWORD = "abc\\"+${S}";`, E],
    ['round 2 A2', 'DB_PASSWORD = "Pa\\"+w0rd"', E],
    ['round 2 A2', "DB_PASSWORD = 'Pa\\'+w0rd'", E],
    ['round 2 A3', 'const authToken = password = "hunter2";', E],
    ['round 2 A3', `const outputToken = password = "${S}";`, E],
    ['round 2 A4', ':password => "hunter2"', E],
    ['round 2 A4', "password => 'hunter2'", E],
    ['round 2 A4', `{ :api_key => "${S}" }`, E],
    ['round 3 B1', `DB_PASSWORD = "ab\\"${repeat('x', 170)}"`, E],
    ['round 3 B1', `const DB_PASSWORD = "ab\\"${repeat('x', 170)}";`, E],
    ['round 3 B1', `DB_PASSWORD = 'ab\\'${repeat('x', 170)}'`, E],
    ['round 3 B2', `:password => "${L}${repeat('x', 161)}"`, E],
    ['round 3 B2', `password => '${L}${repeat('x', 161)}'`, E],
    ['round 3 B3 guard', `readonly API_TOKEN=${S}`, E],
    ['D1 B2', `:password => "${S}${repeat('x', 170)}"`, E],
    ['D1 B2', `password => '${S}${repeat('x', 170)}'`, E],
    ['D1 B3 guard', `  export readonly API_TOKEN=${S}`, E],
    ['D1 B3 guard', `declare API_TOKEN=${S}`, E],
    ['round 4 C1', `:password =>\n  "${S}"`, E],
    ['round 4 C2', `const DB_PASSWORD =${repeat(' ', 161)}"${S}"`, E],
    ['round 4 C3', `DB_PASSWORD = ${S}\r# documentation(`, E],
    ['round 4 C4', `const DB_PASSWORD = \`${S}\\\${literal}\`;`, E],
    ['round 4 U+2028', `DB_PASSWORD = ${S}\u2028(`, E],
    ['round 4 U+2029', `DB_PASSWORD = ${S}\u2029|| y`, E],
    ['round 4 CRLF (', `DB_PASSWORD = ${S}\r\n(x)`, E],
    ['round 4 => CR', `:password =>\r"${S}"`, E],
    ['round 4 tab=>', `:password =>\t"${S}"`, E],
    ['round 4 ctl', `:password => "${S}"`, E],
    ['round 4 ctl', `DB_PASSWORD = ${S}\n# documentation(`, E],
    ['LEAD probe', `local API_TOKEN=${S}`, E],
    ['LEAD probe', `export API_TOKEN=${S}`, E],
    ['LEAD probe', `set API_KEY=${S}`, C],
    ['LEAD probe', `API_TOKEN=${S} npm publish`, E],
    ['LEAD probe', `DB_PASSWORD=${S}!`, E],
    ['LEAD probe', `DB_PASSWORD=${S},x`, E],
    ['LEAD probe', `DB_PASSWORD=None,${S}`, E],
    ['LEAD probe', `DB_PASSWORD=true${S}`, E],
    ['LEAD probe', `password = ${S}`, E],
    ['LEAD probe', `DB_PASSWORD = ${S}`, E],
    ['LEAD probe', `DB_PASSWORD = !${S}`, E],
    ['LEAD probe', `DB_PASSWORD = ${S}<9kL`, E],
    ['LEAD probe', `DB_PASSWORD = ${S}>9kL`, E],
    ['LEAD probe', `DB_PASSWORD = ${S}?x`, E],
    ['LEAD probe', `DB_PASSWORD = ${S}||x`, E],
    ['LEAD probe', `DB_PASSWORD = ${S}&&x`, E],
    ['LEAD probe', `DB_PASSWORD = ${S}(x)`, E],
    ['LEAD probe', `DB_PASSWORD = ${S}[0]`, E],
    ['LEAD probe', `DB_PASSWORD = (${S})`, E],
    ['LEAD probe', `DB_PASSWORD = {${S}}`, E],
    ['LEAD probe', `DB_PASSWORD = --${S}`, E],
    ['LEAD probe', `DB_PASSWORD = ${S};`, E],
    ['LEAD probe', `DB_PASSWORD = ${S},`, E],
    ['LEAD probe', `storePassword = ${S}`, E],
    ['LEAD probe', `keyPassword = ${S}`, E],
    ['LEAD probe', `apiKey = ${S}`, E],
    ['LEAD probe', `storePassword=${S};`, E],
    ['LEAD probe', `storePassword={cipher}${S}`, E],
    ['LEAD probe', `spring.datasource.password = ${S}`, E],
    ['LEAD probe', `spring.datasource.password = ${S};`, E],
    ['LEAD probe', `spring.datasource.password = ${S}(x`, E],
    ['LEAD probe', `spring.datasource.password = ${S}<x`, E],
    ['LEAD probe', `db.password = ${S}?x`, E],
    ['LEAD probe', `spring.datasource.password={cipher}${S}`, C],
    ['LEAD probe', `app.api_key=${S}`, C],
    ['LEAD probe', `spring.datasource.password = None${S}`, E],
    ['LEAD probe', `DB_PASSWORD = NULL${S}`, E],
    ['LEAD probe', `MY_API_KEY = ${S}!=abc`, E],
    ['LEAD probe', `- POSTGRES_PASSWORD=${S}`, E],
    ['LEAD probe', `  - "MYSQL_ROOT_PASSWORD=${S}"`, E],
    ['LEAD probe', `ENV API_TOKEN=${S}`, E],
    ['LEAD probe', `--build-arg NPM_TOKEN=${S}`, E],
    ['LEAD probe', `docker run -e AWS_SECRET_ACCESS_KEY=${S} img`, E],
    ['LEAD probe', `curl -H x https://x?api_key=${S}&y=1`, C],
    ['LEAD probe-f', `const DB_PASSWORD = '${S.repeat(15)}';`, E],
    ['LEAD probe-f', `apiKey = "${S.repeat(15)}"`, E],
    ['LEAD probe-f', 'const DB_PASSWORD = "Pa$$w0rd" + suffix;', E],
    ['LEAD probe-f', 'password = "it\'s"', E],
    ['LEAD probe-f', 'const token = "abc"; // `', E],
    ['LEAD probe-qk', '{"password": "hunter2"}', C],
    ['LEAD probe-qk', `{"password": "${S}"}`, C],
    ['LEAD probe-qk', `DB_PASSWORD = "${S}"\n|| y`, E],
    ['LEAD probe-qk', 'DB_PASSWORD = "X"\n|| y', E],
    ['LEAD probe-r', `const API_KEY: string = "${S}";`, C],
    ['LEAD probe-r2', `DB_PASSWORD = ${S}\r\n&& x`, E],
    ['LEAD probe-r2', `const DB_PASSWORD = \`a\\\`+${S}\`;`, E],
    ['LEAD probe-r2', `a = b = DB_PASSWORD = ${S}`, E],
    ['LEAD probe-r2', `token=password=${S}`, C],
    ['LEAD probe-r2', `$password => "${S}"`, E],
    ['LEAD probe-r2', `API_KEY => ${S}`, E],
    ['LEAD probe-r3', `const DB_PASSWORD = "ab\\"${S.repeat(15)}"`, E],
    ['LEAD probe-r3', `:password => "${S.repeat(15)}"`, E],
    ['LEAD probe-r3', `:password => '${S.repeat(15)}'`, E],
    ['LEAD probe-r3', `const token = \`${S}\`;`, E],
    ['LEAD probe-r4', `const DB_PASSWORD =${repeat(' ', 171)}"${S}"`, E],
    ['LEAD probe-r4', `DB_PASSWORD = \\\n"${S}"`, E],
    ['LEAD probe-r4', `DB_PASSWORD=${repeat(' ', 170)}${S}`, E],
    [
      'former limit, a spaced operator before a non-number',
      `DB_PASSWORD = ${S} < 9kL`,
      E,
    ],
    [
      'former limit, a keyword expression on a bare value',
      `DB_PASSWORD = new ${S}`,
      E,
    ],
    [
      'former limit, a keyword expression on a bare value',
      `DB_PASSWORD = await ${S}`,
      E,
    ],
    [
      'former limit, a keyword expression on a bare value',
      `DB_PASSWORD = typeof ${S}`,
      E,
    ],
    ['LEAD probe-d2', `DB_PASSWORD = ${S}[0].x`, E],
    ['LEAD probe-d2', `password = "${S}"`, E],
    ['LEAD probe-d2', `password = \`${S}\``, E],
    ['#10489 golden', `NPM_TOKEN=npm_${repeat('x', 8)}`, E],
    ['#10489 golden', `export GITHUB_TOKEN="${repeat('a', 12)}"`, E],
    ['#10489 golden', `GITHUB_TOKEN = '${repeat('b', 12)}'`, E],
    ['#10489 golden', `$env:API_TOKEN = "${repeat('c', 8)}"`, E],
    [
      '#10489 golden',
      `docker run -e DB_PASSWORD=${repeat('d', 8)} postgres`,
      E,
    ],
    ['#10489 golden', `DB_PASSWORD=${repeat('e', 6)}.pass`, E],
    ['#10489 golden', `password = ${repeat('f', 8)}`, E],
    ['#10489 golden', `storePassword=${repeat('g', 8)}`, E],
    ['#10489 golden', `run: DEPLOY_TOKEN=${repeat('h', 6)} ./deploy.sh`, E],
    [
      '#10489 golden',
      `const authToken = randomBytes(32).toString('base64url');\nNPM_TOKEN=npm_${repeat('x', 8)}`,
      E,
    ],
    ['#10489 golden', `const DB_PASSWORD = "${repeat('i', 8)}"`, E],
    ['#10489 golden', `process.env.DB_PASSWORD = "${repeat('j', 8)}"`, E],
    ['#10489 golden', 'signing.storePassword=abc123xyz', E],
    ['#10489 golden', 'DB_PASSWORD=!Pa55word', E],
    ['#10489 golden', 'spring.datasource.dbPassword=hunter2Value', E],
    ['#10489 golden', 'db.DB_PASSWORD=s3cr3tValue', E],
    ['#10489 golden', 'DEPLOY_API_KEY=[abc123]', E],
    ['#10489 golden', 'APP_SECRET={abcdef}', E],
    ['#10489 golden', 'MY_TOKEN=(abc)def', E],
    ['#10489 golden', `spring.datasource.dbPassword = ${L}`, E],
    ['#10489 golden', `app.github.apiToken = ${L}`, E],
    ['#10489 golden', `app.SERVICE_TOKEN = ${L}`, E],
    ['#10489 golden', `client.secret = ${L}`, E],
    ['#10489 golden', `config.password = ${L}`, E],
    ['#10489 golden', 'MY_TOKEN=++abc', E],
    ['#10489 golden', 'MY_TOKEN=--abc', E],
    ['#10489 golden', 'MY_TOKEN=$(abc', E],
    ['#10489 golden', 'MY_TOKEN=`abc${x}`', E],
    ['#10489 golden', 'MY_PASSWORD=Pa(ss', E],
    ['#10489 golden', 'MY_API_KEY=abc[1]', E],
    ['#10489 golden', 'MY_TOKEN=abc?def', E],
    ['#10489 golden', 'MY_TOKEN=abc?.def', E],
    ['#10489 golden', 'MY_TOKEN=abc??def', E],
    ['#10489 golden', 'MY_PASSWORD=ab||cd', E],
    ['#10489 golden', 'MY_PASSWORD=ab&&cd', E],
    ['#10489 golden', 'MY_TOKEN=abc!=def', E],
    ['#10489 golden', 'MY_PASSWORD=abc<def', E],
    ['#10489 golden', 'MY_PASSWORD=abc>def', E],
    ['#10489 golden', 'MY_TOKEN=abc.def(x', E],
    ['#10489 golden', 'MY_PASSWORD=null-pass', E],
    ['#10489 golden', 'api_key = dGVzdEtleQ==', E],
    ['#10489 golden', 'MY_PASSWORD = null-pass', E],
    ['#10489 golden', 'spring.datasource.password=hunter2Value', C],
    ['#10489 golden', 'db.password=s3cr3tValue', C],
    ['#10489 golden', 'API_KEY=[abc123]', C],
    ['#10489 golden', 'SECRET={abcdef}', C],
    ['#10489 golden', 'TOKEN=(abc)def', C],
    ['#10489 golden', `spring.datasource.password=${L}`, C],
    ['#10489 golden', `app.github.apiToken=${L}`, E],
    ['#10489 golden', `spring.datasource.password: ${L}`, C],
    ['#10489 golden', `aws_secret_access_key = ${L}`, E],
    ['#10489 golden', `//registry.example.org/:_authToken=${L}`, E],
    ['#10489 golden', `token = "${L}"`, E],
    ['#10489 golden', `$password = "${L}";`, E],
    ['#10489 golden', `config.password = ${L};`, E],
    ['#10489 golden', `password = ${L}.pass`, E],
    ['#10489 golden', `  - POSTGRES_PASSWORD=${L}`, E],
    ['#10489 golden', `set API_TOKEN=${L}`, E],
    ['#10489 golden', `https://x.example/cb?token=${L}&u=1`, C],
    ['#10489 golden', `X-Api-Key: ${L}`, 'auth_header'],
    ['#10489 golden', `{"password":"${L}"}`, C],
    ['#10489 golden', `app.SERVICE_TOKEN = ${L};`, E],
    ['#10489 golden', `password = ${L};`, E],
    ['#10489 golden', `DB_PASSWORD=${L};`, E],
    ['#10489 golden', `config.password = '${L}';`, E],
    ['#10489 golden', 'password = value.pass\n; comment', E],
    ['#10489 golden', `readonly API_TOKEN = ${L}`, E],
    ['#10489 golden', `  export readonly API_TOKEN = ${S}`, E],
    ['#10489 golden', 'MY_TOKEN=!abc', E],
    ['#10489 golden', 'MY_TOKEN=(abc', E],
    ['#10489 golden', 'MY_TOKEN=[abc', E],
    ['#10489 golden', 'MY_TOKEN={abc', E],
    ['#10489 golden', 'MY_TOKEN=-abc', E],
    ['#10489 golden', 'MY_TOKEN=+abc', E],
    ['#10489 golden', 'MY_TOKEN=/abc', E],
    ['#10489 golden', 'MY_TOKEN=@abc', E],
    ['#10489 golden', 'MY_TOKEN=#abc', E],
    ['#10489 golden', 'MY_TOKEN=%abc', E],
    ['#10489 golden', 'MY_TOKEN=*abc', E],
    ['#10489 golden', 'MY_TOKEN=&abc', E],
    ['#10489 golden', 'MY_TOKEN=~abc', E],
    ['#10489 golden', 'MY_TOKEN=^abc', E],
    ['#10489 golden', 'MY_TOKEN=:abc', E],
    ['#10489 golden', 'MY_TOKEN=`abc', E],
    ['#10489 golden', 'MY_TOKEN=7abc', E],
    ['#10489 golden', 'MY_TOKEN = !abc', E],
    ['#10489 golden', 'MY_TOKEN = (abc', E],
    ['#10489 golden', 'MY_TOKEN = [abc', E],
    ['#10489 golden', 'MY_TOKEN = {abc', E],
    ['#10489 golden', 'MY_TOKEN = -abc', E],
    ['#10489 golden', 'MY_TOKEN = +abc', E],
    ['#10489 golden', 'MY_TOKEN = /abc', E],
    ['#10489 golden', 'MY_TOKEN = @abc', E],
    ['#10489 golden', 'MY_TOKEN = #abc', E],
    ['#10489 golden', 'MY_TOKEN = %abc', E],
    ['#10489 golden', 'MY_TOKEN = *abc', E],
    ['#10489 golden', 'MY_TOKEN = &abc', E],
    ['#10489 golden', 'MY_TOKEN = ~abc', E],
    ['#10489 golden', 'MY_TOKEN = ^abc', E],
    ['#10489 golden', 'MY_TOKEN = :abc', E],
    ['#10489 golden', 'MY_TOKEN = `abc', E],
    ['#10489 golden', 'MY_TOKEN = 7abc', E],
    ['#10489 golden', 'MY_TOKEN = (abc)', E],
    ['#10489 golden', 'MY_TOKEN = [abc]', E],
    ['#10489 golden', 'MY_TOKEN = {abc}', E],
    ['#10489 golden', 'MY_TOKEN = (a, b', E],
    ['a keyword joined to more text', 'MY_PASSWORD=None, other', E],
    ['#10489 golden', 'MY_TOKEN=abc!def', E],
    ['#10489 golden', 'MY_TOKEN = abc!', E],
    ['#10489 golden', 'MY_TOKEN = abc?.d', E],
    ['#10489 golden', 'MY_TOKEN = abc<d', E],
    ['#10489 golden', 'MY_TOKEN = abc ?d', E],
    [
      'former limit, a bare property after a call at the line end',
      `DB_PASSWORD = ${S}(x).y`,
      E,
    ],
    ['D2-A sub-shapes', `DB_PASSWORD = ${S}(x)[0]`, E],
    ['D2-A sub-shapes', `DB_PASSWORD = ${S}[0](x)`, E],
    ['guard (value on the next line after =>)', `:password =>\n${S} (`, E],
    [
      'guard (value past the window)',
      `DB_PASSWORD =${repeat(' ', 171)}${S} (`,
      E,
    ],
    ['guard (open bracket after U+2029)', `DB_PASSWORD = ${S}\u2029(`, E],
    [
      'guard (open bracket at the window edge)',
      `DB_PASSWORD = ${repeat('a', 159)}(${repeat('b', 20)}`,
      E,
    ],
    [
      'guard (double-quoted value before an open bracket)',
      `const DB_PASSWORD = "${S}" + build(`,
      E,
    ],
    [
      'guard (single-quoted value before an open bracket)',
      `const DB_PASSWORD = '${S}' + build(`,
      E,
    ],
    [
      'guard (backquoted value joined to a template)',
      `DB_PASSWORD = \`${S}\` + \`\${x}\``,
      E,
    ],
    [
      'guard (shell readonly with a dotted value)',
      `readonly API_TOKEN = ${S}.pass`,
      E,
    ],
    ['guard (declaration before a CR)', `const\rDB_PASSWORD = ${S}.pass`, E],
    ['guard (declaration before U+2028)', `let\u2028API_KEY = ${S}.pass`, E],
    ['guard (declaration before U+2029)', `let\u2029API_KEY = ${S}.pass`, E],
    [
      'guard (arrow candidate inside a code value)',
      `const getToken = password => ${S}`,
      E,
    ],
    ['guard (no space before =)', `DB_PASSWORD= ${S}(a, b)`, E],
    [
      '#10499 round 1, text before a line-end bracket',
      `DB_PASSWORD = ${S} # internal note (`,
      E,
    ],
    [
      '#10499 round 1, text before a line-end bracket',
      `DB_PASSWORD = ${S} # note {`,
      E,
    ],
    [
      '#10499 round 1, text before a line-end bracket',
      `DB_PASSWORD = ${S} // see (`,
      E,
    ],
    [
      '#10499 round 1, text before a line-end bracket',
      `DB_PASSWORD = ${S} ; see [`,
      E,
    ],
    [
      '#10499 round 1, text before a line-end bracket',
      `DB_PASSWORD = ${S} -- note (`,
      E,
    ],
    [
      '#10499 round 1, text before a line-end bracket',
      `DB_PASSWORD = ${S} #(`,
      E,
    ],
    [
      '#10499 round 1, text before a line-end bracket',
      `DB_PASSWORD = ${S} REM x (`,
      E,
    ],
    [
      '#10499 round 1, text before a line-end bracket',
      `DB_PASSWORD = ${S} <!-- x (`,
      E,
    ],
    [
      '#10499 round 1, text before a line-end bracket',
      `DB_PASSWORD = ${S} & echo (`,
      E,
    ],
    [
      '#10499 round 1, text before a line-end bracket',
      `DB_PASSWORD = ${S} /* x (`,
      E,
    ],
    [
      '#10499 round 1, text before a line-end bracket',
      `DB_PASSWORD = ${S} x (`,
      E,
    ],
    [
      '#10499 round 1, text before a line-end bracket',
      `DB_PASSWORD = ${S}, (`,
      E,
    ],
    [
      '#10499 round 1, text before a line-end bracket',
      `DB_PASSWORD = ${S} | (`,
      E,
    ],
    [
      '#10499 round 1, text before a line-end bracket',
      `DB_PASSWORD = ${S} ) (`,
      E,
    ],
    [
      'former limit, a spaced operator before a bracket',
      `DB_PASSWORD = ${S} > (`,
      E,
    ],
    [
      'guard (only spaces before a line-end bracket)',
      `DB_PASSWORD =${repeat(' ', 171)}(`,
      E,
    ],
    ['guard (call closed past LF)', `DB_PASSWORD = ${S}(x\n, y)`, E],
    ['guard (call closed past CR)', `DB_PASSWORD = ${S}(x\r, y)`, E],
    ['guard (call closed past U+2028)', `DB_PASSWORD = ${S}(x\u2028, y)`, E],
    ['guard (call closed past U+2029)', `DB_PASSWORD = ${S}(x\u2029, y)`, E],
    [
      '#10499 round 2, a keyword then a terminator, then a literal',
      `DB_PASSWORD=null)${S}`,
      E,
    ],
    [
      '#10499 round 2, a keyword then a terminator, then a literal',
      `DB_PASSWORD=null;${S}`,
      E,
    ],
    [
      '#10499 round 2, a keyword then a terminator, then a literal',
      `DB_PASSWORD=None ${S}`,
      E,
    ],
    [
      '#10499 round 2, a keyword then a terminator, then a literal',
      `DB_PASSWORD=true, ${S}`,
      E,
    ],
    [
      '#10499 round 2, a keyword then a terminator, then a literal',
      `DB_PASSWORD=true,}${S}`,
      E,
    ],
    [
      '#10499 round 2, a keyword then a terminator, then a literal',
      `DB_PASSWORD=false\t${S}`,
      E,
    ],
    [
      '#10499 round 2, a keyword then a terminator, then a literal',
      `DB_PASSWORD=undefined) ${S}`,
      E,
    ],
    [
      '#10499 round 2, a keyword then a terminator, then a literal',
      `DB_PASSWORD=nil;x${S}`,
      E,
    ],
    [
      '#10499 round 2, a keyword then a terminator, then a literal',
      `DB_PASSWORD=NULL ${S}`,
      E,
    ],
    [
      '#10499 round 2, a keyword then a terminator, then a literal',
      `DB_PASSWORD = null)${S}`,
      E,
    ],
    [
      '#10499 round 2, a keyword then spaces past the window',
      `DB_PASSWORD = null${repeat(' ', 170)}${S}`,
      E,
    ],
    [
      '#10499 round 2, a keyword joined to more text',
      'DB_PASSWORD=None, other',
      E,
    ],
    [
      '#10499 round 2, a keyword expression before a comment',
      `DB_PASSWORD = new ${S} # note`,
      E,
    ],
    [
      '#10499 round 2, a spaced operator before punctuation',
      `DB_PASSWORD = ${S} > /dev/null`,
      E,
    ],
    [
      '#10499 round 2, a spaced operator before punctuation',
      `DB_PASSWORD = ${S} || (`,
      E,
    ],
    ['#10499 round 2, probe-pfx', `DB_PASSWORD = function ${S}`, E],
    ['#10499 round 2, probe-pfx', `const DB_PASSWORD = -${S}`, E],
    ['#10499 round 2, probe-pfx', `export DB_PASSWORD = !${S}`, E],
    ['#10499 round 2, probe-pfx', `DB_PASSWORD = ${S} + x`, E],
    [
      'guard (unspaced keyword then spaces past the window)',
      `DB_PASSWORD=null${repeat(' ', 170)}${S}`,
      E,
    ],
    [
      'guard (keyword call cut by the window)',
      `DB_PASSWORD = await ${S}(x)${repeat(' ', 170)}tail`,
      E,
    ],
    [
      'guard (keyword call before a comment)',
      `DB_PASSWORD = new ${S}(x) # note`,
      E,
    ],
    [
      'guard (spaced operator before an unclosed call)',
      `DB_PASSWORD = ${S} || x(`,
      E,
    ],
    [
      'former limit, a quoted operand after a comparison',
      `DB_PASSWORD = typeof ${S} === 'x'`,
      E,
    ],
    [
      '#10499 round 3, text after a closed bracket',
      `DB_PASSWORD = (a, b) ${S}`,
      E,
    ],
    ['#10499 round 3, text after a closed bracket', `DB_PASSWORD = () ${S}`, E],
    ['#10499 round 3, text after a closed bracket', `DB_PASSWORD = {} ${S}`, E],
    [
      '#10499 round 3, a call then a bare property at the line end',
      `DB_PASSWORD = f(x).${S}`,
      E,
    ],
    ['#10499 round 3, text after a call', `DB_PASSWORD = await f() ${S}`, E],
    ['#10499 round 3, text after a call', `DB_PASSWORD = getKey() ${S}`, E],
    [
      '#10499 round 3, a quoted literal after an operator',
      `DB_PASSWORD = os.environ.get("X") or "${S}T4vB"`,
      E,
    ],
    [
      '#10499 round 3, a quoted literal after an operator',
      `API_TOKEN = ENV["T"] || "${S}T4vB"`,
      E,
    ],
    [
      '#10499 round 3, a quoted literal after an operator',
      `DB_PASSWORD = fallback || "${S}"`,
      E,
    ],
    [
      '#10499 round 3, a quoted literal after an operator',
      `DB_PASSWORD = getKey() || "${S}"`,
      E,
    ],
    [
      '#10499 round 3, a quoted literal in a ternary',
      `DB_PASSWORD = cond ? "${S}" : x`,
      E,
    ],
    [
      '#10499 round 3, a quoted literal in a ternary',
      `DB_PASSWORD = cond ? x : '${S}'`,
      E,
    ],
    ['LEAD probe-a2', `DB_PASSWORD=null#${S}`, E],
    ['LEAD probe-a2', `DB_PASSWORD=True ${S}`, E],
    ['LEAD probe-a2', `DB_PASSWORD=nullable${S}`, E],
    ['LEAD probe-a2', `DB_PASSWORD=null.${S}`, E],
    ['LEAD probe-a2', `DB_PASSWORD=null]${S}`, E],
    ['LEAD probe-a4', `DB_PASSWORD = ${S} > #`, E],
    ['LEAD probe-a4', `DB_PASSWORD = ${S} + (`, E],
    ['LEAD probe-a4', `DB_PASSWORD = ${S} ? (`, E],
    ['LEAD probe-a4', `DB_PASSWORD = ${S} == (`, E],
    ['LEAD probe-a4', `DB_PASSWORD = ${S} && (`, E],
    ['LEAD probe-a4', `DB_PASSWORD = ${S} - (`, E],
    ['LEAD probe-a4', `DB_PASSWORD = ${S} | x`, E],
    ['LEAD probe-a4', `DB_PASSWORD = ${S} # note > x`, E],
    ['LEAD probe-a4', `DB_PASSWORD = ${S} -> x`, E],
    ['LEAD probe-a4', `DB_PASSWORD = ${S} >> log.txt`, E],
    ['LEAD probe-a4', `DB_PASSWORD = ${S} 2> err.log`, E],
    ['LEAD probe-a6', `DB_PASSWORD=${S} # note (`, E],
    ['LEAD probe-a6', `DB_PASSWORD = "${S}" # note (`, E],
    ['LEAD probe-a6', `DB_PASSWORD = ${S} # note`, E],
    ['LEAD probe-a6', 'let token = match x {', E],
    ['LEAD probe-a6b', 'DB_PASSWORD = Zq7x.K9mPw2Lr', E],
    ['LEAD probe-a6b', 'DB_PASSWORD = Zq7x.K9mPw2Lr;', E],
    ['LEAD probe-r2', `DB_PASSWORD = [x] ${S}`, E],
    ['LEAD probe-r2', `DB_PASSWORD = f(x) ${S}`, E],
    ['LEAD probe-r3', `DB_PASSWORD = (x).${S}`, E],
    ['LEAD probe-r3', `DB_PASSWORD = (x)(${S}`, E],
    ['LEAD probe-r3', `DB_PASSWORD = (a): T => ${S}`, E],
    ['LEAD probe-r3', `DB_PASSWORD = c ? "${S}" : x`, E],
    ['LEAD probe-r5', `DB_PASSWORD = os.environ.get("X") or "${S}"`, E],
    ['LEAD probe-r5', `API_TOKEN = ENV["T"] || "${S}"`, E],
    ['LEAD probe-r5', `DB_PASSWORD = ${S} || x y`, E],
    ['LEAD probe-r6', `DB_PASSWORD = cached || fallback || "${S}";`, E],
    ['LEAD probe-r6', `DB_PASSWORD = a || b || '${S}'`, E],
    ['LEAD probe-r6', `DB_PASSWORD = a && b ?? "${S}"`, E],
    ['LEAD probe-r6', `DB_PASSWORD = a || b ${S}`, E],
    ['LEAD probe-r6', `DB_PASSWORD = a || b || c ${S}`, E],
    ['LEAD probe-r6', `DB_PASSWORD = cond ?  "${S}" : x`, E],
    ['LEAD probe-r6', `DB_PASSWORD = cond ? a :  "${S}"`, E],
    ['LEAD probe-r6', `DB_PASSWORD = cond ?\t"${S}" : x`, E],
    [
      'quoted fallback after an operator',
      "const secret = options.secret ?? 'in-memory-secret';",
      E,
    ],
    [
      'quoted fallback after an operator',
      "const apiKey = environment.CANOPY_MOCK_API_KEY ?? 'mock';",
      E,
    ],
    ['guard (index then a method)', `DB_PASSWORD = ${S}[0].trim()`, E],
    [
      'guard (open bracket after a call at the window edge)',
      `DB_PASSWORD = getKey()${repeat(' ', 151)}(${repeat('x', 20)}`,
      E,
    ],
    [
      'guard (spaces after a call past the window)',
      `DB_PASSWORD = getKey()${repeat(' ', 160)}${S}`,
      E,
    ],
    [
      'guard (text after an operand after a call)',
      `DB_PASSWORD = getKey() || x ${S}`,
      E,
    ],
    [
      'guard (text after a ternary after a call)',
      `DB_PASSWORD = getKey() ? a : b ${S}`,
      E,
    ],
    ['guard (text after an arrow body)', `DB_PASSWORD = (a, b) => ${S} x`, E],
    [
      'guard (empty arrow body past the window)',
      `DB_PASSWORD = (a, b) =>${repeat(' ', 170)}${S}`,
      E,
    ],
    [
      '#10499 round 3 review, extra spaces before a quoted ternary branch',
      `DB_PASSWORD = cond ?  "${S}" : fallback`,
      E,
    ],
    [
      '#10499 round 3 review, a tab before a quoted ternary branch',
      `DB_PASSWORD = cond ?\t"${S}" : fallback`,
      E,
    ],
    [
      '#10499 round 3 review, a tab before a quoted ternary branch',
      `DB_PASSWORD = cond ? a :\t'${S}'`,
      E,
    ],
    [
      '#10499 round 3 review, text after a ternary',
      `DB_PASSWORD = cond ? a : b ${S}`,
      E,
    ],
  ];
  it.each(
    CREDENTIALS.map(([label, text, rule]) => [label, rule, text] as const),
  )('reads a %s row as %j: %j', (_label, rule, text) => {
    expect(findSharedTextCredentialRule(text)).toBe(rule);
    expect(memberFileRule(text)).toBe(rule);
  });

  // The stated false positives: code that no shape on its own line
  // proves, so it reads as a credential variable, as on develop.
  const FALSE_POSITIVES: readonly Row[] = [
    ['a member write from a bare identifier', 'this.token = value;', E],
    ['a JSX attribute', 'reloadToken={reloadToken}', E],
    ['a member chain at the line end', 'token = self.session.token', E],
    ['a member chain at the line end', 'password = input.value', E],
    ['a call with one bare argument', 'TOKEN = getToken(ctx)', E],
    ['an index with one bare token', 'TOKEN = keys[0]', E],
    ['a call with one bare argument', 'token = decodeURIComponent(raw);', E],
    [
      'text after a closed bracket or call',
      '{ secret = [], public: visible = [] } = {},',
      E,
    ],
    [
      'a declared name with a bare identifier',
      'const MAIN: ProcessToken = makeToken;',
      E,
    ],
    ['an unspaced call', 'const API_TOKEN=getToken();', E],
    [
      'an arrow returning a bare identifier',
      'String? get currentToken => _cached;',
      E,
    ],
    [
      'a declared name with a bare identifier',
      'private readonly API_KEY = DEFAULT_API_KEY;',
      E,
    ],
    ['a quoted string joined to code', 'const token = "Bearer " + t;', E],
    ['a quoted string joined to code', "const SECRET = '0123'.repeat(4);", E],
    [
      'a quoted string joined to code',
      "$pilotPassword='Aa1!'+[Convert]::ToBase64String($pilotBytes)",
      E,
    ],
    ['an arrow returning a bare identifier', 'token => fallbackToken', E],
    ['a call with one bare argument', 'secret = randomBytes(32);', E],
    ['an arrow returning a bare identifier', 'get currentToken => _cached', E],
    ['an arrow returning a quoted string', 'items.map(token => "x")', E],
    ['an escaped ${ in backquotes', `password = \`${S}\\\${x}\``, E],
    ['a camelCase default', 'reloadToken = 0,', E],
    ['a camelCase variable', 'orphanToken = sessionCookie', E],
    ['an arrow returning a quoted string', '.map(token => "x")', E],
    [
      'other text before an open bracket at the line end',
      "@pragma('vm:prefer-inline') $Res call({Object? token = null,Object? chat = freezed,Object? online = null,}) {",
      E,
    ],
    [
      'other text before an open bracket at the line end',
      "@pragma('vm:prefer-inline') $Res call({Object? token = null,Object? chat = null,Object? online = null,Object? ready = null,}) {",
      E,
    ],
    [
      'other text before an open bracket at the line end',
      "@pragma('vm:prefer-inline') $Res call({Object? token = null,Object? itemId = null,Object? action = null,Object? notifySubscriber = null,}) {",
      E,
    ],
    [
      'other text before an open bracket at the line end',
      "token = signAttributionToken('page-visit-signup-state-v1', {",
      E,
    ],
    [
      'other text before an open bracket at the line end',
      "await db.query('SELECT token FROM sessions WHERE token = $1', [",
      E,
    ],
    [
      'other text before an open bracket at the line end',
      'let token = match self.auth.relay_token(&identity.device_id).await {',
      E,
    ],
    [
      'a keyword expression on a value not proven code',
      'secret = await host',
      E,
    ],
    [
      'a keyword expression on a value not proven code',
      "const secret = await request('chat:command', [",
      E,
    ],
    [
      'a spaced operator before a parenthesised expression',
      'const token = cachedGitHubToken ?? (await resolveGitHubToken());',
      E,
    ],
    [
      'a keyword expression on a value not proven code',
      'const token = await gitHubPatWriteQueue.then(() =>',
      E,
    ],
    [
      'a keyword expression on a value not proven code',
      'const token = await linearTokenWriteQueue.then(() =>',
      E,
    ],
    [
      'a keyword value followed by more code',
      "@pragma('vm:prefer-inline') $Res call({Object? chat = null,Object? token = null,}) {",
      E,
    ],
    [
      'a keyword value followed by more code',
      "@pragma('vm:prefer-inline') $Res call({Object? token = null,}) {",
      E,
    ],
    [
      'a keyword value followed by more code',
      "@pragma('vm:prefer-inline') $Res call({Object? target = null,Object? token = null,}) {",
      E,
    ],
    [
      'a keyword value followed by more code',
      '{ accessTokenExpiresAt = null, refreshToken = null } = {},',
      E,
    ],
    [
      'a keyword value followed by more code',
      'refresh_token = NULL, updated_at = ${UTC_NOW}',
      E,
    ],
    [
      'a keyword value followed by more code',
      'HANDLE token = NULL, process = NULL;',
      E,
    ],
    [
      'a keyword expression on a value not proven code',
      'private readonly byToken = new Map<',
      E,
    ],
    [
      'a keyword expression on a value not proven code',
      'const colorMetadataByToken = new Map<',
      E,
    ],
    [
      'a keyword expression on a value not proven code',
      'const secret = await pending;',
      E,
    ],
    [
      'a keyword expression on a value not proven code',
      'const secret = await attachment.within(() =>',
      E,
    ],
    ['a quoted operand after a comparison', "token = typeof x === 'string'", E],
    ['a quoted operand after a comparison', "token = mode === 'secret'", E],
    [
      'a quoted operand after a comparison',
      "DB_PASSWORD = typeof x === 'string'",
      E,
    ],
    [
      'a quoted operand after a comparison',
      "DB_PASSWORD = mode === 'secret'",
      E,
    ],
    [
      'a quoted operand after an operator',
      "lastResolutionHadToken = token !== '';",
      E,
    ],
    [
      'a quoted operand after an operator',
      "let token = stored.status === 'ok' ? (stored.value ?? '') : '';",
      E,
    ],
    [
      'a quoted operand after an operator',
      "const token = result.value ?? '';",
      E,
    ],
    [
      'text after a closed bracket or call',
      'const readToken = async (): Promise<{',
      E,
    ],
    [
      'a quoted operand after an operator',
      "const runConditionMaySecret = firstRunConditionWarning === 'possible_secret';",
      E,
    ],
    [
      'a quoted operand after an operator',
      "const clientSecret = setup.clientSecretAccepted ? row.oauthClientSecret : '';",
      E,
    ],
    [
      'a quoted operand after an operator',
      "lastToken = property ? 'identifier' : word;",
      E,
    ],
    [
      'a quoted operand after an operator',
      "lastToken = c === '=' && next === '>' ? '=>' : c;",
      E,
    ],
    [
      'text after a closed bracket or call',
      'function stageVerified(item, token = randomUUID()) {',
      E,
    ],
    [
      'text after a closed bracket or call',
      "'apps/web/src/lib/api-keys.ts': 'export type ApiKey = {};\\n',",
      E,
    ],
    [
      'an optional-chained operand after an operator',
      'const apiKey = parsed.apiKey ?? saved?.apiKey;',
      E,
    ],
  ];
  it.each(
    FALSE_POSITIVES.map(([label, text, rule]) => [label, rule, text] as const),
  )('reads %s as %j, a stated false positive: %j', (_label, rule, text) => {
    expect(findSharedTextCredentialRule(text)).toBe(rule);
    expect(memberFileRule(text)).toBe(rule);
  });

  // Rows with no credential that stay null, as on develop: placeholders,
  // empty values, comparisons and environment reads.
  const MUST_STAY_NULL: readonly Row[] = [
    ['68 shapes', 'const API_TOKEN = process.env.API_TOKEN;', null],
    ['68 shapes', 'if (newPassword == oldPassword)', null],
    ['68 shapes', 'SECRET_KEY = env("SECRET_KEY")', null],
    ['68 shapes', 'apiKey ??= fallback', null],
    ['axes', 'const token = "${S}";', null],
    ['round 1 edge ctl $OTHER_VAR', 'export API_KEY="$OTHER_VAR"', null],
    ['round 1 edge ctl empty', 'let password = "";', null],
    ['round 2 A3 ctl', 'const a = b = c;', null],
    ['D1 null', 'let password = ""', null],
    ['D1 null', 'password = "${VAR}"', null],
    ['D1 null', 'TOKEN=""', null],
    ['D1 null+', 'DB_PASSWORD="${DB_PASSWORD}"', null],
    ['D1 null+', "password = '$PASS'", null],
    ['D1 null+', 'API_TOKEN="$(cat token.txt)"', null],
    ['D1 null+', 'password = "{{ secret }}"', null],
    ['D1 null+', "TOKEN=''", null],
    ['LEAD probe-f', 'const apiKey = process.env.API_KEY ?? "";', null],
    ['LEAD probe-r2', 'const f = (token) => token.trim()', null],
    ['LEAD probe-r2', 'abc || d', null],
    ['LEAD probe-r2', 'x = a\n> b', null],
    ['LEAD probe-r2', 'if (a == b)', null],
    ['LEAD probe-r2', 'a === b', null],
    ['#10489 golden', 'spring.datasource.password=${DB_PASS}', null],
    ['#10489 golden', 'MY_TOKEN=$abc', null],
    ['#10489 golden', 'MY_TOKEN = $abc', null],
    [
      'LEAD probe-fb',
      `const DB_PASSWORD = process.env.DB_PASSWORD || "${S}T4vB";`,
      null,
    ],
    [
      'LEAD probe-fb',
      `const API_KEY = process.env.API_KEY ?? '${S}T4vB';`,
      null,
    ],
    ['LEAD probe-fb', `API_TOKEN = ENV.fetch("T", "${S}T4vB")`, null],
    ['LEAD probe-fb', 'const SECRET_KEY = cfg.key || "changeme"', null],
    ['LEAD probe-r2', 'None;', null],
    ['LEAD probe-r2', "typeof x === 'string'", null],
    ['LEAD probe-r2', "mode === 'secret'", null],
    ['LEAD probe-r3', 'f(x).y;', null],
    ['LEAD probe-r3', '(a, b) => c', null],
  ];
  it.each(MUST_STAY_NULL)(
    'leaves a %s row unflagged: %j',
    (_label, text, rule) => {
      expect(findSharedTextCredentialRule(text)).toBe(rule);
      expect(memberFileRule(text)).toBe(rule);
    },
  );

  // Credentials develop misses too, pinned to develop's null and
  // tracked separately: a quoted hash key, a value on the next line,
  // a key name outside the pattern and a literal after a proven-code
  // value.
  const DEVELOP_GAPS: readonly Row[] = [
    ['a quoted hash key', "'password' => 'hunter2'", null],
    ['a quoted hash key', `"api_key" => "${S}"`, null],
    ['a quoted hash key', '{ \'token\' => "X" }', null],
    ['a quoted hash key', `{ 'token' => "${S}" }`, null],
    ['a quoted hash key', `'api_key' => '${S}',`, null],
    ['a quoted hash key', `"secret" => "${S}"`, null],
    ['a value on the next line', `DB_PASSWORD =\n${S}`, null],
    ['a value on the next line', `apiKey =\n  "${S}"`, null],
    ['a key name outside the pattern', `SECRET_KEY = '${L}'`, null],
    ['a key name outside the pattern', `config.secret_key = '${L}'`, null],
    [
      'a literal after a proven-code value',
      `const API_KEY = process.env.API_KEY || "${L}";`,
      null,
    ],
    [
      'a literal after an environment read',
      `const DB_PASSWORD = process.env.X || "${S}"`,
      null,
    ],
  ];
  it.each(DEVELOP_GAPS)(
    'leaves %s unflagged, as develop does: %j',
    (_label, text, rule) => {
      expect(findSharedTextCredentialRule(text)).toBe(rule);
      expect(memberFileRule(text)).toBe(rule);
    },
  );
});

// Every regex in both profiles, on adversarial near-misses at the largest
// file a package may carry. Each input repeats the start of a match without
// completing it, so a pattern with overlapping quantifiers would rescan from
// every start. Both profiles run every input. An input that comes back null
// ran every check of that profile to the end; neutralization is a full
// replace, so the placeholder patterns run over the whole input either way.
//
// Coverage, by the regex each input aims at:
// - SECRET_RULES (capability-files, both profiles): private key, jwt (prefix
//   and dotted runs), github_pat_, gh*_ token, xox*, AKIA, sk-, auth headers,
//   Bearer, the two credential_assignment forms, npm_.
// - Shared placeholder neutralization (SECRET_PLACEHOLDER_ASSIGNMENT_PATTERN
//   and NAMED_PLACEHOLDER_PATTERN): every arm, <…>, ${{…}}, {{…}}, $(…),
//   nested $($(…)), $VAR, ${VAR}, env.VAR.
// - SECRET_ENV_ASSIGNMENT_PATTERN (shared): keyword then spaces or tabs,
//   and code assignments, where every candidate reads as code and so runs
//   the whole line check; and a literal call, flagged at the first candidate
//   (CAN-7614).
// - URL_USER_INFO_PATTERN and USER_FLAG_PATTERN (shared): ://, ://user:,
//   -u and --user= runs.
// - PACKAGE_PLACEHOLDER_ASSIGNMENT_PATTERN (package): <…>, {…}, {{…}}, $VAR,
//   ${VAR}; and the package expression scan on unclosed ${{ and stray }}.
// - The SECRET_RULES check on placeholder contents (both profiles): runs of
//   placeholders holding jwt, sk- and gh*_ prefixes, and a URL password
//   placeholder.
// - Both package readings, stripped and keeping line boundaries (package):
//   runs of line breaks, control characters, and token prefixes at line
//   starts.
// - findPackageFileCredentialRule (the bytes helper): every input above,
//   encoded. The definition-document path has its own block below.
const ADVERSARIAL_UNITS: readonly (readonly [string, string])[] = [
  ['private key header', '-----BEGIN A A A A '],
  ['pgp private key header', '-----BEGIN PGP PRIVATE KEY '],
  ['ssh2 private key header', '---- BEGIN SSH2 '],
  ['ssh2 encrypted private key header', '---- BEGIN SSH2 ENCRYPTED PRIVATE '],
  ['putty key file header', 'PuTTY-User-Key-File-'],
  ['putty key file version', 'PuTTY-User-Key-File-2'],
  ['jwt prefix', 'eyJa'],
  ['jwt dots', 'eyJa.'],
  ['github pat', 'github_pat_'],
  ['github token', 'ghp_'],
  ['slack', 'xoxb'],
  ['aws', 'AKIA'],
  ['sk prefix', 'sk-'],
  ['npm token', 'npm_'],
  ['auth header', 'Authorization '],
  ['bearer', 'Bearer '],
  ['credential colon', '"token" '],
  ['credential equals', 'api_key'],
  ['env assignment spaces', 'API_KEY '],
  ['env assignment tabs', 'TOKEN\t'],
  ['env code call', 'TOKEN = f();'],
  ['env literal call', 'TOKEN = f('],
  ['env code operator', 'TOKEN = a || b;'],
  ['env code declaration', ' const TOKEN = a.b;'],
  ['env code arrow', 'TOKEN => f(a, b);'],
  ['env code template', 'TOKEN = `${a}`;'],
  ['env code keyword chain', 'TOKEN = new new new f().g(x)[0] '],
  ['env code operator operand', 'TOKEN = a ?? b.c(d) '],
  ['env code bracket continuation', 'TOKEN = (a, b).c(d)[0] || e ? f : g;\n'],
  ['env code operator chain', 'TOKEN = f() || a || b || c || d;\n'],
  ['url scheme', 'a://b'],
  ['url user', 'a://b:'],
  ['user flag', ' -u a'],
  ['long user flag', ' --user=a'],
  ['angle placeholder', 'token: <'],
  ['expression placeholder', 'token: ${{ x '],
  ['brace placeholder', 'token: {{'],
  ['single brace placeholder', 'password={'],
  ['command placeholder', 'token: $('],
  ['nested command placeholder', 'token: $($('],
  ['env placeholder', 'token: env.'],
  ['variable placeholder', 'token=$'],
  ['unclosed expressions', '${{ a '],
  ['expression closers', '}}'],
  ['angle run', '<'],
  ['quote run', `"'`],
  ['placeholder holding a jwt prefix', 'token: <eyJa.'],
  ['expression placeholder holding a key prefix', 'token: ${{ sk-'],
  ['brace placeholder holding a token prefix', 'password={{ghp_'],
  ['url placeholder password', 'a://b:<eyJa'],
  ['line feeds', '\n'],
  ['lines ending in a word character', 'a\n'],
  ['carriage returns and line feeds', '\r\n'],
  ['control characters', '\u0001'],
  ['words split by a control character', 'a\u0001b'],
  ['token prefixes at line starts', 'done\nghp_'],
  // Escapes written as text, which the spaced reading reads as spaces
  // (CAN-7627).
  ['escaped line feeds', '\\n'],
  ['words before escaped line feeds', 'a\\n'],
  ['backslash runs before a letter', '\\\\n'],
  ['unfinished unicode escapes', '\\u000'],
  ['unicode escapes', '\\u000a'],
  ['unfinished percent escapes', '%0'],
  ['percent escapes between words', 'a%0Ab'],
  ['percent-u escapes', '%u000a'],
  ['escaped NULs', '\\0'],
  ['YAML line separators', '\\L'],
  ['token prefixes after escapes', 'done\\nghp_'],
  ['jwt prefixes after escapes', 'x\\neyJa.'],
  ['credential equals after escapes', 'x\\napi_key'],
  ['escaped breaks in an angle placeholder', 'token: <a\\n'],
];

// Growth, not wall time (CAN-7592): a loaded runner slows both timings
// alike, so their ratio holds where a 3 s ceiling failed linear code. The
// step-count goldens below remain the exact growth guards; this catches a
// slide of about 16 times over linear, and a milder super-linear term passes.
const SMALL_DIVISOR = 256;
const LINEAR_GROWTH_LIMIT = 16;

// The full input's time over the time of SMALL_DIVISOR runs of an input
// SMALL_DIVISOR times smaller: about 1 when linear (up to about 8 from cache
// effects at 4 MiB), about SMALL_DIVISOR when quadratic. Both timings cover
// the same amount of text, so a short run can't escape the runner's load
// that a long one shares. Up to three attempts keep the best of each and stop
// at the first under the limit, so one stall can't fail it.
function growthOverLinear(small: () => unknown, full: () => unknown): number {
  let smallBest = Number.POSITIVE_INFINITY;
  let fullBest = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let started = performance.now();
    for (let run = 0; run < SMALL_DIVISOR; run += 1) small();
    smallBest = Math.min(smallBest, performance.now() - started);
    started = performance.now();
    full();
    fullBest = Math.min(fullBest, performance.now() - started);
    if (fullBest / smallBest <= LINEAR_GROWTH_LIMIT) break;
  }
  return fullBest / smallBest;
}

describe('every regex in both profiles stays linear (CAN-7226)', () => {
  const MAX = PIPELINE_PACKAGE_MAX_FILE_BYTES;
  const fill = (unit: string, size: number): string =>
    unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const encoder = new TextEncoder();
  const PROFILES = [
    ['shared', findSharedTextCredentialRule],
    ['package', findPackageTextCredentialRule],
    [
      'package file bytes',
      (text: string): SecretMaterialRule | null =>
        findPackageFileCredentialRule(encoder.encode(text)),
    ],
  ] as const;
  it.each(
    PROFILES.flatMap(([profile, check]) =>
      ADVERSARIAL_UNITS.map(
        ([label, unit]) => [profile, label, unit, check] as const,
      ),
    ),
  )(
    '%s profile stays linear on %s at the maximum file size',
    (_profile, _label, unit, check) => {
      const text = fill(unit, MAX);
      const small = fill(unit, MAX / SMALL_DIVISOR);
      expect(text.length).toBe(MAX);
      expect(
        growthOverLinear(
          () => check(small),
          () => check(text),
        ),
      ).toBeLessThanOrEqual(LINEAR_GROWTH_LIMIT);
    },
  );
});

// The definition-document path (validator, then the file-check fallback) on
// adversarial pipeline YAML near its 1 MiB limit.
describe('the package definition path stays linear (CAN-7226)', () => {
  const YAML_SIZE = 1_000_000;
  const encoder = new TextEncoder();
  const check = (bytes: Uint8Array) => (): unknown =>
    findPackageEntryCredential({ definitionDocument: true, bytes });
  it.each([
    ['angle placeholders', 'token: <'],
    ['brace placeholders', 'token: {{'],
    ['unclosed expressions', '${{ a '],
    ['url placeholder passwords', 'a://b:<eyJa'],
    ['env assignments', 'API_KEY '],
  ])('stays linear on %s', (_label, unit) => {
    const definition = (size: number): Uint8Array =>
      encoder.encode(
        JSON.stringify({
          version: 1,
          kind: 'pipeline_definition',
          references: [],
          name: 'deploy',
          yaml: unit.repeat(Math.ceil(size / unit.length)).slice(0, size),
        }),
      );
    expect(
      growthOverLinear(
        check(definition(Math.floor(YAML_SIZE / SMALL_DIVISOR))),
        check(definition(YAML_SIZE)),
      ),
    ).toBeLessThanOrEqual(LINEAR_GROWTH_LIMIT);
  });
  it('stays linear on a non-definition JSON of many strings through the decoded fallback', () => {
    const STRINGS = 100_000;
    const strings = (count: number): Uint8Array =>
      encoder.encode(
        JSON.stringify({
          strings: Array.from({ length: count }, () => 'token: <eyJa.'),
        }),
      );
    expect(
      growthOverLinear(
        check(strings(Math.floor(STRINGS / SMALL_DIVISOR))),
        check(strings(STRINGS)),
      ),
    ).toBeLessThanOrEqual(LINEAR_GROWTH_LIMIT);
  });
});

// Growth measured by counting work, not time, so it can't flake (CAN-7343).
// A small backtracking interpreter runs the production placeholder pattern
// the way String.replace with /g does: each start index in turn, greedy
// repeats tried longest first. One step is one character or assertion test,
// backtracking retries included. Its matches must equal the real RegExp's on
// every input, and it refuses any regex feature it doesn't model, so it
// measures that pattern's own search. develop's unbounded copy above is the
// control: under the same count it grows quadratically.
type CharTest = (character: string) => boolean;
type RegexNode =
  | { readonly kind: 'char'; readonly test: CharTest }
  | { readonly kind: 'boundary' }
  | { readonly kind: 'sequence'; readonly items: readonly RegexNode[] }
  | { readonly kind: 'choice'; readonly options: readonly RegexNode[] }
  | {
      readonly kind: 'repeat';
      readonly test: CharTest;
      readonly min: number;
      readonly max: number;
    };

const WORD_CHARACTER = /[A-Za-z0-9_]/;
const SPACE_CHARACTER = /\s/;

function parseRegex(source: string, ignoreCase: boolean): RegexNode {
  let at = 0;
  const unmodelled = (what: string): never => {
    throw new Error(`The step counter doesn't model ${what} at ${at}.`);
  };
  const literal = (value: string): CharTest =>
    ignoreCase
      ? (character): boolean => character.toLowerCase() === value.toLowerCase()
      : (character): boolean => character === value;
  const escaped = (): CharTest => {
    const next = source[at++] ?? unmodelled('a trailing escape');
    if (next === 's')
      return (character): boolean => SPACE_CHARACTER.test(character);
    if (next === 'r') return literal('\r');
    if (next === 'n') return literal('\n');
    if (next === 't') return literal('\t');
    if (/[A-Za-z0-9]/.test(next)) return unmodelled(`the escape \\${next}`);
    return literal(next);
  };
  const characterClass = (): CharTest => {
    const negate = source[at] === '^';
    if (negate) at += 1;
    const tests: CharTest[] = [];
    while (source[at] !== ']') {
      if (at >= source.length) unmodelled('an unclosed class');
      if (source[at] === '\\') {
        at += 1;
        tests.push(escaped());
        continue;
      }
      const low = source[at++] ?? '';
      if (source[at] === '-' && source[at + 1] !== ']') {
        const high = source[at + 1] ?? '';
        at += 2;
        tests.push(
          (character): boolean => character >= low && character <= high,
        );
      } else tests.push(literal(low));
    }
    at += 1;
    const inClass = (character: string): boolean =>
      tests.some((test) => test(character));
    const caseless = (character: string): boolean =>
      inClass(character) ||
      (ignoreCase &&
        (inClass(character.toLowerCase()) || inClass(character.toUpperCase())));
    return negate ? (character): boolean => !caseless(character) : caseless;
  };
  const quantified = (atom: RegexNode): RegexNode => {
    const next = source[at];
    let min: number;
    let max: number;
    if (next === '?') [min, max] = [0, 1];
    else if (next === '*') [min, max] = [0, Number.POSITIVE_INFINITY];
    else if (next === '+') [min, max] = [1, Number.POSITIVE_INFINITY];
    else if (next === '{') {
      const bound = /^\{(\d+)(?:,(\d*))?\}/.exec(source.slice(at));
      if (bound === null) return unmodelled('a brace that is not a bound');
      min = Number(bound[1]);
      max =
        bound[2] === undefined
          ? min
          : bound[2] === ''
            ? Number.POSITIVE_INFINITY
            : Number(bound[2]);
      at += bound[0].length - 1;
    } else return atom;
    at += 1;
    if (source[at] === '?') unmodelled('a lazy quantifier');
    if (atom.kind !== 'char') return unmodelled('a quantified group');
    return { kind: 'repeat', test: atom.test, min, max };
  };
  const choice = (): RegexNode => {
    const options: RegexNode[] = [sequence()];
    while (source[at] === '|') {
      at += 1;
      options.push(sequence());
    }
    return options.length === 1
      ? (options[0] ?? unmodelled('an empty choice'))
      : { kind: 'choice', options };
  };
  const atom = (): RegexNode => {
    const next = source[at++] ?? '';
    if (next === '(') {
      if (source.slice(at, at + 2) !== '?:') unmodelled('a capturing group');
      at += 2;
      const inner = choice();
      if (source[at++] !== ')') unmodelled('an unclosed group');
      return inner;
    }
    if (next === '[') return { kind: 'char', test: characterClass() };
    if (next === '\\') {
      if (source[at] === 'b') {
        at += 1;
        return { kind: 'boundary' };
      }
      return { kind: 'char', test: escaped() };
    }
    if ('.^$'.includes(next)) return unmodelled(`'${next}'`);
    return { kind: 'char', test: literal(next) };
  };
  function sequence(): RegexNode {
    const items: RegexNode[] = [];
    while (at < source.length && source[at] !== '|' && source[at] !== ')')
      items.push(quantified(atom()));
    return { kind: 'sequence', items };
  }
  const root = choice();
  if (at !== source.length) unmodelled('trailing input');
  return root;
}

interface StepCount {
  readonly steps: number;
  readonly spans: readonly (readonly [number, number])[];
}

function stepCounter(pattern: RegExp): (text: string) => StepCount {
  const root = parseRegex(pattern.source, pattern.flags.includes('i'));
  return (text) => {
    let steps = 0;
    const isWord = (index: number): boolean =>
      index >= 0 &&
      index < text.length &&
      WORD_CHARACTER.test(text[index] ?? '');
    type Next = (position: number) => number | null;
    const run = (
      node: RegexNode,
      position: number,
      next: Next,
    ): number | null => {
      switch (node.kind) {
        case 'char':
          steps += 1;
          return position < text.length && node.test(text[position] ?? '')
            ? next(position + 1)
            : null;
        case 'boundary':
          steps += 1;
          return isWord(position - 1) !== isWord(position)
            ? next(position)
            : null;
        case 'choice':
          for (const option of node.options) {
            const end = run(option, position, next);
            if (end !== null) return end;
          }
          return null;
        case 'sequence': {
          const from = (index: number, at: number): number | null => {
            const item = node.items[index];
            return item === undefined
              ? next(at)
              : run(item, at, (after) => from(index + 1, after));
          };
          return from(0, position);
        }
        case 'repeat': {
          let count = 0;
          while (count < node.max && position + count < text.length) {
            steps += 1;
            if (!node.test(text[position + count] ?? '')) break;
            count += 1;
          }
          for (; count >= node.min; count -= 1) {
            const end = next(position + count);
            if (end !== null) return end;
          }
          return null;
        }
      }
    };
    const spans: (readonly [number, number])[] = [];
    let start = 0;
    while (start <= text.length) {
      steps += 1;
      const end = run(root, start, (position) => position);
      if (end === null) start += 1;
      else {
        spans.push([start, end]);
        start = end > start ? end : start + 1;
      }
    }
    return { steps, spans };
  };
}

function realSpans(
  pattern: RegExp,
  text: string,
): readonly (readonly [number, number])[] {
  return Array.from(
    text.matchAll(new RegExp(pattern.source, pattern.flags)),
    (match) => [match.index, match.index + match[0].length] as const,
  );
}

const fillTo = (unit: string, size: number): string =>
  unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

/** Each doubling's growth factor: about 2 is linear, about 4 quadratic. */
function growth(counts: readonly number[]): number[] {
  return counts.slice(1).map((count, index) => count / (counts[index] ?? 1));
}

describe('package placeholder growth, counted in steps (CAN-7343)', () => {
  const SIZES = [1024, 2048, 4096, 8192];
  // Capped at 4 KB: the quadratic control is slow by design.
  const CONTROL_SIZES = [1024, 2048, 4096];
  const UNITS = [
    ['unclosed brace placeholders', 'token: {{'],
    ['unclosed angle placeholders', 'token: <'],
  ] as const;
  const production = stepCounter(PACKAGE_PLACEHOLDER_ASSIGNMENT_PATTERN);
  const develop = stepCounter(REFERENCE_PLACEHOLDER);
  const counted = (
    pattern: RegExp,
    count: (text: string) => StepCount,
    unit: string,
    sizes: readonly number[],
  ): number[] =>
    sizes.map((size) => {
      const text = fillTo(unit, size);
      const result = count(text);
      // The counter measures the pattern's real search.
      expect(result.spans).toEqual(realSpans(pattern, text));
      return result.steps;
    });

  it.each(UNITS)(
    '%s: the production pattern grows linearly',
    (_label, unit) => {
      const steps = counted(
        PACKAGE_PLACEHOLDER_ASSIGNMENT_PATTERN,
        production,
        unit,
        SIZES,
      );
      for (const factor of growth(steps))
        expect(factor).toBeLessThanOrEqual(2.2);
      // Eight times the input, within ten times the steps; quadratic would
      // be about sixty-four.
      expect(steps[3] ?? 0).toBeLessThanOrEqual((steps[0] ?? 0) * 10);
    },
  );

  it.each(UNITS)(
    "%s: develop's unbounded copy grows quadratically under the same count",
    (_label, unit) => {
      const steps = counted(
        REFERENCE_PLACEHOLDER,
        develop,
        unit,
        CONTROL_SIZES,
      );
      for (const factor of growth(steps))
        expect(factor).toBeGreaterThanOrEqual(3.5);
    },
  );

  it('matches the real pattern on placeholders that do close, and refuses what it does not model', () => {
    const text = fillTo('token: <value> api_key={{ x }} pwd=$PASS ', 4096);
    expect(production(text).spans).toEqual(
      realSpans(PACKAGE_PLACEHOLDER_ASSIGNMENT_PATTERN, text),
    );
    expect(() => stepCounter(/(?=a)b/)).toThrow(/doesn't model/);
    expect(() => stepCounter(/a+?/)).toThrow(/doesn't model/);
  });
});

describe('pipeline expression pass growth, counted in characters scanned (CAN-7343)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });
  // The pass finds each `${{` and its `}}` with indexOf; this counts the
  // characters those searches cover, which a rescan from every opener would
  // make quadratic.
  // The real indexOf, read from its descriptor rather than as a detached
  // method reference.
  const realIndexOf = (): unknown =>
    Object.getOwnPropertyDescriptor(String.prototype, 'indexOf')?.value;
  const scannedBy = (text: string): number => {
    const original = realIndexOf();
    if (typeof original !== 'function')
      throw new Error('String.prototype.indexOf is missing');
    let scanned = 0;
    const spy = jest
      .spyOn(String.prototype, 'indexOf')
      .mockImplementation(function (
        this: string,
        search: string,
        position?: number,
      ): number {
        const found: unknown = Reflect.apply(original, this, [
          search,
          position,
        ]);
        if (typeof found !== 'number')
          throw new Error('indexOf returned a non-number');
        if (search === '${{' || search === '}}') {
          const from = position ?? 0;
          scanned +=
            (found === -1 ? this.length : found + search.length) - from;
        }
        return found;
      });
    try {
      findPackageTextCredentialRule(text);
    } finally {
      spy.mockRestore();
    }
    return scanned;
  };

  it.each([
    ['unclosed expressions', '${{ a '],
    ['closed expressions', '${{ a }} '],
  ])('%s: grows linearly', (_label, unit) => {
    const indexOfBefore = realIndexOf();
    const scanned = [1024, 2048, 4096, 8192].map((size) =>
      scannedBy(fillTo(unit, size)),
    );
    for (const factor of growth(scanned))
      expect(factor).toBeLessThanOrEqual(2.2);
    // The spy is gone, so nothing leaks into other tests.
    expect(realIndexOf()).toBe(indexOfBefore);
  });
});

// Read from source (CAN-7343): every bracketed placeholder arm, here and in
// the capability definition check, bounds its negated class, and neither
// module has a lazy quantifier, such as develop's cross-delimiter
// `\$\{\{[\s\S]*?\}\}`. The step counter above doesn't cover
// capability-definitions.ts; this does. A pattern it can't find fails.
describe('placeholder patterns stay bounded in source (CAN-7343)', () => {
  const read = (relative: string): string =>
    readFileSync(join(__dirname, relative), 'utf8');
  const between = (source: string, start: string, end: string): string => {
    const from = source.indexOf(start);
    if (from === -1) throw new Error(`can't find ${start}`);
    const to = source.indexOf(end, from + start.length);
    if (to === -1) throw new Error(`can't find the end of ${start}`);
    return source.slice(from + start.length, to);
  };
  // The quantifier written after each negated class, '' when there is none.
  const negatedClassQuantifiers = (pattern: string): string[] =>
    Array.from(
      pattern.matchAll(/\[\^(?:\\.|[^\]\\])*\](\{\d+,\d*\}|[+*?])?/g),
      (match) => match[1] ?? '',
    );
  const isBounded = (quantifier: string): boolean => {
    const match = /^\{(\d+),(\d+)\}$/.exec(quantifier);
    if (match === null) return false;
    const [low, high] = [Number(match[1]), Number(match[2])];
    return low >= 1 && low <= high && high <= 256;
  };
  const secretScanArms = (source: string): string[] =>
    negatedClassQuantifiers(
      between(
        source,
        'export const PACKAGE_PLACEHOLDER_ASSIGNMENT_PATTERN = new RegExp(',
        ');',
      ),
    );
  const capabilityArms = (source: string): string[][] => {
    const arms = Array.from(
      between(source, 'const NAMED_PLACEHOLDER_SOURCE = [', '].join(').matchAll(
        /String\.raw`([^`]*)`/g,
      ),
      (match) => match[1] ?? '',
    );
    if (arms.length !== 7)
      throw new Error(`expected 7 placeholder arms, found ${arms.length}`);
    return arms
      .filter((arm) => /^(?:<|\\\$\\\{\\\{|\\\{\\\{)\[\^/.test(arm))
      .map(negatedClassQuantifiers);
  };
  const LAZY_QUANTIFIER = /(?:\*|\+|\{\d+(?:,\d*)?\})\?/;
  const lazyCodeLines = (source: string): string[] =>
    source
      .split('\n')
      .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
      .filter((line) => LAZY_QUANTIFIER.test(line));
  const SECRET_SCAN = read('../secret-scan.ts');
  const CAPABILITY_DEFINITIONS = read(
    '../../shared-containers/capability-definitions.ts',
  );

  it('bounds both negated classes in the package placeholder pattern', () => {
    const quantifiers = secretScanArms(SECRET_SCAN);
    expect(quantifiers).toHaveLength(2);
    expect(quantifiers.filter((quantifier) => !isBounded(quantifier))).toEqual(
      [],
    );
  });

  it('bounds the negated class in each bracketed capability placeholder arm', () => {
    const arms = capabilityArms(CAPABILITY_DEFINITIONS);
    expect(arms).toHaveLength(3);
    for (const quantifiers of arms) {
      expect(quantifiers).toHaveLength(1);
      expect(
        quantifiers.filter((quantifier) => !isBounded(quantifier)),
      ).toEqual([]);
    }
  });

  it('finds no lazy quantifier outside comments in either module', () => {
    for (const source of [SECRET_SCAN, CAPABILITY_DEFINITIONS]) {
      expect(source.split('\n').length).toBeGreaterThan(100);
      expect(lazyCodeLines(source)).toEqual([]);
    }
  });

  it("flags unbounded and lazy forms, and fails when it can't find a pattern", () => {
    expect(
      negatedClassQuantifiers('<[^>\\r\\n]+>|{{[^}]*}}|<[^>]{1,}>'),
    ).toEqual(['+', '*', '{1,}']);
    expect(['+', '*', '{1,}', '{0,256}', '{1,257}', ''].some(isBounded)).toBe(
      false,
    );
    expect(isBounded('{1,256}')).toBe(true);
    expect(
      lazyCodeLines('const e = /\\$\\{\\{([\\s\\S]*?)\\}\\}/g;'),
    ).toHaveLength(1);
    expect(lazyCodeLines(' * a lazy `[\\s\\S]*?` in a comment')).toEqual([]);
    expect(() => secretScanArms('')).toThrow(/can't find/);
    expect(() => capabilityArms('')).toThrow(/can't find/);
  });
});

describe('one member file check for a shared skill or plugin, on desktop and hosted (CAN-7482)', () => {
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
  const TOKEN_TAIL = 'Q'.repeat(30);
  const PASSWORD = `pw${'Z'.repeat(12)}`;
  type MemberRule = ReturnType<typeof findSharedMemberFileCredentialRule>;
  // Each file, what the package profile alone finds, and what the member
  // check finds. The member check differs only where the package profile
  // finds nothing.
  const MEMBER_FILES: readonly (readonly [
    string,
    string,
    SecretMaterialRule | null,
    MemberRule,
  ])[] = [
    ['plain notes', 'Deploy with the release script.\n', null, null],
    [
      'a token',
      `token: gh${'p'}_${TOKEN_TAIL}\n`,
      'github_token',
      'github_token',
    ],
    [
      'a credential variable',
      `Run with NPM_TOKEN=${PASSWORD} set.\n`,
      null,
      'env_assignment',
    ],
    [
      'a password in a URL',
      `Connect to postgres://admin:${PASSWORD}@db/app.\n`,
      null,
      'url_credentials',
    ],
    [
      'a password in a URL behind JSON escapes',
      `{"database":"postgres:\\/\\/admin:${PASSWORD}@db\\/app"}\n`,
      null,
      'url_credentials',
    ],
    [
      'a unicode-escaped password key in JSON',
      `{"\\u0070assword":${'7'.repeat(12)}}\n`,
      null,
      'credential_assignment',
    ],
    [
      'a token behind a unicode escape in YAML',
      `run: "deploy with gh\\u0070_${TOKEN_TAIL}"\n`,
      null,
      'github_token',
    ],
    [
      'JSON too deeply nested to check',
      `${'['.repeat(20_000)}${']'.repeat(20_000)}\n`,
      null,
      'unreadable',
    ],
  ];

  it.each(MEMBER_FILES)(
    'names the rule for %s, and the package profile alone finds only what it finds',
    (_label, text, packageRule, memberRule) => {
      const bytes = encode(text);
      expect(findPackageFileCredentialRule(bytes)).toBe(packageRule);
      expect(findSharedMemberFileCredentialRule(bytes)).toBe(memberRule);
    },
  );

  it('runs the package profile first, so it never misses what a package upload refuses', () => {
    for (const [, text] of SAMPLES) {
      const bytes = encode(`before ${text} after`);
      const packageRule = findPackageFileCredentialRule(bytes);
      expect(packageRule).not.toBeNull();
      expect(findSharedMemberFileCredentialRule(bytes)).toBe(packageRule);
    }
  });

  it('reads bytes that are not UTF-8 leniently, as the package profile does', () => {
    const bytes = new Uint8Array([
      0xff,
      0xfe,
      0x00,
      ...encode(` NPM_TOKEN=${PASSWORD}\n`),
    ]);
    expect(findPackageFileCredentialRule(bytes)).toBeNull();
    expect(findSharedMemberFileCredentialRule(bytes)).toBe('env_assignment');
  });

  it('decodes text escapes into a copy, or gives null when there are none', () => {
    expect(escapeDecodedCopy('no escapes here')).toBeNull();
    expect(escapeDecodedCopy('a\\u0070b\\x41c\\/d\\U0001F600')).toBe(
      'apbAc/d\u{1F600}',
    );
    expect(escapeDecodedCopy('bad \\U00110000 and \\u0070')).toBe(
      'bad \\U00110000 and p',
    );
    expect(escapeDecodedCopy('only \\U00110000')).toBeNull();
  });
});

// CAN-7625: PGP, SSH2 and PuTTY private keys, built at run time. Each is
// refused from its header alone, so a block cut off before its end line, or
// carrying no body at all, is refused just as a whole one is.
describe('every private key format is refused by the shared checks (CAN-7625)', () => {
  const PRIVATE = 'PRIVATE';
  const BODY = [
    'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
    'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU=',
  ];
  const FORMATS: readonly (readonly [
    string,
    string,
    readonly string[],
    string,
  ])[] = [
    [
      'PEM',
      `-----BEGIN ${PRIVATE} KEY-----`,
      BODY,
      `-----END ${PRIVATE} KEY-----`,
    ],
    [
      'PEM RSA',
      `-----BEGIN RSA ${PRIVATE} KEY-----`,
      BODY,
      `-----END RSA ${PRIVATE} KEY-----`,
    ],
    [
      'PEM EC',
      `-----BEGIN EC ${PRIVATE} KEY-----`,
      BODY,
      `-----END EC ${PRIVATE} KEY-----`,
    ],
    [
      'PEM OpenSSH',
      `-----BEGIN OPENSSH ${PRIVATE} KEY-----`,
      BODY,
      `-----END OPENSSH ${PRIVATE} KEY-----`,
    ],
    [
      'PEM encrypted',
      `-----BEGIN ENCRYPTED ${PRIVATE} KEY-----`,
      BODY,
      `-----END ENCRYPTED ${PRIVATE} KEY-----`,
    ],
    [
      'PGP',
      `-----BEGIN PGP ${PRIVATE} KEY BLOCK-----`,
      ['', ...BODY, '=Ab3x'],
      `-----END PGP ${PRIVATE} KEY BLOCK-----`,
    ],
    [
      'SSH2 encrypted',
      `---- BEGIN SSH2 ENCRYPTED ${PRIVATE} KEY ----`,
      ['Comment: "key"', ...BODY],
      `---- END SSH2 ENCRYPTED ${PRIVATE} KEY ----`,
    ],
    [
      'SSH2',
      `---- BEGIN SSH2 ${PRIVATE} KEY ----`,
      BODY,
      `---- END SSH2 ${PRIVATE} KEY ----`,
    ],
    [
      'PuTTY v2',
      `PuTTY-User-${'Key'}-File-2: ssh-rsa`,
      [
        'Encryption: none',
        'Comment: key',
        'Public-Lines: 1',
        BODY[0],
        'Private-Lines: 1',
        BODY[1],
      ],
      'Private-MAC: 0a1b2c3d',
    ],
    [
      'PuTTY v3',
      `PuTTY-User-${'Key'}-File-3: ssh-ed25519`,
      [
        'Encryption: none',
        'Comment: key',
        'Public-Lines: 1',
        BODY[0],
        'Private-Lines: 1',
        BODY[1],
      ],
      'Private-MAC: 0a1b2c3d',
    ],
  ];
  const encoder = new TextEncoder();
  const CHECKS = [
    [
      'secret material',
      (text: string): SecretMaterialRule | null => findSecretMaterialRule(text),
    ],
    ['shared text', findSharedTextCredentialRule],
    ['package text', findPackageTextCredentialRule],
    [
      'package file bytes',
      (text: string): SecretMaterialRule | null =>
        findPackageFileCredentialRule(encoder.encode(text)),
    ],
    [
      'shared member file bytes',
      (text: string): string | null =>
        findSharedMemberFileCredentialRule(encoder.encode(text)),
    ],
  ] as const;
  const SHAPES = [
    ['the header alone', (header: string): string => header],
    [
      'a whole block',
      (header: string, body: readonly string[], end: string): string =>
        [header, ...body, end].join('\n'),
    ],
    [
      'a block cut off before its end line',
      (header: string, body: readonly string[]): string =>
        [header, ...body].join('\n'),
    ],
    [
      'a block inside other text',
      (header: string, body: readonly string[], end: string): string =>
        ['setup output', header, ...body, end, 'done'].join('\n'),
    ],
  ] as const;

  it.each(
    FORMATS.flatMap(([format, header, body, end]) =>
      SHAPES.flatMap(([shape, build]) =>
        CHECKS.map(
          ([check, run]) =>
            [format, shape, check, build(header, body, end), run] as const,
        ),
      ),
    ),
  )(
    '%s as %s is refused by the %s check',
    (_format, _shape, _check, text, run) => {
      expect(run(text)).toBe('private_key');
    },
  );

  // The package profile drops line breaks before it checks, so a PuTTY header
  // right after a line ending in a word character must still be found.
  it('finds a PuTTY header that follows a line ending in a word character, in the package profile', () => {
    const text = `echo done\nPuTTY-User-${'Key'}-File-3: ssh-ed25519`;
    expect(findPackageTextCredentialRule(text)).toBe('private_key');
    expect(findPackageFileCredentialRule(encoder.encode(text))).toBe(
      'private_key',
    );
    expect(findSecretMaterialRule(text)).toBe('private_key');
  });

  it.each([
    [
      'a PGP public key',
      `-----BEGIN PGP PUBLIC KEY BLOCK-----\n${BODY[0]}\n-----END PGP PUBLIC KEY BLOCK-----`,
    ],
    [
      'a PGP signature',
      `-----BEGIN PGP SIGNATURE-----\n${BODY[0]}\n-----END PGP SIGNATURE-----`,
    ],
    [
      'an SSH2 public key',
      `---- BEGIN SSH2 PUBLIC KEY ----\n${BODY[0]}\n---- END SSH2 PUBLIC KEY ----`,
    ],
    [
      'a PEM public key',
      `-----BEGIN PUBLIC KEY-----\n${BODY[0]}\n-----END PUBLIC KEY-----`,
    ],
    [
      'a certificate',
      `-----BEGIN CERTIFICATE-----\n${BODY[0]}\n-----END CERTIFICATE-----`,
    ],
    [
      'prose naming the PuTTY format',
      'Convert the key to the PuTTY-User-Key-File-3 format with puttygen.',
    ],
    [
      'prose naming a .ppk file',
      'Load the PuTTY key file (key.ppk) in Pageant.',
    ],
  ])('%s is not a private key', (_label, text) => {
    expect(findSecretMaterialRule(text)).toBeNull();
    expect(findSharedTextCredentialRule(text)).toBeNull();
  });
});

// CAN-7626: the package profile read text with every control character
// dropped, line breaks and tabs included, so a line ending in a letter or
// digit ran into the next and a token at the start of that line lost the
// boundary its rule needs. It now also reads a copy that keeps line breaks
// and tabs, with every other control character as a space, and refuses when
// either reading trips: develop's stripped reading first, so a rule name it
// gives doesn't change.
describe('the package profile keeps line boundaries (CAN-7626)', () => {
  const encoder = new TextEncoder();
  const SEPARATORS = [
    ['a line feed', '\n'],
    ['a carriage return and line feed', '\r\n'],
    ['a tab', '\t'],
    ['another control character', '\u0001'],
  ] as const;

  it.each(
    SAMPLES.flatMap(([rule, sample]) =>
      SEPARATORS.map(([label, separator]) => [rule, label, separator, sample]),
    ),
  )(
    'finds %s after %s that follows a word character',
    (rule, _label, separator, sample) => {
      const text = `echo done${separator}${sample}`;
      expect(findSecretMaterialRule(sample)).toBe(rule);
      expect(findPackageTextCredentialRule(text)).toBe(rule);
      expect(findPackageFileCredentialRule(encoder.encode(text))).toBe(rule);
    },
  );

  // develop's stripped reading joins these into a token or key, so they
  // stay refused; reading control characters as spaces alone would lose them.
  it.each([
    [
      'a token a control character splits',
      `gh\u0001${'p'}_${repeat('S', 30)}`,
      'github_token',
    ],
    [
      'a token a line break splits',
      `gh\n${'p'}_${repeat('S', 30)}`,
      'github_token',
    ],
    [
      'a credential key a control character splits',
      `api\u0007_${'key'}=value-one`,
      'credential_assignment',
    ],
  ])('still finds %s, as develop does', (_label, text, rule) => {
    expect(referencePackageCheck(text)).toBe(true);
    expect(findPackageTextCredentialRule(text)).toBe(rule);
    expect(findPackageFileCredentialRule(encoder.encode(text))).toBe(rule);
  });

  it('refuses a member file of a hosted package commit holding a token at a line start', () => {
    const token = `gh${'p'}_${repeat('H', 30)}`;
    expect(
      findPackageEntryCredential({
        definitionDocument: false,
        bytes: encoder.encode(`echo done\n${token}\n`),
      }),
    ).toEqual({ rule: 'github_token' });
  });

  // A bracketed placeholder a line break splits isn't neutralized in the
  // reading that keeps line boundaries, since the placeholder patterns stop
  // at a line break; the shared check and the raw text check refuse it too.
  it.each([
    ['an angle placeholder', 'token: <your\nkey>'],
    ['a brace placeholder', 'token: {{ your\nkey }}'],
  ])('refuses %s a line break splits, which develop passed', (_label, text) => {
    expect(referencePackageCheck(text)).toBe(false);
    expect(findPackageTextCredentialRule(text)).toBe('credential_assignment');
    expect(findPackageFileCredentialRule(encoder.encode(text))).toBe(
      'credential_assignment',
    );
    expect(findSecretMaterialRule(text)).toBe('credential_assignment');
  });

  // develop reads a placeholder at a line start after a word character as
  // part of the word before it, so it isn't neutralized; the stripped
  // reading still runs first, so this stays as it was.
  it('still refuses a placeholder at a line start after a word character, as develop does', () => {
    const text = 'echo done\ntoken: <your key>';
    expect(referencePackageCheck(text)).toBe(true);
    expect(findPackageTextCredentialRule(text)).toBe('credential_assignment');
  });

  it.each([
    ['multi-line steps', 'steps:\n  - run: deploy\n  - run: notify\n'],
    [
      'a placeholder after a line ending in punctuation',
      'echo done.\ntoken: <your key>\n',
    ],
    ['an indented variable placeholder', 'run: deploy\n  api_key=$API_KEY\n'],
    ['an expression over a line break', 'token: ${{ secrets.\nNAME }}'],
    ['a placeholder after a control character', 'token:\u0001<your key>'],
    ['tab-indented prose', 'Notes:\n\tKeep the release notes short.\n'],
    ['a short token-like word at a line start', 'echo done\nghp is a prefix'],
  ])('passes %s', (_label, text) => {
    expect(findPackageTextCredentialRule(text)).toBeNull();
    expect(findPackageFileCredentialRule(encoder.encode(text))).toBeNull();
  });
});

// An escape written as text before a token, such as `\n` in a JSON or YAML
// string, `%0A` or `\u000a`, leaves a letter or digit where the token's
// leading boundary should be. Each check reads its text as written and, when
// that finds nothing, once more with each escape read as a space (CAN-7627).
describe('a token after an escape written as text is refused by every check (CAN-7627)', () => {
  const ESCAPES = [
    '\\n',
    '\\t',
    '\\r',
    '\\r\\n',
    '\\b',
    '\\f',
    '\\v',
    '\\0',
    '\\a',
    '\\e',
    '\\N',
    '\\_',
    '\\L',
    '\\P',
    '%0A',
    '%09',
    '%0D%0A',
    '%u000a',
    '\\u000a',
    '\\x0a',
  ];
  const CONTAINERS: readonly (readonly [string, (body: string) => string])[] = [
    ['a JSON string', (body) => `{"a":"${body}"}`],
    ['a YAML double-quoted string', (body) => `a: "${body}"`],
    ['a YAML single-quoted string', (body) => `a: '${body}'`],
    ['plain text', (body) => body],
  ];
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
  const everyCheck = (text: string): unknown[] => [
    findSecretMaterialRule(text),
    findSharedTextCredentialRule(text),
    findSharedMemberFileCredentialRule(bytes(text)),
    findPackageTextCredentialRule(text),
    findPackageFileCredentialRule(bytes(text)),
    findPackageEntryCredential({
      definitionDocument: false,
      bytes: bytes(text),
    })?.rule ?? null,
  ];

  // The shared and member checks keep the rule develop names when develop
  // already refuses the text: develop's env rule catches `api_key=…` after
  // any escape, so those two name env_assignment there.
  it.each(
    SAMPLES.flatMap(([rule, sample]) =>
      ESCAPES.flatMap((escape) =>
        CONTAINERS.map(
          ([where, wrap]) =>
            [rule, escape, where, wrap(`done${escape}${sample}`)] as const,
        ),
      ),
    ),
  )(
    'names %s after %s in %s, in every check',
    (rule, _escape, _where, text) => {
      expect(everyCheck(text)).toEqual([
        rule,
        findSharedTextCredentialRule(text, ESCAPES_AS_WRITTEN) ?? rule,
        findSharedMemberFileCredentialRule(bytes(text), ESCAPES_AS_WRITTEN) ??
          rule,
        rule,
        rule,
        rule,
      ]);
    },
  );

  // An entity ends in `;`, which is already a boundary.
  it.each(
    SAMPLES.flatMap(([rule, sample]) =>
      ['&#10;', '&#x0a;'].map(
        (entity) => [rule, entity, `done${entity}${sample}`] as const,
      ),
    ),
  )('already names %s after the entity %s', (rule, _entity, text) => {
    expect(everyCheck(text)).toEqual(Array(6).fill(rule));
  });

  it.each([
    'C:\\\\new\\\\data',
    'C:\\new\\data',
    'const pattern = /\\bgh[opusr]_[A-Za-z0-9]{20,}/;',
    'const match = header.match(/Bearer\\s+(.+)/i);',
    'if (/^Authorization\\s*:/i.test(line)) return;',
    '{"a":"line one\\nline two"}',
    'a: "line one\\nline two"',
    'echo "first\\tsecond\\r\\nthird"',
    'GET /search?q=a%20b%0Ac',
    'Strings end at the first \\0 byte, so pad them.',
    'char buf[] = "name\\0value";',
    'print("a\\N{EN DASH}b")',
    "preg_match('/^\\N+$/', $line)",
    'echo -e "\\e[1;31mERROR\\e[0m done"',
    'const bell = /\\a/;',
    'const controls = /[\\a\\e\\f]/g;',
    'title: "a\\_b"',
    'note: "line one\\Lline two\\Pline three\\Nline four"',
  ])('finds nothing in the ordinary escaped text %j', (text) => {
    expect(everyCheck(text)).toEqual(Array(6).fill(null));
  });

  it.each(SAMPLES)(
    'keeps the rule %s for a secret it finds as written, with escapes around it',
    (rule, sample) => {
      for (const text of [
        `before ${sample} after`,
        `x\\n before ${sample} after %0A`,
      ])
        expect(findSecretMaterialRule(text)).toBe(rule);
    },
  );

  it('keeps the rule develop names when a later rule already refused the text', () => {
    const note = `{"note":"Run with NPM\\u005fTOKEN=${repeat('Z', 16)} set."}\n`;
    expect(findSharedTextCredentialRule(note)).toBe('env_assignment');
    expect(findSharedMemberFileCredentialRule(bytes(note))).toBe(
      'env_assignment',
    );
    expect(findPackageFileCredentialRule(bytes(note))).toBe(
      'credential_assignment',
    );
    const printf = "printf 'username=%s\\npassword=%s\\n'";
    expect(findSharedTextCredentialRule(printf)).toBe('env_assignment');
    expect(findSharedMemberFileCredentialRule(bytes(printf))).toBe(
      'env_assignment',
    );
  });

  // Stated: the material check has no placeholder notion, so an escaped key
  // with a template value trips it, as `token=${X}` always did; every
  // profile neutralizes the placeholder in the spaced reading.
  it.each([
    ['an escaped underscore', 'Run with NPM\\u005fTOKEN=${LITERAL_VALUE} set.'],
    ['an escaped NUL', 'PATH=/bin\\0TOKEN=${SECRET}\\0'],
  ])(
    'refuses a key behind %s with a template value in the material check alone, a stated false positive',
    (_label, text) => {
      expect(everyCheck(text)).toEqual([
        'credential_assignment',
        null,
        null,
        null,
        null,
        null,
      ]);
    },
  );

  // A label (a file, path, name or key) is shown only when it is clean both
  // as written and with each escape read as a space, whichever pass made the
  // finding. One label here is a secret only as written (its percent escapes
  // read as spaces hide it), the other only when spaced.
  const LABELS = [
    ['only as written', `skills/pwd=%53%65%63%72%65%74/helper`],
    ['only when spaced', `skills/done%0Agh${'p'}_${repeat('L', 30)}/helper`],
  ] as const;
  const caughtAsWritten = `done gh${'p'}_${repeat('W', 30)}`;
  const caughtSpaced = `done\\ngh${'p'}_${repeat('S', 30)}`;
  const messages = (
    finding: Parameters<typeof sharedSkillSecretMessage>[0],
  ): string[] => [
    sharedSkillSecretMessage(finding),
    collectionSkillSecretMessage(finding),
    packagedSkillSecretMessage(finding),
    pluginSecretMessage(finding),
  ];

  it.each(
    LABELS.flatMap(([which, label]) =>
      [
        ['as written', caughtAsWritten],
        ['spaced', caughtSpaced],
      ].map(([pass, text]) => [which, pass, label, text] as const),
    ),
  )(
    'never shows a file path that is a secret %s, in a finding the %s pass makes',
    (_which, _pass, label, text) => {
      const finding = scanSharedSkillForSecrets({
        skillName: 'notes',
        files: [{ path: `${label}/SKILL.md`, text }],
      });
      expect(finding).toMatchObject({ file: '[redacted path]' });
      if (finding === null) throw new Error('no finding');
      for (const message of messages(finding))
        expect(message).not.toContain(label);
    },
  );

  it.each(LABELS)(
    'never shows a skill name that is a secret %s',
    (_which, label) => {
      for (const text of ['Write tidy notes.', caughtAsWritten, caughtSpaced]) {
        const finding = scanSharedSkillForSecrets({
          skillName: label,
          files: [{ path: 'SKILL.md', text }],
        });
        expect(finding).toMatchObject({ skillName: '[redacted name]' });
        if (finding === null) throw new Error('no finding');
        for (const message of messages(finding))
          expect(message).not.toContain(label);
      }
    },
  );

  it.each([
    ['only as written', 'api_key=%41%42%43'],
    ['only when spaced', `done%0Agh${'p'}_${repeat('K', 30)}`],
  ])('never shows an object key that is a secret %s', (_which, key) => {
    expect(credentialPathSegment(key)).toBe('[redacted key]');
  });

  it.each(LABELS)(
    'the one label helper hides a label that is a secret %s',
    (_which, label) => {
      expect(labelSecretRule(label, sharedTextLabelCheck)).not.toBeNull();
      expect(displayableLabel(label, '[redacted]', sharedTextLabelCheck)).toBe(
        '[redacted]',
      );
      expect(
        displayableLabel('notes/setup.md', null, sharedTextLabelCheck),
      ).toBe('notes/setup.md');
    },
  );

  // Every site that shows or names a label (a file, path, name, key or other
  // shown value) goes through labelSecretRule or displayableLabel, so no site
  // can check a label one way only. The analyzer holds no other label check;
  // the hosted upload and plugin checks are guarded in their own goldens.
  it.each([
    '../../../../desktop-shared/src/node/pipelines/package-analyzer.ts',
  ])('%s checks labels only through the one helper', (relative) => {
    const source = readFileSync(join(__dirname, relative), 'utf8');
    expect(source).not.toMatch(/findSharedTextCredentialRule\(/);
    expect(source).not.toMatch(/findSecretMaterialRule\(/);
    expect(source).toMatch(/labelSecretRule\(|displayableLabel\(/);
  });

  // Stated, failing toward flagging: a printf `%s` is not one of the package
  // placeholder forms.
  it('refuses a printf format after an escaped line break in the package checks, a stated false positive', () => {
    const printf = "printf 'username=%s\\npassword=%s\\n'";
    expect(findPackageTextCredentialRule(printf)).toBe('credential_assignment');
    expect(findPackageFileCredentialRule(bytes(printf))).toBe(
      'credential_assignment',
    );
  });
});
