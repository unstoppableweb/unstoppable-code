import type { PipelinePackageManifestV1 } from './package';

/** The kind of manifest text a secret check names, never its value. */
export type PipelinePackageManifestTextKind =
  | 'id'
  | 'name'
  | 'source label'
  | 'invocation key'
  | 'pipeline key'
  | 'asset id'
  | 'installed item'
  | 'folder name'
  | 'file path'
  | 'requirement name'
  | 'step name'
  | 'job name'
  | 'publisher note';

export interface PipelinePackageManifestTextField {
  kind: PipelinePackageManifestTextKind;
  value: string;
  isPath: boolean;
  /** Writes `shown` in the value's place; an installed item ref is dropped. */
  replace: (shown: string) => void;
}

/**
 * Every free-text field a package manifest carries, in one order, so the
 * desktop's final check and the hosted commit read the same list (CAN-7476,
 * CAN-7568). Only string values are visited.
 */
export function forEachPipelinePackageManifestText(
  manifest: PipelinePackageManifestV1,
  visit: (field: PipelinePackageManifestTextField) => void,
): void {
  const text = (
    kind: PipelinePackageManifestTextKind,
    value: unknown,
    replace: (shown: string) => void,
    isPath = false,
  ): void => {
    if (typeof value === 'string') visit({ kind, value, isPath, replace });
  };
  const ids = (list: string[]): void =>
    list.forEach((id, index) => text('id', id, (v) => (list[index] = v)));
  // A location is replaced with a copy rather than written, so one shared
  // with another field stays as it was.
  const steps = (list: Array<{ jobId: string; stepId: string }>): void =>
    list.forEach((step, index) => {
      const shown = (patch: { jobId: string } | { stepId: string }): void => {
        list[index] = { ...(list[index] ?? step), ...patch };
      };
      text('step name', step.jobId, (v) => shown({ jobId: v }));
      text('step name', step.stepId, (v) => shown({ stepId: v }));
    });
  for (const resource of manifest.resources) {
    text('id', resource.id, (v) => (resource.id = v));
    ids(resource.dependencyResourceIds);
    text('name', resource.displayName, (v) => (resource.displayName = v));
    text(
      'source label',
      resource.sourceLabel,
      (v) => (resource.sourceLabel = v),
    );
    resource.invocationKeys.forEach((key, index) =>
      text('invocation key', key, (v) => (resource.invocationKeys[index] = v)),
    );
    text(
      'pipeline key',
      resource.pipelineKey,
      (v) => (resource.pipelineKey = v),
    );
    text('asset id', resource.assetId, (v) => (resource.assetId = v));
    for (const value of Object.values(resource.installedItemRef ?? {}))
      text('installed item', value, () => delete resource.installedItemRef);
    for (const tree of resource.trees) {
      text('folder name', tree.rootName, (v) => (tree.rootName = v));
      for (const entry of tree.entries)
        text('file path', entry.path, (v) => (entry.path = v), true);
    }
  }
  for (const requirement of manifest.environmentRequirements) {
    steps(requirement.affectedSteps);
    text('requirement name', requirement.id, (v) => (requirement.id = v));
    text(
      'requirement name',
      requirement.displayName,
      (v) => (requirement.displayName = v),
    );
    text(
      'requirement name',
      requirement.setupHint,
      (v) => (requirement.setupHint = v),
    );
  }
  for (const binding of manifest.bindings) {
    ids(binding.resourceIds);
    if ('jobId' in binding) {
      text('job name', binding.jobId, (v) => (binding.jobId = v));
      text('step name', binding.stepId, (v) => (binding.stepId = v));
    }
  }
  for (const note of manifest.publisherNotes ?? []) {
    text('publisher note', note.label, (v) => (note.label = v));
    steps(note.affectedSteps);
  }
}

/**
 * What a package refused for secret-looking text says: the kinds of field
 * hit and the rule, never a value.
 */
export function secretShapedTextMessage(input: {
  kinds: readonly string[];
  ruleLabel: string;
  isPath: boolean;
  verb: 'share' | 'upload';
}): string {
  const { kinds, ruleLabel, isPath, verb } = input;
  const [kind = ''] = kinds;
  return kinds.length === 1
    ? `${/^[aeiou]/.test(kind) ? 'An' : 'A'} ${kind} in this package looks like it contains a secret (${ruleLabel}). Rename it, then ${verb} again.`
    : `${isPath ? 'Paths' : 'Names'} in this package look like they contain a secret (${kinds.join(', ')}; ${ruleLabel}). Rename them, then ${verb} again.`;
}
