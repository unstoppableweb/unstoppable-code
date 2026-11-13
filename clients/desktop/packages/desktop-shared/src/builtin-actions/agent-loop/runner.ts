import { spawn } from 'node:child_process';
import { withoutAgentSecretValues } from '@canopy/execution-engine/lib/agent-secret-values-env';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import { withClaudeSessionStartupTimeout } from '../_lib/agent-session-startup';
import {
  buildPipelinePromptRecord,
  buildPipelineSystemPromptRecord,
  createTranscriptCapture,
} from '../_lib/agent-transcript';
import { runWithActionEnvironment } from '../_lib/action-env';
import { setOutput, writeOutputFile } from '../_lib/output';
import { getBrandEnv } from '@canopy/execution-engine/brand/env';
import {
  redactNormalizedPreservingFormat,
  buildQueryOptions,
  extractFinalResult,
  normalizeSingleLine,
  parseAgentSecretValuesEnv,
  parseMaxTurns,
  parsePermissionPreset,
  parseStructuredSchema,
  readPipelineLedgerTools,
  redactNormalizedText,
  resolvePrompt,
} from '@canopy/execution-engine/builtin-actions/agent-prompt/logic';

type ContextStrategy = 'transcript' | 'summary';
type ExitReason = 'check_passed' | 'max_iterations' | 'failure';

interface CheckResult {
  passed: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface IterationRecord {
  iteration: number;
  prompt: string;
  events: unknown[];
  rawText: string;
  check: CheckResult;
}

function parseMaxIterations(raw: string | undefined): number {
  if (!raw || raw.trim().length === 0) {
    return 3;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('max_iterations must be a positive integer');
  }

  return parsed;
}

function parseContextStrategy(raw: string | undefined): ContextStrategy {
  if (!raw || raw.trim().length === 0) {
    return 'summary';
  }

  const trimmed = raw.trim();
  if (trimmed === 'transcript' || trimmed === 'summary') {
    return trimmed;
  }

  throw new Error('context_strategy must be one of: transcript, summary');
}

function buildSummaryContext(history: IterationRecord[]): string {
  if (history.length === 0) {
    return '';
  }

  return history
    .map((record) =>
      [
        `Iteration ${record.iteration}:`,
        `Agent response: ${normalizeSingleLine(record.rawText)}`,
        `Check exit code: ${String(record.check.exitCode ?? 1)}`,
        record.check.stdout.trim()
          ? `Check stdout: ${normalizeSingleLine(record.check.stdout)}`
          : undefined,
        record.check.stderr.trim()
          ? `Check stderr: ${normalizeSingleLine(record.check.stderr)}`
          : undefined,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
}

function buildTranscriptContext(history: IterationRecord[]): string {
  if (history.length === 0) {
    return '';
  }

  return history
    .map((record) =>
      [
        `Iteration ${record.iteration} prompt:`,
        record.prompt,
        '',
        `Iteration ${record.iteration} response:`,
        record.rawText,
        '',
        `Iteration ${record.iteration} check stdout:`,
        record.check.stdout || '(empty)',
        '',
        `Iteration ${record.iteration} check stderr:`,
        record.check.stderr || '(empty)',
      ].join('\n'),
    )
    .join('\n\n');
}

function buildLoopPrompt(
  basePrompt: string,
  history: IterationRecord[],
  contextStrategy: ContextStrategy,
): string {
  if (history.length === 0) {
    return basePrompt;
  }

  const context =
    contextStrategy === 'transcript'
      ? buildTranscriptContext(history)
      : buildSummaryContext(history);

  return [
    basePrompt,
    '',
    'Previous iterations and check feedback:',
    context,
    '',
    'Use this feedback to fix the remaining issue before finishing this iteration.',
  ].join('\n');
}

async function runCheckCommand(command: string): Promise<CheckResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: process.cwd(),
      // Everything but the aggregate of configured values, which is for this
      // action's own masking (`withoutAgentSecretValues`).
      env: withoutAgentSecretValues(process.env),
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: process.platform === 'win32',
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      resolve({
        passed: code === 0,
        stdout,
        stderr,
        exitCode: code,
      });
    });
  });
}

function writeLoopOutputs(
  history: IterationRecord[],
  exitReason: ExitReason,
  transcript: string,
  env: NodeJS.ProcessEnv,
): void {
  const last = history[history.length - 1];
  if (!last) {
    throw new Error('agent-loop did not record any iterations');
  }

  // `agent-loop` invokes the Claude SDK directly in this subprocess, which
  // inherits `secretEnv` alongside every other env var — the agent CAN read
  // a pipeline secret, and if it echoes one back, these outputs write
  // straight to disk (`setOutput`/`writeOutputFile`), bypassing the parent
  // process's stdout-level `SecretValueRedactor` entirely. `text_response`
  // uses `redactNormalizedText`: a multi-line secret echoed verbatim only
  // exact-matches before normalizing collapses its internal newlines, while
  // a secret whose internal whitespace the agent reformatted only
  // exact-matches after normalizing reconstitutes it — closed in one pass
  // rather than two sequential redact passes, which can leak when two
  // configured values share a whitespace-differing prefix/suffix (see its
  // doc comment).
  const secretValues = parseAgentSecretValuesEnv(
    getBrandEnv(env, 'AGENT_SECRET_VALUES'),
  );
  const redactedRawText = redactNormalizedPreservingFormat(
    last.rawText,
    secretValues,
  );
  const redactedTextResponse = redactNormalizedText(last.rawText, secretValues);

  setOutput('iterations_run', String(history.length));
  setOutput('exit_reason', exitReason);
  setOutput('text_response', redactedTextResponse);
  writeOutputFile(
    'text_response_file',
    'agent-loop-final.txt',
    redactedRawText,
  );
  // `transcript` is already structurally redacted record-by-record via
  // `createTranscriptCapture` — a further raw substring pass here would
  // risk corrupting valid JSON via a coincidental match against the
  // transcript's own structure (see `redactSerializedJsonLine`'s doc
  // comment in `lib/redaction.ts`).
  writeOutputFile('transcript_file', 'agent-loop-transcript.jsonl', transcript);
}

export async function runAgentLoopAction(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runWithActionEnvironment(env, async (): Promise<void> => {
    let wroteTerminalOutputs = false;

    try {
      const basePrompt = await resolvePrompt({
        prompt: env.INPUT_PROMPT,
        promptFile: env.INPUT_PROMPT_FILE,
      });
      const checkCommand = env.INPUT_CHECK_COMMAND?.trim();
      if (!checkCommand) {
        throw new Error('agent-loop requires check_command');
      }

      const maxIterations = parseMaxIterations(env.INPUT_MAX_ITERATIONS);
      const contextStrategy = parseContextStrategy(env.INPUT_CONTEXT_STRATEGY);
      const requestedMaxTurns = parseMaxTurns(env.INPUT_MAX_TURNS);
      const permissionPreset = parsePermissionPreset(
        env.INPUT_PERMISSION_PRESET,
      );
      const schema = parseStructuredSchema(env.INPUT_STRUCTURED_OUTPUT_SCHEMA);
      const effectiveMaxTurns = schema
        ? Math.max(requestedMaxTurns, 2)
        : requestedMaxTurns;

      const secretValues = parseAgentSecretValuesEnv(
        getBrandEnv(env, 'AGENT_SECRET_VALUES'),
      );
      const history: IterationRecord[] = [];
      const transcript = createTranscriptCapture(secretValues);
      const systemPromptRecord = buildPipelineSystemPromptRecord(
        'claude',
        env.INPUT_SYSTEM_PROMPT,
      );

      for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
        const prompt = buildLoopPrompt(basePrompt, history, contextStrategy);
        // The `summary` context strategy embeds a `normalizeSingleLine`d copy
        // of a prior iteration's raw output into this prompt, which can
        // collapse a multi-line configured secret's internal newlines before
        // `emitRecord`'s own (unnormalized) redaction pass ever sees it — the
        // same hazard the normalized helpers close for output fields. The
        // ACTUAL `prompt` sent to the model below stays unredacted (the
        // agent legitimately needs its own real prior context to act on);
        // only this persisted transcript copy is redacted.
        //
        // `redactNormalizedText` returns the NORMALIZED projection, so it
        // rewrote this record even with an empty value list: multiline
        // indentation and blank lines collapsed and the recorded "submitted
        // prompt" stopped matching what was submitted. The preserving variant
        // matches the same normalized projection but splices at the ORIGINAL
        // offsets, so an unmatched prompt is recorded byte-for-byte.
        transcript.emitRecord(
          buildPipelinePromptRecord({
            provider: 'claude',
            originalText: redactNormalizedPreservingFormat(
              prompt,
              secretValues,
            ),
          }),
        );
        if (iteration === 1 && systemPromptRecord) {
          transcript.emitRecord(systemPromptRecord);
        }
        const queryResult = claudeQuery({
          prompt,
          options: buildQueryOptions({
            cwd: process.cwd(),
            maxTurns: effectiveMaxTurns,
            model: env.INPUT_MODEL,
            permissionPreset,
            systemPrompt: env.INPUT_SYSTEM_PROMPT,
            schema,
            ledgerTools: readPipelineLedgerTools(env),
          }),
        });

        const events: unknown[] = [];
        for await (const sdkEvent of withClaudeSessionStartupTimeout(
          queryResult,
          env,
          'agent-loop',
        )) {
          const event: unknown = sdkEvent;
          transcript.emitRecord({
            type: 'agent_loop_event',
            iteration,
            event,
          });
          events.push(event);
        }

        const result = extractFinalResult(events, schema !== undefined);
        const check = await runCheckCommand(checkCommand);
        transcript.emitRecord({
          type: 'agent_loop_iteration',
          iteration,
          check,
        });
        history.push({
          iteration,
          prompt,
          events,
          rawText: result.rawText,
          check,
        });

        if (check.passed) {
          writeLoopOutputs(
            history,
            'check_passed',
            transcript.serialize(),
            env,
          );
          wroteTerminalOutputs = true;
          return;
        }
      }

      writeLoopOutputs(history, 'max_iterations', transcript.serialize(), env);
      wroteTerminalOutputs = true;
      throw new Error(
        `agent-loop exhausted max_iterations (${String(maxIterations)}) without passing check_command`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!wroteTerminalOutputs) {
        try {
          setOutput('exit_reason', 'failure');
        } catch {
          // Ignore output write failures when the action is already failing.
        }
      }
      throw new Error(message);
    }
  });
}
