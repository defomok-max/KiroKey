/**
 * Anthropic-compatible route: POST /v1/messages
 *
 * This is what Claude Code, Anthropic SDKs, and MITM setups for Kiro/Antigravity
 * expect. Two main differences vs OpenAI:
 *
 *   - Request: { system, messages, max_tokens, tools } with content blocks
 *   - Response: SSE with events `message_start`, `content_block_start`,
 *     `content_block_delta`, `content_block_stop`, `message_delta`,
 *     `message_stop`. Non-streaming returns a single Message JSON.
 *
 * We normalize the request to OpenAI-style, dispatch through our standard
 * pipeline, and convert the OpenAI deltas back to Anthropic events.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { log } from "../logger.js";
import { dispatchChat, DispatchFailure } from "../kiro/dispatch.js";
import type { AccountManager } from "../kiro/accountManager.js";
import type {
  OpenAIChatRequest,
  OpenAIContentBlock,
  OpenAIMessage,
  OpenAITool,
} from "../kiro/request.js";
import type { OpenAIChatCompletion } from "../kiro/response.js";
import { readJson, sendError, sendJson, sendSseStream } from "../http/util.js";
import { KIRO_MODELS } from "../kiro/types.js";

interface AnthropicMessagesRequest {
  model: string;
  messages: Array<{
    role: "user" | "assistant";
    content:
      | string
      | Array<{
          type: "text" | "tool_use" | "tool_result" | "image";
          text?: string;
          id?: string;
          name?: string;
          input?: unknown;
          tool_use_id?: string;
          content?: string | Array<{ type?: string; text?: string }>;
        }>;
  }>;
  system?: string | Array<{ type: "text"; text: string }>;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema?: unknown;
  }>;
  stream?: boolean;
}

function anthropicToOpenAI(req: AnthropicMessagesRequest): OpenAIChatRequest {
  const messages: OpenAIMessage[] = [];

  if (typeof req.system === "string" && req.system.trim()) {
    messages.push({ role: "system", content: req.system });
  } else if (Array.isArray(req.system)) {
    const merged = req.system
      .filter((b) => b?.type === "text")
      .map((b) => b.text)
      .join("\n\n");
    if (merged) messages.push({ role: "system", content: merged });
  }

  for (const m of req.messages || []) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) continue;

    if (m.role === "assistant") {
      // Split into text + tool_use blocks.
      const blocks: OpenAIContentBlock[] = [];
      const toolCalls: NonNullable<OpenAIMessage["tool_calls"]> = [];
      for (const b of m.content) {
        if (b.type === "text" && b.text) {
          blocks.push({ type: "text", text: b.text });
        } else if (b.type === "tool_use") {
          toolCalls.push({
            id: b.id || "",
            type: "function",
            function: {
              name: b.name || "",
              arguments: JSON.stringify(b.input ?? {}),
            },
          });
        }
      }
      const msg: OpenAIMessage = { role: "assistant", content: blocks };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
      continue;
    }

    // user role — may contain text and tool_result blocks.
    const blocks: OpenAIContentBlock[] = [];
    for (const b of m.content) {
      if (b.type === "text" && b.text) {
        blocks.push({ type: "text", text: b.text });
      } else if (b.type === "tool_result") {
        blocks.push({
          type: "tool_result",
          content: b.content as string | Array<{ type?: string; text?: string }> | undefined,
          tool_use_id: b.tool_use_id,
        });
      }
    }
    messages.push({ role: "user", content: blocks });
  }

  const tools: OpenAITool[] | undefined = req.tools?.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema as Record<string, unknown> | undefined,
    },
  }));

  return {
    model: req.model,
    messages,
    tools,
    temperature: req.temperature,
    top_p: req.top_p,
    max_tokens: req.max_tokens,
    stream: req.stream,
  };
}

interface OpenAIDeltaChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/**
 * Convert an OpenAI SSE stream (Buffer chunks) into an Anthropic Messages
 * SSE stream. Returns a Node Readable yielding Buffers.
 */
// Strip leading/trailing <thinking>...</thinking> wrappers that the OpenAI
// converter emits for reasoningContentEvent. We re-route those chunks into a
// proper Anthropic "thinking" content block instead of inlining them as text.
const THINK_OPEN = "<thinking>";
const THINK_CLOSE = "</thinking>";

function splitThinking(text: string): { thinking: string; speech: string } {
  let thinking = "";
  let speech = "";
  let rest = text;
  while (rest.length > 0) {
    const openIdx = rest.indexOf(THINK_OPEN);
    if (openIdx === -1) {
      speech += rest;
      break;
    }
    speech += rest.slice(0, openIdx);
    rest = rest.slice(openIdx + THINK_OPEN.length);
    const closeIdx = rest.indexOf(THINK_CLOSE);
    if (closeIdx === -1) {
      // No close in this chunk — treat the rest as thinking
      thinking += rest;
      break;
    }
    thinking += rest.slice(0, closeIdx);
    rest = rest.slice(closeIdx + THINK_CLOSE.length);
  }
  return { thinking, speech };
}

function openAiSseToAnthropicSse(openaiSse: Readable, model: string, requestId: string): Readable {
  return Readable.from(
    (async function* (): AsyncIterable<Buffer> {
      let textIndex = -1;
      let thinkingIndex = -1;
      const toolIndexById = new Map<number, number>(); /* openai tool index → anthropic block index */
      let nextBlockIndex = 0;
      let messageStarted = false;
      let usage: { input_tokens: number; output_tokens: number } | null = null;
      let stopReason: "end_turn" | "tool_use" | "stop_sequence" = "end_turn";

      const enc = new TextEncoder();
      const sseEvent = (event: string, data: unknown) =>
        Buffer.from(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      const messageId = `msg_${requestId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`;

      let buffered = "";
      const decoder = new TextDecoder();

      const ensureMessageStart = function* (): IterableIterator<Buffer> {
        if (!messageStarted) {
          messageStarted = true;
          yield sseEvent("message_start", {
            type: "message_start",
            message: {
              id: messageId,
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          });
        }
      };

      const emitText = function* (text: string): IterableIterator<Buffer> {
        if (!text) return;
        if (textIndex === -1) {
          textIndex = nextBlockIndex++;
          yield sseEvent("content_block_start", {
            type: "content_block_start",
            index: textIndex,
            content_block: { type: "text", text: "" },
          });
        }
        yield sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: textIndex,
          delta: { type: "text_delta", text },
        });
      };

      const emitThinking = function* (text: string): IterableIterator<Buffer> {
        if (!text) return;
        if (thinkingIndex === -1) {
          thinkingIndex = nextBlockIndex++;
          yield sseEvent("content_block_start", {
            type: "content_block_start",
            index: thinkingIndex,
            content_block: { type: "thinking", thinking: "" },
          });
        }
        yield sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: thinkingIndex,
          delta: { type: "thinking_delta", thinking: text },
        });
      };

      for await (const raw of openaiSse) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBufferView["buffer"]);
        buffered += decoder.decode(chunk, { stream: true });

        let nlIdx: number;
        while ((nlIdx = buffered.indexOf("\n\n")) >= 0) {
          const rawEvent = buffered.slice(0, nlIdx);
          buffered = buffered.slice(nlIdx + 2);

          const lines = rawEvent.split("\n");
          const dataLine = lines.find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          const data = dataLine.slice(6);
          if (data === "[DONE]") continue;

          let parsed: OpenAIDeltaChunk;
          try {
            parsed = JSON.parse(data) as OpenAIDeltaChunk;
          } catch {
            continue;
          }
          if (!parsed.choices?.length) {
            if (parsed.usage) {
              usage = {
                input_tokens: parsed.usage.prompt_tokens,
                output_tokens: parsed.usage.completion_tokens,
              };
            }
            continue;
          }

          yield* ensureMessageStart();

          for (const choice of parsed.choices) {
            const delta = choice.delta || {};
            const content = typeof delta.content === "string" ? delta.content : "";
            if (content) {
              const { thinking, speech } = splitThinking(content);
              if (thinking) yield* emitThinking(thinking);
              if (speech) yield* emitText(speech);
            }

            for (const tc of delta.tool_calls || []) {
              let blockIdx = toolIndexById.get(tc.index);
              if (blockIdx === undefined) {
                blockIdx = nextBlockIndex++;
                toolIndexById.set(tc.index, blockIdx);
                yield sseEvent("content_block_start", {
                  type: "content_block_start",
                  index: blockIdx,
                  content_block: {
                    type: "tool_use",
                    id: tc.id || `tool_${blockIdx}`,
                    name: tc.function?.name || "",
                    input: {},
                  },
                });
                stopReason = "tool_use";
              }
              const args = tc.function?.arguments;
              if (typeof args === "string" && args.length > 0) {
                yield sseEvent("content_block_delta", {
                  type: "content_block_delta",
                  index: blockIdx,
                  delta: { type: "input_json_delta", partial_json: args },
                });
              }
            }

            if (choice.finish_reason) {
              if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
              else stopReason = "end_turn";
            }
          }

          if (parsed.usage) {
            usage = {
              input_tokens: parsed.usage.prompt_tokens,
              output_tokens: parsed.usage.completion_tokens,
            };
          }
        }
      }

      // Close any open content blocks.
      if (thinkingIndex !== -1) {
        yield sseEvent("content_block_stop", { type: "content_block_stop", index: thinkingIndex });
      }
      if (textIndex !== -1) {
        yield sseEvent("content_block_stop", { type: "content_block_stop", index: textIndex });
      }
      for (const idx of toolIndexById.values()) {
        yield sseEvent("content_block_stop", { type: "content_block_stop", index: idx });
      }

      yield sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: usage ?? { output_tokens: 0 },
      });
      yield sseEvent("message_stop", { type: "message_stop" });
    })()
  );
}

function openAiJsonToAnthropicJson(j: OpenAIChatCompletion, model: string, messageId: string) {
  const choice = j.choices?.[0];
  const content: Array<Record<string, unknown>> = [];
  const msg = choice?.message;
  if (msg?.content && typeof msg.content === "string") {
    const { thinking, speech } = splitThinking(msg.content);
    if (thinking) content.push({ type: "thinking", thinking });
    if (speech) content.push({ type: "text", text: speech });
  }
  if (msg?.tool_calls?.length) {
    for (const tc of msg.tool_calls) {
      let input: unknown = {};
      try {
        input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        input = { _raw: tc.function.arguments };
      }
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    }
  }
  return {
    id: messageId,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason:
      choice?.finish_reason === "tool_calls"
        ? "tool_use"
        : choice?.finish_reason === "length"
          ? "max_tokens"
          : "end_turn",
    stop_sequence: null,
    usage: j.usage
      ? { input_tokens: j.usage.prompt_tokens, output_tokens: j.usage.completion_tokens }
      : { input_tokens: 0, output_tokens: 0 },
  };
}

export async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  manager: AccountManager
): Promise<void> {
  let body: AnthropicMessagesRequest;
  try {
    body = (await readJson(req)) as AnthropicMessagesRequest;
  } catch (err) {
    return sendError(res, 400, "invalid_request", (err as Error).message);
  }
  if (!body || !body.model || !Array.isArray(body.messages)) {
    return sendError(res, 400, "invalid_request", "missing model/messages");
  }
  if (!KIRO_MODELS.includes(body.model as (typeof KIRO_MODELS)[number])) {
    log.debug("anthropic: unknown model id, forwarding anyway", { model: body.model });
  }

  const openaiReq = anthropicToOpenAI(body);
  const wantStream = body.stream !== false;
  openaiReq.stream = wantStream;

  const ac = new AbortController();
  req.on("close", () => ac.abort());

  try {
    const result = await dispatchChat({
      request: openaiReq,
      manager,
      signal: ac.signal,
    });

    if (wantStream && result.sse) {
      const anthropicStream = openAiSseToAnthropicSse(
        result.sse,
        openaiReq.model,
        `${Date.now()}`
      );
      await sendSseStream(res, anthropicStream);
      return;
    }
    if (result.json) {
      const out = openAiJsonToAnthropicJson(
        result.json,
        openaiReq.model,
        `msg_${Date.now()}`
      );
      sendJson(res, 200, out);
      return;
    }
    sendError(res, 502, "internal_error", "no response from dispatch");
  } catch (err) {
    if (err instanceof DispatchFailure) {
      sendError(
        res,
        err.status >= 400 && err.status < 600 ? err.status : 502,
        err.status === 429 ? "rate_limited" : "upstream_error",
        err.message,
        { attempts: err.attempts, body: err.body }
      );
      return;
    }
    log.error("anthropic: dispatch crashed", { err: (err as Error).message });
    sendError(res, 500, "internal_error", (err as Error).message);
  }
}
