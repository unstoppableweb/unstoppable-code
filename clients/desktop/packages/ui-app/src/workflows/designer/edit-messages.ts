/**
 * Why the designer refused an edit, as the host reports it. It mirrors the
 * projection's refusal so this package needn't import the pipeline types.
 */
export type WorkflowDesignerEditRefusal =
  | { readonly kind: 'not-editable' }
  | { readonly kind: 'invalid-id' }
  | { readonly kind: 'duplicate-id' }
  | {
      readonly kind: 'path-label';
      readonly problem: 'empty' | 'too-long' | 'characters' | 'duplicate';
    }
  | { readonly kind: 'too-few-paths' }
  | { readonly kind: 'too-large' }
  | {
      readonly kind: 'reads' | 'order' | 'outcomes';
      readonly reader:
        | {
            readonly kind: 'step';
            readonly stepIndex: number;
            readonly name?: string;
            readonly id?: string;
          }
        | { readonly kind: 'output'; readonly key: string }
        | { readonly kind: 'dependency'; readonly id: string }
        | { readonly kind: 'path'; readonly label: string };
    };

export type WorkflowDesignerEditAction =
  | 'insert'
  | 'remove'
  | 'move'
  | 'rename'
  | 'split'
  | 'add-path'
  | 'remove-path'
  | 'rename-path'
  | 'remove-split';

const CANT: Readonly<Record<WorkflowDesignerEditAction, string>> = {
  insert: 'Can’t add a step here',
  remove: 'Can’t remove this step',
  move: 'Can’t move this step there',
  rename: 'Can’t change this ID',
  split: 'Can’t split here',
  'add-path': 'Can’t add a path',
  'remove-path': 'Can’t remove this path',
  'rename-path': 'Can’t rename this path',
  'remove-split': 'Can’t remove this split',
};

const PATH_LABEL: Readonly<
  Record<'empty' | 'too-long' | 'characters' | 'duplicate', string>
> = {
  empty: 'Name the path.',
  'too-long': 'Use 60 characters or fewer.',
  characters:
    'Leave out quotes, backslashes, line breaks, double spaces, ${{ and spaces at either end.',
  duplicate: 'Another path has this name.',
};

/**
 * The sentence that explains a refused edit. It names what blocks the edit,
 * and a step's name is authored, so hosts show it in a replay-blocked element.
 */
export function workflowDesignerRefusalMessage(
  action: WorkflowDesignerEditAction,
  refusal: WorkflowDesignerEditRefusal,
): string {
  switch (refusal.kind) {
    case 'not-editable':
      return `${CANT[action]}: the designer shows this job read-only. Edit it in YAML instead.`;
    case 'invalid-id':
      return 'Use letters, digits and underscores, starting with a letter or underscore.';
    case 'duplicate-id':
      return 'Another step in this job has this ID.';
    case 'path-label':
      return PATH_LABEL[refusal.problem];
    case 'too-large':
      return `${CANT[action]}: the workflow would be too large for the designer to show. Edit it in YAML instead.`;
    case 'too-few-paths':
      return `${CANT[action]}: a split keeps two paths or more. Remove the split instead.`;
    case 'order':
    case 'outcomes':
    case 'reads': {
      const reader = refusal.reader;
      const who =
        reader.kind === 'output'
          ? `the job output “${reader.key}”`
          : reader.kind === 'dependency'
            ? `the workflow dependency “${reader.id}”`
            : reader.kind === 'path'
              ? `the path “${reader.label}”`
              : `“${reader.name ?? reader.id ?? `Step ${String(reader.stepIndex + 1)}`}”`;
      if (refusal.kind === 'outcomes')
        return `${CANT[action]}: ${who} checks whether the steps before it succeeded, and this changes those steps. Edit it in YAML instead.`;
      if (refusal.kind === 'order')
        return `${CANT[action]}: it changes the steps that run before a step ${who} reads. Edit it in YAML instead.`;
      const what =
        action === 'rename'
          ? `${who} reads this step by its ID`
          : action === 'rename-path'
            ? `${who} reads what the split chose, which may compare it with this name`
            : action === 'remove'
              ? `${who} reads it`
              : action === 'remove-split' || action === 'remove-path'
                ? reader.kind === 'path'
                  ? `${who} reads what the split chose`
                  : `${who} reads a step it removes`
                : `${who} would read a different step`;
      return `${CANT[action]}: ${what}. Edit it in YAML instead.`;
    }
  }
}

/**
 * Why the trigger card refused an entry change, as the host reports it. It
 * mirrors the projection's refusal so this package needn't import it.
 */
export type WorkflowTriggerEditRefusal =
  | { readonly kind: 'no-entry' }
  | { readonly kind: 'scheduled' }
  | { readonly kind: 'hooked' }
  | { readonly kind: 'starters-unknown' }
  | {
      readonly kind: 'entry-read';
      readonly entry: 'run' | 'approved-plan' | 'new-task';
      readonly jobId: string;
      readonly stepIndex?: number;
      readonly name?: string;
    }
  | {
      readonly kind: 'entry-inputs';
      readonly entry: 'run' | 'approved-plan' | 'new-task';
    }
  | {
      readonly kind: 'entry-used';
      readonly entry: 'run' | 'approved-plan' | 'new-task';
      readonly jobId: string;
      readonly stepIndex?: number;
      readonly name?: string;
    };

const ENTRY_NAMES: Readonly<
  Record<'run' | 'approved-plan' | 'new-task', string>
> = {
  run: 'Run',
  'approved-plan': 'Approved plan',
  'new-task': 'New task',
};

/**
 * The sentence that explains a refused entry change. A step's or job's name
 * is authored, so hosts show it in a replay-blocked element.
 */
export function workflowTriggerRefusalMessage(
  refusal: WorkflowTriggerEditRefusal,
): string {
  switch (refusal.kind) {
    case 'no-entry':
      return 'Keep at least one way to start this workflow.';
    case 'scheduled':
      return 'Schedules start this workflow as a run, so Run stays on while it has any.';
    case 'hooked':
      return 'A worktree hook starts this workflow as a run, so Run stays on.';
    case 'starters-unknown':
      return 'Schedules and hooks are still loading, so Run stays on for now. Try again in a moment.';
    case 'entry-inputs':
      return `${ENTRY_NAMES[refusal.entry]} has inputs that turning it off would delete. Change it in the settings panel instead.`;
    case 'entry-read': {
      const who =
        refusal.name ??
        (refusal.stepIndex === undefined
          ? refusal.jobId
          : `Step ${String(refusal.stepIndex + 1)} of ${refusal.jobId}`);
      return `“${who}” checks which entry started the workflow, so ${ENTRY_NAMES[refusal.entry]} stays on. Edit it in YAML instead.`;
    }
    case 'entry-used': {
      const who =
        refusal.name ??
        (refusal.stepIndex === undefined
          ? refusal.jobId
          : `Step ${String(refusal.stepIndex + 1)} of ${refusal.jobId}`);
      return `“${who}” runs only from ${ENTRY_NAMES[refusal.entry]}, so ${ENTRY_NAMES[refusal.entry]} stays on. Edit it in YAML instead.`;
    }
  }
}
