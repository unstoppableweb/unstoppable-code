import * as yaml from 'js-yaml';
import {
  basenamePluginPath,
  comparePluginPaths,
  dirnamePluginPath,
  extensionPluginPath,
  filesBelow,
  isRecord,
  isStringRecord,
  joinPluginPath,
  normalizePluginFiles,
  readJsonRecord,
  readString,
  readStringArray,
  readTextFile,
  relativePluginPath,
  resolvePluginPath,
} from './file-map';
import {
  parseFrontmatterAndBody,
  serializeMarkdownWithFrontmatter,
} from './frontmatter';
import { buildPluginMemberInventory } from './inventory';
import { pluginMemberInvocation } from './invocation-grammar';
import type {
  ClaudePluginManifest,
  PluginFileContent,
  PluginMarkdownMember,
  PluginMemberCodexNames,
  PluginMemberInventory,
  PluginMcpEnvironmentInput,
  PluginSkillMember,
  ProjectClaudePluginForCodexInput,
  ProjectClaudePluginForCodexResult,
  ProjectStandaloneMcpServersForCodexInput,
  ProjectStandaloneMcpServersForCodexResult,
} from './types';

export const CANOPY_COMPATIBILITY_VERSION = 5;

const TEXT_FILE_EXTENSIONS = new Set<string>([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.mjs',
  '.md',
  '.py',
  '.sh',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

interface ProjectionPlan {
  generatedCommandNames: ReadonlyMap<string, string>;
  generatedAgentNames: ReadonlyMap<string, string>;
}

interface ProjectionSource {
  pluginName: string;
  category: string;
  manifest: ClaudePluginManifest | null;
  rawManifest: Readonly<Record<string, unknown>>;
  files: ReadonlyMap<string, PluginFileContent>;
  skills: PluginSkillMember[];
  commands: PluginMarkdownMember[];
  agents: PluginMarkdownMember[];
  hasMods: boolean;
}

interface CompatibilityMcpServer {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  bearer_token_env_var?: string;
  http_headers?: Record<string, string>;
}

interface PluginMcpProjection {
  config: Record<string, CompatibilityMcpServer>;
  extraEnv: Record<string, string>;
}

function sanitizeKebab(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function titleCaseKebab(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function normalizePluginCategory(value: string): string {
  const normalized = titleCaseKebab(value);
  return normalized.length > 0 ? normalized : 'Development';
}

function withCounterSuffix(
  candidate: string,
  counter: number,
  maxLength: number,
): string {
  const suffix = `-${String(counter)}`;
  const maxBaseLength = maxLength - suffix.length;
  const truncated = candidate.slice(0, maxBaseLength).replace(/-+$/g, '');
  return `${truncated || 'skill'}${suffix}`;
}

export function createGeneratedSkillName(
  sourceName: string,
  usedNames: Set<string>,
): string {
  const maxLength = 64;
  const base = sanitizeKebab(sourceName) || 'skill';
  let resolved = base.slice(0, maxLength).replace(/-+$/g, '');
  if (!resolved) resolved = 'skill';
  let counter = 2;
  while (usedNames.has(resolved)) {
    resolved = withCounterSuffix(base, counter, maxLength);
    counter += 1;
  }
  usedNames.add(resolved);
  return resolved;
}

function buildSource(
  input: ProjectClaudePluginForCodexInput,
): ProjectionSource {
  const files = normalizePluginFiles(input.files);
  const rawManifest: Record<string, unknown> = input.rawManifest
    ? { ...input.rawManifest }
    : input.manifest
      ? { ...input.manifest }
      : {};
  const inventory = buildPluginMemberInventory({
    files,
    manifest: input.manifest,
  });
  return {
    pluginName: input.pluginName,
    category: input.category,
    manifest: input.manifest,
    rawManifest,
    files,
    skills: inventory.skills,
    commands: inventory.commands,
    agents: inventory.agents,
    hasMods: (inventory.mods?.length ?? 0) > 0,
  };
}

function buildProjectionPlan(source: ProjectionSource): ProjectionPlan {
  const usedNames = new Set<string>();
  for (const skill of source.skills) usedNames.add(skill.name);
  const generatedCommandNames = new Map<string, string>();
  for (const command of [...source.commands].sort((left, right) =>
    comparePluginPaths(left.filePath, right.filePath),
  )) {
    generatedCommandNames.set(
      command.name,
      createGeneratedSkillName(command.name, usedNames),
    );
  }
  const generatedAgentNames = new Map<string, string>();
  for (const agent of [...source.agents].sort((left, right) =>
    comparePluginPaths(left.filePath, right.filePath),
  )) {
    generatedAgentNames.set(
      agent.name,
      createGeneratedSkillName(agent.name, usedNames),
    );
  }
  return { generatedCommandNames, generatedAgentNames };
}

/**
 * Deterministic naming-only projection for stored member inventories. Web
 * catalog/invocable reads use this instead of re-reading plugin file trees.
 */
export function buildPluginMemberCodexNames(
  inventory: PluginMemberInventory,
): PluginMemberCodexNames {
  const usedNames = new Set<string>();
  const skillNames = new Map<string, string>();
  for (const skill of inventory.skills) {
    usedNames.add(skill.name);
    skillNames.set(skill.name, skill.name);
  }
  const commandNames = new Map<string, string>();
  for (const command of [...inventory.commands].sort((left, right) =>
    comparePluginPaths(left.filePath, right.filePath),
  )) {
    commandNames.set(
      command.name,
      createGeneratedSkillName(command.name, usedNames),
    );
  }
  const agentNames = new Map<string, string>();
  for (const agent of [...inventory.agents].sort((left, right) =>
    comparePluginPaths(left.filePath, right.filePath),
  )) {
    agentNames.set(agent.name, createGeneratedSkillName(agent.name, usedNames));
  }
  return { skillNames, commandNames, agentNames };
}

export function buildClaudePluginQualifiedReferenceMap(
  inputs: readonly ProjectClaudePluginForCodexInput[],
): Map<string, string> {
  const result = new Map<string, string>();
  for (const input of inputs) {
    const source = buildSource(input);
    const plan = buildProjectionPlan(source);
    for (const skill of source.skills) {
      result.set(
        `${source.pluginName}:${skill.name}`,
        pluginMemberInvocation(source.pluginName, skill.name, 'codex'),
      );
    }
    for (const command of source.commands) {
      const generated =
        plan.generatedCommandNames.get(command.name) ?? command.name;
      result.set(
        `${source.pluginName}:${command.name}`,
        pluginMemberInvocation(source.pluginName, generated, 'codex'),
      );
    }
    for (const agent of source.agents) {
      const generated = plan.generatedAgentNames.get(agent.name) ?? agent.name;
      result.set(
        `${source.pluginName}:${agent.name}`,
        pluginMemberInvocation(source.pluginName, generated, 'codex'),
      );
    }
  }
  return result;
}

function createSkillPolicyYaml(options: {
  allowImplicitInvocation: boolean;
  displayName?: string;
  shortDescription?: string;
}): string | null {
  if (
    options.allowImplicitInvocation &&
    !options.displayName &&
    !options.shortDescription
  ) {
    return null;
  }
  const document: Record<string, unknown> = {
    interface:
      options.displayName || options.shortDescription
        ? {
            display_name: options.displayName,
            short_description: options.shortDescription,
          }
        : undefined,
    policy: { allow_implicit_invocation: options.allowImplicitInvocation },
  };
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (value !== undefined) filtered[key] = value;
  }
  return yaml.dump(filtered, { lineWidth: -1, noRefs: true });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceClaudePluginRoot(content: string, pluginRoot: string): string {
  return content.split('${CLAUDE_PLUGIN_ROOT}').join(pluginRoot);
}

function normalizeGeneratedMarkdown(content: string): string {
  let rewritten = content;
  const replacements: Array<[RegExp, string]> = [
    [
      /\b(?:Use|use) `?AskUserQuestion`? to ask the user to provide either:/g,
      'Ask the user directly to provide either:',
    ],
    [
      /\b(?:Use|use) `?AskUserQuestion`? to ask the user how to proceed:/g,
      'Ask the user directly how to proceed:',
    ],
    [
      /\b(?:Use|use) `?AskUserQuestion`? to prompt the user for/g,
      'Ask the user directly for',
    ],
    [
      /\b(?:Use|use) `?AskUserQuestion`? to provide options:/g,
      'Ask the user directly and provide options:',
    ],
    [
      /\b(?:Use|use) `?AskUserQuestion`? to ask the user\b/g,
      'Ask the user directly',
    ],
    [/\b(?:Use|use) `?AskUserQuestion`? with/g, 'Ask the user directly with'],
    [/via AskUserQuestion/g, 'by asking the user directly'],
  ];
  for (const [pattern, replacement] of replacements) {
    rewritten = rewritten.replace(pattern, replacement);
  }
  rewritten = rewritten.replace(
    /`?AskUserQuestion`?/g,
    'ask the user directly',
  );
  rewritten = rewritten.replace(/Use the Bash tool/gi, 'Use the terminal');
  rewritten = rewritten.replace(/\bThe Bash tool\b/g, 'The terminal');
  rewritten = rewritten.replace(/\bBash tool\b/g, 'terminal');
  rewritten = rewritten.replace(
    /\bUse the Task tool with\b/g,
    'Delegate to a subagent with',
  );
  rewritten = rewritten.replace(
    /\bUse Task tool with\b/g,
    'Delegate to a subagent with',
  );
  rewritten = rewritten.replace(/\bvia the Agent tool\b/g, 'via a subagent');
  rewritten = rewritten.replace(
    /\busing the Agent tool\b/g,
    'using a subagent',
  );
  rewritten = rewritten.replace(/\bTask tool\b/g, 'subagent support');
  rewritten = rewritten.replace(/\bAgent tool\b/g, 'subagent support');
  rewritten = rewritten.replace(/\bClaude Code settings\b/g, 'Codex settings');
  rewritten = rewritten.replace(
    /\bconfigured in Claude Code\b/g,
    'configured in Codex',
  );
  rewritten = rewritten.replace(/\bin Claude Code\b/g, 'in Codex');
  rewritten = rewritten.replace(/claude-plugins\//g, 'codex-plugins/');
  rewritten = rewritten.replace(/ \(mode: `bypassPermissions`\)/g, '');
  rewritten = rewritten.replace(
    / with `bypassPermissions` mode/g,
    ' with the permissions already available in the session',
  );
  rewritten = rewritten.replace(/, `mode: "bypassPermissions"`/g, '');
  rewritten = rewritten.replace(
    /\n(\s*)"mode": "bypassPermissions",?\n/g,
    '\n',
  );
  return rewritten.replace(/\bSkill tool\b/g, 'explicit skill invocation');
}

function rewriteCommandLinksToSkills(
  content: string,
  plan: ProjectionPlan,
): string {
  return content.replace(
    /(!?\[[^\]]*]\()commands\/([^)]+\.md)(\))/g,
    (match: string, prefix: string, commandFile: string, suffix: string) => {
      const commandName = commandFile.replace(/\.md$/, '');
      const generated =
        plan.generatedCommandNames.get(commandName) ??
        plan.generatedCommandNames.get(commandName.replace(/[-_]/g, ' '));
      return generated
        ? `${prefix}skills/${generated}/SKILL.md${suffix}`
        : match;
    },
  );
}

function rewriteQualifiedSkillInvocations(
  content: string,
  qualifiedReferenceMap: ReadonlyMap<string, string>,
): string {
  let rewritten = content;
  const references = Array.from(qualifiedReferenceMap.entries()).sort(
    (left, right) => right[0].length - left[0].length,
  );
  for (const [qualifiedName, invocation] of references) {
    const escaped = escapeRegExp(qualifiedName);
    rewritten = rewritten.replace(
      new RegExp(`(?<![A-Za-z0-9-$])/${escaped}(?![A-Za-z0-9-])`, 'g'),
      invocation,
    );
    rewritten = rewritten.replace(
      new RegExp(`(?<![A-Za-z0-9-$])${escaped}(?![A-Za-z0-9-])`, 'g'),
      invocation,
    );
  }
  return rewritten;
}

function rewriteProjectedAgentReferences(
  content: string,
  source: ProjectionSource,
  plan: ProjectionPlan,
): string {
  let rewritten = content;
  for (const agent of source.agents) {
    const generated = plan.generatedAgentNames.get(agent.name);
    if (!generated) continue;
    const qualifiedName = `${source.pluginName}:${agent.name}`;
    const invocation = pluginMemberInvocation(
      source.pluginName,
      generated,
      'codex',
    );
    const taskPattern = new RegExp(
      'Use Task tool with `subagent_type: "' +
        escapeRegExp(qualifiedName) +
        '"`, `description: "([^"]+)"`',
      'g',
    );
    rewritten = rewritten.replace(
      taskPattern,
      (_match: string, description: string) =>
        `Invoke explicit skill \`${invocation}\` with description \`${description}\``,
    );
    rewritten = rewritten
      .split(`\`subagent_type: "${qualifiedName}"\``)
      .join(`\`${invocation}\``)
      .split(`Spawn the **${agent.name}** agent`)
      .join(`Invoke the **${invocation}** skill`)
      .split(`\`${qualifiedName}\` agent`)
      .join(`\`${invocation}\` skill`);
  }
  return rewritten;
}

function splitMarkdownTarget(target: string): {
  pathPart: string;
  suffix: string;
} {
  const suffixIndex = target.search(/[?#]/);
  return suffixIndex === -1
    ? { pathPart: target, suffix: '' }
    : {
        pathPart: target.slice(0, suffixIndex),
        suffix: target.slice(suffixIndex),
      };
}

function isRelativeMarkdownTarget(target: string): boolean {
  return (
    target.length > 0 &&
    !target.startsWith('#') &&
    !target.startsWith('/') &&
    !target.startsWith('<') &&
    !/^[a-z][a-z0-9+.-]*:/i.test(target)
  );
}

function rewriteRelativeMarkdownLinks(options: {
  content: string;
  sourceFilePath: string;
  destinationFilePath: string;
}): string {
  return options.content.replace(
    /(!?\[[^\]]*]\()([^)]+)(\))/g,
    (match: string, prefix: string, target: string, suffix: string) => {
      const parsed = splitMarkdownTarget(target);
      if (!isRelativeMarkdownTarget(parsed.pathPart)) return match;
      const resolvedSource = resolvePluginPath(
        joinPluginPath(
          dirnamePluginPath(options.sourceFilePath),
          parsed.pathPart,
        ),
      );
      if (resolvedSource === null || resolvedSource.length === 0) return match;
      const rewritten = relativePluginPath(
        dirnamePluginPath(options.destinationFilePath),
        resolvedSource,
      );
      return `${prefix}${rewritten}${parsed.suffix}${suffix}`;
    },
  );
}

function transformMarkdown(options: {
  content: string;
  source: ProjectionSource;
  pluginRoot: string;
  plan: ProjectionPlan;
  qualifiedReferenceMap: ReadonlyMap<string, string>;
  sourceFilePath?: string;
  destinationFilePath?: string;
}): string {
  let rewritten = replaceClaudePluginRoot(options.content, options.pluginRoot);
  if (options.sourceFilePath && options.destinationFilePath) {
    rewritten = rewriteRelativeMarkdownLinks({
      content: rewritten,
      sourceFilePath: options.sourceFilePath,
      destinationFilePath: options.destinationFilePath,
    });
  }
  rewritten = rewriteCommandLinksToSkills(rewritten, options.plan);
  rewritten = rewriteProjectedAgentReferences(
    rewritten,
    options.source,
    options.plan,
  );
  rewritten = rewriteQualifiedSkillInvocations(
    rewritten,
    options.qualifiedReferenceMap,
  );
  return normalizeGeneratedMarkdown(rewritten);
}

function copyDirectory(options: {
  source: ProjectionSource;
  sourceDirectory: string;
  destinationDirectory: string;
  output: Map<string, PluginFileContent>;
  transformText: (
    content: string,
    sourcePath: string,
    destinationPath: string,
  ) => string;
}): void {
  for (const [sourcePath, content] of filesBelow(
    options.source.files,
    options.sourceDirectory,
  )) {
    const remainder = sourcePath.slice(options.sourceDirectory.length + 1);
    const destinationPath = joinPluginPath(
      options.destinationDirectory,
      remainder,
    );
    if (TEXT_FILE_EXTENSIONS.has(extensionPluginPath(sourcePath))) {
      const textContent = readTextFile(options.source.files, sourcePath);
      if (textContent === null) continue;
      options.output.set(
        destinationPath,
        options.transformText(textContent, sourcePath, destinationPath),
      );
    } else {
      options.output.set(destinationPath, content);
    }
  }
}

function emitSourceSkill(options: {
  source: ProjectionSource;
  skill: PluginSkillMember;
  pluginRoot: string;
  plan: ProjectionPlan;
  qualifiedReferenceMap: ReadonlyMap<string, string>;
  output: Map<string, PluginFileContent>;
}): void {
  const directoryName = basenamePluginPath(options.skill.path);
  const destinationDirectory = `skills/${directoryName}`;
  copyDirectory({
    source: options.source,
    sourceDirectory: options.skill.path,
    destinationDirectory,
    output: options.output,
    transformText: (content, sourcePath, destinationPath): string =>
      extensionPluginPath(sourcePath) === '.md'
        ? transformMarkdown({
            content,
            source: options.source,
            pluginRoot: options.pluginRoot,
            plan: options.plan,
            qualifiedReferenceMap: options.qualifiedReferenceMap,
            sourceFilePath: sourcePath,
            destinationFilePath: destinationPath,
          })
        : replaceClaudePluginRoot(content, options.pluginRoot),
  });
  const policy = createSkillPolicyYaml({
    allowImplicitInvocation: options.skill.disableModelInvocation !== true,
  });
  if (policy) {
    options.output.set(`${destinationDirectory}/agents/openai.yaml`, policy);
  }
}

function emitGeneratedCommandSkill(options: {
  source: ProjectionSource;
  command: PluginMarkdownMember;
  generatedName: string;
  pluginRoot: string;
  plan: ProjectionPlan;
  qualifiedReferenceMap: ReadonlyMap<string, string>;
  output: Map<string, PluginFileContent>;
}): void {
  const raw = readTextFile(options.source.files, options.command.filePath);
  if (!raw) return;
  const parsed = parseFrontmatterAndBody(raw);
  const destination = `skills/${options.generatedName}/SKILL.md`;
  const invocation = pluginMemberInvocation(
    options.source.pluginName,
    options.generatedName,
    'codex',
  );
  const rewrittenBody = transformMarkdown({
    content: parsed.body,
    source: options.source,
    pluginRoot: options.pluginRoot,
    plan: options.plan,
    qualifiedReferenceMap: options.qualifiedReferenceMap,
    sourceFilePath: options.command.filePath,
    destinationFilePath: destination,
  });
  const body = [
    `# ${titleCaseKebab(options.command.name)} Command`,
    '',
    `This skill is generated from \`${options.command.filePath}\`.`,
    `Use it only through explicit \`${invocation}\` invocation. Codex will not invoke it implicitly.`,
    '',
    rewrittenBody.trim(),
    '',
  ].join('\n');
  options.output.set(
    destination,
    serializeMarkdownWithFrontmatter(
      {
        name: options.generatedName,
        description: `${invocation} only. ${
          options.command.description ||
          `Generated Codex wrapper for ${options.command.name}.`
        }`,
      },
      body,
    ),
  );
  const policy = createSkillPolicyYaml({
    allowImplicitInvocation: false,
    displayName: titleCaseKebab(options.command.name),
    shortDescription: options.command.description,
  });
  if (policy) {
    options.output.set(
      `skills/${options.generatedName}/agents/openai.yaml`,
      policy,
    );
  }
}

function emitGeneratedAgentSkill(options: {
  source: ProjectionSource;
  agent: PluginMarkdownMember;
  generatedName: string;
  pluginRoot: string;
  plan: ProjectionPlan;
  qualifiedReferenceMap: ReadonlyMap<string, string>;
  output: Map<string, PluginFileContent>;
}): void {
  const raw = readTextFile(options.source.files, options.agent.filePath);
  if (!raw) return;
  const invocation = pluginMemberInvocation(
    options.source.pluginName,
    options.generatedName,
    'codex',
  );
  const body = [
    `# ${titleCaseKebab(options.agent.name)} Agent`,
    '',
    'This skill is generated from a Claude subagent definition.',
    `Invoke it explicitly with \`${invocation}\`. Codex will not auto-invoke it.`,
    '',
    transformMarkdown({
      content: parseFrontmatterAndBody(raw).body,
      source: options.source,
      pluginRoot: options.pluginRoot,
      plan: options.plan,
      qualifiedReferenceMap: options.qualifiedReferenceMap,
    }).trim(),
    '',
  ].join('\n');
  options.output.set(
    `skills/${options.generatedName}/SKILL.md`,
    serializeMarkdownWithFrontmatter(
      {
        name: options.generatedName,
        description: `${invocation} only. ${
          options.agent.description ||
          `Generated Codex wrapper for ${options.agent.name}.`
        }`,
      },
      body,
    ),
  );
  const policy = createSkillPolicyYaml({
    allowImplicitInvocation: false,
    displayName: titleCaseKebab(options.agent.name),
    shortDescription: options.agent.description,
  });
  if (policy) {
    options.output.set(
      `skills/${options.generatedName}/agents/openai.yaml`,
      policy,
    );
  }
}

function copyOptionalPluginFiles(options: {
  source: ProjectionSource;
  pluginRoot: string;
  plan: ProjectionPlan;
  qualifiedReferenceMap: ReadonlyMap<string, string>;
  output: Map<string, PluginFileContent>;
}): void {
  for (const directory of ['references', 'assets', 'hooks']) {
    copyDirectory({
      source: options.source,
      sourceDirectory: directory,
      destinationDirectory: directory,
      output: options.output,
      transformText: (content, sourcePath, destinationPath): string =>
        extensionPluginPath(sourcePath) === '.md'
          ? transformMarkdown({
              content,
              source: options.source,
              pluginRoot: options.pluginRoot,
              plan: options.plan,
              qualifiedReferenceMap: options.qualifiedReferenceMap,
              sourceFilePath: sourcePath,
              destinationFilePath: destinationPath,
            })
          : replaceClaudePluginRoot(content, options.pluginRoot),
    });
  }
  const optionalFiles: Array<[string, string]> = [
    ['.app.json', '.app.json'],
    ['index.md', 'index.md'],
    ['README.md', 'SOURCE_README.md'],
  ];
  for (const [sourcePath, destinationPath] of optionalFiles) {
    const content = options.source.files.get(sourcePath);
    if (content === undefined) continue;
    if (TEXT_FILE_EXTENSIONS.has(extensionPluginPath(sourcePath))) {
      const textContent = readTextFile(options.source.files, sourcePath);
      if (textContent === null) continue;
      options.output.set(
        destinationPath,
        extensionPluginPath(sourcePath) === '.md'
          ? transformMarkdown({
              content: textContent,
              source: options.source,
              pluginRoot: options.pluginRoot,
              plan: options.plan,
              qualifiedReferenceMap: options.qualifiedReferenceMap,
              sourceFilePath: sourcePath,
              destinationFilePath: destinationPath,
            })
          : replaceClaudePluginRoot(textContent, options.pluginRoot),
      );
    } else {
      options.output.set(destinationPath, content);
    }
  }
}

function convertHttpHeaders(
  headers: Readonly<Record<string, string>>,
  envVarPrefix: string,
  extraEnv: Record<string, string>,
): {
  bearerTokenEnvVar?: string;
  httpHeaders?: Record<string, string>;
} {
  let counter = 0;
  let bearerTokenEnvVar: string | undefined;
  const httpHeaders: Record<string, string> = {};
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (headerName.toLowerCase() === 'authorization') {
      const match = /^bearer\s+(.+)$/i.exec(headerValue);
      const token = match?.[1];
      if (token !== undefined) {
        const envVarName = `${envVarPrefix}_${String(counter)}`;
        counter += 1;
        extraEnv[envVarName] = token;
        bearerTokenEnvVar = envVarName;
        continue;
      }
    }
    httpHeaders[headerName] = headerValue;
  }
  return {
    ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}),
    ...(Object.keys(httpHeaders).length > 0 ? { httpHeaders } : {}),
  };
}

function extractPluginMcpServers(
  config: Readonly<Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const servers = isRecord(config.mcpServers) ? config.mcpServers : config;
  const result: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(servers)) {
    if (isRecord(value)) result[name] = value;
  }
  return result;
}

function readPluginMcpConfigObjects(
  files: ReadonlyMap<string, PluginFileContent>,
  manifest: ClaudePluginManifest | null,
): Record<string, Record<string, unknown>> {
  const configured = manifest?.mcpServers;
  if (typeof configured === 'string') {
    const resolved = resolvePluginPath(configured);
    const config = resolved === null ? null : readJsonRecord(files, resolved);
    return config ? extractPluginMcpServers(config) : {};
  }
  if (Array.isArray(configured)) {
    const merged: Record<string, Record<string, unknown>> = {};
    for (const entry of configured) {
      if (typeof entry !== 'string') continue;
      const resolved = resolvePluginPath(entry);
      const config = resolved === null ? null : readJsonRecord(files, resolved);
      if (config) Object.assign(merged, extractPluginMcpServers(config));
    }
    return merged;
  }
  if (isRecord(configured)) return extractPluginMcpServers(configured);
  const defaultConfig = readJsonRecord(files, '.mcp.json');
  return defaultConfig ? extractPluginMcpServers(defaultConfig) : {};
}

function buildPluginMcpProjection(options: {
  pluginName: string;
  manifest: ClaudePluginManifest | null;
  files: ReadonlyMap<string, PluginFileContent>;
  pluginRoot: string;
  warnings: string[];
}): PluginMcpProjection {
  const rawServers = readPluginMcpConfigObjects(
    options.files,
    options.manifest,
  );
  const config: Record<string, CompatibilityMcpServer> = {};
  const extraEnv: Record<string, string> = {};
  for (const [serverName, rawServer] of Object.entries(rawServers)) {
    const command = readString(rawServer, 'command');
    const url = readString(rawServer, 'url');
    const args = readStringArray(rawServer.args);
    const env = isStringRecord(rawServer.env) ? rawServer.env : undefined;
    const headers = isStringRecord(rawServer.headers)
      ? rawServer.headers
      : undefined;
    const cwd =
      typeof rawServer.cwd === 'string'
        ? replaceClaudePluginRoot(rawServer.cwd, options.pluginRoot)
        : undefined;
    if (!command && !url) {
      options.warnings.push(
        `Plugin MCP server "${options.pluginName}:${serverName}" is invalid, skipping.`,
      );
      continue;
    }
    const normalizedArgs = args?.map((entry) =>
      replaceClaudePluginRoot(entry, options.pluginRoot),
    );
    const normalizedEnv: Record<string, string> | undefined = env
      ? Object.fromEntries(
          Object.entries(env).map(([key, value]) => [
            key,
            replaceClaudePluginRoot(value, options.pluginRoot),
          ]),
        )
      : undefined;
    if (command) {
      config[serverName] = {
        command: replaceClaudePluginRoot(command, options.pluginRoot),
        args: normalizedArgs,
        cwd: cwd ?? options.pluginRoot,
        env: normalizedEnv,
      };
      continue;
    }
    const normalizedHeaders: Record<string, string> | undefined = headers
      ? Object.fromEntries(
          Object.entries(headers).map(([key, value]) => [
            key,
            replaceClaudePluginRoot(value, options.pluginRoot),
          ]),
        )
      : undefined;
    const converted = normalizedHeaders
      ? convertHttpHeaders(
          normalizedHeaders,
          `CANOPY_PLUGIN_${sanitizeKebab(options.pluginName).toUpperCase()}_${sanitizeKebab(serverName).toUpperCase()}_TOKEN`,
          extraEnv,
        )
      : {};
    config[serverName] = {
      url: replaceClaudePluginRoot(url ?? '', options.pluginRoot),
      bearer_token_env_var: converted.bearerTokenEnvVar,
      http_headers: converted.httpHeaders,
    };
  }
  return { config, extraEnv };
}

export function projectClaudePluginMcpEnvironment(
  input: PluginMcpEnvironmentInput,
): Record<string, string> {
  return buildPluginMcpProjection({
    pluginName: input.pluginName,
    manifest: input.manifest,
    files: normalizePluginFiles(input.files),
    pluginRoot: input.pluginRoot ?? '.',
    warnings: [],
  }).extraEnv;
}

export function projectStandaloneMcpServersForCodex(
  input: ProjectStandaloneMcpServersForCodexInput,
): ProjectStandaloneMcpServersForCodexResult {
  const config: Record<string, CompatibilityMcpServer> = {};
  const extraEnv: Record<string, string> = {};
  const warnings: string[] = [];
  for (const [serverName, rawValue] of Object.entries(input.mcpServers)) {
    if (!isRecord(rawValue)) {
      warnings.push(
        `Standalone MCP server "${serverName}" is invalid, skipping.`,
      );
      continue;
    }
    const serverType = readString(rawValue, 'type');
    if (serverType === 'stdio') {
      const command = readString(rawValue, 'command');
      if (!command) {
        warnings.push(
          `Standalone MCP server "${serverName}" is missing a command, skipping.`,
        );
        continue;
      }
      config[serverName] = {
        command,
        args: readStringArray(rawValue.args),
        env: isStringRecord(rawValue.env) ? rawValue.env : undefined,
      };
      continue;
    }
    if (serverType === 'http') {
      const url = readString(rawValue, 'url');
      if (!url) {
        warnings.push(
          `Standalone MCP server "${serverName}" is missing a URL, skipping.`,
        );
        continue;
      }
      const headers = isStringRecord(rawValue.headers)
        ? rawValue.headers
        : undefined;
      const converted = headers
        ? convertHttpHeaders(
            headers,
            `CANOPY_STANDALONE_${sanitizeKebab(input.pluginName).toUpperCase()}_${sanitizeKebab(serverName).toUpperCase()}_TOKEN`,
            extraEnv,
          )
        : {};
      config[serverName] = {
        url,
        bearer_token_env_var: converted.bearerTokenEnvVar,
        http_headers: converted.httpHeaders,
      };
      continue;
    }
    warnings.push(
      `Standalone MCP server "${serverName}" has unsupported type, skipping.`,
    );
  }
  return { config, extraEnv, warnings };
}

function buildPluginManifest(options: {
  source: ProjectionSource;
  output: ReadonlyMap<string, PluginFileContent>;
  projectedSkillCount: number;
  hasMcpServers: boolean;
}): Record<string, unknown> {
  const manifest = options.source.rawManifest;
  const author = isRecord(manifest.author)
    ? manifest.author
    : options.source.manifest?.author;
  const interfaceBlock: Record<string, unknown> = {
    displayName: titleCaseKebab(options.source.pluginName),
    shortDescription:
      options.source.manifest?.description ??
      readString(manifest, 'description') ??
      '',
    category: normalizePluginCategory(options.source.category),
  };
  if (isRecord(author)) {
    const developerName = readString(author, 'name');
    if (developerName) interfaceBlock.developerName = developerName;
  }
  const result: Record<string, unknown> = {
    name: options.source.pluginName,
    version:
      options.source.manifest?.version ??
      readString(manifest, 'version') ??
      '0.0.0-compat',
    description:
      options.source.manifest?.description ??
      readString(manifest, 'description') ??
      '',
    author,
    homepage:
      readString(manifest, 'homepage') ?? options.source.manifest?.homepage,
    repository: readString(manifest, 'repository'),
    license: readString(manifest, 'license'),
    keywords: readStringArray(manifest.keywords),
    skills: options.projectedSkillCount > 0 ? './skills/' : undefined,
    mcpServers: options.hasMcpServers ? './.mcp.json' : undefined,
    apps: options.output.has('.app.json') ? './.app.json' : undefined,
    interface: interfaceBlock,
  };
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result)) {
    if (value !== undefined && value !== '') filtered[key] = value;
  }
  return filtered;
}

function buildCompatibilityReadme(options: {
  pluginName: string;
  projectedSkills: readonly string[];
  notes: readonly string[];
}): string {
  const lines = [
    '# Generated Codex Plugin',
    '',
    `This compatibility projection was generated for \`${options.pluginName}\`.`,
    '',
    '## Projected Skills',
    '',
  ];
  if (options.projectedSkills.length === 0) {
    lines.push('No skills were projected for this plugin.', '');
  } else {
    for (const skill of options.projectedSkills) lines.push(`- \`${skill}\``);
    lines.push('');
  }
  lines.push('## Compatibility Notes', '');
  if (options.notes.length === 0) {
    lines.push('No compatibility notes.', '');
  } else {
    for (const note of options.notes) lines.push(`- ${note}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** The notice a Codex chat shows for a Claude plugin that contains a Mod. */
export function claudeModCodexWarning(pluginName: string): string {
  return `Plugin "${pluginName}" contains a Claude Mod. Its mod runs in Claude chats only.`;
}

export function projectClaudePluginForCodex(
  input: ProjectClaudePluginForCodexInput,
): ProjectClaudePluginForCodexResult {
  const source = buildSource(input);
  const pluginRoot = input.pluginRoot ?? '.';
  const plan = buildProjectionPlan(source);
  const qualifiedReferenceMap =
    input.qualifiedReferenceMap ??
    buildClaudePluginQualifiedReferenceMap([input]);
  const output = new Map<string, PluginFileContent>();
  const warnings: string[] = [];
  const notes: string[] = [];
  const projectedSkills: string[] = [];
  const generatedSkillNames = new Map<string, string>();
  if (source.hasMods) warnings.push(claudeModCodexWarning(source.pluginName));
  for (const skill of source.skills) {
    emitSourceSkill({
      source,
      skill,
      pluginRoot,
      plan,
      qualifiedReferenceMap,
      output,
    });
    projectedSkills.push(skill.name);
    if (skill.userInvocable === false) {
      notes.push(
        `Skill "${skill.name}" sets user-invocable=false in Claude metadata. Codex compatibility keeps it as an explicitly invokable skill.`,
      );
    }
  }
  for (const command of source.commands) {
    const generated =
      plan.generatedCommandNames.get(command.name) ?? command.name;
    emitGeneratedCommandSkill({
      source,
      command,
      generatedName: generated,
      pluginRoot,
      plan,
      qualifiedReferenceMap,
      output,
    });
    projectedSkills.push(generated);
    generatedSkillNames.set(`command:${command.name}`, generated);
  }
  for (const agent of source.agents) {
    const generated = plan.generatedAgentNames.get(agent.name) ?? agent.name;
    emitGeneratedAgentSkill({
      source,
      agent,
      generatedName: generated,
      pluginRoot,
      plan,
      qualifiedReferenceMap,
      output,
    });
    projectedSkills.push(generated);
    generatedSkillNames.set(`agent:${agent.name}`, generated);
    notes.push(
      `Agent "${agent.name}" is emitted as explicit skill "${generated}" because Codex plugin packaging is skill-based.`,
    );
  }
  copyOptionalPluginFiles({
    source,
    pluginRoot,
    plan,
    qualifiedReferenceMap,
    output,
  });
  const mcpProjection =
    input.includeMcpServers === false
      ? { config: {}, extraEnv: {} }
      : buildPluginMcpProjection({
          pluginName: source.pluginName,
          manifest: source.manifest,
          files: source.files,
          pluginRoot,
          warnings,
        });
  if (Object.keys(mcpProjection.config).length > 0) {
    output.set(
      '.mcp.json',
      JSON.stringify({ mcpServers: mcpProjection.config }, null, 2),
    );
  }
  output.set(
    '.codex-plugin/plugin.json',
    JSON.stringify(
      buildPluginManifest({
        source,
        output,
        projectedSkillCount: projectedSkills.length,
        hasMcpServers: Object.keys(mcpProjection.config).length > 0,
      }),
      null,
      2,
    ),
  );
  output.set(
    'README.md',
    buildCompatibilityReadme({
      pluginName: source.pluginName,
      projectedSkills,
      notes,
    }),
  );
  return { files: output, generatedSkillNames, warnings };
}
