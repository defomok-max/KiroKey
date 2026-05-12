/**
 * Build a Kiro CodeWhisperer payload from an OpenAI Chat Completions request.
 *
 * The CodeWhisperer streaming API is strict:
 *   - top-level: conversationState, profileArn?, inferenceConfig?
 *   - conversationState.history must alternate user/assistant turns
 *   - conversationState.currentMessage MUST be a user turn
 *   - tools live in currentMessage.userInputMessageContext.tools (Bedrock format)
 *
 * Anthropic Messages requests can be normalized to OpenAI Chat first by the
 * /v1/messages route, so this single transform serves both APIs.
 */

import { v4 as uuidv4, v5 as uuidv5 } from "../util/uuid.js";

const KIRO_NAMESPACE = "34f7193f-561d-4050-bc84-9547d953d6bf";

export interface OpenAITool {
  type?: "function";
  function?: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
  name?: string;
  description?: string;
  parameters?: unknown;
  input_schema?: unknown;
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | OpenAIContentBlock[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIContentBlock {
  type: string;
  text?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  tool_use_id?: string;
}

export interface OpenAIToolCall {
  id?: string;
  type?: "function";
  function?: { name: string; arguments?: string };
  name?: string;
  input?: unknown;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
}

export interface BuildOptions {
  model: string;
  profileArn?: string | null;
}

interface KiroToolSpec {
  toolSpecification: {
    name: string;
    description: string;
    inputSchema: { json: { type: "object"; properties: Record<string, unknown>; required: string[] } };
  };
}

interface KiroToolUse {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}

interface KiroToolResult {
  toolUseId: string;
  status: "success";
  content: Array<{ text: string }>;
}

interface KiroUserContext {
  tools?: KiroToolSpec[];
  toolResults?: KiroToolResult[];
}

interface KiroUserMsg {
  userInputMessage: {
    content: string;
    modelId: string;
    origin?: string;
    userInputMessageContext?: KiroUserContext;
  };
}

interface KiroAssistantMsg {
  assistantResponseMessage: {
    content: string;
    toolUses?: KiroToolUse[];
  };
}

type KiroHistoryEntry = KiroUserMsg | KiroAssistantMsg;

export interface KiroPayload {
  conversationState: {
    chatTriggerType: "MANUAL";
    conversationId: string;
    currentMessage: KiroUserMsg;
    history: KiroHistoryEntry[];
  };
  profileArn?: string;
  inferenceConfig?: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
  };
}

function asUserMsg(entry: KiroHistoryEntry): KiroUserMsg | null {
  return "userInputMessage" in entry ? entry : null;
}

function asAssistantMsg(entry: KiroHistoryEntry): KiroAssistantMsg | null {
  return "assistantResponseMessage" in entry ? entry : null;
}

function parseToolInput(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function normalizeSchema(schema: unknown): {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
} {
  const empty = { type: "object" as const, properties: {}, required: [] };
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return empty;
  const s = schema as Record<string, unknown>;
  return {
    type: "object",
    properties:
      s.properties && typeof s.properties === "object" && !Array.isArray(s.properties)
        ? (s.properties as Record<string, unknown>)
        : {},
    required: Array.isArray(s.required) ? (s.required as string[]) : [],
  };
}

function buildKiroTools(tools: OpenAITool[] | undefined): KiroToolSpec[] {
  if (!tools || tools.length === 0) return [];
  return tools.map((t) => {
    const name = t.function?.name || t.name || "tool";
    const rawDesc = t.function?.description ?? t.description ?? "";
    const description = rawDesc.trim() || `Tool: ${name}`;
    const params = t.function?.parameters ?? t.parameters ?? t.input_schema ?? {};
    return {
      toolSpecification: {
        name,
        description,
        inputSchema: { json: normalizeSchema(params) },
      },
    };
  });
}

function extractText(content: OpenAIMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c?.type === "text" || c?.text)
    .map((c) => c.text || "")
    .join("\n");
}

function extractToolResults(content: OpenAIMessage["content"]): KiroToolResult[] {
  if (!Array.isArray(content)) return [];
  const out: KiroToolResult[] = [];
  for (const block of content) {
    if (!block || block.type !== "tool_result") continue;
    let text = "";
    if (typeof block.content === "string") {
      text = block.content;
    } else if (Array.isArray(block.content)) {
      text = block.content.map((c) => c.text || "").join("\n");
    }
    out.push({
      toolUseId: block.tool_use_id || "",
      status: "success",
      content: [{ text }],
    });
  }
  return out;
}

/**
 * Convert OpenAI-style messages into Kiro history + a final user-turn
 * `currentMessage`. System and tool roles are normalized into user turns.
 * Consecutive same-role entries are merged so the resulting history
 * strictly alternates user/assistant.
 */
function convertMessages(
  messages: OpenAIMessage[],
  tools: OpenAITool[] | undefined,
  model: string
): { history: KiroHistoryEntry[]; currentMessage: KiroUserMsg | null } {
  const history: KiroHistoryEntry[] = [];
  const kiroTools = buildKiroTools(tools);

  let pendingUserText: string[] = [];
  let pendingUserToolResults: KiroToolResult[] = [];
  let pendingAssistantText: string[] = [];
  let currentRole: "user" | "assistant" | null = null;

  const flushPending = () => {
    if (currentRole === "user") {
      const content = pendingUserText.join("\n\n").trim() || "continue";
      const msg: KiroUserMsg = {
        userInputMessage: { content, modelId: model },
      };
      if (pendingUserToolResults.length) {
        msg.userInputMessage.userInputMessageContext = {
          toolResults: pendingUserToolResults,
        };
      }
      // Attach tools to the FIRST user turn (Bedrock convention).
      if (kiroTools.length > 0 && history.length === 0) {
        msg.userInputMessage.userInputMessageContext = {
          ...(msg.userInputMessage.userInputMessageContext || {}),
          tools: kiroTools,
        };
      }
      history.push(msg);
      pendingUserText = [];
      pendingUserToolResults = [];
    } else if (currentRole === "assistant") {
      const content = pendingAssistantText.join("\n\n").trim() || "...";
      history.push({ assistantResponseMessage: { content } });
      pendingAssistantText = [];
    }
  };

  for (const msg of messages) {
    let role: "user" | "assistant" =
      msg.role === "assistant" ? "assistant" : "user"; /* system & tool → user */
    if (currentRole !== null && role !== currentRole) {
      flushPending();
    }
    currentRole = role;

    if (msg.role === "tool") {
      const toolContent = typeof msg.content === "string" ? msg.content : extractText(msg.content);
      pendingUserToolResults.push({
        toolUseId: msg.tool_call_id || "",
        status: "success",
        content: [{ text: toolContent }],
      });
      continue;
    }

    if (role === "user") {
      const text = extractText(msg.content);
      const toolResults = extractToolResults(msg.content);
      if (text) pendingUserText.push(text);
      if (toolResults.length) pendingUserToolResults.push(...toolResults);
      continue;
    }

    // assistant
    const text = extractText(msg.content);
    if (text) pendingAssistantText.push(text);

    let toolUses: OpenAIToolCall[] = [];
    if (Array.isArray(msg.content)) {
      const blocks = msg.content.filter((c) => c?.type === "tool_use") as Array<
        OpenAIContentBlock & { id?: string; name?: string; input?: unknown }
      >;
      toolUses = blocks.map((b) => ({
        id: b.id,
        name: b.name,
        input: b.input,
      }));
    }
    if (msg.tool_calls?.length) toolUses = msg.tool_calls;

    if (toolUses.length) {
      flushPending();
      const last = history[history.length - 1];
      const asst = last ? asAssistantMsg(last) : null;
      if (asst) {
        asst.assistantResponseMessage.toolUses = toolUses.map((tc) => ({
          toolUseId: tc.id || uuidv4(),
          name: tc.function?.name || tc.name || "tool",
          input: parseToolInput(tc.function?.arguments ?? tc.input),
        }));
      }
      currentRole = null;
    }
  }

  if (currentRole !== null) flushPending();

  // Last entry must be a user turn → move to currentMessage. Otherwise
  // synthesize a "continue" user turn.
  let currentMessage: KiroUserMsg | null = null;
  const last = history[history.length - 1];
  const lastUser = last ? asUserMsg(last) : null;
  if (lastUser) {
    history.pop();
    currentMessage = lastUser;
  } else {
    currentMessage = {
      userInputMessage: { content: "Continue", modelId: model },
    };
  }

  // Hoist tools from history[0] (where they were attached in flushPending)
  // into currentMessage if the current message doesn't already carry them.
  // MUST happen BEFORE the strip loop below — otherwise the tools have
  // already been deleted and the hoist condition is always false.
  const firstUser = history[0] ? asUserMsg(history[0]) : null;
  if (
    firstUser?.userInputMessage?.userInputMessageContext?.tools &&
    !currentMessage.userInputMessage.userInputMessageContext?.tools
  ) {
    currentMessage.userInputMessage.userInputMessageContext = {
      ...(currentMessage.userInputMessage.userInputMessageContext || {}),
      tools: firstUser.userInputMessage.userInputMessageContext.tools,
    };
  }

  // Strip tools from history entries (only currentMessage carries them).
  for (const entry of history) {
    const u = asUserMsg(entry);
    if (!u) continue;
    if (u.userInputMessage.userInputMessageContext?.tools) {
      delete u.userInputMessage.userInputMessageContext.tools;
    }
    if (
      u.userInputMessage.userInputMessageContext &&
      Object.keys(u.userInputMessage.userInputMessageContext).length === 0
    ) {
      delete u.userInputMessage.userInputMessageContext;
    }
    if (!u.userInputMessage.modelId) u.userInputMessage.modelId = model;
  }

  // Merge consecutive user turns (can happen after assistant→tool→user).
  const merged: KiroHistoryEntry[] = [];
  for (const entry of history) {
    const u = asUserMsg(entry);
    const previous = merged[merged.length - 1];
    const prevU = previous ? asUserMsg(previous) : null;
    if (u && prevU) {
      const prevText = prevU.userInputMessage.content || "";
      const currentText = u.userInputMessage.content || "";
      prevU.userInputMessage.content = prevText
        ? `${prevText}\n\n${currentText}`
        : currentText;
      if (u.userInputMessage.userInputMessageContext) {
        const prevCtx = prevU.userInputMessage.userInputMessageContext || {};
        const nextCtx = u.userInputMessage.userInputMessageContext;
        const out: KiroUserContext = { ...prevCtx };
        if (nextCtx.toolResults) {
          out.toolResults = [...(prevCtx.toolResults || []), ...nextCtx.toolResults];
        }
        if (nextCtx.tools && !out.tools) out.tools = nextCtx.tools;
        prevU.userInputMessage.userInputMessageContext = out;
      }
    } else {
      merged.push(entry);
    }
  }

  return { history: merged, currentMessage };
}

export function buildKiroPayload(
  body: OpenAIChatRequest,
  options: BuildOptions
): KiroPayload {
  const messages = body.messages || [];
  const tools = body.tools || [];
  const maxTokens = body.max_tokens ?? body.max_completion_tokens ?? 32000;
  const temperature = body.temperature;
  const topP = body.top_p;

  const { history, currentMessage } = convertMessages(messages, tools, options.model);

  const originalCurrentContent = currentMessage?.userInputMessage?.content || "";
  const timestamp = new Date().toISOString();
  const finalContent = `[Context: Current time is ${timestamp}]\n\n${originalCurrentContent}`;

  const payload: KiroPayload = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: uuidv4(),
      currentMessage: {
        userInputMessage: {
          content: finalContent,
          modelId: options.model,
          origin: "AI_EDITOR",
          ...(currentMessage?.userInputMessage?.userInputMessageContext && {
            userInputMessageContext: currentMessage.userInputMessage.userInputMessageContext,
          }),
        },
      },
      history,
    },
  };

  // Deterministic conversationId: hash of the first user content so AWS
  // Builder ID can keep its context cache hot across our requests. Use the
  // ORIGINAL message text (without the time-stamped prefix) so the id stays
  // stable across calls — even when the conversation has just one turn and
  // there is no history[0] to fall back to.
  const firstUser = history[0] ? asUserMsg(history[0]) : null;
  const firstContent = firstUser?.userInputMessage.content || originalCurrentContent;
  payload.conversationState.conversationId = uuidv5(
    (firstContent || "continue").substring(0, 4000),
    KIRO_NAMESPACE
  );

  if (options.profileArn) payload.profileArn = options.profileArn;

  if (maxTokens || temperature !== undefined || topP !== undefined) {
    payload.inferenceConfig = {};
    if (maxTokens) payload.inferenceConfig.maxTokens = maxTokens;
    if (temperature !== undefined) payload.inferenceConfig.temperature = temperature;
    if (topP !== undefined) payload.inferenceConfig.topP = topP;
  }

  return payload;
}
