import path from 'node:path';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { writeJson } from './fsHelpers.mjs';

/**
 * Seed a stored (user) pipeline into a test's `CANOPY_DATA_DIR`.
 *
 * Mirrors the writer in `packages/execution-engine/src/pipelines/store.ts`:
 *   - YAML body:  `{userDataDir}/pipelines/{id}.yaml`
 *   - index file: `{userDataDir}/pipelines/index.json` (`PipelineIndex`)
 *
 * `triggerTypes` is derived lazily by the store when omitted, so seeding just
 * id/name/filename/timestamps is enough for the pipeline to appear in
 * trigger-scoped pickers like the Dispatch modal.
 *
 * @param {object} input
 * @param {string} input.userDataDir test-scoped CANOPY_DATA_DIR
 * @param {string} input.id pipeline id (also used as the YAML filename stem)
 * @param {string} input.name display name shown in pickers
 * @param {string} input.yaml full pipeline YAML body
 * @param {string} [input.description]
 */
export function seedStoredPipeline({
  userDataDir,
  id,
  name,
  yaml,
  description = '',
}) {
  const pipelinesDir = path.join(userDataDir, 'pipelines');
  mkdirSync(pipelinesDir, { recursive: true });

  const filename = `${id}.yaml`;
  writeFileSync(path.join(pipelinesDir, filename), yaml, 'utf8');

  const indexPath = path.join(pipelinesDir, 'index.json');
  const existing = existsSync(indexPath)
    ? JSON.parse(readFileSync(indexPath, 'utf8'))
    : { pipelines: [] };
  const now = new Date().toISOString();
  existing.pipelines = [
    ...existing.pipelines.filter((entry) => entry.id !== id),
    {
      id,
      name,
      filename,
      description,
      icon: '',
      createdAt: now,
      updatedAt: now,
    },
  ];
  writeJson(indexPath, existing);
}
