import { readdir } from 'node:fs/promises';
import type {
  ListSharedContainerRepositoryTreeRequest,
  SharedContainerFileSource,
  ReadSharedContainerAttachmentRequest,
  ReadSharedContainerChatRequest,
  ReadSharedContainerOverlayDiffRequest,
  ReadSharedContainerPlanRequest,
  ReadSharedContainerWorkspaceItemRequest,
  SharedContainerAttachmentContent,
  SharedContainerAttachmentSummary,
  SharedContainerChatSummary,
  SharedContainerContentListRequest,
  SharedContainerContentPage,
  SharedContainerPlanSummary,
  SharedContainerRepositorySummary,
  SharedContainerRepositoryTreeEntry,
  SharedContainerRevisionMetadata,
  SharedContainerRevisionRequest,
  SharedContainerWorkspaceItemSummary,
} from '@canopy/desktop-shared/types';
import {
  MAX_SHARED_CONTAINER_ARTIFACT_BYTES,
  isSharedContainerPublishedChat,
  type SharedContainerRevisionRepository,
  type SharedContainerRevisionSnapshotRepository,
  isSharedContainerPublishedPlan,
  type SharedContainerPublishedChat,
  type SharedContainerPublishedPlan,
  type SharedContainerRevisionRunConfig,
  isAnySharedContainerRevisionLayout,
  type AnySharedContainerRevisionLayout,
} from '@canopy/protocol/shared-containers';
import {
  getAddedFileDiff,
  getFileDiffBetweenCommits,
  getFileDiffUncommitted,
  hasLocalCommit,
  type FileDiffContent,
} from '../../lib/git';
import { getSharedContainersRootDir } from '../../lib/paths';
import { SharedContainerReplicaStore } from '../replica/store';
import { COWORK_WORKSPACE_FILE_ROOT_ID } from '@canopy/desktop-shared/types';

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const SHARED_CONTAINER_ATTACHMENT_PREVIEW_BYTES = 256 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
// A Cowork share is read through the same workspace contracts as the
// publisher's Cowork project, so its single file root uses the standard
// Cowork file-root id. `viewer-root.ts` projects the same id, and the
// standard Changes and file-diff panels pass it straight back here.
const COWORK_FILES_REPOSITORY_ID = COWORK_WORKSPACE_FILE_ROOT_ID;
type SharedContainerCodeRepository =
  | SharedContainerRevisionRepository
  | SharedContainerRevisionSnapshotRepository;

function isGitHubRepository(
  repository: SharedContainerCodeRepository,
): repository is SharedContainerRevisionRepository {
  return !('source' in repository);
}

function utf8SafePreviewEnd(bytes: Buffer, maximumBytes: number): number {
  const end = Math.min(bytes.byteLength, maximumBytes);
  if (end === 0 || end === bytes.byteLength) return end;

  let sequenceStart = end - 1;
  while (
    sequenceStart >= 0 &&
    (bytes[sequenceStart] & 0b1100_0000) === 0b1000_0000
  ) {
    sequenceStart -= 1;
  }
  if (sequenceStart < 0 || end - sequenceStart > 4) return end;

  const lead = bytes[sequenceStart];
  const expectedBytes =
    lead >= 0xc2 && lead <= 0xdf
      ? 2
      : lead >= 0xe0 && lead <= 0xef
        ? 3
        : lead >= 0xf0 && lead <= 0xf4
          ? 4
          : 1;
  if (end - sequenceStart >= expectedBytes || expectedBytes === 1) return end;

  const continuation = (offset: number): boolean =>
    offset < bytes.byteLength && (bytes[offset] & 0b1100_0000) === 0b1000_0000;
  const second = bytes[sequenceStart + 1];
  const validSecond =
    expectedBytes === 2
      ? continuation(sequenceStart + 1)
      : lead === 0xe0
        ? second >= 0xa0 && second <= 0xbf
        : lead === 0xed
          ? second >= 0x80 && second <= 0x9f
          : lead === 0xf0
            ? second >= 0x90 && second <= 0xbf
            : lead === 0xf4
              ? second >= 0x80 && second <= 0x8f
              : continuation(sequenceStart + 1);
  const validSequence =
    validSecond &&
    (expectedBytes < 3 || continuation(sequenceStart + 2)) &&
    (expectedBytes < 4 || continuation(sequenceStart + 3));

  // Trim only when the bytes after the preview boundary prove this is a
  // complete, valid Unicode scalar. Malformed input must remain malformed so
  // the renderer's fatal decoder can classify it as binary.
  return validSequence ? sequenceStart : end;
}

function validateId(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) throw new Error(`Invalid ${label}`);
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!/^(?:0|[1-9]\d*)$/.test(decoded)) throw new Error('invalid');
    const offset = Number(decoded);
    if (!Number.isSafeInteger(offset)) throw new Error('invalid');
    return offset;
  } catch {
    throw new Error('Invalid shared-container cursor');
  }
}

function page<T>(
  items: T[],
  request: { cursor?: string; limit?: number },
): SharedContainerContentPage<T> {
  const offset = decodeCursor(request.cursor);
  if (
    request.limit !== undefined &&
    (!Number.isInteger(request.limit) || request.limit < 1)
  ) {
    throw new Error('Invalid shared-container page limit');
  }
  const limit = Math.min(request.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
  const selected = items.slice(offset, offset + limit);
  const nextOffset = offset + selected.length;
  const truncated = nextOffset < items.length;
  return {
    items: selected,
    nextCursor: truncated
      ? Buffer.from(String(nextOffset)).toString('base64url')
      : null,
    truncated,
  };
}

/** The requested revision is not the container's available or pinned one. */
export class SharedContainerRevisionUnavailableError extends Error {
  constructor() {
    super('Shared-container revision is not available');
    this.name = 'SharedContainerRevisionUnavailableError';
  }
}

export class SharedContainerReader {
  constructor(readonly store: SharedContainerReplicaStore) {}

  /** Whether the index still serves `request`'s revision. */
  private async isRevisionCurrent(
    request: SharedContainerRevisionRequest,
  ): Promise<boolean> {
    const state = await this.store.get(request.containerId);
    return (
      (state?.status === 'available' || state?.status === 'pinned') &&
      state.revisionId === request.revisionId
    );
  }

  private async revisionRoot(
    request: SharedContainerRevisionRequest,
  ): Promise<string> {
    if (!(await this.isRevisionCurrent(request))) {
      throw new SharedContainerRevisionUnavailableError();
    }
    return this.store.resolveRevisionRootForRead(
      request.containerId,
      request.revisionId,
    );
  }

  private async readBytes(
    root: string,
    target: string,
    maximumBytes = MAX_SHARED_CONTAINER_ARTIFACT_BYTES,
  ): Promise<Buffer> {
    return this.store.readBoundedFileForRead(root, target, maximumBytes);
  }

  private async assertRealDirectory(
    root: string,
    target: string,
  ): Promise<void> {
    await this.store.assertRealDirectoryForRead(root, target);
  }

  private async readJson(root: string, target: string): Promise<unknown> {
    return JSON.parse((await this.readBytes(root, target)).toString('utf8'));
  }

  private async layout(request: SharedContainerRevisionRequest): Promise<{
    root: string;
    layout: AnySharedContainerRevisionLayout;
  }> {
    try {
      const root = await this.revisionRoot(request);
      const value = await this.readJson(
        root,
        this.store.resolvePathBelowForRead(root, 'artifacts', 'container.json'),
      );
      if (!isAnySharedContainerRevisionLayout(value)) {
        throw new Error('Shared-container layout is invalid');
      }
      return { root, layout: value };
    } catch (error) {
      // A reconciliation or purge can move the revision between the index
      // check and these reads: that is a stale revision, not a failure.
      if (
        !(error instanceof SharedContainerRevisionUnavailableError) &&
        !(await this.isRevisionCurrent(request))
      ) {
        throw new SharedContainerRevisionUnavailableError();
      }
      throw error;
    }
  }

  /** Internal fork boundary: returns the validated layout for the pinned root. */
  async readForkLayout(request: SharedContainerRevisionRequest): Promise<{
    root: string;
    layout: AnySharedContainerRevisionLayout;
  }> {
    return this.layout(request);
  }

  async readRevisionMetadata(
    request: SharedContainerRevisionRequest,
  ): Promise<SharedContainerRevisionMetadata> {
    const { layout } = await this.layout(request);
    return { title: layout.title };
  }

  async readRunConfig(
    request: SharedContainerRevisionRequest,
  ): Promise<SharedContainerRevisionRunConfig | undefined> {
    const { layout } = await this.layout(request);
    return layout.run;
  }

  /** Internal fork boundary: preserve artifact identity when chat ids collide. */
  async readForkChats(request: SharedContainerRevisionRequest): Promise<
    Array<{
      artifactChatId: string;
      chat: SharedContainerPublishedChat;
    }>
  > {
    const { root } = await this.layout(request);
    const directory = this.store.resolvePathBelowForRead(
      root,
      'artifacts',
      'chats',
    );
    let names: string[];
    try {
      await this.assertRealDirectory(root, directory);
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const chats: Array<{
      artifactChatId: string;
      chat: SharedContainerPublishedChat;
    }> = [];
    for (const name of names.filter((item) => item.endsWith('.json')).sort()) {
      const artifactChatId = name.slice(0, -'.json'.length);
      validateId(artifactChatId, 'chat artifact id');
      const value = await this.readJson(
        root,
        this.store.resolvePathBelowForRead(directory, name),
      );
      if (!isSharedContainerPublishedChat(value)) {
        throw new Error('Shared-container chats artifact is invalid');
      }
      chats.push({ artifactChatId, chat: value });
    }
    return chats;
  }

  private async listJsonArtifacts<T, TSummary>(
    request: SharedContainerContentListRequest,
    category: 'chats' | 'plans',
    validate: (value: unknown) => value is T,
    summarize: (value: T) => TSummary,
  ): Promise<SharedContainerContentPage<TSummary>> {
    const { root } = await this.layout(request);
    const directory = this.store.resolvePathBelowForRead(
      root,
      'artifacts',
      category,
    );
    let names: string[];
    try {
      await this.assertRealDirectory(root, directory);
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return page([], request);
      }
      throw error;
    }
    const namesPage = page(
      names.filter((name) => name.endsWith('.json')).sort(),
      request,
    );
    const values: TSummary[] = [];
    for (const name of namesPage.items) {
      const value = await this.readJson(
        root,
        this.store.resolvePathBelowForRead(directory, name),
      );
      if (!validate(value)) {
        throw new Error(`Shared-container ${category} artifact is invalid`);
      }
      // Retain only the small list representation. A page may include up to
      // 100 quota-valid 25 MiB artifacts, so keeping every parsed transcript
      // or plan until a later map would multiply main-process peak memory.
      values.push(summarize(value));
    }
    return { ...namesPage, items: values };
  }

  async listChats(
    request: SharedContainerContentListRequest,
  ): Promise<SharedContainerContentPage<SharedContainerChatSummary>> {
    return this.listJsonArtifacts(
      request,
      'chats',
      isSharedContainerPublishedChat,
      ({ chatId, title, createdAt, description }) => ({
        chatId,
        title,
        createdAt,
        ...(description ? { description } : {}),
      }),
    );
  }

  async readChat(
    request: ReadSharedContainerChatRequest,
  ): Promise<SharedContainerPublishedChat> {
    validateId(request.chatId, 'chat id');
    const { root } = await this.layout(request);
    const value = await this.readJson(
      root,
      this.store.resolvePathBelowForRead(
        root,
        'artifacts',
        'chats',
        `${request.chatId}.json`,
      ),
    );
    if (
      !isSharedContainerPublishedChat(value) ||
      value.chatId !== request.chatId
    ) {
      throw new Error('Shared-container chat artifact is invalid');
    }
    return value;
  }

  async listPlans(
    request: SharedContainerContentListRequest,
  ): Promise<SharedContainerContentPage<SharedContainerPlanSummary>> {
    return this.listJsonArtifacts(
      request,
      'plans',
      isSharedContainerPublishedPlan,
      ({ planId, title, updatedAt, reviewStatus }) => ({
        planId,
        title,
        updatedAt,
        reviewStatus,
      }),
    );
  }

  async readPlan(
    request: ReadSharedContainerPlanRequest,
  ): Promise<SharedContainerPublishedPlan> {
    validateId(request.planId, 'plan id');
    const { root } = await this.layout(request);
    const value = await this.readJson(
      root,
      this.store.resolvePathBelowForRead(
        root,
        'artifacts',
        'plans',
        `${request.planId}.json`,
      ),
    );
    if (
      !isSharedContainerPublishedPlan(value) ||
      value.planId !== request.planId
    ) {
      throw new Error('Shared-container plan artifact is invalid');
    }
    return value;
  }

  private async listWorkspaceItems(
    request: SharedContainerContentListRequest,
    category: 'notes' | 'prompts',
  ): Promise<SharedContainerContentPage<SharedContainerWorkspaceItemSummary>> {
    const { layout } = await this.layout(request);
    return page(
      [...layout[category]].sort((a, b) => a.itemId.localeCompare(b.itemId)),
      request,
    );
  }

  listNotes(
    request: SharedContainerContentListRequest,
  ): Promise<SharedContainerContentPage<SharedContainerWorkspaceItemSummary>> {
    return this.listWorkspaceItems(request, 'notes');
  }

  listPrompts(
    request: SharedContainerContentListRequest,
  ): Promise<SharedContainerContentPage<SharedContainerWorkspaceItemSummary>> {
    return this.listWorkspaceItems(request, 'prompts');
  }

  private async readWorkspaceItem(
    request: ReadSharedContainerWorkspaceItemRequest,
    category: 'notes' | 'prompts',
  ): Promise<string> {
    validateId(request.itemId, `${category} item id`);
    const { root, layout } = await this.layout(request);
    if (!layout[category].some((item) => item.itemId === request.itemId)) {
      throw new Error(`Shared-container ${category} item is not declared`);
    }
    return (
      await this.readBytes(
        root,
        this.store.resolvePathBelowForRead(
          root,
          'content',
          category,
          `${request.itemId}.md`,
        ),
      )
    ).toString('utf8');
  }

  readNote(request: ReadSharedContainerWorkspaceItemRequest): Promise<string> {
    return this.readWorkspaceItem(request, 'notes');
  }

  readPrompt(
    request: ReadSharedContainerWorkspaceItemRequest,
  ): Promise<string> {
    return this.readWorkspaceItem(request, 'prompts');
  }

  async listAttachments(
    request: SharedContainerContentListRequest,
  ): Promise<SharedContainerContentPage<SharedContainerAttachmentSummary>> {
    const { layout } = await this.layout(request);
    const items = Object.entries(layout.attachmentPaths)
      .map(([attachmentId, attachment]) => ({
        attachmentId,
        displayName: attachment.displayName,
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    return page(items, request);
  }

  async listRepositories(
    request: SharedContainerRevisionRequest,
  ): Promise<SharedContainerRepositorySummary[]> {
    const { layout } = await this.layout(request);
    if (layout.containerType === 'COWORK_WORK_ENTRY') {
      return [{ repoId: COWORK_FILES_REPOSITORY_ID, repoName: 'Workspace' }];
    }
    return layout.repositories.map((repository) => ({
      repoId: repository.repoId,
      repoName: repository.repoName,
      baseCommitSha: repository.baseCommitSha,
      // Omitted rather than null so a pre-CAN-2551 revision, or one whose
      // base branch could not be resolved at publish time, is indistinguishable
      // from "the publisher did not tell us".
      ...(isGitHubRepository(repository) && repository.baseBranch
        ? { baseBranch: repository.baseBranch }
        : {}),
    }));
  }

  async readAttachment(
    request: ReadSharedContainerAttachmentRequest,
  ): Promise<SharedContainerAttachmentContent> {
    const { root, layout } = await this.layout(request);
    const attachment = layout.attachmentPaths[request.attachmentId];
    if (!attachment)
      throw new Error('Shared-container attachment is not declared');
    const bytes = await this.readBytes(
      root,
      this.store.resolvePathBelowForRead(
        root,
        'content',
        'attachments',
        attachment.displayName,
      ),
    );
    const previewEnd = utf8SafePreviewEnd(
      bytes,
      SHARED_CONTAINER_ATTACHMENT_PREVIEW_BYTES,
    );
    return {
      displayName: attachment.displayName,
      data: Uint8Array.from(bytes.subarray(0, previewEnd)),
      sizeBytes: String(bytes.byteLength),
      truncated: bytes.byteLength > SHARED_CONTAINER_ATTACHMENT_PREVIEW_BYTES,
    };
  }

  /**
   * Committed work is only listable once the merge-base commit is actually in
   * the replica. `materializeCode` degrades rather than failing the open when
   * that fetch is impossible (rebased or garbage-collected base), so this is
   * the gate that keeps the recipient from being offered diffs that cannot be
   * rendered (CAN-2551).
   */
  private async resolveCommittedRange(
    root: string,
    repoId: string,
    repository: SharedContainerRevisionRepository | undefined,
  ): Promise<{ mergeBaseSha: string; repoDir: string } | null> {
    if (!repository?.mergeBaseSha || !repository.committedFiles?.length) {
      return null;
    }
    const repoDir = this.store.resolvePathBelowForRead(root, 'repos', repoId);
    try {
      await this.assertRealDirectory(root, repoDir);
    } catch {
      return null;
    }
    // The marker, not the commit, is the gate. Materialization fetches the
    // merge-base commit and warms its diff's blobs as two separate steps, so a
    // warm that timed out leaves the commit local with blobs missing. The tree
    // is sealed read-only by then, so git cannot fetch them at read time and
    // `getFileAtRef` would silently return an empty string — rendering an
    // unchanged diff rather than the error state (CAN-2551).
    let marker: string;
    try {
      // Through `readBytes` like every other read in this class, so the marker
      // gets the same symlinked-parent rejection and size bound rather than
      // relying on path containment alone.
      marker = (
        await this.readBytes(
          root,
          this.store.resolvePathBelowForRead(root, 'committed-ranges', repoId),
          64,
        )
      ).toString('utf8');
    } catch {
      return null;
    }
    if (marker.trim() !== repository.mergeBaseSha) return null;
    if (!(await hasLocalCommit(repoDir, repository.mergeBaseSha))) return null;
    return { mergeBaseSha: repository.mergeBaseSha, repoDir };
  }

  private resolveDeclaredRepository(
    layout: AnySharedContainerRevisionLayout,
    repoId: string,
  ): SharedContainerCodeRepository | undefined {
    const repository =
      layout.containerType === 'CODE_WORKTREE'
        ? layout.repositories.find((candidate) => candidate.repoId === repoId)
        : undefined;
    if (
      layout.containerType === 'CODE_WORKTREE'
        ? !repository
        : repoId !== COWORK_FILES_REPOSITORY_ID
    ) {
      throw new Error('Shared-container repository is not declared');
    }
    return repository;
  }

  async listRepositoryTree(
    request: ListSharedContainerRepositoryTreeRequest,
  ): Promise<SharedContainerContentPage<SharedContainerRepositoryTreeEntry>> {
    validateId(request.repoId, 'repository id');
    const { root, layout } = await this.layout(request);
    const repository = this.resolveDeclaredRepository(layout, request.repoId);
    const files = repository?.files ?? layout.files;
    const repoRoot =
      layout.containerType === 'CODE_WORKTREE'
        ? this.store.resolvePathBelowForRead(root, 'repos', request.repoId)
        : this.store.resolvePathBelowForRead(root, 'content');
    const committedRange =
      repository && isGitHubRepository(repository)
        ? await this.resolveCommittedRange(root, request.repoId, repository)
        : null;
    const committedFiles = committedRange
      ? repository && isGitHubRepository(repository)
        ? (repository.committedFiles ?? [])
        : []
      : [];
    const directoryPaths = new Set<string>();
    for (const file of [...files, ...committedFiles]) {
      const segments = file.path.split('/');
      segments.pop();
      for (let index = 1; index <= segments.length; index += 1) {
        directoryPaths.add(segments.slice(0, index).join('/'));
      }
    }
    const items: SharedContainerRepositoryTreeEntry[] = Array.from(
      directoryPaths,
      (path) => ({ repoId: request.repoId, path, kind: 'directory' }),
    );
    for (const file of files) {
      const item: SharedContainerRepositoryTreeEntry = {
        repoId: request.repoId,
        path: file.path,
        kind: 'file',
        status: file.status,
        source: 'uncommitted',
      };
      if (file.status !== 'deleted') {
        // Size is display metadata, so it must never be able to fail the
        // listing. A symlinked overlay entry is legitimate — the publisher
        // records it with git mode 120000 and materialization recreates it —
        // and only regular files have a meaningful size. Anything unreadable
        // is listed without one rather than throwing away every sibling
        // entry, which is what blanked the whole Changes view (CAN-2551).
        // Resolved outside the try: a manifest path that escapes the replica
        // root is an integrity failure, not a missing size, and must still
        // fail loudly rather than being swallowed alongside `ENOENT`.
        const target = this.store.resolvePathBelowForRead(repoRoot, file.path);
        try {
          const info = await this.store.lstatEntryForRead(root, target);
          if (info.isFile()) item.sizeBytes = String(info.size);
        } catch {
          // Listed without a size.
        }
      }
      items.push(item);
    }
    for (const file of committedFiles) {
      // No `sizeBytes`: a committed entry is a diff between two commits in the
      // recipient's own checkout, not an overlay file on disk.
      items.push({
        repoId: request.repoId,
        path: file.path,
        kind: 'file',
        status: file.status,
        source: 'committed',
        ...(file.insertions === undefined
          ? {}
          : { insertions: file.insertions }),
        ...(file.deletions === undefined ? {} : { deletions: file.deletions }),
      });
    }
    items.sort(
      (a, b) =>
        a.path.localeCompare(b.path) ||
        (a.source ?? '').localeCompare(b.source ?? ''),
    );
    return page(items, request);
  }

  private async readCommittedDiff(
    root: string,
    repository: SharedContainerRevisionRepository,
    repoId: string,
    path: string,
  ): Promise<FileDiffContent> {
    if (!repository.committedFiles?.some((file) => file.path === path)) {
      throw new Error('Shared-container committed path is not declared');
    }
    const range = await this.resolveCommittedRange(root, repoId, repository);
    if (!range) {
      throw new Error('Shared-container committed history is not available');
    }
    return getFileDiffBetweenCommits(
      range.repoDir,
      path,
      range.mergeBaseSha,
      repository.baseCommitSha,
    );
  }

  async readOverlayDiff(
    request: ReadSharedContainerOverlayDiffRequest,
  ): Promise<FileDiffContent> {
    validateId(request.repoId, 'repository id');
    const { root, layout } = await this.layout(request);
    const repository = this.resolveDeclaredRepository(layout, request.repoId);
    const source: SharedContainerFileSource = request.source ?? 'uncommitted';
    if (source === 'committed') {
      if (!repository || !isGitHubRepository(repository)) {
        throw new Error('Shared-container repository has no committed history');
      }
      return this.readCommittedDiff(
        root,
        repository,
        request.repoId,
        request.path,
      );
    }
    const file = (repository?.files ?? layout.files).find(
      (candidate) => candidate.path === request.path,
    );
    if (!file) {
      throw new Error('Shared-container overlay path is not declared');
    }
    const repositoryRoot =
      layout.containerType === 'CODE_WORKTREE'
        ? this.store.resolvePathBelowForRead(root, 'repos', request.repoId)
        : this.store.resolvePathBelowForRead(root, 'content');
    await this.assertRealDirectory(root, repositoryRoot);
    // A mode-120000 entry is a symlink, and git's blob for one is its target
    // path — so the target text is the content to diff. Reading it with
    // `readlink` answers correctly without following the link, which
    // `readBoundedFileForRead` rightly refuses to do (CAN-2551).
    const overlayPath = this.store.resolvePathBelowForRead(
      repositoryRoot,
      request.path,
    );
    const authenticatedWorkingTreeData =
      file.status === 'deleted'
        ? null
        : // Cowork files carry no mode and are never symlinks, so the `in`
          // narrow is what distinguishes the two file shapes here.
          'mode' in file && file.mode === '120000'
          ? await this.store.readLinkTargetForRead(root, overlayPath)
          : await this.readBytes(root, overlayPath);
    if (layout.containerType === 'COWORK_WORK_ENTRY') {
      if (authenticatedWorkingTreeData === null) {
        throw new Error('Shared-container Cowork file is not available');
      }
      return getAddedFileDiff(request.path, authenticatedWorkingTreeData);
    }
    return getFileDiffUncommitted(repositoryRoot, request.path, {
      authenticatedWorkingTreeData,
    });
  }
}

let sharedContainerReader: SharedContainerReader | null = null;

export function getSharedContainerReader(): SharedContainerReader {
  sharedContainerReader ??= new SharedContainerReader(
    new SharedContainerReplicaStore(getSharedContainersRootDir()),
  );
  return sharedContainerReader;
}
