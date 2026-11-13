import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { isJsonValue } from '@canopy/execution-engine/node/codex-runtime';
import type { JsonValue } from '@canopy/execution-engine/node/codex-runtime/generated/serde_json/JsonValue';

function seedRoot(): string {
  return join(getCanopyDataDir(), 'codex-reconstruction-seeds', 'v1');
}

function seedPath(seedId: string): string {
  if (!/^[a-f0-9]{64}$/.test(seedId)) {
    throw new Error('Invalid Codex reconstruction seed id');
  }
  return join(seedRoot(), `${seedId}.json`);
}

export async function publishCodexReconstructionSeed(
  items: readonly JsonValue[],
): Promise<string> {
  if (items.length === 0) {
    throw new Error('Cannot publish an empty Codex reconstruction seed');
  }
  const serialized = JSON.stringify({ version: 1, items });
  const seedId = createHash('sha256').update(serialized).digest('hex');
  const root = seedRoot();
  const destination = seedPath(seedId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = join(root, `.${seedId}.${randomUUID()}.tmp`);
  await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
  try {
    await link(temporary, destination);
  } catch (error) {
    // Content-addressed publication is idempotent across Electron processes.
    const existing = await readFile(destination, 'utf8').catch(() => null);
    if (existing !== serialized) throw error;
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return seedId;
}

export async function readCodexReconstructionSeed(
  seedId: string,
): Promise<JsonValue[]> {
  const parsed: unknown = JSON.parse(await readFile(seedPath(seedId), 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Reflect.get(parsed, 'version') !== 1
  ) {
    throw new Error('Invalid Codex reconstruction seed');
  }
  const items: unknown = Reflect.get(parsed, 'items');
  if (!Array.isArray(items) || !items.every(isJsonValue)) {
    throw new Error('Invalid Codex reconstruction seed');
  }
  return items;
}
