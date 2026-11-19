import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { McpServerToolsCacheFile } from '@canopy/execution-engine/types/mcp-servers';
import { getMcpServerToolsCacheFilePath } from '../lib/paths';

/** Cache publication never writes server configs, the index, or removal evidence. */
export async function writeMcpToolsCache(
  cache: McpServerToolsCacheFile,
): Promise<void> {
  const filePath = getMcpServerToolsCacheFilePath();
  const temporaryPath = `${filePath}.${String(process.pid)}.${randomUUID()}.tmp`;
  await mkdir(dirname(filePath), { recursive: true });
  try {
    await writeFile(temporaryPath, JSON.stringify(cache, null, 2), 'utf8');
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
