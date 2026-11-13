/**
 * The web core client for cloud workflow schedules (CAN-6183):
 * `core.pipeline.schedule.*` on main's own web core connection, one
 * connection per call, as attachment uploads do.
 */
import { randomUUID } from 'node:crypto';
import {
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_QUERY_DEFINITIONS,
  PIPELINE_SCHEDULE_INSTRUCTION_DEFINITIONS,
  PIPELINE_SCHEDULE_QUERY_DEFINITIONS,
  PipelineScheduleListResultSchema,
  PipelineScheduleResultSchema,
  composeCanopyInstructionRegistries,
  composeCanopyQueryRegistries,
  type PipelineSchedule,
} from '@canopy/protocol/canopy-core';
import {
  CanopyClientError,
  createCanopyClient,
  type CanopyClient,
} from '@canopy/core-client';
import { CanopyTransportError } from '@canopy/core-transport';
import {
  connectWebCore,
  type WebCoreBindingOptions,
} from '../canopy-cloud/web-core-connection';
import {
  CloudScheduleRemoteError,
  type CloudScheduleRemote,
} from './cloud-schedules';

const DEFINITIONS = {
  queries: composeCanopyQueryRegistries(
    CORE_TRANSPORT_QUERY_DEFINITIONS,
    PIPELINE_SCHEDULE_QUERY_DEFINITIONS,
  ),
  instructions: composeCanopyInstructionRegistries(
    CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
    PIPELINE_SCHEDULE_INSTRUCTION_DEFINITIONS,
  ),
  streams: {},
} as const;

type ScheduleClient = CanopyClient<
  typeof DEFINITIONS.queries,
  typeof DEFINITIONS.instructions
>;

const CALL_TIMEOUT_MS = 30_000;
const LIST_PAGE = 200;

function remoteError(error: unknown): CloudScheduleRemoteError {
  if (error instanceof CloudScheduleRemoteError) return error;
  return new CloudScheduleRemoteError(
    error instanceof CanopyClientError || error instanceof CanopyTransportError
      ? error.payload
      : null,
  );
}

/** The remote main uses, bound to its web core credentials. */
export function createWebCoreCloudScheduleRemote(
  binding: WebCoreBindingOptions,
  clientVersion: string,
  currentAccountId: () => Promise<string | null>,
): CloudScheduleRemote {
  async function call<Result>(
    run: (client: ScheduleClient) => Promise<Result>,
  ): Promise<Result> {
    const signal = AbortSignal.timeout(CALL_TIMEOUT_MS);
    let client: ScheduleClient;
    try {
      client = await createCanopyClient({
        connection: await connectWebCore(binding, signal),
        clientName: 'canopy-desktop-cloud-schedules',
        clientVersion,
        definitions: DEFINITIONS,
        signal,
      });
    } catch (error) {
      throw remoteError(error);
    }
    try {
      return await run(client);
    } catch (error) {
      throw remoteError(error);
    } finally {
      await client.close();
    }
  }

  const gone = (error: unknown): boolean =>
    error instanceof CloudScheduleRemoteError &&
    error.payload?.kind === 'not_found';

  async function list(sourceRecordId?: string): Promise<PipelineSchedule[]> {
    return call(async (client) => {
      const schedules: PipelineSchedule[] = [];
      let cursor: string | undefined;
      do {
        const page = PipelineScheduleListResultSchema.parse(
          await client.query('core.pipeline.schedule.list', {
            limit: LIST_PAGE,
            ...(sourceRecordId === undefined ? {} : { sourceRecordId }),
            ...(cursor === undefined ? {} : { cursor }),
          }),
        );
        schedules.push(...page.schedules);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return schedules;
    });
  }

  return {
    accountId: currentAccountId,
    async create(params) {
      const result = await call((client) =>
        client.instruction('core.pipeline.schedule.create', {
          ...params,
          _meta: { idempotencyKey: randomUUID() },
        }),
      );
      return PipelineScheduleResultSchema.parse(result).schedule;
    },
    async get(scheduleId) {
      try {
        const result = await call((client) =>
          client.query('core.pipeline.schedule.get', { scheduleId }),
        );
        return PipelineScheduleResultSchema.parse(result).schedule;
      } catch (error) {
        if (gone(error)) return null;
        throw error;
      }
    },
    async findBySourceRecord(sourceRecordId) {
      return (await list(sourceRecordId))[0] ?? null;
    },
    list: () => list(),
    async update(params) {
      const result = await call((client) =>
        client.instruction('core.pipeline.schedule.update', {
          ...params,
          _meta: { idempotencyKey: randomUUID() },
        }),
      );
      return PipelineScheduleResultSchema.parse(result).schedule;
    },
    async delete(scheduleId, idempotencyKey) {
      try {
        const result = await call((client) =>
          client.instruction('core.pipeline.schedule.delete', {
            scheduleId,
            _meta: { idempotencyKey },
          }),
        );
        return PipelineScheduleResultSchema.parse(result).schedule;
      } catch (error) {
        if (gone(error)) return null;
        throw error;
      }
    },
  };
}
