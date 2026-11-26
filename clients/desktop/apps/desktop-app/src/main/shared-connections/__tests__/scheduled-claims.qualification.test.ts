/**
 * Scheduled runs on a project's shared connections (CAN-6252), desktop side.
 * An automation's turn carries the writes its automation allowed into the
 * session, which never shares a live session with a person's chat or another
 * automation's list. Its claim is asked for as a scheduled run with those
 * writes, kept apart from the chat's attended claim, and a web from before
 * scheduled claims answers that scheduled runs have none. An automation the
 * form saves as a pipeline it owns keeps its list, and only that pipeline's
 * runs carry it. A break here lets a scheduled run act on a shared connection
 * with a person's claim or another automation's writes, or silently drops the
 * writes a person allowed.
 */
jest.mock('electron', () => ({ app: { getVersion: (): string => '0' } }));
jest.mock('../../canopy-cloud/web-core-connection', () => ({}));
jest.mock('../../canopy-cloud/client', () => ({}));
jest.mock('../../ipc/cloud-chats', () => ({}));
jest.mock('../../pipelines/pipeline-local-metadata-store', () => ({
  readPipelineLocalMetadata: (locator: { value: string }): object =>
    locator.value === 'owned-pipeline' ? { ownerAutomationId: 'auto' } : {},
}));

import { isSharedConnectionWriteList } from '@canopy/desktop-shared/lib/automations';
import { buildInstallAutomationRequest } from '@canopy/desktop-shared/lib/automation-install';
import { buildSharedAutomationDocument } from '@canopy/desktop-shared/lib/automation-sharing';
import {
  chatAutomationToPipeline,
  ownedPipelineToChatAction,
} from '@canopy/desktop-shared/lib/chat-automation-conversion';
import type {
  AutomationAction,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import { ownedPipelineSharedConnectionWrites } from '../../automations/owned-pipeline-writes';
import {
  accountResolutionSignature,
  turnAccountResolution,
  unattendedPluginOptions,
} from '../../agents/turn-account-resolution';
import {
  createSharedConnectionSessions,
  type SharedConnectionCalls,
  type SharedConnectionSessionRead,
} from '../sessions';

const LINEAR = '00000000-0000-4000-8000-0000000000c1';

const issued: SharedConnectionSessionRead = {
  kind: 'ok',
  value: {
    claim: 'claim',
    expiresAt: '2099-01-01T00:00:00.000Z',
    project: { id: 'project', name: 'Acme web' },
    connections: [],
  },
};

describe('a scheduled run’s shared connections (CAN-6252)', () => {
  it('carries an automation’s allowed writes into its unattended session', () => {
    const writes = { [LINEAR]: ['create_issue'] };
    const facts = turnAccountResolution({
      automationDispatch: {
        version: 1,
        automationName: 'Nightly triage',
        presentation: 'background',
        sharedConnectionWrites: writes,
      },
    });
    expect(facts).toEqual({
      accountResolution: 'unattended',
      sharedConnectionWrites: writes,
    });
    expect(unattendedPluginOptions(facts)).toEqual(facts);
    // A person's chat carries neither, even if a list leaked into its options.
    expect(turnAccountResolution({})).toEqual({});
    expect(unattendedPluginOptions({ sharedConnectionWrites: writes })).toEqual(
      {},
    );
  });

  it('never lets two write lists, or a person and an automation, share a session', () => {
    const none = accountResolutionSignature({
      accountResolution: 'unattended',
    });
    const one = accountResolutionSignature({
      accountResolution: 'unattended',
      sharedConnectionWrites: { [LINEAR]: ['create_issue', 'update_issue'] },
    });
    const sameOtherOrder = accountResolutionSignature({
      accountResolution: 'unattended',
      sharedConnectionWrites: { [LINEAR]: ['update_issue', 'create_issue'] },
    });
    const other = accountResolutionSignature({
      accountResolution: 'unattended',
      sharedConnectionWrites: { [LINEAR]: ['delete_issue'] },
    });
    expect(accountResolutionSignature({})).toBe('');
    expect(new Set([none, one, other]).size).toBe(3);
    expect(sameOtherOrder).toBe(one);
  });

  it('asks for a scheduled claim with the writes, kept apart from the chat’s attended one', async () => {
    const asked: unknown[] = [];
    const calls: SharedConnectionCalls = {
      issue: (projectId, chatId, scheduled) => {
        asked.push([projectId, chatId, scheduled]);
        return Promise.resolve(issued);
      },
    };
    const sessions = createSharedConnectionSessions({
      calls,
      owner: () => Promise.resolve('key'),
      now: () => 0,
    });
    const writes = { [LINEAR]: ['create_issue'] };
    await sessions.forChat('project', 'chat');
    await sessions.forChat('project', 'chat', { scheduled: { writes } });
    await sessions.forChat('project', 'chat', { scheduled: { writes } });
    await sessions.forChat('project', 'chat', { scheduled: {} });
    expect(asked).toEqual([
      ['project', 'chat', undefined],
      ['project', 'chat', { writes }],
      ['project', 'chat', {}],
    ]);
  });

  it('keeps an automation’s write list within what a claim carries', () => {
    expect(isSharedConnectionWriteList({ [LINEAR]: ['create_issue'] })).toBe(
      true,
    );
    expect(isSharedConnectionWriteList({ [LINEAR]: [''] })).toBe(false);
    expect(
      isSharedConnectionWriteList({
        [LINEAR]: Array.from({ length: 65 }, (_, index) => `tool_${index}`),
      }),
    ).toBe(false);
    expect(isSharedConnectionWriteList(['create_issue'])).toBe(false);
  });

  it('keeps the writes when the form saves an automation as a pipeline it owns', () => {
    const writes = { [LINEAR]: ['create_issue'] };
    const converted = chatAutomationToPipeline({
      name: 'Nightly triage',
      action: {
        type: 'worktree_prompt',
        workspaceId: 'project',
        prompt: 'Triage new issues',
        sharedConnectionWrites: writes,
      },
    });
    // The edit form reads the list back from the owned pipeline.
    expect(
      ownedPipelineToChatAction(
        converted.pipeline,
        converted.inputs,
        () => false,
      ),
    ).toMatchObject({ sharedConnectionWrites: writes });
    // Only a run of the pipeline the automation owns carries it.
    const action: AutomationAction = {
      type: 'worktree_pipeline',
      workspaceId: 'project',
      pipelineId: 'owned-pipeline',
      pipelineSource: 'user',
      inputs: converted.inputs,
    };
    expect(
      ownedPipelineSharedConnectionWrites(
        { id: 'auto', action },
        'owned-pipeline',
      ),
    ).toEqual(writes);
    expect(
      ownedPipelineSharedConnectionWrites(
        { id: 'other', action },
        'owned-pipeline',
      ),
    ).toBeUndefined();
    expect(
      ownedPipelineSharedConnectionWrites(
        { id: 'auto', action: { ...action, pipelineId: 'workflow' } },
        'workflow',
      ),
    ).toBeUndefined();
  });

  it('never shares an automation’s allowed writes: whoever installs it chooses their own', () => {
    const at = '2026-11-17T00:00:00.000Z';
    const activity: ScheduledActivity = {
      version: 1,
      id: 'auto',
      name: 'Nightly triage',
      enabled: true,
      schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
      action: {
        type: 'app_advisor_prompt',
        prompt: 'Triage new issues',
        sharedConnectionWrites: { [LINEAR]: ['create_issue'] },
      },
      createdAt: at,
      updatedAt: at,
      failureCount: 0,
    };
    const shared = buildSharedAutomationDocument(activity, {
      description: '',
    });
    if (!shared.ok) throw new Error(JSON.stringify(shared));
    expect(shared.notices).toContain('shared_connection_writes_stripped');
    expect(JSON.stringify(shared.document)).not.toContain('create_issue');
    const installed = buildInstallAutomationRequest(
      { id: 'share', contentHash: 'hash', automation: shared.document },
      {},
      at,
    );
    if (!installed.ok) throw new Error(installed.error);
    expect(installed.request.action).not.toHaveProperty(
      'sharedConnectionWrites',
    );
  });
});
