"use strict";

const crypto = require("crypto");

function parseJsonSafe(value, fallback = null) {
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function anthropicMessagesToOpenAi(body = {}) {
  const messages = [];
  const system = anthropicContentToText(body.system);
  if (system) messages.push({ role: "system", content: system });
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    appendAnthropicMessageAsOpenAi(messages, message);
  }
  return messages;
}

function appendAnthropicMessageAsOpenAi(messages, message) {
  const role = message?.role === "assistant" ? "assistant" : "user";
  const blocks = normalizeAnthropicContentBlocks(message?.content);
  if (role === "assistant") {
    const text = [];
    const toolCalls = [];
    for (const block of blocks) {
      if (block.type === "text") text.push(String(block.text || ""));
      if (block.type === "tool_use") {
        toolCalls.push({
          id: String(block.id || `call_${crypto.randomUUID()}`),
          type: "function",
          function: {
            name: String(block.name || "tool"),
            arguments: JSON.stringify(block.input && typeof block.input === "object" ? block.input : {}),
          },
        });
      }
    }
    const openAiMessage = { role: "assistant", content: text.filter(Boolean).join("\n") || null };
    if (toolCalls.length) openAiMessage.tool_calls = toolCalls;
    if (openAiMessage.content || toolCalls.length) messages.push(openAiMessage);
    return;
  }

  let userParts = [];
  const flushUserParts = () => {
    if (!userParts.length) return;
    messages.push({ role: "user", content: openAiUserContentFromParts(userParts) });
    userParts = [];
  };

  for (const block of blocks) {
    if (block.type === "text") {
      userParts.push({ type: "text", text: String(block.text || "") });
    } else if (block.type === "image" && block.source) {
      const imageUrl = anthropicImageSourceToUrl(block.source);
      if (imageUrl) userParts.push({ type: "image_url", image_url: { url: imageUrl } });
    } else if (block.type === "tool_result") {
      flushUserParts();
      const toolCallId = String(block.tool_use_id || block.toolUseId || "");
      const content = anthropicContentToText(block.content);
      if (toolCallId) {
        messages.push({
          role: "tool",
          tool_call_id: toolCallId,
          content: block.is_error ? `Error: ${content}` : content,
        });
      } else if (content) {
        userParts.push({ type: "text", text: content });
      }
    }
  }
  flushUserParts();
}

function normalizeAnthropicContentBlocks(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content.filter((block) => block && typeof block === "object");
  if (content && typeof content === "object") return [content];
  return [];
}

function openAiUserContentFromParts(parts) {
  const hasStructured = parts.some((part) => part.type !== "text");
  if (!hasStructured) return parts.map((part) => part.text || "").filter(Boolean).join("\n");
  return parts;
}

function anthropicToolsToOpenAi(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool) => tool && typeof tool === "object" && tool.name)
    .map((tool) => ({
      type: "function",
      function: {
        name: String(tool.name),
        description: String(tool.description || ""),
        parameters: tool.input_schema || tool.inputSchema || tool.parameters || {
          type: "object",
          properties: {},
        },
      },
    }));
}

function anthropicToolChoiceToOpenAi(choice, tools) {
  if (!tools.length) return undefined;
  if (!choice) return "auto";
  if (typeof choice === "string") return choice;
  const type = String(choice.type || "").toLowerCase();
  if (type === "none") return "none";
  if (type === "any" || type === "required") return "required";
  if (type === "tool" && choice.name) {
    return { type: "function", function: { name: String(choice.name) } };
  }
  return "auto";
}

function buildOpenAiChatBodyFromClaude(body = {}, model, options = {}) {
  const messages = anthropicMessagesToOpenAi(body);
  const tools = anthropicToolsToOpenAi(body.tools);
  const payload = {
    model,
    messages,
    max_tokens: Math.max(1, Number(body.max_tokens || body.maxTokens || options.defaultMaxTokens || 1024)),
  };
  const chatTemplateKwargs = body.chat_template_kwargs && typeof body.chat_template_kwargs === "object" && !Array.isArray(body.chat_template_kwargs)
    ? { ...body.chat_template_kwargs }
    : {};
  if (options.disableQwenThinking !== false && /qwen/i.test(String(model || "")) && chatTemplateKwargs.enable_thinking === undefined) {
    chatTemplateKwargs.enable_thinking = false;
  }
  if (Object.keys(chatTemplateKwargs).length) payload.chat_template_kwargs = chatTemplateKwargs;
  if (tools.length) {
    payload.tools = tools;
    payload.tool_choice = anthropicToolChoiceToOpenAi(body.tool_choice, tools);
  }
  if (body.disable_parallel_tool_use === true) payload.parallel_tool_calls = false;
  for (const field of ["temperature", "top_p", "presence_penalty", "frequency_penalty"]) {
    if (body[field] !== undefined && body[field] !== null && body[field] !== "") payload[field] = Number(body[field]);
  }
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) payload.stop = body.stop_sequences;
  if (body.stream === true) {
    payload.stream = true;
    payload.stream_options = { include_usage: true };
  }
  return payload;
}

function anthropicContentToOpenAi(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return anthropicContentToText(content);
  const parts = [];
  let structured = false;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") {
      parts.push({ type: "text", text: String(block.text || "") });
    } else if (block.type === "image" && block.source) {
      const imageUrl = anthropicImageSourceToUrl(block.source);
      if (imageUrl) {
        structured = true;
        parts.push({ type: "image_url", image_url: { url: imageUrl } });
      }
    } else if (block.type === "tool_result") {
      parts.push({ type: "text", text: anthropicContentToText(block.content) });
    }
  }
  if (!structured) return parts.map((part) => part.text || "").filter(Boolean).join("\n");
  return parts;
}

function anthropicImageSourceToUrl(source = {}) {
  if (source.type === "url" && source.url) return String(source.url);
  if (source.type === "base64" && source.data) {
    const mediaType = source.media_type || source.mediaType || "image/png";
    return `data:${mediaType};base64,${source.data}`;
  }
  return "";
}

function anthropicContentToText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (!block || typeof block !== "object") return "";
        if (block.type === "text") return block.text || "";
        if (block.type === "tool_result") return anthropicContentToText(block.content);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object" && content.type === "text") return content.text || "";
  return "";
}

function openAiResponseToClaude(data, fallbackModel) {
  const choice = data?.choices?.[0] || {};
  const message = choice.message || {};
  const content = openAiMessageToClaudeContent(message);
  const hasToolUse = content.some((block) => block.type === "tool_use");
  return {
    id: data?.id || `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model: data?.model || fallbackModel,
    content: content.length ? content : [{ type: "text", text: "" }],
    stop_reason: hasToolUse ? "tool_use" : mapOpenAiStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: data?.usage?.prompt_tokens || 0,
      output_tokens: data?.usage?.completion_tokens || 0,
    },
  };
}

function openAiMessageToClaudeContent(message = {}) {
  const content = [];
  const text = openAiMessageContentToText(message.content);
  if (text) content.push({ type: "text", text });
  for (const call of normalizeOpenAiToolCalls(message)) {
    content.push(openAiToolCallToClaudeBlock(call));
  }
  return content;
}

function normalizeOpenAiToolCalls(message = {}) {
  const calls = Array.isArray(message?.tool_calls) ? [...message.tool_calls] : [];
  if (message?.function_call) {
    calls.push({
      id: `call_${crypto.randomUUID()}`,
      type: "function",
      function: message.function_call,
    });
  }
  return calls;
}

function openAiToolCallToClaudeBlock(call = {}) {
  const fn = call?.function || {};
  return {
    type: "tool_use",
    id: String(call?.id || `toolu_${crypto.randomUUID()}`),
    name: String(fn.name || call?.name || "tool"),
    input: parseToolArguments(fn.arguments ?? call?.arguments),
  };
}

function parseToolArguments(value) {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "object") return value;
  const parsed = parseJsonSafe(String(value), null);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  if (parsed !== null) return { value: parsed };
  return { raw: String(value) };
}

function writeClaudeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function streamOpenAiAsClaude(upstream, res, fallbackModel, usageContext = {}) {
  const messageId = `msg_${crypto.randomUUID()}`;
  const model = fallbackModel || "local-model";
  const recordUsage = typeof usageContext.recordUsage === "function" ? usageContext.recordUsage : async () => {};
  const isExpectedStreamDisconnect = typeof usageContext.isExpectedStreamDisconnect === "function"
    ? usageContext.isExpectedStreamDisconnect
    : () => false;
  let stopReason = "end_turn";
  let inputTokens = 0;
  let outputTokens = 0;
  let buffer = "";
  let nextContentIndex = 0;
  let textBlockIndex = null;
  let activeToolIndex = null;
  let toolUseCount = 0;
  let streamError = null;
  const toolStates = new Map();

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  writeClaudeSse(res, "message_start", {
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

  const closeTextBlock = () => {
    if (textBlockIndex === null) return;
    writeClaudeSse(res, "content_block_stop", { type: "content_block_stop", index: textBlockIndex });
    textBlockIndex = null;
  };
  const finalizeActiveTool = () => {
    if (activeToolIndex === null) return;
    const state = toolStates.get(activeToolIndex);
    if (state?.started && !state.done) {
      writeClaudeSse(res, "content_block_stop", { type: "content_block_stop", index: state.blockIndex });
      state.done = true;
    }
    activeToolIndex = null;
  };
  const ensureTextBlock = () => {
    finalizeActiveTool();
    if (textBlockIndex !== null) return textBlockIndex;
    textBlockIndex = nextContentIndex++;
    writeClaudeSse(res, "content_block_start", {
      type: "content_block_start",
      index: textBlockIndex,
      content_block: { type: "text", text: "" },
    });
    return textBlockIndex;
  };
  const emitToolArgs = (state) => {
    const pending = state.arguments.slice(state.sentChars);
    if (!pending) return;
    state.sentChars = state.arguments.length;
    writeClaudeSse(res, "content_block_delta", {
      type: "content_block_delta",
      index: state.blockIndex,
      delta: { type: "input_json_delta", partial_json: pending },
    });
  };
  const handleToolDelta = (delta) => {
    const index = Number.isInteger(delta.index) ? delta.index : toolStates.size;
    let state = toolStates.get(index);
    if (!state) {
      state = { index, id: "", name: "", arguments: "", blockIndex: null, started: false, done: false, sentChars: 0 };
      toolStates.set(index, state);
    }
    if (delta.id) state.id = String(delta.id);
    const fn = delta.function || {};
    if (fn.name) {
      const nextName = String(fn.name);
      state.name = state.name && nextName.startsWith(state.name) ? nextName : state.name + nextName;
    }
    if (delta.name && !state.name) state.name = String(delta.name);
    if (fn.arguments) state.arguments += String(fn.arguments);
    if (delta.arguments) state.arguments += String(delta.arguments);
    if (state.done) return;
    if (!state.started) {
      if (!state.name) return;
      closeTextBlock();
      if (activeToolIndex !== null && activeToolIndex !== index) finalizeActiveTool();
      state.blockIndex = nextContentIndex++;
      state.started = true;
      activeToolIndex = index;
      writeClaudeSse(res, "content_block_start", {
        type: "content_block_start",
        index: state.blockIndex,
        content_block: { type: "tool_use", id: state.id || `call_${index}`, name: state.name, input: {} },
      });
    }
    emitToolArgs(state);
  };

  try {
    const decoder = new TextDecoder();
    for await (const chunk of upstream.body) {
      if (res.destroyed) break;
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        for (const line of frame.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          const data = parseJsonSafe(payload, null);
          if (!data) continue;
          if (data.usage) {
            inputTokens = data.usage.prompt_tokens || inputTokens;
            outputTokens = data.usage.completion_tokens || outputTokens;
          }
          const choice = data.choices?.[0] || {};
          const delta = choice.delta || {};
          const deltaText = delta.content || choice.message?.content || "";
          if (deltaText) {
            const index = ensureTextBlock();
            writeClaudeSse(res, "content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "text_delta", text: deltaText },
            });
          }
          for (const toolDelta of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) handleToolDelta(toolDelta);
          for (const toolDelta of Array.isArray(choice.message?.tool_calls) ? choice.message.tool_calls : []) handleToolDelta(toolDelta);
          if (choice.finish_reason) stopReason = mapOpenAiStopReason(choice.finish_reason);
        }
        separator = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    streamError = error;
  }

  const expectedDisconnect = Boolean(res.destroyed || isExpectedStreamDisconnect(streamError, res));
  if (expectedDisconnect) {
    if (usageContext.req) {
      usageContext.req.serviceGatewayAccessUsage = {
        resolvedModel: model,
        inputTokens,
        outputTokens,
        stopReason,
        toolUseCount,
        error: streamError?.message || "Client disconnected mid-stream.",
      };
    }
    await recordUsage({
      requestedModel: usageContext.requestedModel || "",
      model,
      ok: false,
      error: streamError?.message || "Client disconnected mid-stream.",
      stream: true,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      latencyMs: Date.now() - Number(usageContext.startedAt || Date.now()),
      toolSchemaCount: Number(usageContext.toolSchemaCount || 0),
      toolUseCount,
      stopReason,
      compression: usageContext.compression,
      session: usageContext.session,
    }).catch(() => {});
    if (!res.writableEnded) res.end();
    return;
  }

  if (streamError) {
    if (usageContext.req) {
      usageContext.req.serviceGatewayAccessUsage = {
        resolvedModel: model,
        inputTokens,
        outputTokens,
        stopReason,
        toolUseCount,
        error: streamError.message,
      };
    }
    writeClaudeSse(res, "error", {
      type: "error",
      error: { type: "api_error", message: `Upstream stream failed: ${streamError.message}` },
    });
    res.end();
  } else {
    finalizeActiveTool();
    closeTextBlock();
    for (const state of Array.from(toolStates.values()).sort((a, b) => a.index - b.index)) {
      if (state.started || !(state.name || state.arguments)) continue;
      const block = openAiToolCallToClaudeBlock({
        id: state.id,
        type: "function",
        function: { name: state.name, arguments: state.arguments },
      });
      const index = nextContentIndex++;
      writeClaudeSse(res, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
      const partialJson = JSON.stringify(block.input || {});
      if (partialJson && partialJson !== "{}") {
        writeClaudeSse(res, "content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: partialJson },
        });
      }
      writeClaudeSse(res, "content_block_stop", { type: "content_block_stop", index });
      state.done = true;
    }
    toolUseCount = Array.from(toolStates.values()).filter((state) => state.done || state.started).length;
    if (toolUseCount) stopReason = "tool_use";
    if (!nextContentIndex) {
      const index = nextContentIndex++;
      writeClaudeSse(res, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
      writeClaudeSse(res, "content_block_stop", { type: "content_block_stop", index });
    }
    writeClaudeSse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    });
    writeClaudeSse(res, "message_stop", { type: "message_stop" });
    if (usageContext.req) {
      usageContext.req.serviceGatewayAccessUsage = {
        resolvedModel: model,
        inputTokens,
        outputTokens,
        stopReason,
        toolSchemaCount: Number(usageContext.toolSchemaCount || 0),
        toolUseCount,
      };
    }
    res.end();
  }

  await recordUsage({
    requestedModel: usageContext.requestedModel || "",
    model,
    ok: !streamError,
    error: streamError ? streamError.message : undefined,
    stream: true,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    latencyMs: Date.now() - Number(usageContext.startedAt || Date.now()),
    toolSchemaCount: Number(usageContext.toolSchemaCount || 0),
    toolUseCount,
    stopReason,
    compression: usageContext.compression,
    session: usageContext.session,
  }).catch(() => {});
}

function openAiMessageContentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === "string" ? part : part?.text || "").filter(Boolean).join("\n");
  }
  return content == null ? "" : String(content);
}

function mapOpenAiStopReason(reason) {
  if (reason === "length") return "max_tokens";
  if (reason === "tool_calls" || reason === "function_call") return "tool_use";
  if (reason === "content_filter") return "stop_sequence";
  return "end_turn";
}

module.exports = {
  anthropicContentToOpenAi,
  anthropicContentToText,
  anthropicImageSourceToUrl,
  anthropicMessagesToOpenAi,
  anthropicToolChoiceToOpenAi,
  anthropicToolsToOpenAi,
  appendAnthropicMessageAsOpenAi,
  buildOpenAiChatBodyFromClaude,
  mapOpenAiStopReason,
  normalizeAnthropicContentBlocks,
  normalizeOpenAiToolCalls,
  openAiMessageContentToText,
  openAiMessageToClaudeContent,
  openAiResponseToClaude,
  openAiToolCallToClaudeBlock,
  openAiUserContentFromParts,
  parseToolArguments,
  streamOpenAiAsClaude,
  writeClaudeSse,
};
