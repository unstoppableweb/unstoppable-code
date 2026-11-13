import { desktopBrowserPort } from './desktop-browser-port';
import { desktopExperimentsPort } from './desktop-experiments-port';
import { desktopInstalledItemsPort } from './desktop-installed-items-port';
import { desktopSettingsPort } from './desktop-settings-port';
import { desktopPipelineExecutionsPort } from './desktop-pipeline-executions-port';
import { desktopPipelinesPort } from './desktop-pipelines-port';
import { desktopCapabilityPackagePort } from './desktop-capability-package-port';
import {
  createBotActionFamily,
  createBrowserActionFamily,
  createEnvironmentActionFamily,
  createTranscriptReadActionFamily,
  createProjectActionFamily,
  createExperimentsActionFamily,
  createInstalledItemsActionFamily,
  type AgentInstalledItemsPort,
  createSettingsActionFamily,
  createCapabilityPackageActionFamily,
  createPipelineExecutionsActionFamily,
  createPipelinesActionFamily,
  type AgentBrowserPort,
  type AgentCapabilityPackagePort,
  type AgentExperimentsPort,
  type AgentPipelineExecutionsPort,
  type AgentPipelinesPort,
  type AgentSettingsPort,
  defineAgentActionHost,
  type AgentActionFamily,
  type AgentActionHostCapabilities,
  type AgentActionLimitsPort,
  type AgentActionReceiptStore,
  type AgentActionSplitPort,
  type AgentChatWatcherPort,
  type AgentEnvironmentPort,
  type AgentTranscriptReadPort,
  type AgentProjectBotPort,
} from '@canopy/agent-actions';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import { desktopLegacyActionFamily } from './desktop-legacy-family';
import {
  createDesktopEnvironmentPort,
  desktopEnvironmentPortDeps,
} from './desktop-environment-port';
import {
  desktopAgentActionLimits,
  desktopAgentActionReceipts,
} from './desktop-limits-port';
import {
  createDesktopSplitPort,
  startDesktopSplitAgent,
} from './desktop-split-port';
import { desktopProjectBotPort } from './desktop-project-bot-port';
import { desktopChatWatcherPort } from './desktop-watcher-port';
import { createDesktopTranscriptReadPort } from './desktop-transcript-read-port';

/**
 * The desktop agent action host: its families in surface order, the chat
 * profiles it serves, and how each environment port member reaches the
 * backend. Registered reads and chat writes use the desktop dispatcher; a new
 * chat's first message keeps the retained send service or renderer bridge.
 */
export const DESKTOP_AGENT_ACTION_HOST = defineAgentActionHost({
  id: 'desktop',
  // Editor setup and cloud chats mount only in App Advisor's navigation
  // surface, through desktop-editor-setup-port and desktop-cloud-chats-port;
  // scoped chat surfaces keep their current families.
  families: [
    'environment',
    'transcript-read',
    'projects',
    'bots',
    'experiments',
    'installed-items',
    'settings',
    'capability-package',
    'pipelines',
    'pipeline-executions',
    'browser',
    'desktop-legacy',
    'editor-setup',
    'cloud-chats',
  ],
  profiles: {
    worktree: {
      executionScope: 'worktree',
      chatCreatePlacements: ['current', 'new_worktree'],
    },
    cowork: { executionScope: 'directory', chatCreatePlacements: ['current'] },
  },
  transcriptReadPort: {
    authorizeOwner: {
      via: 'retained',
      uses: [
        'core.workspace.get',
        'core.worktree.list',
        'core.chat.list',
        'cowork-work-entries:listWorkEntryChatSummaries',
        'standalone-chat-service:resolveStandaloneChatTarget',
      ],
    },
    page: { via: 'dispatcher', uses: ['core.chat.transcript.page'] },
    content: { via: 'dispatcher', uses: ['core.chat.content.read'] },
    blocks: { via: 'dispatcher', uses: ['core.chat.transcript.blocks.page'] },
  },
  environmentPort: {
    query: {
      via: 'dispatcher',
      uses: [
        'core.workspace.get',
        'core.worktree.list',
        'core.worktree.get',
        'core.chat.list',
      ],
    },
    // Cowork Work Entries have no registered operation yet; getChat reads
    // them from the Work Entry registry and the chats through the dispatcher.
    getChat: {
      via: 'retained',
      uses: [
        'core.workspace.get',
        'core.worktree.list',
        'core.chat.list',
        'core.chat.transcript.page',
        'cowork-work-entries:listWorkEntryChatSummaries',
        'chat-service:listTerminalDrivenChatIds',
      ],
    },
    startChat: {
      via: 'retained',
      uses: [
        'chat-service:reserveWorktreeChatForSend',
        'renderer:worktree.create',
        'chat-service:isWorktreeChatMessageCommitted',
        'core.chat.message.send',
      ],
    },
    postMessage: {
      via: 'dispatcher',
      uses: [
        'core.chat.list',
        'chat-service:isWorktreeChatMessageCommitted',
        'core.chat.message.send',
      ],
    },
    listModels: {
      via: 'retained',
      uses: [
        'portal:buildProjectedModelCatalog',
        'work-owner:resolveAiCreditsScopeOwner',
      ],
    },
    callerDepth: { via: 'retained', uses: ['process-local lineage'] },
    unmessageableChatIds: {
      via: 'retained',
      uses: ['chat-service:listTerminalDrivenChatIds'],
    },
  },
});

export interface DesktopAgentActionPorts {
  /** Runs browser actions on the calling chat's in-app browser. */
  browser?: AgentBrowserPort<CanopyInjectedToolRuntime>;
  installedItems?: AgentInstalledItemsPort<CanopyInjectedToolRuntime>;
  capabilityPackage?: AgentCapabilityPackagePort<CanopyInjectedToolRuntime>;
  experiments?: AgentExperimentsPort<CanopyInjectedToolRuntime>;
  /** Opens hosted account and organization settings in the main window. */
  settings?: AgentSettingsPort<CanopyInjectedToolRuntime>;
  /** Starts pipeline runs through the main-process start path. */
  pipelines?: AgentPipelinesPort<CanopyInjectedToolRuntime>;
  /** Lists, reads and controls runs on the worktree action path. */
  pipelineExecutions?: AgentPipelineExecutionsPort<CanopyInjectedToolRuntime>;
  environment: AgentEnvironmentPort<CanopyInjectedToolRuntime>;
  transcriptRead: AgentTranscriptReadPort<CanopyInjectedToolRuntime>;
  /** Explicit-target project and bot reads through project discovery. */
  projectBot?: AgentProjectBotPort<CanopyInjectedToolRuntime>;
  limits: AgentActionLimitsPort;
  chatWatchers: AgentChatWatcherPort<CanopyInjectedToolRuntime>;
  split: AgentActionSplitPort<CanopyInjectedToolRuntime>;
  /** Shared by the environment family and the split port. */
  receipts: AgentActionReceiptStore<CanopyInjectedToolRuntime>;
}

let defaultPorts: DesktopAgentActionPorts | null = null;

/** The production ports, built once per process. */
export function desktopAgentActionPorts(): DesktopAgentActionPorts {
  if (!defaultPorts) {
    const receipts = desktopAgentActionReceipts;
    defaultPorts = {
      environment: createDesktopEnvironmentPort(desktopEnvironmentPortDeps()),
      transcriptRead: createDesktopTranscriptReadPort(),
      limits: desktopAgentActionLimits,
      chatWatchers: desktopChatWatcherPort,
      split: createDesktopSplitPort({
        startSplitAgent: startDesktopSplitAgent,
        receipts,
      }),
      receipts,
      experiments: desktopExperimentsPort,
      settings: desktopSettingsPort,
      capabilityPackage: desktopCapabilityPackagePort,
      pipelines: desktopPipelinesPort,
      pipelineExecutions: desktopPipelineExecutionsPort,
      browser: desktopBrowserPort,
    };
  }
  return defaultPorts;
}

/** The desktop families, in {@link DESKTOP_AGENT_ACTION_HOST} order. */
export function desktopAgentActionFamilies(
  capabilities: AgentActionHostCapabilities,
  ports: DesktopAgentActionPorts,
): readonly AgentActionFamily<CanopyInjectedToolRuntime>[] {
  return [
    createEnvironmentActionFamily<CanopyInjectedToolRuntime>({
      capabilities,
      port: ports.environment,
      limits: capabilities.limits ? ports.limits : null,
      watchers: capabilities.watcherTriggers.includes(
        'worktree_chat_completion',
      )
        ? ports.chatWatchers
        : null,
      receipts: ports.receipts,
    }),
    createTranscriptReadActionFamily({ port: ports.transcriptRead }),
    createProjectActionFamily(ports.projectBot ?? desktopProjectBotPort),
    createBotActionFamily(ports.projectBot ?? desktopProjectBotPort),
    createInstalledItemsActionFamily({
      port: ports.installedItems ?? desktopInstalledItemsPort,
      receipts: ports.receipts,
      limits: capabilities.limits ? ports.limits : null,
    }),
    createExperimentsActionFamily({
      port: ports.experiments ?? desktopExperimentsPort,
      receipts: ports.receipts,
      limits: capabilities.limits ? ports.limits : null,
    }),
    createSettingsActionFamily({
      port: ports.settings ?? desktopSettingsPort,
    }),
    createCapabilityPackageActionFamily({
      port: ports.capabilityPackage ?? desktopCapabilityPackagePort,
    }),
    createPipelinesActionFamily({
      port: ports.pipelines ?? desktopPipelinesPort,
      receipts: ports.receipts,
    }),
    createPipelineExecutionsActionFamily({
      port: ports.pipelineExecutions ?? desktopPipelineExecutionsPort,
    }),
    createBrowserActionFamily({
      port: ports.browser ?? desktopBrowserPort,
    }),
    desktopLegacyActionFamily,
  ];
}
