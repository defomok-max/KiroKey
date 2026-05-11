/**
 * Translate the AWS CodeWhisperer EventStream into either:
 *   - Streaming: OpenAI Chat Completions SSE chunks (`data: {...}\n\n`)
 *   - Non-streaming: a single ChatCompletion JSON object
 *
 * Event types we handle:
 *   - assistantResponseEvent  { content }          → choices[0].delta.content
 *   - codeEvent               { content }          → choices[0].delta.content
 *   - reasoningContentEvent   { content }          → wrapped <thinking>...</thinking>
 *   - toolUseEvent            { toolUseId, name, input }
 *   - messageStopEvent        → finish_reason
 *   - metricsEvent            → usage (prompt_tokens etc.)
 *   - contextUsageEvent       → fallback usage estimation
 *
 * The Anthropic Messages API (POST /v1/messages) consumes the same stream
 * via `convertOpenAIStreamToAnthropic` in ./anthropicTransform.ts.
 */

import { Readable } from "node:stream";
import { ByteQueue, drainFrames, type EventFrame } from "./eventstream.js";
import { log } from "../logger.js";

const ENC = new TextEncoder();

export interface UsageSummary {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface StreamState {
  responseId: string;
  created: number;
  model: string;
  chunkIndex: number;
  hasToolCalls: boolean;
  toolCallIndex: number;
  seenToolIds: Map<string, number>;
  totalContentLength: number;
  contextUsagePercentage: number;
  usage: UsageSummary | null;
  finishEmitted: boolean;
  badFrames: number;
  /** Set when the upstream emitted an exception frame mid-stream. */
  upstreamException: { type: string; message: string } | null;
}

function newStreamState(model: string): StreamState {
  return {
    responseId: `chatcmpl-${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    created: Math.floor(Date.now() / 1000),
    model,
    chunkIndex: 0,
    hasToolCalls: false,
    toolCallIndex: 0,
    seenToolIds: new Map(),
    totalContentLength: 0,
    contextUsagePercentage: 0,
    usage: null,
    finishEmitted: false,
    badFrames: 0,
    upstreamException: null,
  };
}

function ensureUsage(state: StreamState): void {
  if (state.usage) return;
  const completion = state.totalContentLength > 0 ? Math.max(1, Math.floor(state.totalContentLength / 4)) : 0;
  const prompt =
    state.contextUsagePercentage > 0 ? Math.floor((state.contextUsagePercentage * 200_000) / 100) : 0;
  if (completion === 0 && prompt === 0) return;
  state.usage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

interface DeltaChoice {
  index: 0;
  delta: Record<string, unknown>;
  finish_reason: string | null;
}

interface OpenAIChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: DeltaChoice[];
  usage?: UsageSummary;
}

function buildChunk(state: StreamState, delta: Record<string, unknown>): OpenAIChunk {
  const chunk: OpenAIChunk = {
    id: state.responseId,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: null }],
  };
  state.chunkIndex++;
  return chunk;
}

function frameToChunks(frame: EventFrame, state: StreamState): OpenAIChunk[] {
  const type = frame.headers[":event-type"] || frame.headers["event"] || "";
  const payload = frame.payload || {};
  const out: OpenAIChunk[] = [];

  if (type === "assistantResponseEvent") {
    const content = typeof payload.content === "string" ? payload.content : "";
    if (content) {
      state.totalContentLength += content.length;
      const delta = state.chunkIndex === 0 ? { role: "assistant", content } : { content };
      out.push(buildChunk(state, delta));
    }
  } else if (type === "codeEvent") {
    const content = typeof payload.content === "string" ? payload.content : "";
    if (content) {
      state.totalContentLength += content.length;
      out.push(buildChunk(state, { content }));
    }
  } else if (type === "reasoningContentEvent") {
    const content = typeof payload.content === "string" ? payload.content : "";
    if (content) {
      const delta =
        state.chunkIndex === 0
          ? { role: "assistant", content: `<thinking>${content}</thinking>` }
          : { content: `<thinking>${content}</thinking>` };
      out.push(buildChunk(state, delta));
    }
  } else if (type === "toolUseEvent") {
    state.hasToolCalls = true;
    const tools = Array.isArray(payload) ? payload : [payload];
    for (const tu of tools) {
      const t = tu as { toolUseId?: string; name?: string; input?: unknown };
      const toolCallId = t.toolUseId || `call_${Date.now()}_${state.toolCallIndex}`;
      const toolName = t.name || "";
      let toolIndex = state.seenToolIds.get(toolCallId);
      const isNew = toolIndex === undefined;
      if (isNew) {
        toolIndex = state.toolCallIndex++;
        state.seenToolIds.set(toolCallId, toolIndex);
        const startDelta = {
          ...(state.chunkIndex === 0 ? { role: "assistant" } : {}),
          tool_calls: [
            {
              index: toolIndex,
              id: toolCallId,
              type: "function" as const,
              function: { name: toolName, arguments: "" },
            },
          ],
        };
        out.push(buildChunk(state, startDelta));
      }
      if (t.input !== undefined) {
        const argsStr =
          typeof t.input === "string"
            ? t.input
            : t.input !== null && typeof t.input === "object"
              ? JSON.stringify(t.input)
              : "";
        if (argsStr) {
          out.push(
            buildChunk(state, {
              tool_calls: [
                {
                  index: toolIndex,
                  function: { arguments: argsStr },
                },
              ],
            })
          );
        }
      }
    }
  } else if (type === "contextUsageEvent") {
    const pct = typeof payload.contextUsagePercentage === "number" ? payload.contextUsagePercentage : 0;
    if (pct > 0) state.contextUsagePercentage = pct;
  } else if (type === "metricsEvent") {
    const m = (payload.metricsEvent || payload) as Record<string, unknown>;
    if (m && typeof m === "object") {
      const inputTokens = typeof m.inputTokens === "number" ? m.inputTokens : 0;
      const outputTokens = typeof m.outputTokens === "number" ? m.outputTokens : 0;
      const cacheRead = typeof m.cacheReadTokens === "number" ? m.cacheReadTokens : 0;
      const cacheCreate = typeof m.cacheCreationTokens === "number" ? m.cacheCreationTokens : 0;
      if (inputTokens > 0 || outputTokens > 0) {
        state.usage = {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
          ...(cacheRead > 0 && { cache_read_input_tokens: cacheRead }),
          ...(cacheCreate > 0 && { cache_creation_input_tokens: cacheCreate }),
        };
      }
    }
  } else if (type === "messageStopEvent") {
    // emit finish chunk on flush
  } else if (
    type === "exception" ||
    type === "InternalServerException" ||
    type === "ThrottlingException" ||
    type === "ValidationException" ||
    type === "AccessDeniedException" ||
    frame.headers[":message-type"] === "exception"
  ) {
    const errorType = type || frame.headers[":exception-type"] || "upstream_exception";
    const rawMessage =
      (typeof payload.message === "string" && payload.message) ||
      (typeof payload.Message === "string" && payload.Message) ||
      (typeof payload.errorMessage === "string" && payload.errorMessage) ||
      "";
    state.upstreamException = {
      type: errorType,
      message: rawMessage || `Kiro upstream emitted ${errorType}`,
    };
    log.warn("kiro: exception event from upstream", {
      type: errorType,
      message: state.upstreamException.message,
      headers: frame.headers,
      payload: frame.payload ?? null,
    });
  }

  return out;
}

function buildFinishChunk(state: StreamState, includeUsage: boolean): OpenAIChunk {
  const finishReason = state.upstreamException
    ? "error"
    : state.hasToolCalls
      ? "tool_calls"
      : "stop";
  const chunk: OpenAIChunk = {
    id: state.responseId,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason,
      },
    ],
  };
  if (includeUsage && state.usage) chunk.usage = state.usage;
  return chunk;
}

/** Build a synthetic delta chunk that carries an upstream error to the client. */
function buildErrorChunk(state: StreamState): OpenAIChunk {
  const errMsg = state.upstreamException?.message || "upstream error";
  return {
    id: state.responseId,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [
      {
        index: 0,
        delta: { content: `\n[kiro-router: upstream error — ${errMsg}]` },
        finish_reason: null,
      },
    ],
  };
}

/**
 * Convert a Kiro EventStream body into an OpenAI SSE stream (Node Readable).
 * `model` is the model name to attach to chunks.
 */
export function streamKiroAsOpenAISSE(body: Readable, model: string): Readable {
  return Readable.from(iterateKiroAsOpenAISSE(body, model));
}

export async function* iterateKiroAsOpenAISSE(
  body: Readable,
  model: string
): AsyncIterable<Buffer> {
  const state = newStreamState(model);
  const queue = new ByteQueue();
  let errorChunkEmitted = false;
  let transportError: Error | null = null;
  try {
    for await (const raw of body) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBufferView["buffer"]);
      queue.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      const frames = drainFrames(queue, () => {
        state.badFrames++;
      });
      for (const frame of frames) {
        const chunks = frameToChunks(frame, state);
        for (const ch of chunks) {
          yield Buffer.from(ENC.encode(`data: ${JSON.stringify(ch)}\n\n`));
        }
        if (state.upstreamException && !errorChunkEmitted) {
          // Surface the upstream error as an inline chunk so the client UI
          // shows what went wrong instead of an empty completion.
          errorChunkEmitted = true;
          yield Buffer.from(
            ENC.encode(`data: ${JSON.stringify(buildErrorChunk(state))}\n\n`)
          );
        }
      }
    }
  } catch (err) {
    transportError = err as Error;
    if (!state.upstreamException) {
      state.upstreamException = {
        type: "transport_error",
        message: transportError.message || "upstream stream aborted",
      };
    }
    log.error("kiro: stream error", { err: transportError.message });
    if (!errorChunkEmitted) {
      errorChunkEmitted = true;
      yield Buffer.from(
        ENC.encode(`data: ${JSON.stringify(buildErrorChunk(state))}\n\n`)
      );
    }
  } finally {
    ensureUsage(state);
    if (!state.finishEmitted) {
      state.finishEmitted = true;
      try {
        yield Buffer.from(
          ENC.encode(`data: ${JSON.stringify(buildFinishChunk(state, true))}\n\n`)
        );
        yield Buffer.from(ENC.encode("data: [DONE]\n\n"));
      } catch {
        /* downstream already closed */
      }
    }
    if (state.badFrames > 0) {
      log.warn("kiro: stream had bad frames", { count: state.badFrames });
    }
  }
}

export interface OpenAIChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: UsageSummary;
}

/**
 * Non-streaming variant: collect the whole stream, return an OpenAI
 * ChatCompletion JSON object.
 */
export async function collectKiroAsOpenAIJson(
  body: Readable,
  model: string
): Promise<OpenAIChatCompletion> {
  const state = newStreamState(model);
  const queue = new ByteQueue();

  let content = "";
  const toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];
  const toolCallById = new Map<string, number>();

  try {
    for await (const raw of body) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBufferView["buffer"]);
      queue.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      const frames = drainFrames(queue, () => {
        state.badFrames++;
      });
      for (const frame of frames) {
        const type = frame.headers[":event-type"] || "";
        const payload = frame.payload || {};
        if (type === "assistantResponseEvent" || type === "codeEvent") {
          const c = typeof payload.content === "string" ? payload.content : "";
          if (c) {
            content += c;
            state.totalContentLength += c.length;
          }
        } else if (type === "toolUseEvent") {
          state.hasToolCalls = true;
          const tools = Array.isArray(payload) ? payload : [payload];
          for (const tu of tools) {
            const t = tu as { toolUseId?: string; name?: string; input?: unknown };
            const id = t.toolUseId || `call_${Date.now()}_${toolCalls.length}`;
            let idx = toolCallById.get(id);
            if (idx === undefined) {
              idx = toolCalls.length;
              toolCallById.set(id, idx);
              toolCalls.push({
                id,
                type: "function",
                function: { name: t.name || "", arguments: "" },
              });
            }
            if (t.input !== undefined) {
              const argsStr =
                typeof t.input === "string"
                  ? t.input
                  : t.input !== null && typeof t.input === "object"
                    ? JSON.stringify(t.input)
                    : "";
              toolCalls[idx].function.arguments += argsStr;
            }
          }
        } else if (type === "contextUsageEvent") {
          const pct =
            typeof payload.contextUsagePercentage === "number" ? payload.contextUsagePercentage : 0;
          if (pct > 0) state.contextUsagePercentage = pct;
        } else if (type === "metricsEvent") {
          const m = (payload.metricsEvent || payload) as Record<string, unknown>;
          const inputTokens = typeof m.inputTokens === "number" ? m.inputTokens : 0;
          const outputTokens = typeof m.outputTokens === "number" ? m.outputTokens : 0;
          if (inputTokens > 0 || outputTokens > 0) {
            state.usage = {
              prompt_tokens: inputTokens,
              completion_tokens: outputTokens,
              total_tokens: inputTokens + outputTokens,
            };
          }
        } else if (
          type === "exception" ||
          type === "InternalServerException" ||
          type === "ThrottlingException" ||
          type === "ValidationException" ||
          type === "AccessDeniedException" ||
          frame.headers[":message-type"] === "exception"
        ) {
          const errorType = type || frame.headers[":exception-type"] || "upstream_exception";
          const rawMessage =
            (typeof payload.message === "string" && payload.message) ||
            (typeof payload.Message === "string" && payload.Message) ||
            "";
          state.upstreamException = {
            type: errorType,
            message: rawMessage || `Kiro upstream emitted ${errorType}`,
          };
          log.warn("kiro: exception event from upstream (non-stream)", {
            type: errorType,
            message: state.upstreamException.message,
            payload: frame.payload ?? null,
          });
        }
      }
    }
  } catch (err) {
    const e = err as Error;
    if (!state.upstreamException) {
      state.upstreamException = {
        type: "transport_error",
        message: e.message || "upstream stream aborted",
      };
    }
    log.error("kiro: non-stream collection error", { err: e.message });
  }
  ensureUsage(state);

  const finishReason = state.upstreamException
    ? "error"
    : state.hasToolCalls
      ? "tool_calls"
      : "stop";
  const finalContent = state.upstreamException
    ? `${content}${content ? "\n\n" : ""}[kiro-router: upstream error — ${state.upstreamException.message}]`
    : content;

  return {
    id: state.responseId,
    object: "chat.completion",
    created: state.created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: finalContent || null,
          ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
        },
        finish_reason: finishReason,
      },
    ],
    ...(state.usage && { usage: state.usage }),
  };
}
