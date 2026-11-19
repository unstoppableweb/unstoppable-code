import {
  isDismissibleInvocationToken,
  PIPELINE_PACKAGE_MAX_FILE_BYTES,
  PIPELINE_PACKAGE_MAX_FILES,
  PIPELINE_PACKAGE_MAX_INVOCATION_DISMISSALS,
  PIPELINE_PACKAGE_MAX_TOTAL_BYTES,
} from '@canopy/protocol/pipelines';
import { formatPipelinePackageBytes } from '@canopy/ui-shared/lib/pipeline-package-display';
import type {
  PipelinePackageAnalysisBlocker,
  PipelinePackageBlockerCode,
  PipelinePackageInvocationDismissal,
  PipelinePackageLimit,
  PipelinePackageReferenceDismissal,
} from '@canopy/protocol/pipelines';

/**
 * Pure presentation layer for publisher-facing dependency problems.
 *
 * The main process emits a typed `code` plus a `subject` (the token or member
 * the problem is about); every user-visible sentence is composed here, because
 * this copy is governed by `docs/ux-writing.md` and because grouping and
 * ordering need a stable identity that English prose is not. The legacy
 * `message` survives as a fallback and as the technical detail behind a
 * disclosure — it is never the headline.
 *
 * Display only: no fetching, no stores, no `window.api`.
 */

/**
 * The one code a publisher may mark as "not a command". An allowlist rather
 * than a denylist, so a code added later is non-dismissible until someone
 * deliberately decides otherwise. Security findings are structurally
 * undismissible in the analyzer too — this is the second lock, not the only
 * one.
 */
/**
 * The words in a dismissible problem's detail that the row turns into the
 * "not a command" link, so the action reads as part of the sentence.
 */
export const DISMISS_INVOCATION_PHRASE = 'mark it as not a command';

export const DISMISSIBLE_BLOCKER_CODES: ReadonlySet<PipelinePackageBlockerCode> =
  new Set<PipelinePackageBlockerCode>(['UNRESOLVED_INVOCATION']);

/**
 * The pipeline-reference codes a publisher may dismiss, each with the words
 * in its detail that become the dismiss link. A name the prompt only
 * mentions is not a pipeline; a child chosen at run time is shared without
 * its child on purpose.
 */
export const DISMISS_REFERENCE_PHRASES: Readonly<
  Partial<Record<PipelinePackageBlockerCode, string>>
> = {
  AMBIGUOUS_PIPELINE_REFERENCE: 'mark it as not a pipeline',
  UNRESOLVED_CHILD_PIPELINE_REF: 'share without it',
};

/**
 * Severity order for a deterministic list: security findings first (they are
 * about what would leave the machine), then a dependency that vanished, then
 * ambiguity, then a token that did not resolve, then the whole-package check.
 */
const SEVERITY_RANK: Record<PipelinePackageBlockerCode, number> = {
  SUSPECTED_SECRET: 0,
  SOURCE_PATH_ESCAPE: 1,
  SYMLINK_BLOCKED: 2,
  NATIVE_EXECUTABLE_BLOCKED: 3,
  OPAQUE_EXECUTABLE_BLOCKED: 4,
  EXPORT_DENIED_FILE: 5,
  ASSET_PATH_OUTSIDE_HOME: 5,
  ASSET_OVERLAPS_LOCAL_STATE: 5,
  ASSETS_NOT_ALLOWED_FOR_PUBLIC: 5,
  MISSING_DEPENDENCY_SOURCE: 6,
  DEPENDENCY_SOURCE_UNREADABLE: 6,
  MISSING_REQUIRED_ASSET: 6,
  DEPENDENCY_HAS_INSTALLED_PACKAGE: 6,
  LOCAL_ONLY_PIPELINE_TRIGGER: 6,
  AMBIGUOUS_INVOCATION: 7,
  AMBIGUOUS_PIPELINE_REFERENCE: 7,
  DUPLICATE_PIPELINE_KEY: 7,
  ASSETS_REQUIRE_AUTOMATION_SHARE: 8,
  ASSETS_ON_PACKAGED_CHILD: 8,
  UNRESOLVED_INVOCATION: 8,
  UNRESOLVED_CHILD_PIPELINE_REF: 8,
  PACKAGE_LIMIT_EXCEEDED: 9,
  INVALID_PACKAGE: 10,
};

export interface CapabilityPackageProblem {
  /** Stable, index-free key for React and for `data-testid` suffixes. */
  slug: string;
  code: PipelinePackageBlockerCode;
  subject?: string;
  /** The headline sentence, without a trailing full stop. */
  title: string;
  /** What to do about it, as one sentence. */
  detail: string;
  /** Raw main-process prose, shown only behind the Details disclosure. */
  message: string;
  relativePath?: string;
  occurrences: ReadonlyArray<{ jobId: string; stepId: string }>;
  dismissal?: { provider: 'claude' | 'codex'; token: string };
  /** Set on a dismissible pipeline-reference problem. */
  referenceDismissal?: PipelinePackageReferenceDismissal;
  dismissible: boolean;
}

function limitTitle(
  limit: PipelinePackageLimit | undefined,
  subject: string | undefined,
): string {
  const file = subject ?? 'A file';
  switch (limit) {
    case 'file_size':
      return `${file} is larger than ${formatPipelinePackageBytes(PIPELINE_PACKAGE_MAX_FILE_BYTES)}`;
    case 'file_count':
      return `${file} goes past the ${PIPELINE_PACKAGE_MAX_FILES.toLocaleString('en-US')}-file limit`;
    case 'total_size':
    case undefined:
      return `${file} pushes the share past ${formatPipelinePackageBytes(PIPELINE_PACKAGE_MAX_TOTAL_BYTES)}`;
  }
}

function titleFor(
  code: PipelinePackageBlockerCode,
  subject: string | undefined,
  message: string,
  limit: PipelinePackageLimit | undefined,
): string {
  switch (code) {
    case 'UNRESOLVED_INVOCATION':
      return subject ? `${subject} was not found` : message;
    case 'UNRESOLVED_CHILD_PIPELINE_REF':
      return subject
        ? `The child pipeline ${subject} is only known when the pipeline runs`
        : 'A child pipeline is only known when the pipeline runs';
    case 'LOCAL_ONLY_PIPELINE_TRIGGER':
      return subject
        ? `${subject} has a Workflow trigger`
        : 'A pipeline in this share has a Workflow trigger';
    case 'AMBIGUOUS_INVOCATION':
      return subject
        ? `${subject} matches more than one command`
        : 'A step matches more than one command';
    case 'MISSING_DEPENDENCY_SOURCE':
      return subject
        ? `${subject} is no longer on this machine`
        : 'A dependency is no longer on this machine';
    case 'DEPENDENCY_SOURCE_UNREADABLE':
      return subject
        ? `${subject} could not be read`
        : 'A dependency could not be read';
    case 'SUSPECTED_SECRET':
      return subject
        ? `${subject} may contain a credential`
        : 'A dependency file may contain a credential';
    case 'SYMLINK_BLOCKED':
      return subject
        ? `${subject} is a symbolic link`
        : 'A dependency is a symbolic link';
    case 'SOURCE_PATH_ESCAPE':
      return 'A dependency points outside its source folder';
    case 'NATIVE_EXECUTABLE_BLOCKED':
      return subject
        ? `${subject} is a compiled program`
        : 'A dependency is a compiled program';
    case 'OPAQUE_EXECUTABLE_BLOCKED':
      return subject
        ? `${subject} is an unreadable executable`
        : 'A dependency is an unreadable executable';
    case 'EXPORT_DENIED_FILE':
      return subject ? `${subject} can't be shared` : "A file can't be shared";
    case 'PACKAGE_LIMIT_EXCEEDED':
      return limitTitle(limit, subject);
    case 'INVALID_PACKAGE':
      return 'The package failed a safety check';
    case 'AMBIGUOUS_PIPELINE_REFERENCE':
      return subject
        ? `${subject} matches more than one pipeline`
        : 'The prompt matches more than one pipeline';
    case 'DEPENDENCY_HAS_INSTALLED_PACKAGE':
      return subject
        ? `${subject} was installed from another share`
        : 'A pipeline was installed from another share';
    case 'DUPLICATE_PIPELINE_KEY':
      return subject
        ? `Two pipelines share the name ${subject}`
        : 'Two pipelines share a name';
    case 'ASSETS_REQUIRE_AUTOMATION_SHARE':
      return 'This pipeline uses files that travel only with an automation';
    case 'ASSETS_ON_PACKAGED_CHILD':
      return subject
        ? `The child pipeline ${subject} declares its own files`
        : 'A child pipeline declares its own files';
    case 'ASSETS_NOT_ALLOWED_FOR_PUBLIC':
      return 'Files are not available for Public shares';
    case 'ASSET_OVERLAPS_LOCAL_STATE':
      return subject
        ? `${subject} overlaps the pipeline's local state`
        : "A shared folder overlaps the pipeline's local state";
    case 'ASSET_PATH_OUTSIDE_HOME':
      return subject
        ? `${subject} is outside your home folder`
        : 'A shared folder is outside your home folder';
    case 'MISSING_REQUIRED_ASSET':
      return subject
        ? `${subject} was not found`
        : 'A required folder was not found';
  }
}

/** Shown instead of the dismiss link once the scope holds the most it can. */
const DISMISSAL_LIMIT_DETAIL = `You can mark up to ${String(PIPELINE_PACKAGE_MAX_INVOCATION_DISMISSALS)} names as not commands.`;

function detailFor(
  code: PipelinePackageBlockerCode,
  origin: PipelinePackageAnalysisBlocker['origin'],
  dismissible: boolean,
  dismissalLimitReached: boolean,
): string {
  switch (code) {
    case 'UNRESOLVED_INVOCATION':
      if (dismissalLimitReached) {
        return origin === 'transitive'
          ? `A packaged dependency references it. Install it. ${DISMISSAL_LIMIT_DETAIL}`
          : `Install it, or remove the mention. ${DISMISSAL_LIMIT_DETAIL}`;
      }
      if (origin === 'transitive') {
        return dismissible
          ? `A packaged dependency references it. Install it, or ${DISMISS_INVOCATION_PHRASE}.`
          : 'A packaged dependency references it. Install it.';
      }
      return dismissible
        ? `Install it, or ${DISMISS_INVOCATION_PHRASE} if the prompt only mentions it.`
        : 'Install it.';
    case 'AMBIGUOUS_INVOCATION':
      return 'Point the step at one plugin, or rename the other command.';
    case 'UNRESOLVED_CHILD_PIPELINE_REF':
      return dismissible
        ? `Set the pipeline ID as a literal in env and reference that, or ${DISMISS_REFERENCE_PHRASES.UNRESOLVED_CHILD_PIPELINE_REF}.`
        : 'Set the pipeline ID as a literal in env and reference that instead.';
    case 'MISSING_DEPENDENCY_SOURCE':
      return 'Reinstall it, or remove it from the step.';
    case 'DEPENDENCY_SOURCE_UNREADABLE':
      return 'Check that you can read it, or remove it from the step.';
    case 'LOCAL_ONLY_PIPELINE_TRIGGER':
      return "Workflows with a Workflow trigger can't be shared yet. Remove the trigger, or leave that pipeline out of the share.";
    case 'SUSPECTED_SECRET':
      return 'Remove the credential from this file.';
    case 'SYMLINK_BLOCKED':
      return 'Replace it with the file it points to.';
    case 'SOURCE_PATH_ESCAPE':
      return 'Move the file inside the dependency folder.';
    case 'NATIVE_EXECUTABLE_BLOCKED':
      return 'Compiled programs are not shared. Remove it from the dependency.';
    case 'OPAQUE_EXECUTABLE_BLOCKED':
      return 'Replace it with a plain script, or remove it from the dependency.';
    case 'EXPORT_DENIED_FILE':
      return 'Remove it from the dependency folder.';
    case 'PACKAGE_LIMIT_EXCEEDED':
      return 'Move it out of the shared folder.';
    case 'INVALID_PACKAGE':
      return 'Close this and share again to recheck.';
    case 'AMBIGUOUS_PIPELINE_REFERENCE':
      return dismissible
        ? `Reference it by ID, or ${DISMISS_REFERENCE_PHRASES.AMBIGUOUS_PIPELINE_REFERENCE} if the prompt only mentions it.`
        : 'Rename one of the pipelines, or reference it by ID.';
    case 'DEPENDENCY_HAS_INSTALLED_PACKAGE':
      return 'Share the original automation, or remove this pipeline from the dependencies.';
    case 'DUPLICATE_PIPELINE_KEY':
      return 'Rename one of the project pipeline files.';
    case 'ASSETS_REQUIRE_AUTOMATION_SHARE':
      return 'Share the automation that runs this pipeline.';
    case 'ASSETS_ON_PACKAGED_CHILD':
      return 'Declare the files on the entry pipeline instead.';
    case 'ASSETS_NOT_ALLOWED_FOR_PUBLIC':
      return 'Share with your team or organization instead.';
    case 'ASSET_OVERLAPS_LOCAL_STATE':
      return 'Move the local state out of the shared folder.';
    case 'ASSET_PATH_OUTSIDE_HOME':
      return 'Move the folder inside your home folder.';
    case 'MISSING_REQUIRED_ASSET':
      return 'Create the folder, or mark the asset as not required.';
  }
}

/** Lowercase, hyphen-joined, ASCII-only slug fragment. */
export function slugifyProblemPart(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug.slice(0, 64) : 'item';
}

/**
 * Set equality for dismissal lists, ignoring order. Both share modals compare
 * their queued dismissals against main's echo to decide whether to re-issue
 * them, so the comparison lives here rather than in either caller.
 */
export function sameInvocationSet(
  left: readonly PipelinePackageInvocationDismissal[],
  right: readonly PipelinePackageInvocationDismissal[],
): boolean {
  if (left.length !== right.length) return false;
  const seen = new Set(
    right.map(({ provider, token }) => `${provider}\0${token}`),
  );
  return left.every(({ provider, token }) => seen.has(`${provider}\0${token}`));
}

/** {@link sameInvocationSet} for pipeline-reference dismissals. */
export function sameReferenceSet(
  left: readonly PipelinePackageReferenceDismissal[],
  right: readonly PipelinePackageReferenceDismissal[],
): boolean {
  if (left.length !== right.length) return false;
  const seen = new Set(right.map(({ kind, token }) => `${kind}\0${token}`));
  return left.every(({ kind, token }) => seen.has(`${kind}\0${token}`));
}

function stableProblemSlugSuffix(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Project the wire blockers into renderable problems: one row each, severity
 * ordered, with stable slugs. Order inside a severity tier follows the
 * analyzer's emission order so two runs over the same tree agree.
 */
export function buildCapabilityPackageProblems(
  blockers: readonly PipelinePackageAnalysisBlocker[],
  options: {
    /**
     * The scope already holds the most "not a command" marks the store
     * accepts, so another would fail every recheck.
     */
    readonly invocationDismissalsFull?: boolean;
  } = {},
): CapabilityPackageProblem[] {
  const invocationDismissalsFull = options.invocationDismissalsFull ?? false;
  const identities = blockers.map(
    (blocker) => blocker.subject ?? blocker.relativePath ?? blocker.message,
  );
  const bases = blockers.map(
    (blocker, index) =>
      `${slugifyProblemPart(blocker.code)}-${slugifyProblemPart(identities[index] ?? blocker.message)}`,
  );
  const baseCounts = new Map<string, number>();
  for (const base of bases) {
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }
  const problems = blockers.map((blocker, index): CapabilityPackageProblem => {
    const identity = identities[index] ?? blocker.message;
    const base = bases[index] ?? slugifyProblemPart(blocker.code);
    // The analyzer has already deduplicated exact identities. When two
    // different identities normalize to the same ASCII test-id fragment, use
    // an identity-derived suffix rather than a list position so reordering
    // cannot rename either row.
    const slug =
      (baseCounts.get(base) ?? 0) > 1
        ? `${base}-${stableProblemSlugSuffix(
            `${blocker.dismissal?.provider ?? ''}\0${identity}`,
          )}`
        : base;
    const referenceDismissible =
      DISMISS_REFERENCE_PHRASES[blocker.code] !== undefined &&
      blocker.referenceDismissal !== undefined;
    // The store rejects a whole set when one token fails its check, so a
    // token it would refuse is never offered for dismissal.
    const invocationDismissible =
      DISMISSIBLE_BLOCKER_CODES.has(blocker.code) &&
      blocker.dismissal !== undefined &&
      isDismissibleInvocationToken(blocker.dismissal.token);
    const dismissalLimitReached =
      invocationDismissible && invocationDismissalsFull;
    const dismissible =
      (invocationDismissible && !dismissalLimitReached) || referenceDismissible;
    return {
      slug,
      code: blocker.code,
      ...(blocker.subject !== undefined ? { subject: blocker.subject } : {}),
      title: titleFor(
        blocker.code,
        blocker.subject,
        blocker.message,
        blocker.limit,
      ),
      detail: detailFor(
        blocker.code,
        blocker.origin,
        dismissible,
        dismissalLimitReached,
      ),
      message: blocker.message,
      ...(blocker.relativePath !== undefined
        ? { relativePath: blocker.relativePath }
        : {}),
      occurrences: blocker.occurrences ?? [],
      ...(blocker.dismissal ? { dismissal: blocker.dismissal } : {}),
      ...(referenceDismissible && blocker.referenceDismissal
        ? { referenceDismissal: blocker.referenceDismissal }
        : {}),
      dismissible,
    };
  });
  return problems
    .map((problem, index) => ({ problem, index }))
    .sort(
      (left, right) =>
        SEVERITY_RANK[left.problem.code] - SEVERITY_RANK[right.problem.code] ||
        left.index - right.index,
    )
    .map(({ problem }) => problem);
}
