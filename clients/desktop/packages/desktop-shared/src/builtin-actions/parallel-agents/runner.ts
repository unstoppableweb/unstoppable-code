import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import { withClaudeSessionStartupTimeout } from '../_lib/agent-session-startup';
import { setOutput, writeOutputFile } from '../_lib/output';
import { runWithActionEnvironment } from '../_lib/action-env';
import {
  redactNormalizedPreservingFormat,
  redactNormalizedStructuredValue,
  buildQueryOptions,
  extractFinalResult,
  parseAgentSecretValuesEnv,
  parseMaxTurns,
  parsePermissionPreset,
  parseStructuredSchema,
  readPipelineLedgerTools,
  redactNormalizedText,
  resolvePrompt,
  serializeTranscript,
} from '@canopy/execution-engine/builtin-actions/agent-prompt/logic';
import { brandEnvName, getBrandEnv } from '@canopy/execution-engine/brand/env';

interface PromptDescriptor {
  prompt?: string;
  prompt_file?: string;
  system_prompt?: string;
}

interface AgentResult {
  index: number;
  status: 'success' | 'failure';
  text_response?: string;
  json_response?: string;
  transcript_file?: string;
  text_response_file?: string;
  json_response_file?: string;
  error?: string;
}

function getOutputDir(env: NodeJS.ProcessEnv): string {
  const outputFile = getBrandEnv(env, 'OUTPUT');
  if (!outputFile) {
    throw new Error(
      `${brandEnvName('OUTPUT')} is required for parallel-agents`,
    );
  }
  return path.dirname(outputFile);
}

function parsePromptDescriptors(env: NodeJS.ProcessEnv): PromptDescriptor[] {
  const raw =
    env.INPUT_PROMPTS_FILE && env.INPUT_PROMPTS_FILE.trim().length > 0
      ? undefined
      : env.INPUT_PROMPTS;

  const source =
    env.INPUT_PROMPTS_FILE && env.INPUT_PROMPTS_FILE.trim().length > 0
      ? 'file'
      : 'inline';

  if (source === 'file') {
    throw new Error(
      'parallel-agents requires parsePromptDescriptorsFromFile() for prompts_file',
    );
  }

  if (!raw || raw.trim().length === 0) {
    throw new Error('parallel-agents requires prompts or prompts_file');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('parallel-agents prompts must be valid JSON');
  }

  if (!Array.isArray(parsed)) {
    throw new Error('parallel-agents prompts must be a JSON array');
  }

  return parsed as PromptDescriptor[];
}

async function parsePromptDescriptorsFromFile(
  env: NodeJS.ProcessEnv,
): Promise<PromptDescriptor[]> {
  const promptFile = env.INPUT_PROMPTS_FILE?.trim();
  if (!promptFile) {
    return parsePromptDescriptors(env);
  }

  const raw = await import('node:fs/promises').then((fs) =>
    fs.readFile(path.resolve(process.cwd(), promptFile), 'utf8'),
  );
  const clonedEnv = {
    ...env,
    INPUT_PROMPTS: raw,
    INPUT_PROMPTS_FILE: '',
  };
  return parsePromptDescriptors(clonedEnv);
}

async function runSinglePrompt(
  descriptor: PromptDescriptor,
  index: number,
  env: NodeJS.ProcessEnv,
): Promise<AgentResult> {
  // Each agent invokes the Claude SDK directly in this subprocess, which
  // inherits `secretEnv` alongside every other env var — it CAN read a
  // pipeline secret, and if it echoes one back (including into an SDK
  // error message, e.g. by quoting a failing prompt or tool result), every
  // one of these outputs writes straight to disk, bypassing the parent
  // process's stdout-level `SecretValueRedactor` entirely. Computed before
  // the try block so it's available to redact the failure path too.
  const secretValues = parseAgentSecretValuesEnv(
    getBrandEnv(env, 'AGENT_SECRET_VALUES'),
  );
  try {
    const schema = parseStructuredSchema(env.INPUT_STRUCTURED_OUTPUT_SCHEMA);
    const requestedMaxTurns = parseMaxTurns(env.INPUT_MAX_TURNS);
    const permissionPreset = parsePermissionPreset(env.INPUT_PERMISSION_PRESET);
    const prompt = await resolvePrompt({
      prompt: descriptor.prompt,
      promptFile: descriptor.prompt_file,
    });
    const effectiveMaxTurns = schema
      ? Math.max(requestedMaxTurns, 2)
      : requestedMaxTurns;

    const queryResult = claudeQuery({
      prompt,
      options: buildQueryOptions({
        cwd: process.cwd(),
        maxTurns: effectiveMaxTurns,
        model: env.INPUT_MODEL,
        permissionPreset,
        systemPrompt: descriptor.system_prompt,
        schema,
        // Every child speaks for the step's one agent session.
        ledgerTools: readPipelineLedgerTools(env),
      }),
    });

    const events: SDKMessage[] = [];
    for await (const event of withClaudeSessionStartupTimeout(
      queryResult,
      env,
      'parallel-agents',
    )) {
      events.push(event);
    }

    const result = extractFinalResult(events, schema !== undefined);
    // `text_response` uses `redactNormalizedText` (see its doc comment in
    // agent-prompt/logic.ts): a multi-line secret echoed verbatim only
    // exact-matches before normalizing collapses its internal newlines,
    // while a secret whose internal whitespace the agent reformatted only
    // exact-matches after normalizing reconstitutes it.
    const redactedRawText = redactNormalizedPreservingFormat(
      result.rawText,
      secretValues,
    );
    const redactedTextResponse = redactNormalizedText(
      result.rawText,
      secretValues,
    );
    const redactedStructured =
      result.structured === undefined
        ? undefined
        : redactNormalizedStructuredValue(result.structured, secretValues);
    const redactedTranscript = serializeTranscript(events, secretValues);
    const outputDir = getOutputDir(env);
    const transcriptFile = path.join(
      outputDir,
      `agent-${index}-transcript.jsonl`,
    );
    const textResponseFile = path.join(outputDir, `agent-${index}-text.txt`);
    await Promise.all([
      writeFile(transcriptFile, redactedTranscript, 'utf8'),
      writeFile(textResponseFile, redactedRawText, 'utf8'),
    ]);

    let jsonResponseFile: string | undefined;
    let jsonResponse: string | undefined;
    if (redactedStructured !== undefined) {
      jsonResponse = JSON.stringify(redactedStructured);
      jsonResponseFile = path.join(outputDir, `agent-${index}-json.json`);
      await writeFile(
        jsonResponseFile,
        `${JSON.stringify(redactedStructured, null, 2)}\n`,
        'utf8',
      );
    }

    return {
      index,
      status: 'success',
      text_response: redactedTextResponse,
      json_response: jsonResponse,
      transcript_file: transcriptFile,
      text_response_file: textResponseFile,
      json_response_file: jsonResponseFile,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      index,
      status: 'failure',
      // `redactNormalizedText`, not plain `redactValues`: a secret whose
      // internal whitespace got reformatted (or a multi-line secret echoed
      // verbatim) into this SDK failure message needs the same protection
      // as every other free-text output field (see its doc comment in
      // agent-prompt/logic.ts).
      // Formatting preserved: this lands in the durable `parallel-results.json`,
      // where a provider's multi-line error was being flattened whether a secret
      // matched or not. Same matching strength, no reformatting.
      error: redactNormalizedPreservingFormat(message, secretValues),
    };
  }
}

export async function runParallelAgentsAction(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runWithActionEnvironment(env, async () => {
    const descriptors = await parsePromptDescriptorsFromFile(env);
    const results = await Promise.all(
      descriptors.map((descriptor, index) =>
        runSinglePrompt(descriptor, index, env),
      ),
    );

    const successCount = results.filter(
      (result) => result.status === 'success',
    ).length;
    const failureCount = results.length - successCount;

    setOutput('results', JSON.stringify(results));
    setOutput('success_count', String(successCount));
    setOutput('failure_count', String(failureCount));
    writeOutputFile(
      'results_file',
      'parallel-results.json',
      `${JSON.stringify(results, null, 2)}\n`,
    );
  });
}
