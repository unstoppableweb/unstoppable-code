import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  pipelineCapabilitiesRefusedError,
  pipelineStartFailedError,
} from '@canopy/core-runtime/node/pipeline';
import type { PipelineRunnerCapabilityPort } from '@canopy/core-runtime/node/pipeline/host';
import {
  CAPABILITY_BUNDLE_SKILL_ENTRYPOINT_FILENAME,
  formatCapabilityBundleDigest,
  isCapabilityBundleV1,
  projectMcpServersForClaudeCode,
  serializeCanonicalCapabilityBundle,
  validateCapabilityBundle,
  type CapabilityBundleSkill,
  type CapabilityBundleV1,
} from '@canopy/protocol/capability-bundle';
import {
  WORKER_PIPELINE_DATA_CHUNK_MAX_BYTES,
  WorkerPipelineCapabilityDeliverySchema,
  type WorkerPipelineCapabilitiesImportParams,
  type WorkerPipelineCapabilitiesImportResult,
  type WorkerPipelineCapabilityDeliveryRef,
} from '@canopy/protocol/canopy-core';
import {
  CLOUD_RUN_CAPABILITIES_DIR,
  CLOUD_RUN_CAPABILITY_MCP_PLUGIN,
  CLOUD_RUN_CAPABILITY_SOURCE_PREFIX,
  cloudRunCapabilityKeyOf,
  cloudRunCapabilityPlan,
  type CloudRunCapabilityPlan,
} from '@canopy/protocol/pipeline-relay';
import { getSkillSourceDirectoryName } from '../../skills/paths';
import { sha256 } from './archive';

/*
 * A cloud run's capabilities on the runner (CAN-6439, cloud pipelines CP-25).
 * The web core resolves the run's plugin collections into capability
 * bundles and delivers them with `worker.pipeline.capabilities.import`
 * before the run's start, on every incarnation. Each bundle lands in the
 * data root where the engine's plugin resolver reads installed skills and
 * plugins (`plugin-resolver.ts`), so the selection refs the start's plugin
 * collection snapshots carry (`cloudRunCapabilityPlan`) resolve as an
 * installed skill or plugin does on desktop:
 *
 * - `skills/cloud-run:<key>/<name>/`: each skill, its `SKILL.md` naming it
 *   as the bundle does;
 * - `cloud-capabilities/<key>/plugins/...`: each plugin's Claude and Codex
 *   trees, as the bundle roots them, written from their blobs;
 * - `cloud-capabilities/<key>/mcp/`: a Claude plugin whose MCP
 *   configuration names the bundle's servers, all behind the activation's
 *   proxy origin, with the run's AI Credits session key as their bearer;
 * - `plugins-cache.json`: the plugin catalog, one marketplace per bundle.
 *
 * Nothing is written until the whole delivery checks out: its SHA-256,
 * every bundle against its digest and the bundle validation (with the proxy
 * origin as the only MCP origin), and every blob against its SHA-256 and the
 * size each tree entry records. Bundles are immutable by digest, so a bundle
 * already held is kept and an import only adds. A Claude plugin's stdio MCP
 * servers start inside the sandbox with its step, under the host's fence.
 */

/** The run's MCP proxy credential: the activation's AI Credits session. */
export interface PipelineRunnerMcpProxy {
  /** The web origin; the only origin a bundle's MCP servers may name. */
  readonly origin: string;
  /** The session key, sent as the bearer to that origin only. */
  readonly token: string;
}

/** The data root's plugin catalog, which the engine's resolver reads. */
const PLUGIN_CATALOG_FILE = 'plugins-cache.json';

/** Where a bundle's MCP plugin sits in its folder. */
const MCP_PLUGIN_DIR = 'mcp';

interface Staging {
  readonly delivery: WorkerPipelineCapabilityDeliveryRef;
  readonly chunks: Buffer[];
  received: number;
}

/** One bundle, checked and ready to write. */
interface CheckedBundle {
  readonly bundle: CapabilityBundleV1;
  readonly plan: CloudRunCapabilityPlan;
}

function refuse(message: string, cause?: unknown): CanopyOperationError {
  return pipelineCapabilitiesRefusedError(message, cause);
}

function decodeChunk(chunk: string): Buffer {
  const bytes = Buffer.from(chunk, 'base64');
  if (bytes.byteLength > WORKER_PIPELINE_DATA_CHUNK_MAX_BYTES)
    throw refuse("A chunk of this run's capabilities is too large.");
  return bytes;
}

function sameDelivery(
  a: WorkerPipelineCapabilityDeliveryRef,
  b: WorkerPipelineCapabilityDeliveryRef,
): boolean {
  return a.sha256 === b.sha256 && a.byteSize === b.byteSize;
}

function digestOf(bundle: CapabilityBundleV1): string {
  return formatCapabilityBundleDigest(
    createHash('sha256')
      .update(serializeCanonicalCapabilityBundle(bundle), 'utf8')
      .digest('base64url'),
  );
}

/** A path under `root` for a relative POSIX path the bundle validation passed. */
function inside(root: string, relative: string): string {
  const target = path.resolve(root, ...relative.split('/'));
  if (target === root || !target.startsWith(`${root}${path.sep}`))
    throw refuse("This run's capabilities name a path outside their folder.");
  return target;
}

/** A frontmatter mapping, or null for anything else. */
function frontmatterOf(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  } catch {
    return null;
  }
  if (parsed === undefined || parsed === null) return {};
  return typeof parsed === 'object' && !Array.isArray(parsed)
    ? { ...parsed }
    : null;
}

/**
 * The skill's `SKILL.md`: its document as stored, with its frontmatter
 * `name` set to the bundle's name and a `description` when it has none, so
 * the name a step's agent sees is the one the bundle names. The frontmatter
 * is parsed and written again as YAML, so a quoted key or a block scalar
 * keeps it valid; one that doesn't parse is replaced. The body is kept.
 */
export function cloudRunSkillDocument(skill: CapabilityBundleSkill): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n?---(?:\r?\n|$)/.exec(skill.content);
  const stored = match === null ? {} : (frontmatterOf(match[1] ?? '') ?? {});
  const description = stored.description;
  const frontmatter: Record<string, unknown> = {
    ...stored,
    name: skill.name,
    description:
      typeof description === 'string' && description.trim() !== ''
        ? description
        : skill.description,
  };
  const body =
    match === null ? skill.content : skill.content.slice(match[0].length);
  return `---\n${yaml.dump(frontmatter, { schema: yaml.JSON_SCHEMA, lineWidth: -1 })}---\n${body}`;
}

/** The manifest files that name a plugin, per provider tree. */
const PLUGIN_MANIFESTS = [
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
];

/** A plugin manifest's `name`, or null when it has none or doesn't parse. */
function manifestNameOf(bytes: Buffer | undefined): string | null {
  if (bytes === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  const name: unknown =
    typeof parsed === 'object' && parsed !== null
      ? Reflect.get(parsed, 'name')
      : undefined;
  return typeof name === 'string' ? name : null;
}

/** One plugin manifest of a provider's trees: where it is and its names. */
interface PluginManifest {
  /** `<root>/<manifest path>`. */
  readonly key: string;
  /** The manifest's own `name`. */
  readonly name: string;
  /** The name the plan gave its plugin. */
  readonly planned: string;
}

/** The named manifests of one provider's plugin trees, in plan order. */
function pluginManifestsOf(
  provider: 'claude' | 'codex',
  bundle: CapabilityBundleV1,
  plan: CloudRunCapabilityPlan,
  blobs: ReadonlyMap<string, Buffer>,
): PluginManifest[] {
  const manifests: PluginManifest[] = [];
  for (const plugin of plan.plugins) {
    const root = provider === 'claude' ? plugin.claudeRoot : plugin.codexRoot;
    const tree = bundle.fileTrees?.find((entry) => entry.root === root);
    if (root === undefined || tree === undefined) continue;
    for (const manifestPath of PLUGIN_MANIFESTS) {
      const entry = tree.entries.find((file) => file.path === manifestPath);
      const name = manifestNameOf(
        entry === undefined ? undefined : blobs.get(entry.sha256),
      );
      if (name !== null)
        manifests.push({
          key: `${root}/${manifestPath}`,
          name,
          planned: plugin.name,
        });
    }
  }
  return manifests;
}

/** `base`, suffixed `-2`, `-3`, ... until no name in `taken` uses it. */
function unusedName(base: string, taken: ReadonlySet<string>): string {
  let name = base;
  for (let suffix = 2; taken.has(name.toLowerCase()); suffix += 1)
    name = `${base}-${String(suffix)}`;
  return name;
}

/**
 * The renames that keep every final name distinct from each other and from
 * `reserved`: the first manifest to use a free name keeps it; each later
 * one, and one whose name is reserved, takes its planned name, suffixed
 * until it is free. Answers the renames and every final name, lowercased.
 */
function distinctNames(
  manifests: readonly PluginManifest[],
  reserved: ReadonlySet<string>,
): { renames: Map<string, string>; names: string[] } {
  const taken = new Set(reserved);
  const kept = new Set<string>();
  const colliding = manifests.filter((manifest) => {
    const name = manifest.name.toLowerCase();
    if (taken.has(name) || kept.has(name)) return true;
    kept.add(name);
    return false;
  });
  for (const name of kept) taken.add(name);
  const renames = new Map<string, string>();
  for (const manifest of colliding) {
    const name = unusedName(manifest.planned, taken);
    taken.add(name.toLowerCase());
    renames.set(manifest.key, name);
  }
  return {
    renames,
    names: [
      ...kept,
      ...[...renames.values()].map((name) => name.toLowerCase()),
    ],
  };
}

/** The final manifest names of the bundles a runner holds, per provider. */
interface HeldManifestNames {
  readonly claude: ReadonlySet<string>;
  readonly codex: ReadonlySet<string>;
}

/** How one bundle's plugins are named on the runner. */
interface BundleNaming {
  /** The manifests to rename, by `<root>/<manifest path>`. */
  readonly renames: Map<string, string>;
  /** The generated MCP plugin's manifest name, when the bundle has one. */
  readonly mcpName?: string;
  /** Every final name the bundle adds, lowercased, per provider. */
  readonly names: { readonly claude: string[]; readonly codex: string[] };
}

/**
 * How a bundle's plugins are named on the runner. The provider names a
 * plugin's skills and MCP servers after its manifest `name`, and a step
 * can load two collections at once (its own and its model alias's), so
 * every final name stays distinct across the bundles the runner holds. The
 * generated MCP plugin is named after the bundle's digest; a plugin whose
 * manifest name another plugin already uses takes its planned name,
 * suffixed until it is free. Every other plugin keeps its own name, as
 * desktop loads it. Bundles arrive in the order the web core sends them on
 * every incarnation, so the names do not change between incarnations.
 */
function bundleNaming(
  bundle: CapabilityBundleV1,
  plan: CloudRunCapabilityPlan,
  blobs: ReadonlyMap<string, Buffer>,
  held: HeldManifestNames,
): BundleNaming {
  const claudeTaken = new Set(held.claude);
  const mcpName = plan.mcpPlugin
    ? unusedName(
        `${CLOUD_RUN_CAPABILITY_MCP_PLUGIN}-${plan.key.slice(0, 8).toLowerCase()}`,
        claudeTaken,
      )
    : undefined;
  if (mcpName !== undefined) claudeTaken.add(mcpName.toLowerCase());
  const claude = distinctNames(
    pluginManifestsOf('claude', bundle, plan, blobs),
    claudeTaken,
  );
  const codex = distinctNames(
    pluginManifestsOf('codex', bundle, plan, blobs),
    held.codex,
  );
  return {
    renames: new Map([...claude.renames, ...codex.renames]),
    ...(mcpName !== undefined && { mcpName }),
    names: {
      claude: [
        ...claude.names,
        ...(mcpName === undefined ? [] : [mcpName.toLowerCase()]),
      ],
      codex: codex.names,
    },
  };
}

/** A manifest's bytes with its `name` set to `name`. */
function renamedManifest(bytes: Buffer, name: string): Buffer {
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  return Buffer.from(
    `${JSON.stringify(typeof parsed === 'object' && parsed !== null ? { ...parsed, name } : { name }, null, 2)}\n`,
  );
}

/** Files that start with `#!` stay executable: a plugin's scripts and servers. */
function modeOf(bytes: Buffer): number {
  return bytes.subarray(0, 2).toString('latin1') === '#!' ? 0o755 : 0o644;
}

/**
 * Each run's capabilities on one runner: the bundles its imports delivered,
 * by digest key. The launch resolver asks it whether a start's plugin
 * collection snapshots name only bundles it holds.
 */
export class PipelineRunnerCapabilityStore implements PipelineRunnerCapabilityPort {
  readonly #dataRoot: string;
  readonly #proxy: PipelineRunnerMcpProxy | undefined;
  #staging: Staging | undefined;
  /** The import checking and writing its delivery, and the delivery it holds. */
  #finishing:
    | {
        readonly delivery: WorkerPipelineCapabilityDeliveryRef;
        readonly done: Promise<void>;
      }
    | undefined;
  /** The last delivery that completed, so its last chunk sent again is answered. */
  #completed: WorkerPipelineCapabilityDeliveryRef | undefined;
  /** The bundles installed, by digest key, in the order they arrived. */
  readonly #held = new Map<string, CloudRunCapabilityPlan>();
  /**
   * The bundles the committed plugin catalog lists: what a start may name.
   * A bundle installed but not yet listed resolves to nothing, so a start
   * that names it is refused until a catalog that lists it commits.
   */
  #listed: ReadonlySet<string> = new Set();
  /** The final manifest names of the installed bundles, per provider. */
  readonly #manifestNames = {
    claude: new Set<string>(),
    codex: new Set<string>(),
  };

  constructor(dataRoot: string, proxy?: PipelineRunnerMcpProxy) {
    this.#dataRoot = path.resolve(dataRoot);
    this.#proxy = proxy;
  }

  async importCapabilities(
    params: WorkerPipelineCapabilitiesImportParams,
    context: { readonly leaseHeld: () => boolean },
  ): Promise<WorkerPipelineCapabilitiesImportResult> {
    const { delivery, offset } = params;
    const chunk = decodeChunk(params.chunk);
    const end = offset + chunk.byteLength;
    // The last chunk sent again while it installs, or after it did.
    const finishing = this.#finishing;
    if (
      finishing &&
      sameDelivery(finishing.delivery, delivery) &&
      end === delivery.byteSize
    ) {
      await finishing.done;
      return { received: delivery.byteSize, complete: true };
    }
    if (finishing)
      throw refuse("This run's capabilities are still being installed.");
    if (
      this.#completed &&
      sameDelivery(this.#completed, delivery) &&
      !this.#staging &&
      end === delivery.byteSize
    )
      return { received: delivery.byteSize, complete: true };
    let staging = this.#staging;
    if (
      offset === 0 &&
      (!staging || !sameDelivery(staging.delivery, delivery))
    ) {
      staging = { delivery, chunks: [], received: 0 };
      this.#staging = staging;
    }
    if (!staging || !sameDelivery(staging.delivery, delivery))
      throw refuse(
        "This run's capabilities must be sent from their first chunk.",
      );
    // A chunk sent again after its reply was lost.
    if (end <= staging.received && offset < staging.received)
      return { received: staging.received, complete: false };
    if (offset !== staging.received)
      throw refuse("This run's capabilities arrived out of order.");
    if (end > delivery.byteSize) {
      this.#staging = undefined;
      throw refuse("This run's capabilities are longer than their delivery.");
    }
    staging.chunks.push(chunk);
    staging.received = end;
    if (end < delivery.byteSize) return { received: end, complete: false };
    this.#staging = undefined;
    const bytes = Buffer.concat(staging.chunks, staging.received);
    const done = this.#install(bytes, delivery, context);
    this.#finishing = { delivery, done };
    try {
      await done;
    } finally {
      this.#finishing = undefined;
    }
    this.#completed = delivery;
    return { received: delivery.byteSize, complete: true };
  }

  /**
   * Fails a start whose plugin collection snapshots name a `cloud-run:`
   * skill source or marketplace this runner holds no bundle for, or that
   * arrives while an import installs: its steps would run without them.
   */
  assertDelivered(snapshots: unknown): void {
    if (this.#finishing)
      throw pipelineStartFailedError(
        new Error("This run's capabilities are still being installed."),
      );
    for (const source of cloudRunSourcesOf(snapshots)) {
      const key = cloudRunCapabilityKeyOf(source);
      if (key === null || !this.#listed.has(key))
        throw pipelineStartFailedError(
          new Error("This run's capabilities were not delivered."),
        );
    }
  }

  async #install(
    bytes: Buffer,
    delivery: WorkerPipelineCapabilityDeliveryRef,
    context: { readonly leaseHeld: () => boolean },
  ): Promise<void> {
    if (sha256(bytes) !== delivery.sha256)
      throw refuse("This run's capabilities do not match their digest.");
    const checked = this.#check(bytes);
    let added = false;
    try {
      for (const [key, entry] of checked.bundles) {
        if (this.#held.has(key)) continue;
        await this.#write(entry, checked.blobs, context);
        this.#held.set(key, entry.plan);
        added = true;
      }
    } catch (error) {
      // The bundles installed before the failure are held: list them, so a
      // start that names one finds it, unless the lease ended meanwhile.
      if (added && context.leaseHeld())
        await this.#writeCatalog(context).catch(() => undefined);
      throw error;
    }
    await this.#writeCatalog(context);
  }

  /** The delivery's bundles by key and its blobs by SHA-256, all checked. */
  #check(bytes: Buffer): {
    bundles: Map<string, CheckedBundle>;
    blobs: Map<string, Buffer>;
  } {
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      throw refuse("This run's capabilities are not valid.", error);
    }
    const parsed = WorkerPipelineCapabilityDeliverySchema.safeParse(raw);
    if (!parsed.success)
      throw refuse("This run's capabilities are not valid.", parsed.error);
    const blobs = new Map<string, Buffer>();
    for (const blob of parsed.data.blobs) {
      const content = Buffer.from(blob.content, 'base64');
      if (sha256(content) !== blob.sha256)
        throw refuse(
          "A file of this run's capabilities does not match its digest.",
        );
      blobs.set(blob.sha256, content);
    }
    const allowedMcpOrigins = this.#proxy ? [this.#proxy.origin] : [];
    const bundles = new Map<string, CheckedBundle>();
    for (const { digest, bundle } of parsed.data.bundles) {
      if (!isCapabilityBundleV1(bundle) || digestOf(bundle) !== digest)
        throw refuse('A capability bundle does not match its digest.');
      const errors = validateCapabilityBundle(bundle, { allowedMcpOrigins });
      if (errors.length > 0)
        throw refuse(
          `A capability bundle is not valid: ${errors.slice(0, 3).join('; ')}`,
        );
      const plan = cloudRunCapabilityPlan(digest, bundle);
      const planned = new Set(
        plan.plugins.flatMap((plugin) =>
          [plugin.claudeRoot, plugin.codexRoot].filter(
            (root): root is string => root !== undefined,
          ),
        ),
      );
      for (const tree of bundle.fileTrees ?? []) {
        if (!planned.has(tree.root)) continue;
        for (const entry of tree.entries) {
          const blob = blobs.get(entry.sha256);
          if (blob === undefined || blob.byteLength !== entry.size)
            throw refuse(
              "A plugin file of this run's capabilities is missing or the wrong size.",
            );
        }
      }
      bundles.set(plan.key, { bundle, plan });
    }
    return { bundles, blobs };
  }

  /**
   * Writes one bundle beside its folders, then swaps each in. The import
   * writes outside the host's lease fence, so it asks for the lease before
   * it swaps the folders in and again after: a lease that ended meanwhile
   * removes what it installed, and the import is refused.
   */
  async #write(
    { bundle, plan }: CheckedBundle,
    blobs: ReadonlyMap<string, Buffer>,
    context: { readonly leaseHeld: () => boolean },
  ): Promise<void> {
    const pluginsRoot = path.join(
      this.#dataRoot,
      CLOUD_RUN_CAPABILITIES_DIR,
      plan.key,
    );
    const skillsRoot = path.join(
      this.#dataRoot,
      'skills',
      getSkillSourceDirectoryName(plan.source),
    );
    const suffix = `.installing-${randomUUID()}`;
    const stagedPlugins = `${pluginsRoot}${suffix}`;
    const stagedSkills = `${skillsRoot}${suffix}`;
    try {
      await mkdir(stagedPlugins, { recursive: true, mode: 0o700 });
      await mkdir(stagedSkills, { recursive: true, mode: 0o700 });
      for (const skill of bundle.skills) {
        const folder = inside(stagedSkills, skill.name);
        await mkdir(folder, { recursive: true });
        await writeFile(
          path.join(folder, CAPABILITY_BUNDLE_SKILL_ENTRYPOINT_FILENAME),
          cloudRunSkillDocument(skill),
          { mode: 0o644 },
        );
        for (const file of skill.files ?? []) {
          const target = inside(folder, file.path);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, file.content, { mode: 0o644 });
        }
      }
      const planned = new Set(
        plan.plugins.flatMap((plugin) =>
          [plugin.claudeRoot, plugin.codexRoot].filter(
            (root): root is string => root !== undefined,
          ),
        ),
      );
      const naming = bundleNaming(bundle, plan, blobs, this.#manifestNames);
      const renames = naming.renames;
      for (const tree of bundle.fileTrees ?? []) {
        if (!planned.has(tree.root)) continue;
        const treeRoot = inside(stagedPlugins, tree.root);
        for (const entry of tree.entries) {
          const stored = blobs.get(entry.sha256) ?? Buffer.alloc(0);
          const rename = renames.get(`${tree.root}/${entry.path}`);
          const content =
            rename === undefined ? stored : renamedManifest(stored, rename);
          const target = inside(treeRoot, entry.path);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, content, { mode: modeOf(content) });
        }
      }
      if (naming.mcpName !== undefined)
        await this.#writeMcpPlugin(bundle, stagedPlugins, naming.mcpName);
      if (!context.leaseHeld()) throw refuse("This runner's lease has ended.");
      await rm(pluginsRoot, { recursive: true, force: true });
      await rm(skillsRoot, { recursive: true, force: true });
      await mkdir(path.dirname(pluginsRoot), { recursive: true });
      await mkdir(path.dirname(skillsRoot), { recursive: true });
      await rename(stagedPlugins, pluginsRoot);
      await rename(stagedSkills, skillsRoot);
      if (!context.leaseHeld()) {
        await rm(pluginsRoot, { recursive: true, force: true });
        await rm(skillsRoot, { recursive: true, force: true });
        throw refuse("This runner's lease has ended.");
      }
      for (const name of naming.names.claude)
        this.#manifestNames.claude.add(name);
      for (const name of naming.names.codex)
        this.#manifestNames.codex.add(name);
    } catch (error) {
      await rm(stagedPlugins, { recursive: true, force: true });
      await rm(stagedSkills, { recursive: true, force: true });
      throw error instanceof CanopyOperationError
        ? error
        : refuse("This run's capabilities could not be installed.", error);
    }
  }

  /**
   * The bundle's MCP servers as one Claude plugin. The bundle validation
   * already held every server to the proxy origin; the session key is added
   * for that origin only, and its file is readable by the runner alone.
   */
  async #writeMcpPlugin(
    bundle: CapabilityBundleV1,
    folder: string,
    manifestName: string,
  ): Promise<void> {
    const proxy = this.#proxy;
    if (proxy === undefined)
      throw refuse("This run's MCP servers need the run's AI Credits session.");
    const servers: Record<string, unknown> = {};
    for (const [name, server] of Object.entries(
      projectMcpServersForClaudeCode(bundle),
    )) {
      if (new URL(server.url).origin !== new URL(proxy.origin).origin)
        throw refuse("This run's MCP servers must use the run's MCP proxy.");
      servers[name] = {
        ...server,
        headers: { ...server.headers, Authorization: `Bearer ${proxy.token}` },
      };
    }
    const plugin = path.join(folder, MCP_PLUGIN_DIR);
    await mkdir(path.join(plugin, '.claude-plugin'), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      path.join(plugin, '.claude-plugin', 'plugin.json'),
      `${JSON.stringify(
        {
          name: manifestName,
          description: "This run's account MCP connections.",
        },
        null,
        2,
      )}\n`,
      { mode: 0o644 },
    );
    await writeFile(
      path.join(plugin, '.mcp.json'),
      `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  /**
   * The plugin catalog for every bundle held, written whole and swapped in,
   * only while the lease holds: a stale incarnation's catalog would name
   * nothing its fenced host runs, so the import is refused instead.
   */
  async #writeCatalog(context: {
    readonly leaseHeld: () => boolean;
  }): Promise<void> {
    const now = new Date().toISOString();
    const listing = new Set(this.#held.keys());
    const marketplaces = [...this.#held.values()].map((plan) =>
      catalogMarketplace(
        plan,
        path.join(this.#dataRoot, CLOUD_RUN_CAPABILITIES_DIR, plan.key),
        now,
      ),
    );
    const target = path.join(this.#dataRoot, PLUGIN_CATALOG_FILE);
    const staged = `${target}.installing-${randomUUID()}`;
    try {
      await writeFile(
        staged,
        `${JSON.stringify({ version: 2, lastRefreshed: now, marketplaces }, null, 2)}\n`,
        { mode: 0o644 },
      );
      if (!context.leaseHeld()) throw refuse("This runner's lease has ended.");
      await rename(staged, target);
    } catch (error) {
      await rm(staged, { force: true });
      throw error instanceof CanopyOperationError
        ? error
        : refuse("This run's plugin catalog could not be written.", error);
    }
    if (!context.leaseHeld()) throw refuse("This runner's lease has ended.");
    this.#listed = listing;
  }
}

/** An array's entries as unknown values, or none for anything else. */
function entriesOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value.map((entry: unknown) => entry) : [];
}

/** A member of an object, or undefined for anything else. */
function memberOf(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? Reflect.get(value, key)
    : undefined;
}

/** Every `cloud-run:` skill source and marketplace a start's snapshots name. */
function cloudRunSourcesOf(snapshots: unknown): Set<string> {
  const sources = new Set<string>();
  const add = (value: unknown): void => {
    if (
      typeof value === 'string' &&
      value.startsWith(CLOUD_RUN_CAPABILITY_SOURCE_PREFIX)
    )
      sources.add(value);
  };
  const scan = (selections: unknown): void => {
    for (const ref of entriesOf(memberOf(selections, 'skillRefs')))
      add(memberOf(ref, 'sourceId'));
    for (const ref of entriesOf(memberOf(selections, 'pluginRefs')))
      add(memberOf(ref, 'marketplaceId'));
  };
  if (typeof snapshots !== 'object' || snapshots === null) return sources;
  for (const snapshot of Object.values(snapshots)) {
    scan(memberOf(snapshot, 'selections'));
    scan(memberOf(snapshot, 'chatSelections'));
  }
  return sources;
}

/** One provider facet of a catalog plugin: native, installed at `location`. */
function facet(
  name: string,
  provider: 'claude' | 'codex',
  location: string,
  sourcePath: string,
): Record<string, unknown> {
  return {
    name,
    provider,
    mode: 'native',
    sourcePath,
    installLocation: location,
  };
}

/** One bundle's marketplace in the plugin catalog (`PluginsCache` v2). */
function catalogMarketplace(
  plan: CloudRunCapabilityPlan,
  folder: string,
  now: string,
): Record<string, unknown> {
  const plugins: Record<string, unknown>[] = plan.plugins.map((plugin) => ({
    name: plugin.name,
    sourcePath: plugin.claudeRoot ?? plugin.codexRoot ?? plugin.name,
    marketplaceId: plan.source,
    providerSupport: {
      claude: plugin.claudeRoot !== undefined ? 'native' : 'none',
      codex: plugin.codexRoot !== undefined ? 'native' : 'none',
    },
    facets: {
      ...(plugin.claudeRoot !== undefined && {
        claude: facet(
          plugin.name,
          'claude',
          path.join(folder, ...plugin.claudeRoot.split('/')),
          plugin.claudeRoot,
        ),
      }),
      ...(plugin.codexRoot !== undefined && {
        codex: facet(
          plugin.name,
          'codex',
          path.join(folder, ...plugin.codexRoot.split('/')),
          plugin.codexRoot,
        ),
      }),
    },
  }));
  if (plan.mcpPlugin)
    plugins.push({
      name: CLOUD_RUN_CAPABILITY_MCP_PLUGIN,
      sourcePath: MCP_PLUGIN_DIR,
      marketplaceId: plan.source,
      providerSupport: { claude: 'native', codex: 'none' },
      facets: {
        claude: facet(
          CLOUD_RUN_CAPABILITY_MCP_PLUGIN,
          'claude',
          path.join(folder, MCP_PLUGIN_DIR),
          MCP_PLUGIN_DIR,
        ),
      },
    });
  const status = (provider: 'claude' | 'codex'): Record<string, unknown> => ({
    provider,
    state: 'valid',
    accepted: true,
    pluginCount: plugins.length,
    lastCheckedAt: now,
  });
  return {
    id: plan.source,
    name: plan.source,
    description: "A cloud run's plugin collection.",
    sourceType: 'cloud-run',
    sourceUrl: plan.source,
    installLocation: folder,
    lastUpdated: now,
    pluginCount: plugins.length,
    plugins,
    providerStatus: { claude: status('claude'), codex: status('codex') },
    validProviders: ['claude', 'codex'],
  };
}
