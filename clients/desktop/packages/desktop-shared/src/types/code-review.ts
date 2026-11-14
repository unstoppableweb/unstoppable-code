import type { TurnDiffData } from './activity-panel';
import {
  isDataModelDiffDiagram,
  isLogicDiffDiagram,
  type DataModelDiffDiagram,
  type LogicDiffDiagram,
  type PlanDiagramStatus,
} from './plan-diagrams';

export type ReviewCommentSource = 'code' | 'diagram';
export type ReviewDiagramKind = 'logicDiff' | 'dataModelDiff';
export type ReviewCommentSide = 'old' | 'new';
export type ReviewCommentAuthor = 'user' | 'agent';
export type ReviewCommentThreadStatus = 'open' | 'resolved';
export type ReviewAnchorState = 'matched' | 'outdated';
export type ReviewAnnotationKind = 'explanation' | 'caution' | 'context';

/** A file panel comparison; content is never serialized into tab metadata. */
export interface FileDiffContext {
  path: string;
  repoId?: string;
  previousPath?: string;
  source: 'uncommitted' | 'committed' | 'combined' | 'turn';
  startTree?: string;
  endTree?: string;
  turnDiff?: TurnDiffData;
}

export interface ReviewDiffIdentity {
  source: FileDiffContext['source'];
  snapshotId: string;
  previousPath?: string;
  startTree?: string;
  endTree?: string;
}

export function isFileDiffContext(value: unknown): value is FileDiffContext {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    value.path.length > 0 &&
    isDiffSource(value.source) &&
    (value.turnDiff === undefined || isStoredTurnDiff(value.turnDiff)) &&
    ['repoId', 'previousPath', 'startTree', 'endTree'].every(
      (key) => value[key] === undefined || typeof value[key] === 'string',
    ) &&
    (value.source !== 'turn' ||
      (typeof value.startTree === 'string' &&
        value.startTree.length > 0 &&
        typeof value.endTree === 'string' &&
        value.endTree.length > 0))
  );
}

function isStoredTurnDiff(value: unknown): value is TurnDiffData {
  if (
    !isRecord(value) ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.treeRefs)
  )
    return false;
  return (
    ['totalInsertions', 'totalDeletions', 'capturedAt'].every(
      (key) => typeof value[key] === 'number' && Number.isFinite(value[key]),
    ) &&
    value.files.every(
      (file) =>
        isRecord(file) &&
        typeof file.path === 'string' &&
        file.path.length > 0 &&
        [
          'added',
          'modified',
          'deleted',
          'renamed',
          'copied',
          'unmerged',
          'type-changed',
          'untracked',
          'unknown',
        ].includes(String(file.status)) &&
        typeof file.insertions === 'number' &&
        typeof file.deletions === 'number' &&
        ['repoId', 'repoName', 'previousPath'].every(
          (key) => file[key] === undefined || typeof file[key] === 'string',
        ),
    ) &&
    value.treeRefs.every(
      (ref) =>
        isRecord(ref) &&
        typeof ref.startTree === 'string' &&
        typeof ref.endTree === 'string' &&
        (ref.repoId === undefined || typeof ref.repoId === 'string'),
    )
  );
}

function isDiffSource(value: unknown): boolean {
  return (
    value === 'uncommitted' ||
    value === 'committed' ||
    value === 'combined' ||
    value === 'turn'
  );
}

/** Shared by submitted prompts and agent tool output. Never treat diff lines as disk lines. */
export function describeReviewCommentContext(
  anchor: ReviewCommentAnchor,
): string {
  if (anchor.source === 'diagram')
    return `Change diagram: ${anchor.diagramKind ?? 'diagram'}; node ${anchor.nodeId ?? 'general'}; snapshot ${anchor.diagramFingerprint ?? 'unknown'}`;
  if (anchor.view !== 'diff') return 'File view';
  const diff = anchor.diff;
  return `Diff view; source ${diff?.source ?? 'unknown'}; snapshot ${diff?.snapshotId ?? 'unknown'}; side ${anchor.side ?? 'unspecified'}${anchor.repoId ? `; repository ${anchor.repoId}` : ''}${diff?.previousPath ? `; previous path ${diff.previousPath}` : ''}${diff?.startTree ? `; trees ${diff.startTree} → ${diff.endTree}` : ''}`;
}

/**
 * Where a review comment thread is attached. Code anchors carry
 * repo/file/side/line data plus the exact quoted source lines (the ground
 * truth for re-anchoring and for the agent). Diagram anchors carry the
 * diagram kind and node id with the node title as the quote. Unanchored
 * threads (file-level or general notes) set `unanchored: true`.
 */
export interface ReviewCommentAnchor {
  source: ReviewCommentSource;
  /** Absent on legacy normal-file annotations means file. */
  view?: 'file' | 'diff';
  diff?: ReviewDiffIdentity;
  diagramFingerprint?: string;
  /** Exact source lines (code) or node title (diagram). */
  quote: string;
  repoId?: string;
  filePath?: string;
  side?: ReviewCommentSide;
  lineStart?: number;
  lineEnd?: number;
  diagramKind?: ReviewDiagramKind;
  nodeId?: string;
  /** Generic file annotations can create the thread this anchor belongs to. */
  annotationId?: string;
  unanchored?: boolean;
}

export interface ReviewComment {
  id: string;
  author: ReviewCommentAuthor;
  body: string;
  createdAt: string;
  /** Renderer-only draft flag; cleared when submitted to chat. */
  staged?: boolean;
}

export interface ReviewCommentThread {
  id: string;
  status: ReviewCommentThreadStatus;
  createdAt: string;
  anchor: ReviewCommentAnchor;
  anchorState: ReviewAnchorState;
  comments: ReviewComment[];
}

export interface ReviewAnnotation {
  id: string;
  repoId: string;
  filePath: string;
  side: ReviewCommentSide;
  lineStart: number;
  lineEnd: number;
  kind: ReviewAnnotationKind;
  /** One-line gist shown collapsed in the gutter popover header. */
  title: string;
  /** Markdown explanation. */
  body: string;
}

export interface ReviewAnnotationSet {
  schemaVersion: 1;
  annotations: ReviewAnnotation[];
}

/**
 * Artifact envelope for generated review content. `derivedFromFingerprint`
 * is the branch diff fingerprint the artifact was generated from (the
 * code-review analog of the plan revision number).
 */
export interface CodeReviewArtifact<T> {
  data: T | null;
  derivedFromFingerprint: string;
  status: PlanDiagramStatus;
  generatedAt?: string;
  error?: string;
}

export interface CodeReviewDiagrams {
  logicDiff?: CodeReviewArtifact<LogicDiffDiagram>;
  /** Conditional ERD; absent when not applicable to the branch diff. */
  dataModelDiff?: CodeReviewArtifact<DataModelDiffDiagram>;
}

export interface CodeReviewFile {
  version: 1;
  armed: boolean;
  armedAt?: string;
  commentThreads: ReviewCommentThread[];
  annotations?: CodeReviewArtifact<ReviewAnnotationSet>;
  diagrams: CodeReviewDiagrams;
}

export function emptyCodeReviewFile(): CodeReviewFile {
  return { version: 1, armed: false, commentThreads: [], diagrams: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const REVIEW_ANNOTATION_KINDS: readonly ReviewAnnotationKind[] = [
  'explanation',
  'caution',
  'context',
] as const;

function isReviewAnnotationKind(value: unknown): value is ReviewAnnotationKind {
  return (
    typeof value === 'string' &&
    REVIEW_ANNOTATION_KINDS.some((kind) => kind === value)
  );
}

function isReviewCommentSide(value: unknown): value is ReviewCommentSide {
  return value === 'old' || value === 'new';
}

export function isReviewAnnotation(value: unknown): value is ReviewAnnotation {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.repoId === 'string' &&
    typeof value.filePath === 'string' &&
    isReviewCommentSide(value.side) &&
    typeof value.lineStart === 'number' &&
    typeof value.lineEnd === 'number' &&
    isReviewAnnotationKind(value.kind) &&
    typeof value.title === 'string' &&
    typeof value.body === 'string'
  );
}

export function isReviewAnnotationSet(
  value: unknown,
): value is ReviewAnnotationSet {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    Array.isArray(value.annotations) &&
    value.annotations.every(isReviewAnnotation)
  );
}

function isReviewCommentAnchor(value: unknown): value is ReviewCommentAnchor {
  if (!isRecord(value)) {
    return false;
  }
  if (value.source !== 'code' && value.source !== 'diagram') {
    return false;
  }
  if (typeof value.quote !== 'string') {
    return false;
  }
  if (
    value.view !== undefined &&
    value.view !== 'file' &&
    value.view !== 'diff'
  )
    return false;
  if (
    value.diagramFingerprint !== undefined &&
    typeof value.diagramFingerprint !== 'string'
  )
    return false;
  if (value.diff !== undefined) {
    const diff = value.diff;
    if (
      !isRecord(diff) ||
      !isDiffSource(diff.source) ||
      typeof diff.snapshotId !== 'string' ||
      !diff.snapshotId ||
      !['previousPath', 'startTree', 'endTree'].every(
        (key) => diff[key] === undefined || typeof diff[key] === 'string',
      )
    )
      return false;
  }
  if (value.view === 'diff' && value.diff === undefined) return false;
  if (value.repoId !== undefined && typeof value.repoId !== 'string') {
    return false;
  }
  if (value.filePath !== undefined && typeof value.filePath !== 'string') {
    return false;
  }
  if (value.side !== undefined && !isReviewCommentSide(value.side)) {
    return false;
  }
  if (value.lineStart !== undefined && typeof value.lineStart !== 'number') {
    return false;
  }
  if (value.lineEnd !== undefined && typeof value.lineEnd !== 'number') {
    return false;
  }
  if (
    value.diagramKind !== undefined &&
    value.diagramKind !== 'logicDiff' &&
    value.diagramKind !== 'dataModelDiff'
  ) {
    return false;
  }
  if (value.nodeId !== undefined && typeof value.nodeId !== 'string') {
    return false;
  }
  if (
    value.annotationId !== undefined &&
    typeof value.annotationId !== 'string'
  ) {
    return false;
  }
  if (value.unanchored !== undefined && typeof value.unanchored !== 'boolean') {
    return false;
  }
  return true;
}

function isReviewComment(value: unknown): value is ReviewComment {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.author === 'user' || value.author === 'agent') &&
    typeof value.body === 'string' &&
    typeof value.createdAt === 'string' &&
    (value.staged === undefined || typeof value.staged === 'boolean')
  );
}

export function isReviewCommentThread(
  value: unknown,
): value is ReviewCommentThread {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.status === 'open' || value.status === 'resolved') &&
    typeof value.createdAt === 'string' &&
    isReviewCommentAnchor(value.anchor) &&
    (value.anchorState === 'matched' || value.anchorState === 'outdated') &&
    Array.isArray(value.comments) &&
    value.comments.every(isReviewComment)
  );
}

const CODE_REVIEW_ARTIFACT_STATUSES: readonly PlanDiagramStatus[] = [
  'pending',
  'generating',
  'ready',
  'stale',
  'error',
] as const;

function isCodeReviewArtifactShape(
  value: unknown,
): value is CodeReviewArtifact<unknown> {
  return (
    isRecord(value) &&
    'data' in value &&
    typeof value.derivedFromFingerprint === 'string' &&
    typeof value.status === 'string' &&
    CODE_REVIEW_ARTIFACT_STATUSES.some((status) => status === value.status) &&
    (value.generatedAt === undefined ||
      typeof value.generatedAt === 'string') &&
    (value.error === undefined || typeof value.error === 'string')
  );
}

/**
 * Normalize a persisted (possibly corrupt) code-review file. Unknown versions
 * and malformed top-level shapes fall back to the empty file; individually
 * malformed threads/artifacts are dropped rather than failing the whole file.
 */
export function normalizeCodeReviewFile(value: unknown): CodeReviewFile {
  if (!isRecord(value) || value.version !== 1) {
    return emptyCodeReviewFile();
  }
  const threadsRaw = Array.isArray(value.commentThreads)
    ? value.commentThreads
    : [];
  const commentThreads = threadsRaw.filter(isReviewCommentThread);
  const diagramsRaw = isRecord(value.diagrams) ? value.diagrams : {};
  const diagrams: CodeReviewDiagrams = {};
  if (isCodeReviewArtifactShape(diagramsRaw.logicDiff)) {
    diagrams.logicDiff = {
      derivedFromFingerprint: diagramsRaw.logicDiff.derivedFromFingerprint,
      status: diagramsRaw.logicDiff.status,
      data: isLogicDiffDiagram(diagramsRaw.logicDiff.data)
        ? diagramsRaw.logicDiff.data
        : null,
      ...(diagramsRaw.logicDiff.generatedAt !== undefined
        ? { generatedAt: diagramsRaw.logicDiff.generatedAt }
        : {}),
      ...(diagramsRaw.logicDiff.error !== undefined
        ? { error: diagramsRaw.logicDiff.error }
        : {}),
    };
  }
  if (isCodeReviewArtifactShape(diagramsRaw.dataModelDiff)) {
    diagrams.dataModelDiff = {
      derivedFromFingerprint: diagramsRaw.dataModelDiff.derivedFromFingerprint,
      status: diagramsRaw.dataModelDiff.status,
      data: isDataModelDiffDiagram(diagramsRaw.dataModelDiff.data)
        ? diagramsRaw.dataModelDiff.data
        : null,
      ...(diagramsRaw.dataModelDiff.generatedAt !== undefined
        ? { generatedAt: diagramsRaw.dataModelDiff.generatedAt }
        : {}),
      ...(diagramsRaw.dataModelDiff.error !== undefined
        ? { error: diagramsRaw.dataModelDiff.error }
        : {}),
    };
  }
  const file: CodeReviewFile = {
    version: 1,
    armed: value.armed === true,
    commentThreads,
    diagrams,
  };
  if (typeof value.armedAt === 'string') {
    file.armedAt = value.armedAt;
  }
  if (
    isCodeReviewArtifactShape(value.annotations) &&
    (value.annotations.data === null ||
      isReviewAnnotationSet(value.annotations.data))
  ) {
    file.annotations = {
      derivedFromFingerprint: value.annotations.derivedFromFingerprint,
      status: value.annotations.status,
      data: isReviewAnnotationSet(value.annotations.data)
        ? value.annotations.data
        : null,
      ...(value.annotations.generatedAt !== undefined
        ? { generatedAt: value.annotations.generatedAt }
        : {}),
      ...(value.annotations.error !== undefined
        ? { error: value.annotations.error }
        : {}),
    };
  }
  return file;
}

// ---------------------------------------------------------------------------
// IPC wire/request types
// ---------------------------------------------------------------------------

export interface CodeReviewScopeRequest {
  projectId: string;
  worktreeId: string;
}

export type CodeReviewGetRequest = CodeReviewScopeRequest;

export interface CodeReviewGetResponse {
  review: CodeReviewFile;
  fingerprint: string;
  /**
   * Stored comment threads the reader couldn't use, so they aren't in
   * `review` (CAN-6667). Writes keep them on disk as they were. Absent when
   * there are none.
   */
  skippedCommentThreads?: number;
}

export type CodeReviewArmRequest = CodeReviewScopeRequest;
export type CodeReviewGenerateRequest = CodeReviewScopeRequest;

export interface CodeReviewGenerationResult {
  status: 'fresh' | 'empty' | 'generated' | 'error' | 'queued' | 'stopped';
  error?: string;
}

export interface CodeReviewSaveCommentsRequest extends CodeReviewScopeRequest {
  commentThreads: ReviewCommentThread[];
  baseCommentThreadIds?: string[];
  /** Full renderer snapshot used for field-level three-way merging. */
  baseCommentThreads?: ReviewCommentThread[];
}

export interface CodeReviewUpdatedEvent {
  projectId: string;
  worktreeId: string;
  fingerprint: string;
  review: CodeReviewFile;
  /** As on `CodeReviewGetResponse`. */
  skippedCommentThreads?: number;
}

/**
 * Register the real project a code-review chat scope runs against. The
 * code-review scope uses `projectId = CODE_REVIEW_CHAT_PROJECT_ID` and
 * `worktreeId = <real worktreeId>`; this maps that worktreeId back to the real
 * `projectId` whose checkout the sidecar session runs in.
 */
export interface RegisterCodeReviewRequest {
  worktreeId: string;
  projectId: string;
}

export interface CodeReviewModalOpenRequest extends CodeReviewScopeRequest {
  open: boolean;
  consumerId?: string;
}

export interface CodeReviewApi {
  get(request: CodeReviewGetRequest): Promise<CodeReviewGetResponse>;
  arm(request: CodeReviewArmRequest): Promise<CodeReviewGenerationResult>;
  generate(
    request: CodeReviewGenerateRequest,
  ): Promise<CodeReviewGenerationResult>;
  saveComments(
    request: CodeReviewSaveCommentsRequest,
  ): Promise<CodeReviewFile | null>;
  registerTarget(request: RegisterCodeReviewRequest): Promise<void>;
  setModalOpen(request: CodeReviewModalOpenRequest): Promise<void>;
  onUpdated(callback: (event: CodeReviewUpdatedEvent) => void): () => void;
}
