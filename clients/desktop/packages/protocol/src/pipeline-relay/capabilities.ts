/**
 * A cloud run's capabilities on its runner (CAN-6439, cloud pipelines CP-25).
 *
 * The web core resolves each plugin collection a cloud run names into a
 * capability bundle (`CapabilityBundleV1`) with the producer cloud chats use,
 * and delivers the bundles to each runner incarnation with
 * `worker.pipeline.capabilities.import` before it sends the run's portable
 * start. The runner materializes each bundle in its data root, under the
 * bundle's digest, as the engine's plugin resolver reads installed skills
 * and plugins on desktop:
 *
 * - each skill under `skills/<source>/<name>/`;
 * - each plugin's Claude and Codex trees under
 *   `cloud-capabilities/<digest body>/`, listed in the data root's plugin
 *   catalog under the marketplace `<source>`;
 * - the bundle's MCP servers, all behind the web origin's MCP proxy, as one
 *   Claude plugin, {@link CLOUD_RUN_CAPABILITY_MCP_PLUGIN}, whose MCP
 *   configuration names them. A pipeline's SDK step loads only the MCP
 *   servers a plugin ships (CAN-6277), on desktop too.
 *
 * `<source>` is {@link cloudRunCapabilitySource}. The run's portable start
 * carries, for each collection, the selection refs
 * {@link cloudRunCapabilityPlan} names for its bundle, so its steps resolve
 * the bundle exactly. Both ends compute the plan from the bundle alone.
 *
 * A bundle is secret-free: the runner adds the MCP proxy credential, the
 * run's AI Credits session key from its activation, only for servers at the
 * activation's proxy origin, so no credential crosses the relay (P9).
 * Paths depend only on the digest and the data root, which every
 * incarnation of a delegation shares, so a run resumed on a new incarnation
 * finds its plugins where its state recorded them once the bundles are
 * delivered again.
 */
import {
  CAPABILITY_BUNDLE_DIGEST_PREFIX,
  createCapabilitySkillNameAllocator,
  isCapabilityBundleDigest,
  type CapabilityBundleV1,
} from '../capability-bundle';

/** What a cloud run's skill sources and plugin marketplaces start with. */
export const CLOUD_RUN_CAPABILITY_SOURCE_PREFIX = 'cloud-run:';

/** Under the runner's data root: each bundle's plugin trees, by digest body. */
export const CLOUD_RUN_CAPABILITIES_DIR = 'cloud-capabilities';

/** The Claude plugin that carries a bundle's MCP servers. */
export const CLOUD_RUN_CAPABILITY_MCP_PLUGIN = 'cloud-mcp';

/** Where a bundle's plugin trees are rooted: `plugins/<provider>/<key>`. */
const PLUGIN_TREE_ROOT = /^plugins\/(claude|codex)\/(.+)$/;

/** One plugin of a bundle: its name and the bundle roots of its trees. */
export interface CloudRunCapabilityPlugin {
  /** Its plugin name in the run's marketplace: lowercase, unique in the bundle. */
  readonly name: string;
  /** The `fileTrees[].root` of its Claude tree, when it has one. */
  readonly claudeRoot?: string;
  /** The `fileTrees[].root` of its Codex tree, when it has one. */
  readonly codexRoot?: string;
}

/**
 * The selection refs a run's steps resolve a materialized bundle with: a
 * plugin collection snapshot's `selections`. A type, not an interface, so it
 * is a JSON value a portable start carries.
 */
export type CloudRunCapabilitySelections = {
  collectionIds: string[];
  skillRefs: { sourceId: string; skillName: string }[];
  pluginRefs: { marketplaceId: string; pluginName: string }[];
  mcpServerRefs: { serverId: string; configId: string }[];
};

/** How a runner materializes one bundle, and the refs that name it. */
export interface CloudRunCapabilityPlan {
  /** The digest body: the bundle's folder under {@link CLOUD_RUN_CAPABILITIES_DIR}. */
  readonly key: string;
  /** The skill source and plugin marketplace id: {@link cloudRunCapabilitySource}. */
  readonly source: string;
  /** The bundle's skill names, as the bundle names them. */
  readonly skills: readonly string[];
  /** The bundle's plugins, from its `plugins/<provider>/<key>` trees, in order. */
  readonly plugins: readonly CloudRunCapabilityPlugin[];
  /** File trees rooted elsewhere, such as a chat's memory: never materialized. */
  readonly ignoredRoots: readonly string[];
  /** Whether {@link CLOUD_RUN_CAPABILITY_MCP_PLUGIN} carries the bundle's MCP servers. */
  readonly mcpPlugin: boolean;
  readonly selections: CloudRunCapabilitySelections;
}

/** `cloud-run:<digest body>`: the skill source and marketplace a bundle's refs name. */
export function cloudRunCapabilitySource(digest: string): string {
  if (!isCapabilityBundleDigest(digest))
    throw new Error('Not a capability bundle digest.');
  return `${CLOUD_RUN_CAPABILITY_SOURCE_PREFIX}${digest.slice(CAPABILITY_BUNDLE_DIGEST_PREFIX.length)}`;
}

/** The digest body a `cloud-run:` source names, or null for any other source. */
export function cloudRunCapabilityKeyOf(source: string): string | null {
  if (!source.startsWith(CLOUD_RUN_CAPABILITY_SOURCE_PREFIX)) return null;
  const key = source.slice(CLOUD_RUN_CAPABILITY_SOURCE_PREFIX.length);
  return isCapabilityBundleDigest(`${CAPABILITY_BUNDLE_DIGEST_PREFIX}${key}`)
    ? key
    : null;
}

/**
 * The plan for one bundle, from its digest and content alone. Plugins pair a
 * bundle's Claude and Codex trees by the key after `plugins/<provider>/`, so
 * a curated plugin (`plugins/claude/<key>`) and a marketplace plugin
 * (`plugins/claude/marketplaces/<id>/<key>`) stay apart. Each is named after
 * its key's last segment, lowercased (the resolver matches plugin names
 * without case) and made unique with `-2`, `-3`, ...; the MCP plugin's name
 * is reserved.
 */
export function cloudRunCapabilityPlan(
  digest: string,
  bundle: CapabilityBundleV1,
): CloudRunCapabilityPlan {
  const source = cloudRunCapabilitySource(digest);
  const key = source.slice(CLOUD_RUN_CAPABILITY_SOURCE_PREFIX.length);
  const trees = new Map<string, { claude?: string; codex?: string }>();
  const ignoredRoots: string[] = [];
  for (const tree of bundle.fileTrees ?? []) {
    const match = PLUGIN_TREE_ROOT.exec(tree.root);
    const provider = match?.[1];
    const pluginKey = match?.[2];
    if (
      match === null ||
      pluginKey === undefined ||
      (provider !== 'claude' && provider !== 'codex')
    ) {
      ignoredRoots.push(tree.root);
      continue;
    }
    const pair = trees.get(pluginKey) ?? {};
    // A second tree for the same provider and key would overwrite the first.
    if (pair[provider] !== undefined) {
      ignoredRoots.push(tree.root);
      continue;
    }
    pair[provider] = tree.root;
    trees.set(pluginKey, pair);
  }
  const names = createCapabilitySkillNameAllocator();
  names.claim(CLOUD_RUN_CAPABILITY_MCP_PLUGIN);
  const plugins: CloudRunCapabilityPlugin[] = [];
  for (const [pluginKey, pair] of trees) {
    const segments = pluginKey.split('/');
    const name = names.claim(
      (segments[segments.length - 1] ?? pluginKey).toLowerCase(),
    );
    plugins.push({
      name,
      ...(pair.claude !== undefined && { claudeRoot: pair.claude }),
      ...(pair.codex !== undefined && { codexRoot: pair.codex }),
    });
  }
  const mcpPlugin = bundle.mcpServers.length > 0;
  const skills = bundle.skills.map((skill) => skill.name);
  return {
    key,
    source,
    skills,
    plugins,
    ignoredRoots,
    mcpPlugin,
    selections: {
      collectionIds: [],
      skillRefs: skills.map((skillName) => ({ sourceId: source, skillName })),
      pluginRefs: [
        ...plugins.map(({ name }) => ({
          marketplaceId: source,
          pluginName: name,
        })),
        ...(mcpPlugin
          ? [
              {
                marketplaceId: source,
                pluginName: CLOUD_RUN_CAPABILITY_MCP_PLUGIN,
              },
            ]
          : []),
      ],
      mcpServerRefs: [],
    },
  };
}
