/** One storage row of the pipeline definitions family (CAN-5340). */
export interface PipelineDefinitionsBackupMember {
  readonly namespaceId: string;
  /** Data-root-relative path of the row's file or folder. */
  readonly path: string;
  readonly kind: 'file' | 'directory';
  /**
   * Top-level names in the folder that belong to another row. A backup skips
   * them, and a restore leaves them where they are.
   */
  readonly exclude: readonly string[];
  /** The top-level entry a restore puts in place last. */
  readonly commitLast?: string;
}

/**
 * The family's rows in restore order, the definitions folder last. The
 * project share-link catalog sits in the definitions folder but is its own
 * row, written only by its admitted writer.
 */
export const PIPELINE_DEFINITIONS_BACKUP_MEMBERS: readonly PipelineDefinitionsBackupMember[] =
  [
    {
      namespaceId: 'pipeline_definition_replays',
      path: 'pipeline-definition-replays.json',
      kind: 'file',
      exclude: [],
    },
    {
      namespaceId: 'pipeline_data',
      path: 'pipeline-data',
      kind: 'directory',
      exclude: [],
    },
    {
      namespaceId: 'pipeline_definitions',
      path: 'pipelines',
      kind: 'directory',
      exclude: ['.project-share-links.json'],
      commitLast: 'index.json',
    },
  ];
