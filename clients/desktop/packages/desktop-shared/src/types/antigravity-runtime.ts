/**
 * The managed Antigravity CLI download. `installed` is true when the managed
 * copy verifies or a user copy resolves; `managed` says which one
 * `executable` is.
 */
export interface AntigravityRuntimeStatus {
  /** True only on darwin arm64 and x64, the platforms the manifest pins. */
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
  install(operationId: string): Promise<AntigravityRuntimeStatus>;
  cancel(operationId: string): Promise<void>;
  onProgress(callback: (status: AntigravityRuntimeStatus) => void): () => void;
}
