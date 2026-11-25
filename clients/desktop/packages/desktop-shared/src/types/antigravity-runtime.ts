/**
 * The managed Antigravity CLI download. `installed` is true when the managed
 * copy verifies or a user copy resolves; `managed` says which one
 * `executable` is.
 */
export interface AntigravityRuntimeStatus {
  /** True only on darwin and linux, arm64 and x64: the platforms the manifest pins. */
  supported: boolean;
  installed: boolean;
  managed: boolean;
  version: string;
  executable?: string;
  phase: 'idle' | 'downloading' | 'verifying' | 'installed' | 'failed';
  error?: string;
}

export interface AntigravityRuntimeApi {
  status(): Promise<AntigravityRuntimeStatus>;
  /**
   * Whether this host has a pinned Antigravity CLI artifact: the manifest
   * alone, with no executable lookup or hashing. Pickers and Settings rows
   * use it; the setup card reads `status`.
   */
  hostSupported(): Promise<boolean>;
  install(operationId: string): Promise<AntigravityRuntimeStatus>;
  cancel(operationId: string): Promise<void>;
  onProgress(callback: (status: AntigravityRuntimeStatus) => void): () => void;
}
