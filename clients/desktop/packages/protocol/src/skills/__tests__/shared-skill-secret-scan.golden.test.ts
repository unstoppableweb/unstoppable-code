/**
 * CAN-7226: one secret check for shared skill text, run by desktop and the
 * hosted service alike. It names the rule that matched, never the match; it
 * ignores named placeholders; it does no I/O or logging; and every pattern
 * stays linear on adversarial input at the largest file a package may carry.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  containsSecretMaterial,
  findSecretMaterialRule,
  type SecretMaterialRule,
} from '../../capability-files';
import { PIPELINE_PACKAGE_MAX_FILE_BYTES } from '../../pipelines/package';
import {
  encodeSharedContainerDefinitionDocument,
  findSharedTextCredentialRule,
  parseSharedContainerDefinitionDocument,
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
  sharedSkillSecretMessage,
  templateInstallSkillSecretMessage,
} from '../secret-scan';

// Built at runtime so no secret-shaped literal is committed.
const repeat = (text: string, count: number): string => text.repeat(count);
const SAMPLES: readonly (readonly [SecretMaterialRule, string])[] = [
  ['private_key', `-----BEGIN RSA ${'PRIVATE'} KEY-----`],
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
function referenceWithoutExpressions(text: string): string {
  const stripped = Array.from(text, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? '' : character;
  }).join('');
  return stripped.replace(REFERENCE_EXPRESSION, (expression, inner: string) =>
    containsSecretMaterial(inner) ? expression : '""',
  );
}
function referencePackageCheck(text: string): boolean {
  return containsSecretMaterial(
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
function intendedPackageCheck(text: string): boolean {
  return containsSecretMaterial(
    referenceWithoutExpressions(text).replace(
      REFERENCE_PLACEHOLDER,
      (assignment) =>
        containsSecretMaterial(assignment.slice(assignment.search(/[=:]/) + 1))
          ? assignment
          : 'placeholder=example',
    ),
  );
}

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
  ];
  it.each(CORPUS)('agrees with develop plus R2 on %j', (text) => {
    expect(findPackageTextCredentialRule(text) !== null).toBe(
      intendedPackageCheck(text),
    );
  });

  it('differs from develop on the corpus only where a placeholder holds a real value', () => {
    const changed = CORPUS.filter(
      (text) =>
        (findPackageTextCredentialRule(text) !== null) !==
        referencePackageCheck(text),
    );
    const placeholderValues = CORPUS.filter(
      (text) => intendedPackageCheck(text) !== referencePackageCheck(text),
    );
    expect(changed).toEqual(placeholderValues);
    expect(changed.length).toBeGreaterThan(0);
    // Each change refuses more: develop let it through, the check refuses it.
    for (const text of changed) {
      expect(referencePackageCheck(text)).toBe(false);
      expect(findPackageTextCredentialRule(text)).not.toBeNull();
    }
  });

  it('agrees on 20,000 generated mixes of keys, placeholders, expressions and secrets', () => {
    const fragments = [
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
    let seed = 7226;
    const next = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % bound;
    };
    const disagreements: string[] = [];
    const unexplained: string[] = [];
    for (let index = 0; index < 20_000; index += 1) {
      let text = '';
      const parts = 1 + next(8);
      for (let part = 0; part < parts; part += 1)
        text += fragments[next(fragments.length)];
      const verdict = findPackageTextCredentialRule(text) !== null;
      if (verdict !== intendedPackageCheck(text)) disagreements.push(text);
      // A change against develop must be a placeholder holding a real value.
      if (
        verdict !== referencePackageCheck(text) &&
        intendedPackageCheck(text) === referencePackageCheck(text)
      )
        unexplained.push(text);
    }
    expect(disagreements).toEqual([]);
    expect(unexplained).toEqual([]);
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
  it("reads a file's bytes as develop's desktop analysis did (plus R2), on every corpus text as UTF-8, Latin-1 and binary", () => {
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
// - SECRET_ENV_ASSIGNMENT_PATTERN (shared): keyword then spaces or tabs.
// - URL_USER_INFO_PATTERN and USER_FLAG_PATTERN (shared): ://, ://user:,
//   -u and --user= runs.
// - PACKAGE_PLACEHOLDER_ASSIGNMENT_PATTERN (package): <…>, {…}, {{…}}, $VAR,
//   ${VAR}; and the package expression scan on unclosed ${{ and stray }}.
// - The SECRET_RULES check on placeholder contents (both profiles): runs of
//   placeholders holding jwt, sk- and gh*_ prefixes, and a URL password
//   placeholder.
// - findPackageFileCredentialRule (the bytes helper): every input above,
//   encoded. The definition-document path has its own block below.
const ADVERSARIAL_UNITS: readonly (readonly [string, string])[] = [
  ['private key header', '-----BEGIN A A A A '],
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
