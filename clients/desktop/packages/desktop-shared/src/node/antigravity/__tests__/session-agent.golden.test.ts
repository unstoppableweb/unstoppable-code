// Golden (CAP-02): every Antigravity launch selects the Canopy agent from the
// private profile. Antigravity 1.5.1 feeds repository skills, rules and
// workflows to its default agent with no off switch; this agent inherits none
// of them and offers only the gated native tools. The runtime silently falls
// back to its default agent on any frontmatter key or value outside the
// qualified schema, and the handshake does not name the active agent, so the
// file Canopy writes is pinned here.
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANTIGRAVITY_AGENT_DEFINITION,
  antigravityAgentPath,
  antigravityArguments,
  prepareAntigravityProfile,
} from '../runtime';

jest.mock('@canopy/desktop-shared/node/acp', () => ({ connectAcp: jest.fn() }));

const posixIt = process.platform === 'win32' ? it.skip : it;

function splitAgentFile(contents: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(contents);
  if (!match) throw new Error('The agent file has no frontmatter fences.');
  const lines = match[1].split('\n');
  // Seven pinned keys, one per line: a repeated key cannot hide in toEqual.
  if (lines.length !== 7)
    throw new Error(`Expected 7 frontmatter lines, found ${lines.length}.`);
  const frontmatter: Record<string, string> = {};
  for (const line of lines) {
    const separator = line.indexOf(': ');
    if (separator <= 0) throw new Error(`Unreadable line: ${line}`);
    const key = line.slice(0, separator);
    if (Object.hasOwn(frontmatter, key))
      throw new Error(`Repeated frontmatter key: ${key}`);
    frontmatter[key] = line.slice(separator + 2);
  }
  return { frontmatter, body: match[2] };
}

describe('Antigravity sessions run as the Canopy agent', () => {
  let profile: string;

  beforeEach(async () => {
    profile = await mkdtemp(join(tmpdir(), 'agy-agent-golden-'));
  });

  afterEach(async () => {
    await rm(profile, { recursive: true, force: true });
  });

  it('launch arguments select the Canopy agent', () => {
    const args = antigravityArguments('/p');
    expect(args.slice(-2)).toEqual(['--agent', 'canopy']);
    expect(args).toContain('--include-default-customizations=false');
    expect(args).toContain('--process-per-session');
  });

  posixIt(
    'the profile carries the agent file with the pinned frontmatter',
    async () => {
      await prepareAntigravityProfile(profile);
      const file = antigravityAgentPath(profile);
      expect(file).toBe(join(profile, 'config', 'agents', 'canopy.md'));
      const { frontmatter, body } = splitAgentFile(
        await readFile(file, 'utf8'),
      );
      expect(frontmatter).toEqual({
        name: 'canopy',
        description: 'App session agent',
        mainAgent: 'true',
        subagent: 'false',
        inheritCustomizations: 'false',
        excludeDefaultComponents: 'true',
        tools: '[read_file, write_file, run_command]',
      });
      expect(body.startsWith('# Session agent')).toBe(true);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    },
  );

  it('the body is brand-neutral, app-authored and bounded', () => {
    const { body } = splitAgentFile(ANTIGRAVITY_AGENT_DEFINITION);
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(2048);
    expect(body).toContain('plan mode');
    expect(body).toContain('approval');
    expect(body).toContain('workspace');
    // No brand or vendor self-description: the text is the app's own.
    expect(body).not.toContain('Canopy');
    expect(body).not.toContain('Antigravity');
  });

  posixIt('a modified agent file is rewritten on the next launch', async () => {
    await prepareAntigravityProfile(profile);
    const file = antigravityAgentPath(profile);
    await writeFile(file, '---\nname: other\n---\njunk\n');
    await chmod(file, 0o644);
    await prepareAntigravityProfile(profile);
    expect(await readFile(file, 'utf8')).toBe(ANTIGRAVITY_AGENT_DEFINITION);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
