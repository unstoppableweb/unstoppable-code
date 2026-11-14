import { classifyError } from '@canopy/protocol/app-errors/classification';
import { IdentifierValidationError } from '../lib/identifier-validation-error';
import { BrowserProfileError } from '@canopy/desktop-shared/browser-profile-error';
import {
  isBrowserProfileSelection,
  isProfileRecord,
} from '@canopy/protocol/browser-profiles';
import { validateProfilePatch } from '@canopy/desktop-shared/browser-profile-error';
import { createBrowserProfileCommands } from '../browser/browser-profile-commands';
import { join } from 'node:path';
import {
  BrowserWindow,
  app,
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import {
  IPC_CHANNELS,
  type BrowserAutomationRequest,
  type BrowserAutomationResponse,
  type BrowserConsoleEntry,
  type BrowserCreateRequest,
  type BrowserProfileSwitchRequest,
  type BrowserProfileSwitchResult,
  type BrowserElementSnapshot,
  type BrowserFindInPageRequest,
  type BrowserGetConsoleRequest,
  type BrowserGetNetworkRequest,
  type BrowserHandleJavaScriptDialogRequest,
  type BrowserHandleJavaScriptDialogResponse,
  type BrowserInspectRequest,
  type BrowserInputSnapshotRequest,
  type BrowserInputSnapshotResponse,
  type BrowserListTransfersRequest,
  type BrowserListTransfersResult,
  type BrowserNavigateRequest,
  type BrowserNetworkEntry,
  type BrowserJavaScriptDialog,
  type BrowserOpenLinkRequestResolution,
  type BrowserRecordingResult,
  type BrowserSaveDownloadRequest,
  type BrowserSaveDownloadResult,
  type BrowserScreenshotRequest,
  type BrowserScreenshotResponse,
  type BrowserSessionSnapshot,
  type BrowserSetActiveRequest,
  type BrowserSetBoundsRequest,
  type BrowserStopFindInPageAction,
  type BrowserStopFindInPageRequest,
  type BrowserThemeMode,
  type BrowserTransferCommand,
  type BrowserTransferCommandResult,
  type BrowserAnswerFileChooserRequest,
  type BrowserFileChooser,
  type BrowserSavePdfRequest,
  type BrowserSavePdfResult,
  type BrowserPrintRequest,
  type BrowserAnswerPrintRequestRequest,
  type BrowserAnswerPrintRequestResult,
  type BrowserAuthRequest,
  type BrowserAnswerAuthRequestRequest,
  type BrowserTransfer,
  type BrowserTransferStatus,
  type DefaultBrowserRegistrationStatus,
  type LoadWorktreeBrowserStateResponse,
  type SaveWorktreeBrowserStateRequest,
} from '@canopy/desktop-shared/types';
import { validateId } from '../lib/validation';
import { BrowserService } from '../browser/browser-service';
import { validateBrowserAutomationCommand } from '../browser/actions/automation-validation';
import { registerBrowserAutomationCancellation } from '../browser/automation-cancellation';
import { assertNotSplitLocked } from '../services/split-lock-service';
import { registerIpcHandler } from './register';
import {
  resolveAppLinkRequest,
  routeAppLink,
} from '../browser/app-link-router';
import { getDefaultBrowserRegistrationService } from '../browser/default-browser-registration';
import {
  isFileBrowserUrl,
  isSafeExternalBrowserUrl,
} from '../browser/browser-url-policy';
import { logMainProcessError } from '../lib/main-process-logging';
import { setLinkBrowserTargetAvailable } from '../lib/link-context-menu';

function validateOptionalUrl(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new Error(`Invalid ${label}: must be a string`);
  }
}

function validateTheme(value: BrowserThemeMode): void {
  if (value !== 'system' && value !== 'light' && value !== 'dark') {
    throw new Error('Invalid themeMode');
  }
}

function profileCommandId(
  request: Record<string, unknown>,
  key: string,
): string {
  try {
    validateId(request[key], key);
    return request[key];
  } catch {
    throw new BrowserProfileError(
      'invalid_request',
      `Invalid browser profile ${key}.`,
    );
  }
}

function optionalProfileCommandId(
  request: Record<string, unknown>,
  key: string,
): string | undefined {
  return request[key] === undefined
    ? undefined
    : profileCommandId(request, key);
}

function profileCommandInteger(
  request: Record<string, unknown>,
  key: string,
): number;
function profileCommandInteger(
  request: Record<string, unknown>,
  key: string,
  optional: true,
): number | undefined;
function profileCommandInteger(
  request: Record<string, unknown>,
  key: string,
  optional?: boolean,
): number | undefined {
  const value = request[key];
  if (optional && value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new BrowserProfileError(
      'invalid_request',
      `Invalid browser profile ${key}.`,
    );
  return Number(value);
}

function profileMaintenanceOperation(
  value: unknown,
): { kind: 'cache' } | { kind: 'site'; origin: string } | { kind: 'reset' } {
  if (!isProfileRecord(value))
    throw new BrowserProfileError(
      'invalid_request',
      'Invalid browser profile maintenance operation.',
    );
  if (value.kind === 'cache' || value.kind === 'reset')
    return { kind: value.kind };
  if (value.kind === 'site' && typeof value.origin === 'string')
    return { kind: 'site', origin: value.origin };
  throw new BrowserProfileError(
    'invalid_request',
    'Invalid browser profile maintenance operation.',
  );
}

async function preserveInvokingRendererFocus<T>(
  event: IpcMainInvokeEvent,
  browserService: BrowserService,
  operation: () => T | Promise<T>,
): Promise<T> {
  const sender = event.sender;
  const shouldRestoreRendererFocus = sender.isFocused();
  const userInteractionGeneration =
    browserService.getUserInteractionGeneration();
  try {
    return await operation();
  } finally {
    const hostWindow = BrowserWindow.fromWebContents(sender);
    if (
      shouldRestoreRendererFocus &&
      userInteractionGeneration ===
        browserService.getUserInteractionGeneration() &&
      !sender.isDestroyed() &&
      hostWindow !== null &&
      !hostWindow.isDestroyed() &&
      hostWindow.isFocused() &&
      !sender.isFocused()
    ) {
      sender.focus();
    }
  }
}

const BROWSER_TRANSFER_STATUSES: readonly BrowserTransferStatus[] = [
  'in_progress',
  'paused',
  'complete',
  'cancelled',
  'interrupted',
  'failed',
];
const MAX_BROWSER_TRANSFER_LIMIT = 100;
// Keyed by the shared union, so a new transfer kind can't be missed here.
const BROWSER_TRANSFER_KINDS: Record<BrowserTransfer['kind'], true> = {
  download: true,
  copy: true,
  upload: true,
};

function isBrowserTransferKind(
  value: unknown,
): value is BrowserTransfer['kind'] {
  return Object.keys(BROWSER_TRANSFER_KINDS).some((kind) => kind === value);
}

function isBrowserTransferStatus(
  value: unknown,
): value is BrowserTransferStatus {
  return BROWSER_TRANSFER_STATUSES.some((status) => status === value);
}

/**
 * Builds a fresh request so unknown renderer-supplied fields (including
 * `expectedRuntimeGeneration`) never reach the service.
 */
function parseBrowserListTransfersRequest(
  request: unknown,
): BrowserListTransfersRequest {
  if (!isProfileRecord(request)) {
    throw new Error('Invalid browser list-transfers request');
  }
  validateId(request.browserId, 'browserId');
  const parsed: BrowserListTransfersRequest = { browserId: request.browserId };
  if (request.kind !== undefined) {
    if (!isBrowserTransferKind(request.kind)) {
      throw new Error('Invalid browser transfer kind');
    }
    parsed.kind = request.kind;
  }
  if (request.status !== undefined) {
    if (!isBrowserTransferStatus(request.status)) {
      throw new Error('Invalid browser transfer status');
    }
    parsed.status = request.status;
  }
  if (request.offset !== undefined) {
    if (!Number.isSafeInteger(request.offset) || Number(request.offset) < 0) {
      throw new Error('Invalid browser transfer offset');
    }
    parsed.offset = Number(request.offset);
  }
  if (request.limit !== undefined) {
    if (
      !Number.isSafeInteger(request.limit) ||
      Number(request.limit) < 1 ||
      Number(request.limit) > MAX_BROWSER_TRANSFER_LIMIT
    ) {
      throw new Error('Invalid browser transfer limit');
    }
    parsed.limit = Number(request.limit);
  }
  return parsed;
}

/** Builds a fresh command so unknown renderer-supplied fields are dropped. */
function parseBrowserTransferCommand(command: unknown): BrowserTransferCommand {
  if (!isProfileRecord(command)) {
    throw new Error('Invalid browser transfer command');
  }
  validateId(command.browserId, 'browserId');
  switch (command.kind) {
    case 'allow_more':
      return { kind: 'allow_more', browserId: command.browserId };
    case 'cancel':
    case 'resume':
    case 'show':
    case 'save_copy':
    case 'attach':
      // Transfer ids are `randomUUID()` download/job ids: lowercase and hyphens.
      validateId(command.transferId, 'transferId');
      return {
        kind: command.kind,
        browserId: command.browserId,
        transferId: command.transferId,
      };
    default:
      throw new Error('Invalid browser transfer command');
  }
}

const MAX_SAVE_DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_SAVE_DOWNLOAD_PATH_LENGTH = 4096;

/** Builds a fresh save request so unknown renderer-supplied fields are dropped. */
function parseBrowserAnswerFileChooserRequest(
  request: unknown,
): BrowserAnswerFileChooserRequest {
  if (!isProfileRecord(request)) {
    throw new Error('Invalid browser file chooser answer');
  }
  validateId(request.browserId, 'browserId');
  validateId(request.chooserId, 'chooserId');
  if (request.answer !== 'choose' && request.answer !== 'dismiss') {
    throw new Error('Invalid browser file chooser answer');
  }
  return {
    browserId: request.browserId,
    chooserId: request.chooserId,
    answer: request.answer,
  };
}

function parseBrowserAnswerPrintRequestRequest(
  request: unknown,
): BrowserAnswerPrintRequestRequest {
  if (!isProfileRecord(request)) {
    throw new Error('Invalid browser print request answer');
  }
  validateId(request.browserId, 'browserId');
  validateId(request.printRequestId, 'printRequestId');
  const answer = request.answer;
  if (answer !== 'save_pdf' && answer !== 'print' && answer !== 'dismiss') {
    throw new Error('Invalid browser print request answer');
  }
  return {
    browserId: request.browserId,
    printRequestId: request.printRequestId,
    answer,
  };
}

/** The longest username and password a sign-in passes on. */
const MAX_AUTH_USERNAME_LENGTH = 1024;
const MAX_AUTH_PASSWORD_LENGTH = 4096;

function parseBrowserAnswerAuthRequestRequest(
  request: unknown,
): BrowserAnswerAuthRequestRequest {
  // Messages never echo the credentials.
  if (!isProfileRecord(request)) {
    throw new Error('Invalid browser sign-in answer');
  }
  validateId(request.browserId, 'browserId');
  validateId(request.authRequestId, 'authRequestId');
  const answer = request.answer;
  if (answer === 'cancel')
    return {
      browserId: request.browserId,
      authRequestId: request.authRequestId,
      answer,
    };
  const { username, password } = request;
  if (
    answer !== 'sign_in' ||
    typeof username !== 'string' ||
    typeof password !== 'string' ||
    username.length > MAX_AUTH_USERNAME_LENGTH ||
    password.length > MAX_AUTH_PASSWORD_LENGTH
  ) {
    throw new Error('Invalid browser sign-in answer');
  }
  return {
    browserId: request.browserId,
    authRequestId: request.authRequestId,
    answer,
    username,
    password,
  };
}

const MAX_SAVE_PDF_TIMEOUT_MS = 60_000;

function parseBrowserSavePdfRequest(request: unknown): BrowserSavePdfRequest {
  if (!isProfileRecord(request)) {
    throw new Error('Invalid browser save-pdf request');
  }
  validateId(request.browserId, 'browserId');
  const parsed: BrowserSavePdfRequest = { browserId: request.browserId };
  const invalid = (field: string): never => {
    throw new Error(`Invalid browser save-pdf ${field}`);
  };
  if (request.expectedRuntimeGeneration !== undefined) {
    if (
      !Number.isSafeInteger(request.expectedRuntimeGeneration) ||
      Number(request.expectedRuntimeGeneration) < 1
    )
      invalid('expectedRuntimeGeneration');
    parsed.expectedRuntimeGeneration = Number(
      request.expectedRuntimeGeneration,
    );
  }
  const fileName = request.fileName;
  if (fileName !== undefined) {
    if (
      typeof fileName !== 'string' ||
      fileName.trim() === '' ||
      fileName.length > 120
    )
      return invalid('fileName');
    parsed.fileName = fileName;
  }
  for (const field of [
    'landscape',
    'printBackground',
    'displayHeaderFooter',
  ] as const) {
    const value = request[field];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') invalid(field);
    parsed[field] = value === true;
  }
  if (request.scale !== undefined) {
    if (
      typeof request.scale !== 'number' ||
      !(request.scale >= 0.1 && request.scale <= 2)
    )
      invalid('scale');
    parsed.scale = Number(request.scale);
  }
  if (request.paperFormat !== undefined) {
    const format = request.paperFormat;
    if (
      format !== 'letter' &&
      format !== 'legal' &&
      format !== 'a4' &&
      format !== 'a3' &&
      format !== 'tabloid'
    )
      return invalid('paperFormat');
    parsed.paperFormat = format;
  }
  const pageRanges = request.pageRanges;
  if (pageRanges !== undefined) {
    if (
      typeof pageRanges !== 'string' ||
      pageRanges.trim() === '' ||
      pageRanges.length > 200
    )
      return invalid('pageRanges');
    parsed.pageRanges = pageRanges;
  }
  // The shared schema's action id: any trimmed string of 1 to 128 characters.
  const actionId = request.actionId;
  if (actionId !== undefined) {
    if (
      typeof actionId !== 'string' ||
      actionId.trim() === '' ||
      actionId.trim().length > 128
    )
      return invalid('actionId');
    parsed.actionId = actionId.trim();
  }
  if (request.timeoutMs !== undefined) {
    if (
      !Number.isSafeInteger(request.timeoutMs) ||
      Number(request.timeoutMs) < 1 ||
      Number(request.timeoutMs) > MAX_SAVE_PDF_TIMEOUT_MS
    )
      invalid('timeoutMs');
    parsed.timeoutMs = Number(request.timeoutMs);
  }
  return parsed;
}

function parseBrowserSaveDownloadRequest(
  request: unknown,
): BrowserSaveDownloadRequest {
  if (!isProfileRecord(request)) {
    throw new Error('Invalid browser save-download request');
  }
  validateId(request.browserId, 'browserId');
  validateId(request.downloadId, 'downloadId');
  if (
    typeof request.path !== 'string' ||
    request.path.trim() === '' ||
    request.path.length > MAX_SAVE_DOWNLOAD_PATH_LENGTH
  ) {
    throw new Error('Invalid browser save-download path');
  }
  const parsed: BrowserSaveDownloadRequest = {
    browserId: request.browserId,
    downloadId: request.downloadId,
    path: request.path,
  };
  if (request.overwrite !== undefined) {
    if (typeof request.overwrite !== 'boolean') {
      throw new Error('Invalid browser save-download overwrite');
    }
    parsed.overwrite = request.overwrite;
  }
  if (request.timeoutMs !== undefined) {
    if (
      !Number.isSafeInteger(request.timeoutMs) ||
      Number(request.timeoutMs) < 1 ||
      Number(request.timeoutMs) > MAX_SAVE_DOWNLOAD_TIMEOUT_MS
    ) {
      throw new Error('Invalid browser save-download timeout');
    }
    parsed.timeoutMs = Number(request.timeoutMs);
  }
  if (request.approvalChat !== undefined)
    parsed.approvalChat = parseApprovalChat(request.approvalChat);
  return parsed;
}

/** The chat a renderer names to answer an action's approval, with its ids checked. */
function parseApprovalChat(value: unknown): {
  projectId: string;
  worktreeId: string;
  chatId: string;
} {
  if (!isProfileRecord(value)) throw new Error('Invalid approval chat');
  validateId(value.projectId, 'projectId');
  validateId(value.worktreeId, 'worktreeId');
  validateId(value.chatId, 'chatId');
  return {
    projectId: value.projectId,
    worktreeId: value.worktreeId,
    chatId: value.chatId,
  };
}

/** Opens the save dialog over the window that asked, in the user's Downloads folder. */
async function chooseSavePath(
  event: IpcMainInvokeEvent,
  defaultName: string,
): Promise<string | undefined> {
  const options = {
    defaultPath: join(app.getPath('downloads'), defaultName),
  };
  const window = BrowserWindow.fromWebContents(event.sender);
  const result = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options);
  return result.canceled ? undefined : result.filePath;
}

function validateBrowserIdRequest(request: { browserId: string }): void {
  validateId(request.browserId, 'browserId');
}

const BROWSER_STOP_FIND_IN_PAGE_ACTIONS: ReadonlySet<string> =
  new Set<BrowserStopFindInPageAction>([
    'clearSelection',
    'keepSelection',
    'activateSelection',
  ]);

function isBrowserStopFindInPageAction(
  value: unknown,
): value is BrowserStopFindInPageAction {
  return (
    typeof value === 'string' && BROWSER_STOP_FIND_IN_PAGE_ACTIONS.has(value)
  );
}

function validateBrowserFindInPageRequest(
  request: BrowserFindInPageRequest,
): void {
  validateBrowserIdRequest(request);
  if (typeof request.text !== 'string') {
    throw new Error('Invalid text: must be a string');
  }
  if (request.findNext !== undefined && typeof request.findNext !== 'boolean') {
    throw new Error('Invalid findNext: must be a boolean');
  }
  if (request.forward !== undefined && typeof request.forward !== 'boolean') {
    throw new Error('Invalid forward: must be a boolean');
  }
}

function validateBrowserSetActiveRequest(
  request: unknown,
): asserts request is BrowserSetActiveRequest {
  if (
    typeof request !== 'object' ||
    request === null ||
    Array.isArray(request)
  ) {
    throw new Error('Invalid browser set-active request');
  }
  if (!('projectId' in request) || typeof request.projectId !== 'string') {
    throw new Error('Invalid projectId: must be a string');
  }
  if (!('worktreeId' in request) || typeof request.worktreeId !== 'string') {
    throw new Error('Invalid worktreeId: must be a string');
  }
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  if (
    !('browserId' in request) ||
    !Object.prototype.hasOwnProperty.call(request, 'browserId')
  ) {
    throw new Error('Invalid browserId: field is required');
  }
  if (request.browserId !== null) {
    if (typeof request.browserId !== 'string') {
      throw new Error('Invalid browserId: must be a string or null');
    }
    validateId(request.browserId, 'browserId');
  }
}

export function registerBrowserHandlers(
  getWindow: () => BrowserWindow | null,
  service?: BrowserService,
  resolveHostWindow?: (projectId: string) => BrowserWindow | null,
  onViewAttached?: (window: BrowserWindow) => void,
): BrowserService {
  const browserService =
    service ??
    new BrowserService({ getWindow, resolveHostWindow, onViewAttached });

  // Recover durable jobs and owner retirement even if no browser/profile UI is
  // opened this run. Existing recovery is asynchronous, bounded, and acquires
  // native storage only for work that actually requires it; registration and
  // shell startup do not wait. Admission still awaits the same recovery promise.
  void browserService.profileData.ensureReady().catch((error: unknown) => {
    // Match startup recovery diagnostics even before a browser UI is opened.
    logMainProcessError('[Browser] Profile startup recovery failed', error);
  });

  const registerBrowserIpc = <Args extends unknown[], Result>(
    channel: string,
    handler: (
      event: IpcMainInvokeEvent,
      ...args: Args
    ) => Result | Promise<Result>,
  ): void => {
    registerIpcHandler<Args, Result>(channel, (event, ...args) => {
      const request = args[0];
      if (!isProfileRecord(request) || typeof request.browserId !== 'string')
        return handler(event, ...args);
      const targeted = browserService.withRuntimeTarget(
        {
          browserId: request.browserId,
          expectedRuntimeGeneration:
            typeof request.expectedRuntimeGeneration === 'number'
              ? request.expectedRuntimeGeneration
              : undefined,
        },
        () => handler(event, ...args),
        {
          presentation:
            channel === IPC_CHANNELS.browserSetVisible ||
            channel === IPC_CHANNELS.browserSetBounds,
          dialog:
            channel === IPC_CHANNELS.browserGetDialog ||
            channel === IPC_CHANNELS.browserHandleDialog,
          removesView:
            channel === IPC_CHANNELS.browserDestroy ||
            channel === IPC_CHANNELS.browserDisposeLiveView,
          rehydrate: channel === IPC_CHANNELS.browserCreate,
        },
      );
      if (channel !== IPC_CHANNELS.browserSetVisible) return targeted;
      return targeted.catch((error: unknown): never => {
        if (
          error instanceof BrowserProfileError &&
          (error.code === 'stale_runtime' ||
            error.code === 'operation_conflict' ||
            error.code === 'scope_retired')
        )
          throw classifyError(error, 'external.state_changed');
        throw error;
      });
    });
  };

  const profileCommands = createBrowserProfileCommands(browserService);
  registerIpcHandler<[unknown], Promise<unknown>>(
    IPC_CHANNELS.browserProfiles,
    async (_event, input) => {
      try {
        if (
          !isProfileRecord(input) ||
          input.schemaVersion !== 1 ||
          typeof input.method !== 'string' ||
          !Object.prototype.hasOwnProperty.call(
            profileCommands,
            input.method,
          ) ||
          !isProfileRecord(input.request) ||
          Buffer.byteLength(JSON.stringify(input)) > 65_536
        )
          throw new BrowserProfileError(
            'invalid_request',
            'Invalid browser profile command.',
          );
        const request = input.request;
        let value: unknown;
        switch (input.method) {
          case 'inventoryStart':
            value = await profileCommands.inventoryStart({
              operationId: profileCommandId(request, 'operationId'),
              profileId: profileCommandId(request, 'profileId'),
              storageGeneration: profileCommandInteger(
                request,
                'storageGeneration',
              ),
            });
            break;
          case 'inventoryGet':
            value = await profileCommands.inventoryGet({
              profileId: profileCommandId(request, 'profileId'),
              storageGeneration: profileCommandInteger(
                request,
                'storageGeneration',
              ),
              ...(profileCommandInteger(request, 'offset', true) !== undefined
                ? { offset: profileCommandInteger(request, 'offset', true) }
                : {}),
            });
            break;
          case 'jobGet':
            value = await profileCommands.jobGet({
              jobId: profileCommandId(request, 'jobId'),
            });
            break;
          case 'jobList': {
            const profileId = optionalProfileCommandId(request, 'profileId');
            const offset = profileCommandInteger(request, 'offset', true);
            value = await profileCommands.jobList({
              ...(profileId ? { profileId } : {}),
              ...(offset !== undefined ? { offset } : {}),
            });
            break;
          }
          case 'jobCancel':
            value = await profileCommands.jobCancel({
              jobId: profileCommandId(request, 'jobId'),
            });
            break;
          case 'previewClear':
            value = await profileCommands.previewClear({
              profileId: profileCommandId(request, 'profileId'),
              storageGeneration: profileCommandInteger(
                request,
                'storageGeneration',
              ),
              metadataRevision: profileCommandInteger(
                request,
                'metadataRevision',
              ),
              operation: profileMaintenanceOperation(request.operation),
            });
            break;
          case 'clear':
            value = await profileCommands.clear({
              operationId: profileCommandId(request, 'operationId'),
              token: profileCommandId(request, 'token'),
            });
            break;
          case 'retryJob':
            value = await profileCommands.retryJob({
              jobId: profileCommandId(request, 'jobId'),
            });
            break;
          case 'cleanupStatus':
            value = await profileCommands.cleanupStatus();
            break;
          case 'retryCleanup':
            value = await profileCommands.retryCleanup();
            break;
          case 'list': {
            const projectId = optionalProfileCommandId(request, 'projectId');
            const worktreeId = optionalProfileCommandId(request, 'worktreeId');
            const offset = profileCommandInteger(request, 'offset', true);
            value = await profileCommands.list({
              ...(projectId ? { projectId } : {}),
              ...(worktreeId ? { worktreeId } : {}),
              ...(offset !== undefined ? { offset } : {}),
            });
            break;
          }
          case 'get':
            value = await profileCommands.get({
              profileId: profileCommandId(request, 'profileId'),
            });
            break;
          case 'create':
            validateProfilePatch(request.input);
            if (typeof request.input.displayName !== 'string')
              throw new BrowserProfileError(
                'invalid_request',
                'A browser profile name is required.',
              );
            value = await profileCommands.create({
              operationId: profileCommandId(request, 'operationId'),
              input: {
                ...request.input,
                displayName: request.input.displayName,
              },
            });
            break;
          case 'update':
            validateProfilePatch(request.patch);
            value = await profileCommands.update({
              operationId: profileCommandId(request, 'operationId'),
              profileId: profileCommandId(request, 'profileId'),
              expectedMetadataRevision: profileCommandInteger(
                request,
                'expectedMetadataRevision',
              ),
              patch: request.patch,
            });
            break;
          case 'context':
            value = await profileCommands.context({
              projectId: profileCommandId(request, 'projectId'),
              worktreeId: profileCommandId(request, 'worktreeId'),
            });
            break;
          case 'setDefault':
            if (!isBrowserProfileSelection(request.selection))
              throw new BrowserProfileError(
                'invalid_request',
                'Invalid browser profile selection.',
              );
            value = await profileCommands.setDefault({
              operationId: profileCommandId(request, 'operationId'),
              projectId: profileCommandId(request, 'projectId'),
              worktreeId: profileCommandId(request, 'worktreeId'),
              incarnationId: profileCommandId(request, 'incarnationId'),
              expectedMetadataRevision: profileCommandInteger(
                request,
                'expectedMetadataRevision',
              ),
              selection: request.selection,
            });
            break;
          case 'previewDelete':
            value = await profileCommands.previewDelete({
              profileId: profileCommandId(request, 'profileId'),
              expectedMetadataRevision: profileCommandInteger(
                request,
                'expectedMetadataRevision',
              ),
            });
            break;
          case 'delete':
            value = await profileCommands.delete({
              operationId: profileCommandId(request, 'operationId'),
              token: profileCommandId(request, 'token'),
            });
            break;
          default:
            throw new BrowserProfileError(
              'invalid_request',
              'Invalid browser profile command.',
            );
        }
        return { ok: true, value };
      } catch (error) {
        return {
          ok: false,
          error: {
            code:
              error instanceof BrowserProfileError
                ? error.code
                : 'storage_unavailable',
            message: (error instanceof Error
              ? error.message
              : 'Browser profile operation failed.'
            ).slice(0, 1000),
          },
        };
      }
    },
  );

  registerIpcHandler<
    [BrowserProfileSwitchRequest],
    Promise<BrowserProfileSwitchResult>
  >(IPC_CHANNELS.browserSwitchProfile, (event, request) =>
    preserveInvokingRendererFocus(event, browserService, () =>
      browserService.switchProfile(request),
    ),
  );

  registerBrowserIpc<[BrowserCreateRequest], Promise<BrowserSessionSnapshot>>(
    IPC_CHANNELS.browserCreate,
    (event, request) => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      assertNotSplitLocked(
        request.projectId,
        request.worktreeId,
        'opening a browser',
      );
      if (request.browserId !== undefined)
        validateId(request.browserId, 'browserId');
      validateOptionalUrl(request.url, 'url');
      if (request.themeMode !== undefined) validateTheme(request.themeMode);
      return preserveInvokingRendererFocus(event, browserService, () =>
        browserService.create(request),
      );
    },
  );

  registerBrowserIpc<[{ browserId: string }], Promise<void>>(
    IPC_CHANNELS.browserDestroy,
    (_event, request) => {
      validateId(request.browserId, 'browserId');
      return browserService.destroy(request.browserId);
    },
  );

  registerBrowserIpc<[{ browserId: string }], Promise<void>>(
    IPC_CHANNELS.browserDisposeLiveView,
    (_event, request) => {
      validateId(request.browserId, 'browserId');
      return browserService.disposeLiveView(request.browserId);
    },
  );

  registerBrowserIpc<
    [{ projectId: string; worktreeId: string }],
    Promise<LoadWorktreeBrowserStateResponse>
  >(IPC_CHANNELS.browserLoadWorktreeState, (_event, request) => {
    validateId(request.projectId, 'projectId');
    validateId(request.worktreeId, 'worktreeId');
    return browserService.loadWorktreeState(
      request.projectId,
      request.worktreeId,
    );
  });

  registerBrowserIpc<[SaveWorktreeBrowserStateRequest], Promise<void>>(
    IPC_CHANNELS.browserSaveWorktreeState,
    (_event, request) => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      return browserService.saveWorktreeState(request);
    },
  );

  registerBrowserIpc<[BrowserSetActiveRequest], Promise<void>>(
    IPC_CHANNELS.browserSetActive,
    async (_event, request) => {
      validateBrowserSetActiveRequest(request);
      if (
        request.browserId !== null &&
        !browserService
          .listWorktreeBrowsers(request.projectId, request.worktreeId)
          .some((snapshot) => snapshot.id === request.browserId)
      ) {
        throw new Error(
          `Browser ${request.browserId} does not belong to the supplied project/worktree`,
        );
      }
      await browserService.setActiveBrowser(
        request.projectId,
        request.worktreeId,
        request.browserId,
      );
    },
  );

  registerBrowserIpc<[BrowserSetBoundsRequest], void>(
    IPC_CHANNELS.browserSetBounds,
    (_event, request) => {
      validateId(request.browserId, 'browserId');
      browserService.setBounds(request);
    },
  );

  registerBrowserIpc<[{ browserId: string; visible: boolean }], Promise<void>>(
    IPC_CHANNELS.browserSetVisible,
    (event, request) => {
      if (!request || typeof request.visible !== 'boolean')
        throw classifyError(
          new Error('Expected a browser visibility request.'),
          'input.not_accepted',
        );
      try {
        validateId(request.browserId, 'browserId');
      } catch (error) {
        if (error instanceof IdentifierValidationError)
          throw classifyError(error, 'input.not_accepted');
        throw error;
      }
      return preserveInvokingRendererFocus(event, browserService, () => {
        browserService.setVisible(request.browserId, request.visible);
      });
    },
  );

  registerBrowserIpc<[BrowserNavigateRequest], Promise<BrowserSessionSnapshot>>(
    IPC_CHANNELS.browserNavigate,
    (event, request) => {
      validateId(request.browserId, 'browserId');
      validateOptionalUrl(request.url, 'url');
      return preserveInvokingRendererFocus(event, browserService, () =>
        browserService.navigate(request),
      );
    },
  );

  registerBrowserIpc<[{ browserId: string }], Promise<BrowserSessionSnapshot>>(
    IPC_CHANNELS.browserBack,
    (event, request) => {
      validateBrowserIdRequest(request);
      return preserveInvokingRendererFocus(event, browserService, () =>
        browserService.back(request.browserId),
      );
    },
  );
  registerBrowserIpc<[{ browserId: string }], Promise<BrowserSessionSnapshot>>(
    IPC_CHANNELS.browserForward,
    (event, request) => {
      validateBrowserIdRequest(request);
      return preserveInvokingRendererFocus(event, browserService, () =>
        browserService.forward(request.browserId),
      );
    },
  );
  registerBrowserIpc<[{ browserId: string }], Promise<BrowserSessionSnapshot>>(
    IPC_CHANNELS.browserReload,
    (event, request) => {
      validateBrowserIdRequest(request);
      return preserveInvokingRendererFocus(event, browserService, () =>
        browserService.reload(request.browserId),
      );
    },
  );
  registerBrowserIpc<[{ browserId: string }], Promise<BrowserSessionSnapshot>>(
    IPC_CHANNELS.browserStop,
    (event, request) => {
      validateBrowserIdRequest(request);
      return preserveInvokingRendererFocus(event, browserService, () =>
        browserService.stop(request.browserId),
      );
    },
  );

  // Find keeps keyboard focus in the invoking renderer so the find bar's
  // input stays focused while the page highlights matches (CAN-3048).
  registerBrowserIpc<[BrowserFindInPageRequest], Promise<number>>(
    IPC_CHANNELS.browserFindInPage,
    (event, request) => {
      validateBrowserFindInPageRequest(request);
      return preserveInvokingRendererFocus(event, browserService, () =>
        browserService.findInPage(request.browserId, request.text, {
          findNext: request.findNext,
          forward: request.forward,
        }),
      );
    },
  );
  registerBrowserIpc<[BrowserStopFindInPageRequest], Promise<void>>(
    IPC_CHANNELS.browserStopFindInPage,
    (event, request) => {
      validateBrowserIdRequest(request);
      if (!isBrowserStopFindInPageAction(request.action)) {
        throw new Error('Invalid action: unsupported stop-find action');
      }
      const { action } = request;
      return preserveInvokingRendererFocus(event, browserService, () =>
        browserService.stopFindInPage(request.browserId, action),
      );
    },
  );

  registerBrowserIpc<
    [{ browserId: string; themeMode: BrowserThemeMode }],
    Promise<BrowserSessionSnapshot>
  >(IPC_CHANNELS.browserSetTheme, (_event, request) => {
    validateId(request.browserId, 'browserId');
    validateTheme(request.themeMode);
    return browserService.setTheme(request.browserId, request.themeMode);
  });

  registerBrowserIpc<
    [{ browserId: string; enabled: boolean }],
    Promise<BrowserSessionSnapshot>
  >(IPC_CHANNELS.browserSetPickMode, (_event, request) => {
    validateId(request.browserId, 'browserId');
    return browserService.setPickMode(request.browserId, request.enabled);
  });

  registerBrowserIpc<[{ browserId: string }], Promise<BrowserSessionSnapshot>>(
    IPC_CHANNELS.browserStartRecording,
    (_event, request) => {
      validateBrowserIdRequest(request);
      return browserService.startRecording(request.browserId);
    },
  );
  registerBrowserIpc<[{ browserId: string }], Promise<BrowserRecordingResult>>(
    IPC_CHANNELS.browserStopRecording,
    (_event, request) => {
      validateBrowserIdRequest(request);
      return browserService.stopRecording(request.browserId);
    },
  );
  registerBrowserIpc<[{ browserId: string }], void>(
    IPC_CHANNELS.browserClearRecording,
    (_event, request) => {
      validateBrowserIdRequest(request);
      browserService.clearRecording(request.browserId);
    },
  );
  registerBrowserIpc<[{ browserId: string }], BrowserRecordingResult>(
    IPC_CHANNELS.browserGetRecording,
    (_event, request) => {
      validateBrowserIdRequest(request);
      return browserService.getRecording(request.browserId);
    },
  );

  registerBrowserIpc<[{ url: string; browserId?: string }], Promise<void>>(
    IPC_CHANNELS.browserOpenExternal,
    (_event, request) => {
      validateOptionalUrl(request.url, 'url');
      if (typeof request.url !== 'string') {
        throw new Error('Invalid url: must be a string');
      }
      // Local file pages are bound to the tab showing them; http(s) stays on
      // the always-external path and ignores `browserId`.
      if (isFileBrowserUrl(request.url)) {
        validateId(request.browserId, 'browserId');
        return browserService.openFilePageExternally(
          request.browserId,
          request.url,
        );
      }
      return browserService.openExternal(request.url);
    },
  );

  registerIpcHandler<[{ url: string }], Promise<void>>(
    IPC_CHANNELS.browserOpenLink,
    async (event, request) => {
      validateOptionalUrl(request.url, 'url');
      if (typeof request.url !== 'string') {
        throw new Error('Invalid url: must be a string');
      }
      if (!isSafeExternalBrowserUrl(request.url)) {
        throw new Error('Invalid url: must be an http or https URL');
      }
      await routeAppLink({
        url: request.url,
        sender: event.sender,
        source: 'app-link',
      });
    },
  );

  // Only the main window's renderer knows the selected worktree, so only its
  // report decides whether the link context menu offers "Open in browser".
  // One-way `on`, not `handle`: there is nothing to return, and an invoke's
  // reply flushes the chat state held back for the renderer, which made
  // navigation during concurrent chats slower.
  ipcMain.on(
    IPC_CHANNELS.browserReportLinkBrowserTarget,
    (event, request: unknown) => {
      if (
        typeof request !== 'object' ||
        request === null ||
        !('available' in request) ||
        typeof request.available !== 'boolean'
      ) {
        return;
      }
      const mainWindow = getWindow();
      if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return;
      setLinkBrowserTargetAvailable(request.available);
    },
  );

  registerIpcHandler<[BrowserOpenLinkRequestResolution], boolean>(
    IPC_CHANNELS.browserResolveOpenLinkRequest,
    (event, request) => {
      if (
        typeof request !== 'object' ||
        request === null ||
        typeof request.requestId !== 'string' ||
        request.requestId.length === 0 ||
        typeof request.handled !== 'boolean' ||
        !['acknowledge', 'reserve', 'complete'].includes(request.phase)
      ) {
        throw new Error('Invalid browser open-link response');
      }
      return resolveAppLinkRequest(event.sender, request);
    },
  );

  registerIpcHandler<[], DefaultBrowserRegistrationStatus>(
    IPC_CHANNELS.browserGetDefaultRegistrationStatus,
    () => getDefaultBrowserRegistrationService().refresh(),
  );

  registerBrowserIpc<[BrowserGetConsoleRequest], BrowserConsoleEntry[]>(
    IPC_CHANNELS.browserGetConsole,
    (_event, request) => {
      if (request.browserId !== undefined) {
        validateId(request.browserId, 'browserId');
      }
      if (request.projectId !== undefined)
        validateId(request.projectId, 'projectId');
      if (request.worktreeId !== undefined)
        validateId(request.worktreeId, 'worktreeId');
      return browserService.getConsole(request);
    },
  );
  registerBrowserIpc<[BrowserGetNetworkRequest], BrowserNetworkEntry[]>(
    IPC_CHANNELS.browserGetNetwork,
    (_event, request) => {
      if (request.browserId !== undefined) {
        validateId(request.browserId, 'browserId');
      }
      if (request.projectId !== undefined)
        validateId(request.projectId, 'projectId');
      if (request.worktreeId !== undefined)
        validateId(request.worktreeId, 'worktreeId');
      return browserService.getNetwork(request);
    },
  );
  registerBrowserIpc<
    [BrowserScreenshotRequest],
    Promise<BrowserScreenshotResponse>
  >(IPC_CHANNELS.browserScreenshot, (_event, request) => {
    validateBrowserIdRequest(request);
    if (request.purpose !== undefined && request.purpose !== 'freeze-frame') {
      throw new Error('Invalid browser screenshot purpose');
    }
    return browserService.screenshot(request);
  });
  registerBrowserIpc<[BrowserInspectRequest], Promise<BrowserElementSnapshot>>(
    IPC_CHANNELS.browserInspect,
    (_event, request) => {
      validateBrowserIdRequest(request);
      return browserService.inspect(request);
    },
  );
  registerBrowserIpc<[{ browserId: string }], BrowserJavaScriptDialog | null>(
    IPC_CHANNELS.browserGetDialog,
    (_event, request) => {
      validateBrowserIdRequest(request);
      return browserService.getDialog(request.browserId);
    },
  );
  registerBrowserIpc<
    [BrowserHandleJavaScriptDialogRequest],
    Promise<BrowserHandleJavaScriptDialogResponse>
  >(IPC_CHANNELS.browserHandleDialog, (_event, request) => {
    validateBrowserIdRequest(request);
    validateId(request.dialogId, 'dialogId');
    if (typeof request.accept !== 'boolean') {
      throw new Error('Invalid accept: must be a boolean');
    }
    if (
      request.promptText !== undefined &&
      typeof request.promptText !== 'string'
    ) {
      throw new Error('Invalid promptText: must be a string');
    }
    return browserService.handleDialog(request);
  });
  registerBrowserIpc<
    [BrowserInputSnapshotRequest],
    Promise<BrowserInputSnapshotResponse>
  >(IPC_CHANNELS.browserInputSnapshot, (_event, request) => {
    validateBrowserIdRequest(request);
    return browserService.inputSnapshot(request);
  });
  registerIpcHandler<
    [BrowserAutomationRequest],
    Promise<BrowserAutomationResponse>
  >(IPC_CHANNELS.browserAutomation, async (event, request) => {
    if (!isProfileRecord(request)) {
      return {
        ok: false,
        error: {
          code: 'invalid_payload',
          message: 'Invalid automation request.',
        },
      };
    }
    if (typeof request.browserId !== 'string')
      throw new BrowserProfileError(
        'invalid_request',
        'Automation requires an explicit browserId and its current runtime generation.',
      );
    validateId(request.browserId, 'browserId');
    if (request.projectId !== undefined)
      validateId(request.projectId, 'projectId');
    if (request.worktreeId !== undefined) {
      validateId(request.worktreeId, 'worktreeId');
    }
    const commandValidationError = validateBrowserAutomationCommand(
      request.command,
    );
    if (commandValidationError !== undefined) {
      return {
        ok: false,
        error: { code: 'invalid_payload', message: commandValidationError },
      };
    }
    if (request.cancellationKey !== undefined) {
      try {
        validateId(request.cancellationKey, 'cancellationKey');
      } catch {
        return {
          ok: false,
          error: {
            code: 'invalid_payload',
            message: 'Invalid cancellationKey.',
          },
        };
      }
    }
    let approvalChat: BrowserAutomationRequest['approvalChat'];
    if (request.approvalChat !== undefined) {
      try {
        approvalChat = parseApprovalChat(request.approvalChat);
      } catch {
        return {
          ok: false,
          error: { code: 'invalid_payload', message: 'Invalid approvalChat.' },
        };
      }
    }
    const automationRequest: BrowserAutomationRequest = {
      ...request,
      ...(approvalChat ? { approvalChat } : {}),
    };

    const controller = new AbortController();
    const unregister =
      request.cancellationKey === undefined
        ? undefined
        : registerBrowserAutomationCancellation(
            request.cancellationKey,
            controller,
          );
    try {
      const result = await preserveInvokingRendererFocus(
        event,
        browserService,
        () =>
          browserService.withRuntimeTarget(
            {
              browserId: request.browserId ?? '',
              expectedRuntimeGeneration:
                typeof request.expectedRuntimeGeneration === 'number'
                  ? request.expectedRuntimeGeneration
                  : undefined,
            },
            () =>
              browserService.automation(automationRequest, controller.signal),
          ),
      );
      if ('kind' in result)
        return {
          ok: true,
          completed: false,
          receipt: result.receipt,
          ...('repeated' in result && result.repeated === true
            ? { repeated: true }
            : {}),
          ...('dialog' in result && result.dialog
            ? { dialog: result.dialog }
            : {}),
          ...('handledDialog' in result && result.handledDialog
            ? { handledDialog: result.handledDialog }
            : {}),
        };
      return result;
    } finally {
      unregister?.();
    }
  });

  // Transfers keep the owner captured when the download started and are not
  // runtime-generation scoped, so these bypass `registerBrowserIpc`
  // (`withRuntimeTarget` would reject on a stale generation or profile switch).
  registerIpcHandler<[unknown], BrowserListTransfersResult>(
    IPC_CHANNELS.browserListTransfers,
    (_event, request) =>
      browserService.listTransfers(parseBrowserListTransfersRequest(request)),
  );
  registerIpcHandler<[unknown], Promise<BrowserTransferCommandResult>>(
    IPC_CHANNELS.browserTransferCommand,
    (event, command) =>
      browserService.transferCommand(parseBrowserTransferCommand(command), {
        revealInFolder: (path) => shell.showItemInFolder(path),
        chooseSavePath: (defaultName) => chooseSavePath(event, defaultName),
      }),
  );
  // App Advisor's `browser.save_download`: the renderer dispatcher names the
  // chat whose approval session decides the write.
  registerIpcHandler<[unknown], Promise<BrowserSaveDownloadResult>>(
    IPC_CHANNELS.browserSaveDownload,
    (_event, request) =>
      browserService.saveDownload(parseBrowserSaveDownloadRequest(request)),
  );
  // App Advisor's `browser.get_dialog` reads the pending chooser here.
  registerIpcHandler<[unknown], BrowserFileChooser | null>(
    IPC_CHANNELS.browserGetFileChooser,
    (_event, request) => {
      if (!isProfileRecord(request))
        throw new Error('Invalid browser file chooser request');
      validateId(request.browserId, 'browserId');
      return browserService.getFileChooser(request.browserId);
    },
  );
  // App Advisor's `browser.get_dialog` reads the pending print request here.
  registerIpcHandler<[unknown], BrowserPrintRequest | null>(
    IPC_CHANNELS.browserGetPrintRequest,
    (_event, request) => {
      if (!isProfileRecord(request))
        throw new Error('Invalid browser print request read');
      validateId(request.browserId, 'browserId');
      return browserService.getPrintRequest(request.browserId);
    },
  );
  // The pane banner's answers, and App Advisor's `browser.handle_dialog`
  // (which only saves a PDF or dismisses) for a pending print request.
  registerIpcHandler<[unknown], Promise<BrowserAnswerPrintRequestResult>>(
    IPC_CHANNELS.browserAnswerPrintRequest,
    (_event, request) =>
      browserService.answerPrintRequest(
        parseBrowserAnswerPrintRequestRequest(request),
      ),
  );
  // App Advisor's `browser.get_dialog` reads the pending sign-in here.
  registerIpcHandler<[unknown], BrowserAuthRequest | null>(
    IPC_CHANNELS.browserGetAuthRequest,
    (_event, request) => {
      if (!isProfileRecord(request))
        throw new Error('Invalid browser sign-in read');
      validateId(request.browserId, 'browserId');
      return browserService.getAuthRequest(request.browserId);
    },
  );
  // The credentials dialog's answer, or a cancel from the notice or from
  // App Advisor's `browser.handle_dialog` (which can only cancel).
  registerIpcHandler<[unknown], { ok: boolean }>(
    IPC_CHANNELS.browserAnswerAuthRequest,
    (_event, request) =>
      browserService.answerAuthRequest(
        parseBrowserAnswerAuthRequestRequest(request),
      ),
  );
  // App Advisor's `browser.save_pdf`.
  registerIpcHandler<[unknown], Promise<BrowserSavePdfResult>>(
    IPC_CHANNELS.browserSavePdf,
    (_event, request) => {
      const parsed = parseBrowserSavePdfRequest(request);
      return browserService.withRuntimeTarget(parsed, () =>
        browserService.savePdf(parsed),
      );
    },
  );
  // The user's own answer from the pending chooser banner; the chooser id
  // binds it to the chooser the page opened.
  registerIpcHandler<[unknown], Promise<{ ok: boolean }>>(
    IPC_CHANNELS.browserAnswerFileChooser,
    (_event, request) =>
      browserService.answerFileChooser(
        parseBrowserAnswerFileChooserRequest(request),
      ),
  );

  return browserService;
}
