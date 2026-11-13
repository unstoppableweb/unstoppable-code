// Pure display chat primitives shared between the desktop renderer and the
// web portal. All components in this barrel are display-only and free of
// stores, IPC, Electron, Node, or Next dependencies. Hosts wrap them with
// the runtime state they need (copy buttons, revert handlers, store subs).
export * from './tool-display-info';
export * from './exit-plan-mode-plan';
export * from './tool-display';
export * from './step-words';
export * from './ChatAppNote';
export * from './StepRow';
export * from './ChatCopyAction';
export * from './PlanCopyAction';
export * from './TurnMoreMenu';
export * from './ToolCallCard';
export * from './tool-approval-wait';
export * from './live-tool-activity';
export * from './AutoResumeMarker';
export * from './tool-denial';
export * from './CollapsibleBlock';
export * from './CollapsedTurnSummary';
export * from './TurnOutcomeTooltip';
export * from './turn-outcome-label';
export * from './turn-completion-status';
export * from './tool-outcome-summary';
export * from './AgentBlockCard';
export * from './TurnGroup';
export * from './QueuedMessageActions';
export * from './QueuedMessageReason';
export * from './StatusAnnouncer';
export * from './QueuedMessageBubble';
export * from './QueuedMessageSettingsHeldWarning';
export * from './FirstSendFailedNotice';
export * from './TurnResumeNotice';
export * from './MessageEditEntry';
export * from './MessageEditCard';
export * from './AskUserQuestionCard';
export * from './ToolApprovalCard';
export * from './ToolApprovalDock';
export * from './ApprovalContentModal';
export * from './approval-content-preview';
export * from './ask-user-question-presentation';
export * from './ask-user-question-answers';
export {
  AgentVisualFrame,
  type AgentVisualFrameProps,
  type AgentVisualFrameStatus,
  type AgentVisualFrameTestIds,
  useAgentVisualHostTheme,
} from './AgentVisualFrame';

export { DeferredTextOutput } from './DeferredTextOutput';
export { TranscriptPagingControls } from './TranscriptPagingControls';
export * from './FileDeliverableCard';
export * from './FileAttachmentChip';
export * from './TurnFileChipView';
export * from './TurnFilesSummaryView';
export * from './turn-files-heading';
export * from './MessageImageAttachments';
export { DelegatedAgentCard } from './DelegatedAgentCard';
export * from './TaskStopButton';
export {
  DelegatedAgentCapabilities,
  type DelegatedAgentCapabilitiesProps,
} from './DelegatedAgentCapabilities';
export * from './delegated-agent-copy';
export * from './CompactionInfoBlock';
export * from './AccountProxySwitchLine';
export * from './DeferredAccountProxySwitchPart';
export * from './ClaudeModsSkippedNotice';
export * from './SteeringTitle';
export * from './SteeringRequestTitle';
export { normalizeCommandReadToolBlock } from '@canopy/agent-transcript/lib/command-read-display';
export * from './subagents';

export { QuestionOptionText } from './QuestionOptionText';
export * from './TurnWorkHeader';
export * from './QueuedMessageRow';
export * from './clean-step-runs';
export * from './approval-file-change-rows';
export * from './ApprovalFileChangePreview';

export * from './turn-file-styles';
