/**
 * Integration identity for Customize catalog entries (CAN-6808).
 *
 * The same integration reaches the catalog from several places: the Claude
 * and Codex marketplaces, the curated MCP catalog, curated plugins, provider
 * connectors and installed servers. This module decides which entries are the
 * same integration, so a surface can show one row per integration. It is
 * pure and deterministic: the same sources give the same groups and keys in
 * any input order, on desktop and in the Portal.
 *
 * Grouping uses the publisher brand (the registrable domain label of a
 * publisher or MCP address, so `sentry.io` and `sentry.dev` are both
 * `sentry`) and the MCP server host:
 *
 * 1. Entries with the same normalized name join, unless their brands or MCP
 *    domains disagree (`apollo` on apollo.io is not `apollo-skills` on
 *    apollographql.com).
 * 2. An entry whose name contains another's joins it when both share a brand
 *    and, where both name an MCP host, the same host. That keeps one
 *    publisher's products apart (Adobe Express and Adobe Workfront both sit
 *    on adobe.io, on different hosts). An entry with no MCP host that would
 *    reach several such products joins none of them: it is ambiguous.
 *
 * Generic hosting domains (github.com, googleapis.com, workers.dev, …) are
 * never a brand, so Google and Microsoft products never join by domain.
 */

/** Where a copy comes from, which orders the preferred-endpoint choice. */
export type CatalogIntegrationSourceKind =
  | 'mcp-catalog'
  | 'connector'
  | 'curated-plugin'
  | 'marketplace-plugin'
  | 'installed';

/** One catalog entry as the grouping sees it. */
export interface CatalogIntegrationSource {
  /** The entry id; never changed by grouping. */
  readonly id: string;
  readonly kind: CatalogIntegrationSourceKind;
  /** Display and package names; each is normalized and compared. */
  readonly names: readonly string[];
  /** Publisher addresses: homepage, author, docs or package source URLs. */
  readonly publisherUrls: readonly string[];
  /**
   * MCP servers the entry connects to: an http(s) URL, a bare host, or a
   * command line (only an npm scope in it is read).
   */
  readonly mcpEndpoints: readonly string[];
}

/** One integration: every copy of it, and the endpoint to prefer. */
export interface CatalogIntegration {
  /** Stable for the same members; the optional `integrationKey` field. */
  readonly key: string;
  /** Member entry ids, in input order. */
  readonly memberIds: readonly string[];
  /** The http MCP endpoint to prefer when copies point at different URLs. */
  readonly preferredEndpoint?: string;
}

/** Not a publisher brand: hosting, package and social domains. */
const GENERIC_DOMAINS = new Set([
  'amazonaws.com',
  'anthropic.com',
  'apple.com',
  'azurewebsites.net',
  'claude.ai',
  'cloudflare.com',
  'docs.google.com',
  'fly.dev',
  'github.com',
  'github.io',
  'githubusercontent.com',
  'gitbook.io',
  'gitlab.com',
  'google.com',
  'googleapis.com',
  'herokuapp.com',
  'linkedin.com',
  'medium.com',
  'microsoft.com',
  'mintlify.app',
  'modelcontextprotocol.io',
  'netlify.app',
  'notion.site',
  'npmjs.com',
  'onrender.com',
  'openai.com',
  'pages.dev',
  'pypi.org',
  'readme.io',
  'run.app',
  'smithery.ai',
  'twitter.com',
  'vercel.app',
  'workers.dev',
  'x.com',
  'youtube.com',
]);

/** Second-level labels under which a country code is the public suffix. */
const SECOND_LEVEL_SUFFIXES = new Set(['co', 'com', 'org', 'net', 'ac', 'gov']);

/** Containment shorter than this is a coincidence, not a product name. */
const MIN_CONTAINED_NAME_LENGTH = 3;

const SOURCE_RANK: Record<CatalogIntegrationSourceKind, number> = {
  'mcp-catalog': 0,
  connector: 1,
  'curated-plugin': 2,
  'marketplace-plugin': 3,
  installed: 4,
};

const QUALIFIER_PHRASES = /\b(?:for claude|for codex|by [a-z0-9 ]+)\b/g;
const TRAILING_KIND_WORDS =
  /[-_ ]?(?:mcp|plugins?|skills?|lsp|server|connector|official|app|tools?|integration|toolkit|cli)$/;
const TRAILING_PACKAGE_WORDS =
  /[-_ ]?(?:mcp|plugins?|skills?|server|official)$/;

/**
 * The name two copies of one integration share: lowercased, without
 * qualifiers (`for Claude`, `by Acme`), one trailing kind word (`plugin`,
 * `skills`, `cli`, …) and then one more package word, and punctuation.
 * `vanta-mcp-plugin`, `Zoom for Claude` and `huggingface-skills` become
 * `vanta`, `zoom` and `huggingface`.
 */
function catalogIntegrationNameKey(name: string): string {
  let key = name.toLowerCase().replace(QUALIFIER_PHRASES, '');
  key = key.trim().replace(TRAILING_KIND_WORDS, '');
  key = key.trim().replace(TRAILING_PACKAGE_WORDS, '');
  return key.replace(/[^a-z0-9]/g, '');
}

function urlHostname(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : /^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(trimmed)
      ? `https://${trimmed}`
      : undefined;
  return withScheme === undefined
    ? undefined
    : parseCatalogWebUrl(withScheme)?.hostname.toLowerCase();
}

function parseCatalogWebUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.hostname &&
      (url.protocol === 'http:' || url.protocol === 'https:')
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

/** Canonical identity for a catalog URL, including its full path and query. */
export function canonicalCatalogEndpoint(value: string): string | undefined {
  return parseCatalogWebUrl(value)?.href;
}

/** `mcp.eu.vanta.com` → `vanta.com`; `bbc.co.uk` stays `bbc.co.uk`. */
function registrableDomain(hostname: string): string {
  const parts = hostname.replace(/^www\./, '').split('.');
  if (
    parts.length >= 3 &&
    parts[parts.length - 1].length === 2 &&
    SECOND_LEVEL_SUFFIXES.has(parts[parts.length - 2])
  ) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

/** Hosts that only resolve inside a private network. */
const PRIVATE_HOST_SUFFIXES = [
  '.local',
  '.internal',
  '.localhost',
  '.lan',
  '.home.arpa',
  '.corp',
  '.intranet',
  '.invalid',
  '.test',
  '.example',
];

/** A public, named host: never localhost, an IP or an intranet name. */
function publicHostname(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const host = urlHostname(value);
  if (
    host === undefined ||
    !host.includes('.') ||
    host.includes(':') ||
    /^[\d.]+$/.test(host) ||
    host === 'localhost' ||
    PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  )
    return undefined;
  return host;
}

/**
 * Brand domains whose own icon names their maker. They group nothing as
 * integrations (`GENERIC_DOMAINS`), but their site icon is still right.
 */
const SITE_ICON_BRAND_DOMAINS = new Set([
  'anthropic.com',
  'apple.com',
  'claude.ai',
  'cloudflare.com',
  'google.com',
  'microsoft.com',
  'openai.com',
]);

/**
 * A publisher name from an MCP server's address (Sergii's Customize QA):
 * `https://mcp.sentry.dev/mcp` reads "Sentry". `properName` (the server's or
 * listing's own name) supplies the casing when it is the same word
 * ("DeepWiki", not "Deepwiki"). Private hosts, hosting, package and social
 * domains name nobody.
 */
export function endpointPublisherName(
  endpoint: string | undefined,
  properName?: string,
): string | undefined {
  const host = publicHostname(endpoint);
  if (host === undefined) return undefined;
  const domain = registrableDomain(host);
  if (GENERIC_DOMAINS.has(domain)) return undefined;
  const label = brandLabel(domain);
  if (label === '') return undefined;
  const proper = properName?.trim();
  if (
    proper &&
    proper.replace(/[\s-]+/g, '').toLowerCase() === label.replace(/-/g, '')
  )
    return proper;
  return label
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * The brand an item's homepage or MCP server host names (`mcp.deepwiki.com`
 * reads `deepwiki`), for the bundled brand marks. Private, hosting, package
 * and social hosts name none.
 */
export function siteBrandKey(site: string | undefined): string | undefined {
  const host = publicHostname(site);
  if (host === undefined) return undefined;
  const domain = registrableDomain(host);
  if (GENERIC_DOMAINS.has(domain) && !SITE_ICON_BRAND_DOMAINS.has(domain))
    return undefined;
  const label = brandLabel(domain);
  return label === '' ? undefined : label;
}

/**
 * The site icon address for an item's homepage or MCP server URL (Sergii's
 * Customize QA, logo step 4): `https://<registrable domain>/favicon.ico`.
 * The desktop resolves it in main, trying the apple-touch-icon first, and
 * caches it on disk. Private hosts (localhost, IP addresses, `.local`,
 * `.internal` and other intranet names), single-label hosts and hosting,
 * package or social domains get none.
 */
export function siteIconUrl(site: string | undefined): string | undefined {
  const host = publicHostname(site);
  if (host === undefined) return undefined;
  const domain = registrableDomain(host);
  if (GENERIC_DOMAINS.has(domain) && !SITE_ICON_BRAND_DOMAINS.has(domain))
    return undefined;
  return `https://${domain}/favicon.ico`;
}

function brandLabel(domain: string): string {
  return domain.startsWith('npm:') ? domain.slice(4) : domain.split('.')[0];
}

function npmScope(command: string): string | undefined {
  const match = /@([a-z0-9-]+)\//i.exec(command);
  return match ? `npm:${match[1].toLowerCase()}` : undefined;
}

/**
 * An endpoint as a preferred-endpoint candidate: an http(s) URL with its
 * trailing `/` off. A bare host or a command line is never preferred.
 */
function endpointUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return undefined;
  if (urlHostname(trimmed) === undefined) return undefined;
  return trimmed.replace(/\/+(?=$|[?#])/, '');
}

interface Profile {
  readonly index: number;
  readonly source: CatalogIntegrationSource;
  readonly names: ReadonlySet<string>;
  /** Exact MCP hosts. */
  readonly hosts: ReadonlySet<string>;
  /** Registrable domains of MCP endpoints, generic ones included. */
  readonly endpointDomains: ReadonlySet<string>;
  /** Non-generic brand labels from MCP endpoints and publisher URLs. */
  readonly brands: ReadonlySet<string>;
}

function profile(source: CatalogIntegrationSource, index: number): Profile {
  const names = new Set<string>();
  for (const name of source.names) {
    const key = catalogIntegrationNameKey(name);
    if (key !== '') names.add(key);
  }
  const hosts = new Set<string>();
  const endpointDomains = new Set<string>();
  const brands = new Set<string>();
  const addBrand = (domain: string): void => {
    if (!GENERIC_DOMAINS.has(domain)) brands.add(brandLabel(domain));
  };
  for (const endpoint of source.mcpEndpoints) {
    const host = urlHostname(endpoint);
    if (host !== undefined) {
      const domain = registrableDomain(host);
      hosts.add(host);
      endpointDomains.add(domain);
      addBrand(domain);
      continue;
    }
    const scope = npmScope(endpoint);
    if (scope !== undefined) {
      endpointDomains.add(scope);
      addBrand(scope);
    }
  }
  for (const url of source.publisherUrls) {
    const host = urlHostname(url);
    if (host === undefined) continue;
    if (GENERIC_DOMAINS.has(host)) continue;
    addBrand(registrableDomain(host));
  }
  return { index, source, names, hosts, endpointDomains, brands };
}

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const value of a) if (b.has(value)) return true;
  return false;
}

/** Either side knows nothing, or the two agree on something. */
function agree(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === 0 || b.size === 0 || intersects(a, b);
}

/** A union-find component and what its members know together. */
interface Component {
  parent: number;
  readonly names: Set<string>;
  readonly hosts: Set<string>;
  readonly endpointDomains: Set<string>;
  readonly brands: Set<string>;
}

class Components {
  private readonly items: Component[];

  constructor(profiles: readonly Profile[]) {
    this.items = profiles.map((p) => ({
      parent: p.index,
      names: new Set(p.names),
      hosts: new Set(p.hosts),
      endpointDomains: new Set(p.endpointDomains),
      brands: new Set(p.brands),
    }));
  }

  root(index: number): number {
    let current = index;
    while (this.items[current].parent !== current) {
      const parent = this.items[current].parent;
      this.items[current].parent = this.items[parent].parent;
      current = parent;
    }
    return current;
  }

  get(index: number): Component {
    return this.items[this.root(index)];
  }

  union(a: number, b: number): void {
    const ra = this.root(a);
    const rb = this.root(b);
    if (ra === rb) return;
    // The lower index stays the root, so results do not depend on edge order.
    const [keep, drop] = ra < rb ? [ra, rb] : [rb, ra];
    const kept = this.items[keep];
    const dropped = this.items[drop];
    dropped.parent = keep;
    for (const value of dropped.names) kept.names.add(value);
    for (const value of dropped.hosts) kept.hosts.add(value);
    for (const value of dropped.endpointDomains)
      kept.endpointDomains.add(value);
    for (const value of dropped.brands) kept.brands.add(value);
  }
}

function compareIds(a: Profile, b: Profile): number {
  if (a.source.id < b.source.id) return -1;
  if (a.source.id > b.source.id) return 1;
  return a.index - b.index;
}

/** Same normalized name, and neither brands nor MCP domains disagree. */
function joinSameNames(
  profiles: readonly Profile[],
  components: Components,
): void {
  const byName = new Map<string, Profile[]>();
  for (const p of profiles) {
    for (const name of p.names) {
      const bucket = byName.get(name);
      if (bucket) bucket.push(p);
      else byName.set(name, [p]);
    }
  }
  for (const name of [...byName.keys()].sort()) {
    const bucket = (byName.get(name) ?? []).slice().sort(compareIds);
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = 0; j < i; j += 1) {
        const a = components.get(bucket[j].index);
        const b = components.get(bucket[i].index);
        if (a === b) continue;
        if (!agree(a.brands, b.brands)) continue;
        if (!agree(a.endpointDomains, b.endpointDomains)) continue;
        components.union(bucket[j].index, bucket[i].index);
      }
    }
  }
}

function properlyContains(longer: string, shorter: string): boolean {
  return (
    shorter.length >= MIN_CONTAINED_NAME_LENGTH &&
    longer.length > shorter.length &&
    longer.includes(shorter)
  );
}

function namesOverlap(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const x of a) {
    for (const y of b) {
      if (properlyContains(x, y) || properlyContains(y, x)) return true;
    }
  }
  return false;
}

function namesRelated(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return intersects(a, b) || namesOverlap(a, b);
}

function sharesHost(a: Component, b: Component): boolean {
  return intersects(a.hosts, b.hosts);
}

/** Pairs of current roots, each pair once, lower root first. */
function rootPairs(
  profiles: readonly Profile[],
  components: Components,
): Array<[number, number]> {
  const roots = [
    ...new Set(profiles.map((p) => components.root(p.index))),
  ].sort((a, b) => a - b);
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < roots.length; i += 1) {
    for (let j = i + 1; j < roots.length; j += 1) {
      pairs.push([roots[i], roots[j]]);
    }
  }
  return pairs;
}

/**
 * Containing names under one brand join. Copies on the same MCP host always
 * do (`atlassian` and `Atlassian Rovo` on mcp.atlassian.com). When one side
 * names no host, the join is only safe if it is unambiguous: a component
 * whose partners are separate products (different hosts, or unrelated names
 * and no shared host) is a publisher suite, so it joins none of them. That keeps Carta CRM and
 * Carta Cap Table apart, and a bare `adobe` plugin out of every Adobe server.
 */
function joinContainedNames(
  profiles: readonly Profile[],
  components: Components,
): void {
  const related = (a: Component, b: Component): boolean =>
    intersects(a.brands, b.brands) &&
    namesOverlap(a.names, b.names) &&
    agree(a.endpointDomains, b.endpointDomains);

  for (const [x, y] of rootPairs(profiles, components)) {
    const a = components.get(x);
    const b = components.get(y);
    if (a !== b && related(a, b) && sharesHost(a, b)) components.union(x, y);
  }

  const partners = new Map<number, number[]>();
  for (const [x, y] of rootPairs(profiles, components)) {
    const a = components.get(x);
    const b = components.get(y);
    if (!related(a, b)) continue;
    if (a.hosts.size > 0 && b.hosts.size > 0) continue;
    partners.set(x, [...(partners.get(x) ?? []), y]);
    partners.set(y, [...(partners.get(y) ?? []), x]);
  }
  const ambiguous = new Set<number>();
  for (const [root, linked] of partners) {
    const separate = linked.some((first, i) =>
      linked.slice(i + 1).some((second) => {
        const a = components.get(first);
        const b = components.get(second);
        // Two hosts that differ are two products, however alike their
        // names (`Acme Cloud` and `Acme Cloud Enterprise`).
        if (a.hosts.size > 0 && b.hosts.size > 0) return !sharesHost(a, b);
        return !namesRelated(a.names, b.names) && !sharesHost(a, b);
      }),
    );
    if (separate) ambiguous.add(root);
  }
  for (const [root, linked] of [...partners].sort((a, b) => a[0] - b[0])) {
    if (ambiguous.has(root)) continue;
    for (const other of linked) {
      if (other < root || ambiguous.has(other)) continue;
      const a = components.get(root);
      const b = components.get(other);
      if (a === b) continue;
      // Re-checked: an earlier join may have given either side a host.
      if (a.hosts.size > 0 && b.hosts.size > 0 && !sharesHost(a, b)) continue;
      if (!agree(a.endpointDomains, b.endpointDomains)) continue;
      components.union(root, other);
    }
  }
}

/**
 * The endpoint to prefer: on the integration's own brand first, then without
 * a query (`?utm_source=…`, `?client=…` tag one source's copy), then by
 * source (the curated MCP catalog first), then the most-shared, shortest URL.
 */
function preferredEndpoint(
  members: readonly Profile[],
  brands: ReadonlySet<string>,
): string | undefined {
  interface Candidate {
    url: string;
    rank: number;
    count: number;
  }
  const candidates = new Map<string, Candidate>();
  for (const member of members) {
    for (const endpoint of member.source.mcpEndpoints) {
      const url = endpointUrl(endpoint);
      if (url === undefined) continue;
      const rank = SOURCE_RANK[member.source.kind];
      const existing = candidates.get(url);
      if (existing) {
        existing.count += 1;
        existing.rank = Math.min(existing.rank, rank);
      } else {
        candidates.set(url, { url, rank, count: 1 });
      }
    }
  }
  const onBrand = (url: string): number => {
    const host = urlHostname(url);
    if (host === undefined) return 1;
    return brands.has(brandLabel(registrableDomain(host))) ? 0 : 1;
  };
  const hasQuery = (url: string): number => (/[?#]/.test(url) ? 1 : 0);
  const ranked = [...candidates.values()].sort(
    (a, b) =>
      onBrand(a.url) - onBrand(b.url) ||
      hasQuery(a.url) - hasQuery(b.url) ||
      a.rank - b.rank ||
      b.count - a.count ||
      a.url.length - b.url.length ||
      (a.url < b.url ? -1 : a.url > b.url ? 1 : 0),
  );
  return ranked[0]?.url;
}

/** Shortest name, then alphabetical: the integration's readable label. */
function labelOf(members: readonly Profile[]): string {
  let best = '';
  for (const member of members) {
    for (const name of member.names) {
      if (
        best === '' ||
        name.length < best.length ||
        (name.length === best.length && name < best)
      ) {
        best = name;
      }
    }
  }
  return best;
}

function qualifierOf(
  preferred: string | undefined,
  members: readonly Profile[],
): string {
  const host = preferred === undefined ? undefined : urlHostname(preferred);
  if (host !== undefined) return host;
  const brands = [...new Set(members.flatMap((m) => [...m.brands]))].sort();
  if (brands.length > 0) return brands[0];
  return [...members].sort(compareIds)[0]?.source.id ?? '';
}

/**
 * Groups catalog sources into integrations. Every source lands in exactly one
 * integration; a source that matches nothing is an integration of its own.
 * Returns integrations in the order of their first member.
 */
export function groupCatalogIntegrations(
  sources: readonly CatalogIntegrationSource[],
): CatalogIntegration[] {
  // Every pass runs in id order, so the groups, keys and endpoints never
  // depend on the order the host listed its entries in.
  const ordered = sources
    .map((source, position) => ({ source, position }))
    .sort(
      (a, b) =>
        (a.source.id < b.source.id ? -1 : a.source.id > b.source.id ? 1 : 0) ||
        a.position - b.position,
    );
  const profiles = ordered.map(({ source }, index) => profile(source, index));
  const positionOf = (p: Profile): number => ordered[p.index].position;
  const components = new Components(profiles);
  joinSameNames(profiles, components);
  joinContainedNames(profiles, components);

  const membersByRoot = new Map<number, Profile[]>();
  for (const p of profiles) {
    const root = components.root(p.index);
    const members = membersByRoot.get(root);
    if (members) members.push(p);
    else membersByRoot.set(root, [p]);
  }
  // Colliding keys are numbered in id order of each group's first member.
  const usedKeys = new Map<string, number>();
  const groups = [...membersByRoot.values()].map((members) => {
    const component = components.get(members[0].index);
    const preferred = preferredEndpoint(members, component.brands);
    const label = labelOf(members) || 'entry';
    const base = `${label}@${qualifierOf(preferred, members)}`;
    const seen = usedKeys.get(base) ?? 0;
    usedKeys.set(base, seen + 1);
    const inInputOrder = [...members].sort(
      (a, b) => positionOf(a) - positionOf(b),
    );
    return {
      key: seen === 0 ? base : `${base}#${seen + 1}`,
      members: inInputOrder,
      preferred,
    };
  });
  return groups
    .sort((a, b) => positionOf(a.members[0]) - positionOf(b.members[0]))
    .map(
      (group): CatalogIntegration => ({
        key: group.key,
        memberIds: group.members.map((m) => m.source.id),
        ...(group.preferred !== undefined
          ? { preferredEndpoint: group.preferred }
          : {}),
      }),
    );
}
