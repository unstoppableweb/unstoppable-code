import type { ProjectStartPage } from '@canopy/protocol/start-page';
import { MCP_SERVER_CHANNELS } from '@canopy/desktop-shared/constants/mcp-server-channels';
import type { RemoteSurface } from '@canopy/desktop-shared/remote-control/surfaces';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { RemoteControllerRefusedError } from '../remote-protocol';
import {
  controllerCredentialParts,
  mergeControllerUrl,
} from './controller-remote-urls';

/**
 * Start pages a controller sends back (CAN-7082). The controller only ever
 * gets a start page's URL through `controllerCredentialFreeUrl`, so an
 * unchanged one would overwrite the stored token. Before the call reaches
 * main, each URL the controller sent exactly as it got it is replaced by the
 * stored value of the same field it came from; any other URL is stored as
 * sent, without the old credential (`mergeControllerUrl`). A field is only
 * ever compared with its own stored value, so it never receives another
 * field's credential. A saved MCP server's URLs are merged
 * inside its save instead (`mergeControllerServerUrls`), which refuses a
 * changed one.
 */

/** The start pages a project stores now, by the field each is stored in. */
export interface StoredStartPageFields {
  /** The project's own setting; `null` when it is turned off. */
  readonly local?: ProjectStartPage | null;
  readonly cowork?: ProjectStartPage;
  /** The target worktree's canopy.json, when a worktree is named. */
  readonly worktreeManifest?: ProjectStartPage;
  /** The project source's canopy.json, which a new worktree starts from. */
  readonly sourceManifest?: ProjectStartPage;
}

export type StoredStartPages = (
  projectId: string,
  worktreeId: string | undefined,
) => Promise<StoredStartPageFields>;

/** Which stored start page a write replaces. */
type StartPageField = 'local' | 'cowork' | 'manifest';

export const CONTROLLER_START_PAGE_UNREADABLE =
  "This computer couldn't check the saved start page, so nothing was changed.";

/** The URL fields each channel merges, as remote-url-fields.json records them. */
export const CONTROLLER_URL_WRITEBACK_FIELDS: Readonly<
  Record<string, readonly string[]>
> = {
  [IPC_CHANNELS.projectsSave]: ['url'],
  [IPC_CHANNELS.workspaceSetStartPage]: ['url'],
  [IPC_CHANNELS.chatProjectUpdate]: ['url'],
  [IPC_CHANNELS.workspaceApplySourceChanges]: ['url'],
  [IPC_CHANNELS.projectApplySourceChanges]: ['url'],
  [MCP_SERVER_CHANNELS.SAVE_SERVER]: ['authorizationUrl', 'tokenUrl', 'url'],
};

interface StartPageOwner {
  readonly projectId: string;
  readonly worktreeId?: string;
  readonly field: StartPageField;
  /** A sidebar item, compared first with the start page delivered to it. */
  readonly sidebarItem?: true;
}

type UrlRewrite = (url: string, owner: StartPageOwner) => Promise<string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The URL of a `{ kind: 'url' }` start page, or `undefined`. */
function startPageUrl(value: unknown): string | undefined {
  return isRecord(value) &&
    value.kind === 'url' &&
    typeof value.url === 'string'
    ? value.url
    : undefined;
}

async function withStartPageUrl(
  record: Record<string, unknown>,
  owner: StartPageOwner,
  rewrite: UrlRewrite,
): Promise<Record<string, unknown>> {
  const url = startPageUrl(record.startPage);
  if (url === undefined || !isRecord(record.startPage)) return record;
  const merged = await rewrite(url, owner);
  return merged === url
    ? record
    : { ...record, startPage: { ...record.startPage, url: merged } };
}

/** A request object's start page, owned by the project its `idField` names. */
function requestStartPage(
  idField: string,
  field: StartPageField,
): (args: readonly unknown[], rewrite: UrlRewrite) => Promise<unknown[]> {
  return async ([request, ...rest], rewrite) => {
    if (!isRecord(request) || typeof request[idField] !== 'string')
      return [request, ...rest];
    const target = request.target;
    const worktreeId =
      isRecord(target) &&
      target.mode === 'existing' &&
      typeof target.worktreeId === 'string'
        ? target.worktreeId
        : undefined;
    return [
      await withStartPageUrl(
        request,
        { projectId: request[idField], worktreeId, field },
        rewrite,
      ),
      ...rest,
    ];
  };
}

/** Sidebar items other than Cowork ones, whose start page this save admits. */
function isSavedStartPageItem(
  item: unknown,
): item is Record<string, unknown> & { id: string } {
  return (
    isRecord(item) && typeof item.id === 'string' && item.type !== 'cowork'
  );
}

const START_PAGE_WRITES: Readonly<
  Record<
    string,
    (args: readonly unknown[], rewrite: UrlRewrite) => Promise<unknown[]>
  >
> = {
  [IPC_CHANNELS.projectsSave]: async ([items, ...rest], rewrite) => [
    Array.isArray(items)
      ? await Promise.all(
          items.map((item: unknown) =>
            isSavedStartPageItem(item)
              ? withStartPageUrl(
                  item,
                  { projectId: item.id, field: 'local', sidebarItem: true },
                  rewrite,
                )
              : item,
          ),
        )
      : items,
    ...rest,
  ],
  [IPC_CHANNELS.workspaceSetStartPage]: requestStartPage(
    'workspaceId',
    'local',
  ),
  [IPC_CHANNELS.chatProjectUpdate]: requestStartPage('projectId', 'cowork'),
  [IPC_CHANNELS.workspaceApplySourceChanges]: requestStartPage(
    'workspaceId',
    'manifest',
  ),
  [IPC_CHANNELS.projectApplySourceChanges]: requestStartPage(
    'projectId',
    'manifest',
  ),
};

/**
 * The stored start page a write replaces: an apply-source-changes write
 * replaces the target worktree's canopy.json, or the source's, which a new
 * worktree starts from.
 */
function replacedStartPage(
  fields: StoredStartPageFields,
  owner: StartPageOwner,
): ProjectStartPage | null | undefined {
  if (owner.field === 'local') return fields.local;
  if (owner.field === 'cowork') return fields.cowork;
  return owner.worktreeId === undefined
    ? fields.sourceManifest
    : fields.worktreeManifest;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/**
 * The workspaces a `projects:save` kept as they were, whose delivered baseline
 * stays the one they were edited from (`getSidebarItemsPreserveWorkspaceIds`).
 */
function preservedWorkspaceIds(result: unknown): Set<string> {
  if (!isRecord(result)) return new Set();
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  return new Set([
    ...stringList(result.preservedWorkspaceIds),
    ...stringList(
      warnings.map((warning: unknown) =>
        isRecord(warning) ? warning.workspaceId : undefined,
      ),
    ),
  ]);
}

/** Each sidebar item's start page URL, by item id. */
function deliveredStartPages(items: unknown): Map<string, string> {
  const delivered = new Map<string, string>();
  if (!Array.isArray(items)) return delivered;
  for (const item of items) {
    if (!isSavedStartPageItem(item)) continue;
    const url = startPageUrl(item.startPage);
    if (url !== undefined) delivered.set(item.id, url);
  }
  return delivered;
}

/** One host session's start page merges. */
export class ControllerUrlWritebacks {
  /**
   * The start page URLs main last delivered to each bridge window, by item
   * id, as `projects:save` keeps its `deliveredSidebarItems` baseline: from
   * the last `projects:load` reply, then each save's submitted items. They
   * hold credentials: never logged, serialized or sent, and cleared when the
   * session ends or its pairing is revoked.
   */
  private readonly delivered = new Map<RemoteSurface, Map<string, string>>();
  /**
   * Each bridge window's newest `projects:load`, as main numbers them in
   * `projectsLoadGenerations`: an older load that finishes later never
   * replaces the newer one's delivered values.
   */
  private readonly loads = new Map<RemoteSurface, number>();

  constructor(private readonly stored: StoredStartPages | undefined) {}

  /**
   * The call's arguments with each start page URL the controller sent back
   * unchanged replaced by the stored value it came from.
   */
  async merge(
    surface: RemoteSurface,
    channel: string,
    args: readonly unknown[],
  ): Promise<readonly unknown[]> {
    const write = START_PAGE_WRITES[channel];
    if (!write) return args;
    return write(args, async (url, owner) => {
      if (controllerCredentialParts(url).length > 0) return url;
      const read = this.stored;
      if (!read)
        throw new RemoteControllerRefusedError(
          CONTROLLER_START_PAGE_UNREADABLE,
        );
      const delivered = owner.sidebarItem
        ? this.delivered.get(surface)?.get(owner.projectId)
        : undefined;
      const stored = startPageUrl(
        replacedStartPage(await read(owner.projectId, owner.worktreeId), owner),
      );
      const merged = mergeControllerUrl(url, [
        ...(delivered === undefined ? [] : [delivered]),
        ...(stored === undefined ? [] : [stored]),
      ]);
      return merged.kind === 'carry' ? merged.value : url;
    });
  }

  /**
   * Numbers a call about to reach main: a `projects:load` gets the bridge
   * window's next load number, any other call `undefined`.
   */
  begin(surface: RemoteSurface, channel: string): number | undefined {
    if (channel !== IPC_CHANNELS.projectsLoad) return undefined;
    const load = (this.loads.get(surface) ?? 0) + 1;
    this.loads.set(surface, load);
    return load;
  }

  /**
   * Records what main delivered to the bridge window for the next save. A
   * `projects:load` records only while it is the window's newest (`load`,
   * from `begin`).
   */
  record(
    surface: RemoteSurface,
    channel: string,
    args: readonly unknown[],
    result: unknown,
    load?: number,
  ): void {
    if (channel === IPC_CHANNELS.projectsLoad) {
      if (load !== this.loads.get(surface)) return;
      if (isRecord(result) && Array.isArray(result.items))
        this.delivered.set(surface, deliveredStartPages(result.items));
      return;
    }
    if (channel !== IPC_CHANNELS.projectsSave) return;
    const previous = this.delivered.get(surface);
    const preserved = preservedWorkspaceIds(result);
    const next = deliveredStartPages(
      Array.isArray(args[0])
        ? args[0].filter(
            (item: unknown) =>
              !isSavedStartPageItem(item) || !preserved.has(item.id),
          )
        : [],
    );
    for (const id of preserved) {
      const kept = previous?.get(id);
      if (kept !== undefined) next.set(id, kept);
    }
    this.delivered.set(surface, next);
  }

  /** Drops every delivered value. */
  clear(): void {
    this.delivered.clear();
    this.loads.clear();
  }
}
