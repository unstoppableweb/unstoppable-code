import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecordStoreFactory } from '@canopy/execution-engine/node/pipelines/executor/spawned-process';
import {
  SpillingRecordStore,
  type RecordStore,
} from '@canopy/execution-engine/node/pipelines/executor/record-store';

/**
 * UI-automation-only synchronization for a stored record's replay.
 *
 * A step stopped while a spilled record is being replayed is a real user
 * flow, but the replay normally finishes in milliseconds, so no UI test could
 * reach that window deterministically. When the E2E build is running AND the
 * test names an owned directory in `CANOPY_E2E_REPLAY_GATE_DIR`, each replay
 * pauses just before its second chunk: it writes `replay-paused` into that
 * directory and continues once the test creates `replay-release`. Storage,
 * thresholds, masking and timing limits are the defaults; only the moment the
 * replay resumes is handed to the test.
 *
 * Release builds compile `__CANOPY_E2E__` to `false`, so this always returns
 * `undefined` there and the default store is used.
 */
export function e2eReplayGateFactory(): RecordStoreFactory | undefined {
  if (typeof __CANOPY_E2E__ === 'undefined' || !__CANOPY_E2E__)
    return undefined;
  const directory = process.env.CANOPY_E2E_REPLAY_GATE_DIR;
  if (!directory) return undefined;
  const released = async (): Promise<void> => {
    while (!existsSync(join(directory, 'replay-release')))
      await new Promise((resolve) => setTimeout(resolve, 10));
  };
  return (spillAfterChars, label): RecordStore => {
    const inner = new SpillingRecordStore(spillAfterChars, label);
    return {
      get length(): number {
        return inner.length;
      },
      get spilled(): boolean {
        return inner.spilled;
      },
      get residentLength(): number {
        return inner.residentLength;
      },
      get location(): string | undefined {
        return inner.location;
      },
      settling: (): Promise<void> | undefined => inner.settling(),
      append: (text: string): boolean => inner.append(text),
      whenDrained: (): Promise<void> => inner.whenDrained(),
      replay: async function* (): AsyncIterable<string> {
        let index = 0;
        for await (const chunk of inner.replay()) {
          if (index === 1) {
            await writeFile(join(directory, 'replay-paused'), 'paused');
            await released();
          }
          index += 1;
          yield chunk;
        }
      },
      dispose: (): Promise<void> => inner.dispose(),
    };
  };
}
