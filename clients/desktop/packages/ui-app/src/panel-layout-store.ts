/**
 * Deep-import shim for the shared panel layout store.
 *
 * Desktop consumers import through `@canopy/ui-app/panel-layout-store` so the
 * store's module graph stays limited to the layout-state core instead of
 * evaluating the whole ui-app barrel (heavy chat/shell components) — which
 * matters for renderer chunking and for node-environment jest suites whose
 * import chain reaches the store.
 */
export {
  findPanelByInstanceKey,
  getAuxPanelLayoutOwnerKey,
  getPanelGridController,
  getPanelInstanceKey,
  getPanelLayoutViewModel,
  isAuxPanelLayoutKey,
  isSingletonPanelKind,
  makeAuxPanelLayoutKey,
  makeWorktreePanelKey,
  panelTabIndexForShownIndex,
  PRUNABLE_BOUND_PANEL_KINDS,
  pruneInvalidBoundPanelEntries,
  readPanelGroupRevealState,
  restrictedChatGroupId,
  sanitizeRawPlanPanelBindings,
  setPanelLeafDocumentResolver,
  setFixedSidePanelTabsClosable,
  setPanelLayoutChatGroup,
  setPanelLayoutExcludedKinds,
  setPanelLayoutScopeExcludedKinds,
  setPanelLayoutFixedTopology,
  setPanelTabCloseGuard,
  usePanelGridController,
  usePanelLayoutStore,
  usePanelLayoutViewModel,
  type AdoptLayoutTabsOptions,
  type DefaultLayoutDescriptor,
  type DefaultLayoutGroupSeed,
  type PanelGridController,
  type PanelGroupRevealState,
  type PanelGroupState,
  type PanelInstanceLocation,
  type PanelLeafDocumentResolver,
  type PanelLayoutState,
  type PanelTabCloseGuard,
  type PanelTabDescriptor,
  type SplitGroupSeed,
  type WorktreePanelLayout,
} from './code/panels/panel-layout-store';
export {
  CHAT_SIBLING_CONTENT_KINDS,
  createChatSiblingGroupToRight,
  pickContentTargetGroupId,
  pickReusableChatSiblingGroupId,
  resolveChatPanelAnchor,
  rollbackCreatedChatSiblingGroup,
  type ChatPanelAnchor,
  type CreatedChatSiblingGroup,
  type FilePanelPlacementPolicy,
} from './code/panels/sibling-panel-placement';
export {
  CHAT_VISUALS_PANEL_KIND,
  CHAT_VISUALS_PANEL_TITLE,
  openChatVisualsPanel,
  rebindChatVisualsPanel,
  type OpenChatVisualsPanelRequest,
} from './code/panels/chat-visuals-panel-open';
