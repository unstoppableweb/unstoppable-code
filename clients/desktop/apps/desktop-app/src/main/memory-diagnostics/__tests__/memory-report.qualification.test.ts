import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getHeapStatistics, writeHeapSnapshot } from 'node:v8';
import type * as V8 from 'node:v8';
import { getMemoryReportsDir } from '../../lib/paths';
import { captureNativeMemory } from '../native-memory';
import { createMemoryDiagnosticsService } from '../service';

jest.mock('electron', () => ({
  app: { getAppMetrics: (): [] => [], getVersion: (): string => '1.0.0' },
}));
jest.mock('../../lib/paths', () => ({ getMemoryReportsDir: jest.fn() }));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessError: jest.fn(),
  logMainProcessWarn: jest.fn(),
}));
jest.mock('../native-memory', () => ({
  captureNativeMemory: jest.fn(),
  NATIVE_DUMP_WAIT_MS: 0,
  NativeMemoryTraceCleanupError: class extends Error {},
}));
jest.mock('node:v8', () => ({
  ...jest.requireActual<typeof V8>('node:v8'),
  getHeapStatistics: jest.fn(),
  writeHeapSnapshot: jest.fn(),
}));

describe('memory-diagnostics:create-report host qualification', () => {
  it.each([
    { used: 60, limit: 100, included: false },
    { used: 50, limit: 100, included: true },
    { used: 20, limit: 0, included: false },
  ])(
    'writes a usable report with main heap $used/$limit',
    async ({ used, limit, included }) => {
      const root = await mkdtemp(join(tmpdir(), 'memory-report-'));
      const service = createMemoryDiagnosticsService({
        getAppRenderers: () => [],
      });
      const heap = process.getBuiltinModule('node:v8').getHeapStatistics();
      jest.mocked(getMemoryReportsDir).mockReturnValue(root);
      jest.mocked(getHeapStatistics).mockReturnValue({
        ...heap,
        used_heap_size: 10,
        heap_size_limit: 100,
      });
      jest.mocked(writeHeapSnapshot).mockImplementation((path) => {
        if (typeof path !== 'string') throw new Error('Expected snapshot path');
        writeFileSync(path, '{}');
        return path;
      });
      jest.mocked(captureNativeMemory).mockImplementation(() => {
        // Native capture can consume the headroom measured at report admission.
        jest.mocked(getHeapStatistics).mockReturnValue({
          ...heap,
          used_heap_size: used,
          heap_size_limit: limit,
        });
        return Promise.resolve({
          captured: true,
          unavailableReason: null,
          durationMs: 0,
          processes: [],
          missingProcessIds: [],
        });
      });
      try {
        service.setEnabled(true);
        const result = await service.createReport();
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.message);
        const reportPath = service.resolveReportPath(result.report.reportId);
        expect(reportPath).not.toBeNull();
        if (reportPath === null) throw new Error('Report path did not resolve');
        expect(await readdir(reportPath)).toEqual(
          expect.arrayContaining(['summary.json', 'main.heapprofile']),
        );
        expect((await readdir(reportPath)).includes('main.heapsnapshot')).toBe(
          included,
        );
        expect(
          JSON.parse(await readFile(join(reportPath, 'summary.json'), 'utf8')),
        ).toMatchObject({
          version: 1,
          mainSnapshot: {
            included,
            usedHeapBytes: used,
            heapLimitBytes: limit,
            ...(!included
              ? { skippedReason: 'insufficient-heap-headroom' }
              : {}),
          },
          nativeMemory: { captured: true },
          sampling: { included: true },
        });
      } finally {
        await service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
