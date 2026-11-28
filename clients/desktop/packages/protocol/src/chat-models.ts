/** Model identifier string (canonical model IDs, aliases, and Ollama IDs). */
export type ChatModel = string;

/**
 * ClaudeModel is a string — model IDs are defined in package.json, not in code.
 * Use desktop-shared `isClaudeModel` for runtime checks.
 */
export type ClaudeModel = string;

/**
 * CodexModel is a string — model IDs are defined in package.json, not in code.
 * Use execution-engine `isCodexModel` for runtime checks.
 */
export type CodexModel = string;

export const DEFAULT_CLAUDE_MODEL: ClaudeModel = 'opus[1m]';
export const DEFAULT_CODEX_MODEL: string = 'gpt-6.2-sol';
