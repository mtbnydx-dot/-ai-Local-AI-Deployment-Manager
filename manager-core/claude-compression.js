const {
  anthropicContentToText,
  normalizeAnthropicContentBlocks,
} = require("./claude-bridge");

function estimateTokenCount(text) {
  const value = String(text || "");
  if (!value) return 0;
  const cjk = (value.match(/[\u3400-\u9fff]/g) || []).length;
  const words = (value.replace(/[\u3400-\u9fff]/g, " ").match(/[A-Za-z0-9_./:-]+/g) || []).length;
  const punctuation = (value.match(/[^\sA-Za-z0-9_\u3400-\u9fff]/g) || []).length;
  return Math.max(1, Math.ceil(cjk * 0.9 + words * 1.3 + punctuation * 0.35));
}

function anthropicMessageToSummaryText(message) {
  const blocks = normalizeAnthropicContentBlocks(message?.content);
  if (!blocks.length && typeof message?.content === "string") return message.content;
  return blocks.map((block) => {
    if (!block || typeof block !== "object") return "";
    if (block.type === "text") return block.text || "";
    if (block.type === "tool_use") return `[tool_use ${block.name || "tool"} ${JSON.stringify(block.input || {})}]`;
    if (block.type === "tool_result") return `[tool_result ${block.tool_use_id || ""}] ${anthropicContentToText(block.content)}`;
    if (block.type === "image") return "[image]";
    return "";
  }).filter(Boolean).join("\n");
}

function splitClaudeMessagesForCompression(messages, recentBudget) {
  const list = Array.isArray(messages) ? messages : [];
  const tokenCounts = list.map((message) => estimateTokenCount(anthropicMessageToSummaryText(message)));
  const selected = new Set();
  let total = 0;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const cost = Math.max(1, tokenCounts[index]);
    if (selected.size >= 4 && total + cost > recentBudget) break;
    selected.add(index);
    total += cost;
  }
  expandSelectedToolPairs(list, selected);
  const recentMessages = list.filter((_message, index) => selected.has(index));
  const summarizedMessages = list.filter((_message, index) => !selected.has(index));
  return { recentMessages, summarizedMessages };
}

function expandSelectedToolPairs(messages, selected) {
  const needToolUse = new Set();
  const needToolResult = new Set();
  for (const index of selected) {
    for (const block of normalizeAnthropicContentBlocks(messages[index]?.content)) {
      if (block.type === "tool_result" && (block.tool_use_id || block.toolUseId)) {
        needToolUse.add(String(block.tool_use_id || block.toolUseId));
      }
      if (block.type === "tool_use" && block.id) needToolResult.add(String(block.id));
    }
  }
  messages.forEach((message, index) => {
    for (const block of normalizeAnthropicContentBlocks(message?.content)) {
      if (block.type === "tool_use" && needToolUse.has(String(block.id || ""))) selected.add(index);
      if (block.type === "tool_result" && needToolResult.has(String(block.tool_use_id || block.toolUseId || ""))) selected.add(index);
    }
  });
}

function appendClaudeCompressionSummary(system, summaryText) {
  const block = `\n\n${summaryText}`;
  if (!system) return summaryText;
  if (typeof system === "string") return `${system}${block}`;
  if (Array.isArray(system)) return [...system, { type: "text", text: summaryText }];
  if (system && typeof system === "object") return [system, { type: "text", text: summaryText }];
  return summaryText;
}

function buildClaudeCompressionSummary(messages, options = {}) {
  const settings = normalizeCompressionSummarySettings(options);
  const language = String(options.language || "zh-CN").toLowerCase().startsWith("en") ? "en-US" : "zh-CN";
  const copy = SUMMARY_COPY[language];
  const summaryBudget = Number(options.summaryBudget || Math.max(512, Math.floor(settings.contextLimit * settings.summaryRatio)));
  const buckets = {
    goals: [],
    hardRules: [],
    errors: [],
    paths: [],
    commands: [],
    tools: [],
    progress: [],
    openIssues: [],
    snippets: [],
  };

  (Array.isArray(messages) ? messages : []).forEach((message, index) => collectCompressionFacts(message, index, buckets, copy));
  const protectedItems = Object.values(buckets).reduce((sum, items) => sum + items.length, 0);
  const header = copy.header(settings, messages.length);
  const sections = copy.sections(buckets);

  let importantText = [
    ...header,
    ...sections.flatMap(([title, items]) => renderSummarySection(title, items, 12, copy)),
  ].join("\n");

  let snippets = buckets.snippets.slice(0, 24);
  let text = renderCompressionSummaryText(importantText, snippets, copy);
  while (estimateTokenCount(text) > summaryBudget && snippets.length) {
    snippets.pop();
    text = renderCompressionSummaryText(importantText, snippets, copy);
  }
  if (estimateTokenCount(text) > summaryBudget) {
    importantText = clipToEstimatedTokens(importantText, summaryBudget, copy);
    text = renderCompressionSummaryText(importantText, [], copy);
  }

  return {
    text,
    tokens: estimateTokenCount(text),
    protectedItems,
  };
}

function buildClaudeCompressionSummaryText(messages, options = {}) {
  return buildClaudeCompressionSummary(messages, options).text;
}

function applyClaudeContextCompression(body = {}, runtime = {}, model = "", settings = {}, options = {}) {
  const config = normalizeCompressionRuntimeSettings(settings);
  const contextLimit = resolveClaudeContextLimit(runtime, model, body, options.defaultContextLimit || 8192);
  const maxTokens = Math.max(1, Number(body.max_tokens || body.maxTokens || options.defaultMaxTokens || 1024));
  const originalPromptTokens = estimateClaudeBodyTokens(body);
  const triggerTokens = Math.floor(contextLimit * config.triggerRatio);
  const shouldCompress = config.enabled
    && contextLimit > 0
    && Array.isArray(body.messages)
    && body.messages.length >= config.minMessages
    && originalPromptTokens + maxTokens >= triggerTokens;

  const base = {
    applied: false,
    enabled: config.enabled,
    mode: config.mode,
    contextLimit,
    triggerRatio: config.triggerRatio,
    triggerTokens,
    recentRatio: config.recentRatio,
    summaryRatio: config.summaryRatio,
    originalPromptTokens,
    compressedPromptTokens: originalPromptTokens,
    savedTokens: 0,
    recentMessageCount: 0,
    summarizedMessageCount: 0,
    body,
  };
  if (!shouldCompress) return base;

  const recentBudget = Math.max(512, Math.floor(contextLimit * config.recentRatio));
  const summaryBudget = Math.max(512, Math.floor(contextLimit * config.summaryRatio));
  const { recentMessages, summarizedMessages } = splitClaudeMessagesForCompression(body.messages, recentBudget);
  if (!summarizedMessages.length) return base;

  const summary = buildClaudeCompressionSummary(summarizedMessages, {
    language: options.language || "zh-CN",
    summaryBudget,
    originalPromptTokens,
    contextLimit,
    recentBudget,
    settings: config,
  });
  const compressedBody = {
    ...body,
    system: appendClaudeCompressionSummary(body.system, summary.text),
    messages: recentMessages,
  };
  const compressedPromptTokens = estimateClaudeBodyTokens(compressedBody);
  return {
    ...base,
    applied: compressedPromptTokens < originalPromptTokens,
    compressedPromptTokens,
    savedTokens: Math.max(0, originalPromptTokens - compressedPromptTokens),
    summaryTokens: summary.tokens,
    recentMessageCount: recentMessages.length,
    summarizedMessageCount: summarizedMessages.length,
    protectedItems: summary.protectedItems,
    body: compressedPromptTokens < originalPromptTokens ? compressedBody : body,
  };
}

function resolveClaudeContextLimit(runtime = {}, model = "", body = {}, fallback = 8192) {
  const candidates = [];
  const served = [...(runtime?.servedModels || []), ...(runtime?.models || [])];
  for (const item of served) {
    const id = String(item?.id || "").toLowerCase();
    const root = String(item?.root || "").toLowerCase();
    if (!model || id === String(model).toLowerCase() || root === String(model).toLowerCase()) {
      candidates.push(item?.max_model_len, item?.maxModelLen, item?.contextCapacityTokens);
    }
  }
  candidates.push(body.max_model_len, body.maxModelLen, runtime?.models?.[0]?.maxModelLen, runtime?.servedModels?.[0]?.max_model_len);
  for (const value of candidates) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 1024) return Math.floor(number);
  }
  return Math.max(1024, Math.floor(Number(fallback) || 8192));
}

function estimateClaudeBodyTokens(body = {}) {
  const parts = [];
  const system = anthropicContentToText(body.system);
  if (system) parts.push(system);
  if (Array.isArray(body.tools) && body.tools.length) parts.push(JSON.stringify(body.tools));
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    parts.push(message.role || "user");
    parts.push(anthropicMessageToSummaryText(message));
  }
  return estimateTokenCount(parts.join("\n"));
}

function normalizeCompressionSummarySettings(options = {}) {
  const settings = options.settings || options || {};
  return {
    triggerRatio: Number(settings.triggerRatio || 0.9),
    recentRatio: Number(settings.recentRatio || 0.2),
    summaryRatio: Number(settings.summaryRatio || 0.2),
    originalPromptTokens: Number(options.originalPromptTokens || settings.originalPromptTokens || 0),
    contextLimit: Number(options.contextLimit || settings.contextLimit || 8192),
  };
}

function normalizeCompressionRuntimeSettings(settings = {}) {
  const item = settings && typeof settings === "object" ? settings : {};
  return {
    enabled: item.enabled !== false,
    mode: new Set(["cautious", "balanced", "aggressive"]).has(String(item.mode || "").toLowerCase())
      ? String(item.mode).toLowerCase()
      : "cautious",
    triggerRatio: clampRatio(item.triggerRatio ?? 0.9, 0.9, 0.05, 0.99),
    recentRatio: clampRatio(item.recentRatio ?? 0.2, 0.2, 0.05, 0.5),
    summaryRatio: clampRatio(item.summaryRatio ?? 0.2, 0.2, 0.05, 0.5),
    minMessages: Math.max(1, Math.floor(Number(item.minMessages || 8))),
  };
}

function clampRatio(value, fallback, min, max) {
  let number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  if (number > 1) number /= 100;
  return Math.min(max, Math.max(min, number));
}

function renderCompressionSummaryText(importantText, snippets, copy) {
  const snippetSection = snippets.length
    ? `\n${copy.snippetTitle}\n${snippets.map((item) => `- ${item}`).join("\n")}`
    : `\n${copy.snippetOmitted}`;
  return `${importantText}${snippetSection}\n${copy.end}`;
}

function renderSummarySection(title, items, limit, copy) {
  const unique = uniqueStrings(items).slice(0, limit);
  if (!unique.length) return [`${title}${copy.sectionSeparator}`, `- ${copy.none}`];
  return [`${title}${copy.sectionSeparator}`, ...unique.map((item) => `- ${item}`)];
}

function collectCompressionFacts(message, index, buckets, copy) {
  const role = message?.role === "assistant" ? copy.assistantRole : copy.userRole;
  const blocks = normalizeAnthropicContentBlocks(message?.content);
  const text = anthropicMessageToSummaryText(message);
  const clipped = clipText(text.replace(/\s+/g, " ").trim(), 360, copy.truncated);
  if (clipped) buckets.snippets.push(`#${index + 1} ${role}: ${clipped}`);

  for (const line of importantLines(text)) {
    const item = clipText(`${role}: ${line}`, 360, copy.truncated);
    if (isHardInstructionLine(line)) buckets.hardRules.push(item);
    if (isGoalLine(line) || role === copy.userRole) buckets.goals.push(item);
    if (isErrorLine(line)) buckets.errors.push(item);
    if (isPathConfigLine(line)) buckets.paths.push(item);
    if (isCommandLine(line)) buckets.commands.push(item);
    if (isProgressLine(line)) buckets.progress.push(item);
    if (isOpenIssueLine(line)) buckets.openIssues.push(item);
  }

  for (const block of blocks) {
    if (block.type === "tool_use") {
      buckets.tools.push(clipText(`tool_use ${block.name || "tool"} id=${block.id || "-"} input=${JSON.stringify(block.input || {})}`, 420, copy.truncated));
    } else if (block.type === "tool_result") {
      const resultText = anthropicContentToText(block.content);
      const keyLines = importantLines(resultText).slice(0, 8);
      const compactResult = (keyLines.join(" | ") || resultText).replace(/\s+/g, " ");
      buckets.tools.push(clipText(`tool_result ${block.tool_use_id || block.toolUseId || "-"}${block.is_error ? " ERROR" : ""}: ${compactResult}`, 520, copy.truncated));
      if (block.is_error || isErrorLine(resultText)) {
        buckets.errors.push(clipText(`${copy.toolErrorPrefix} ${block.tool_use_id || block.toolUseId || "-"}: ${compactResult}`, 520, copy.truncated));
      }
    }
  }
}

function importantLines(text) {
  return String(text || "")
    .split(/\r?\n|(?<=[.!?;:\u3002\uff01\uff1f\uff1b\uff1a])\s+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => isHardInstructionLine(line) || isGoalLine(line) || isErrorLine(line) || isPathConfigLine(line) || isCommandLine(line) || isProgressLine(line) || isOpenIssueLine(line))
    .slice(0, 80);
}

function isHardInstructionLine(line) {
  return /\u5fc5\u987b|\u7edd\u5bf9|\u4e0d\u80fd|\u4e0d\u8981|\u522b|\u5148\u522b|\u7981\u6b62|\u52a1\u5fc5|\u4e00\u5b9a|\u8bb0\u4f4f|\u4e0d\u8981\u4e22|\u4fdd\u7559|\u9690\u79c1|\u5ba1\u8ba1|\u5bc6\u7801|\u89c4\u5219|must|never|do not|don't|keep|preserve|required/i.test(line);
}

function isGoalLine(line) {
  return /\u6211\u8981|\u6211\u60f3|\u9700\u8981|\u5e2e\u6211|\u8bf7|\u76ee\u6807|\u4efb\u52a1|\u65b9\u6848|\u5b9e\u73b0|\u4fee\u590d|\u52a0\u4e2a|\u505a\u4e2a|can you|please|need|goal|task|implement|fix|add/i.test(line);
}

function isErrorLine(line) {
  return /\u9519\u8bef|\u62a5\u9519|\u5931\u8d25|\u5f02\u5e38|\u5d29\u6e83|\u65e0\u6cd5|\u4e0d\u80fd|\u4e0d\u6b63\u786e|failed|error|exception|traceback|fatal|warning|warn|timeout|404|500|unauthorized|not available/i.test(line);
}

function isPathConfigLine(line) {
  return /[A-Za-z]:\\|\/[\w.-]+\/[\w.-]+|https?:\/\/|127\.0\.0\.1|localhost|:\d{2,5}\b|--[a-z0-9-]+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|Qwen|DeepSeek|Claude|OpenWebUI|vLLM|llama|Docker|GPU|NVFP4|FP8|GGUF/i.test(line);
}

function isCommandLine(line) {
  return /^\s*(docker|node|npm|python|pip|hf|curl|Invoke-|Get-|Set-|Start-|Stop-|sqlite|git)\b/i.test(line) || /`[^`]+`|<Bash|tool_use|tool_result/i.test(line);
}

function isProgressLine(line) {
  return /\u5df2\u5b8c\u6210|\u5df2\u7ecf|\u65b0\u589e|\u4fee\u6539|\u9a8c\u8bc1|\u901a\u8fc7|\u91cd\u542f|\u542f\u52a8|\u5173\u95ed|\u4e0b\u8f7d|\u5378\u8f7d|configured|started|stopped|added|updated|verified/i.test(line);
}

function isOpenIssueLine(line) {
  return /\u5f85\u529e|\u4e0b\u4e00\u6b65|\u8fd8\u6ca1|\u9700\u8981\u7ee7\u7eed|\u672a\u89e3\u51b3|\u95ee\u9898|\u98ce\u9669|todo|next|pending|remaining|blocked/i.test(line);
}

function uniqueStrings(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const text = String(item || "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function clipText(text, maxLength, marker = "...[truncated]") {
  const value = String(text || "").trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - marker.length - 1)).trim()} ${marker}`;
}

function clipToEstimatedTokens(text, maxTokens, copy) {
  const value = String(text || "");
  if (estimateTokenCount(value) <= maxTokens) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (estimateTokenCount(value.slice(0, mid)) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  return `${value.slice(0, Math.max(0, low - 24)).trim()}\n${copy.budgetTruncated}`;
}

const SUMMARY_COPY = {
  "zh-CN": {
    userRole: "\u7528\u6237",
    assistantRole: "\u52a9\u624b",
    sectionSeparator: "\uff1a",
    none: "\u672a\u53d1\u73b0\u660e\u786e\u6761\u76ee\u3002",
    snippetTitle: "\u65e7\u5bf9\u8bdd\u539f\u6587\u6458\u5f55\uff1a",
    snippetOmitted: "\u65e7\u5bf9\u8bdd\u539f\u6587\u6458\u5f55\uff1a\u5df2\u7701\u7565\u4f4e\u4f18\u5148\u7ea7\u95f2\u804a\u548c\u91cd\u590d\u5185\u5bb9\u3002",
    end: "[\u81ea\u52a8\u538b\u7f29\u4e0a\u4e0b\u6587\u6458\u8981\u7ed3\u675f]",
    truncated: "...[\u622a\u65ad]",
    budgetTruncated: "...[\u6458\u8981\u56e0\u9884\u7b97\u622a\u65ad]",
    toolErrorPrefix: "\u5de5\u5177\u7ed3\u679c\u9519\u8bef",
    header(settings, count) {
      return [
        "[\u81ea\u52a8\u538b\u7f29\u4e0a\u4e0b\u6587\u6458\u8981]",
        "\u8bf4\u660e\uff1a\u8fd9\u662f Local AI Deployment Manager \u5728 Claude \u517c\u5bb9\u6865\u91cc\u81ea\u52a8\u751f\u6210\u7684\u8c28\u614e\u538b\u7f29\u6458\u8981\u3002\u7cfb\u7edf\u6d88\u606f\u3001\u6700\u8fd1\u539f\u6587\u7a97\u53e3\u548c\u5de5\u5177\u8c03\u7528\u914d\u5bf9\u4f1a\u88ab\u4f18\u5148\u4fdd\u62a4\uff1b\u5982\u6458\u8981\u548c\u6700\u8fd1\u539f\u6587\u51b2\u7a81\uff0c\u4ee5\u6700\u8fd1\u539f\u6587\u4e3a\u51c6\u3002",
        `\u538b\u7f29\u8303\u56f4\uff1a${count} \u6761\u8f83\u65e7\u6d88\u606f\uff1b\u89e6\u53d1\u9608\u503c ${(settings.triggerRatio * 100).toFixed(0)}%\uff1b\u6700\u8fd1\u539f\u6587\u4fdd\u7559 ${(settings.recentRatio * 100).toFixed(0)}%\uff1b\u6458\u8981\u9884\u7b97 ${(settings.summaryRatio * 100).toFixed(0)}%\u3002`,
        `\u538b\u7f29\u524d\u4f30\u7b97\uff1a${settings.originalPromptTokens} tokens\uff1b\u6a21\u578b\u4e0a\u4e0b\u6587\u4e0a\u9650\uff1a${settings.contextLimit} tokens\u3002`,
      ];
    },
    sections(buckets) {
      return [
        ["\u5f53\u524d\u76ee\u6807\u548c\u7528\u6237\u8981\u6c42", buckets.goals],
        ["\u786c\u6027\u7ea6\u675f/\u4e0d\u8981\u4e22", buckets.hardRules],
        ["\u9519\u8bef\u3001\u5931\u8d25\u548c\u98ce\u9669", buckets.errors],
        ["\u5173\u952e\u8def\u5f84\u3001\u5730\u5740\u3001\u7aef\u53e3\u3001\u6a21\u578b\u548c\u914d\u7f6e", buckets.paths],
        ["\u547d\u4ee4\u3001\u63a5\u53e3\u548c\u64cd\u4f5c\u8bb0\u5f55", buckets.commands],
        ["\u5de5\u5177\u8c03\u7528\u548c\u7ed3\u679c", buckets.tools],
        ["\u5df2\u5b8c\u6210\u64cd\u4f5c", buckets.progress],
        ["\u672a\u5b8c\u6210\u4e8b\u9879", buckets.openIssues],
      ];
    },
  },
  "en-US": {
    userRole: "user",
    assistantRole: "assistant",
    sectionSeparator: ":",
    none: "None detected.",
    snippetTitle: "Older-message excerpts:",
    snippetOmitted: "Older-message excerpts: omitted low-priority chatter and repeated content.",
    end: "[End automatic context compression summary]",
    truncated: "...[truncated]",
    budgetTruncated: "...[summary truncated to fit budget]",
    toolErrorPrefix: "tool_result error",
    header(settings, count) {
      return [
        "[Automatic context compression summary]",
        "Purpose: preserve durable intent, hard instructions, errors, paths, configuration, and tool-call pairs while older low-priority chat is compressed.",
        "Conflict rule: recent original messages and explicit hard instructions override this summary.",
        `Compressed messages: ${count}; trigger: ${(settings.triggerRatio * 100).toFixed(0)}%; recent raw window: ${(settings.recentRatio * 100).toFixed(0)}%; summary budget: ${(settings.summaryRatio * 100).toFixed(0)}%.`,
        `Before compression estimate: ${settings.originalPromptTokens} tokens; context limit: ${settings.contextLimit} tokens.`,
      ];
    },
    sections(buckets) {
      return [
        ["Current goals and user requests", buckets.goals],
        ["Hard rules and safety constraints", buckets.hardRules],
        ["Errors, failures, and risks", buckets.errors],
        ["Paths, addresses, ports, models, and configuration", buckets.paths],
        ["Commands, APIs, and operations", buckets.commands],
        ["Tool calls and results", buckets.tools],
        ["Completed work", buckets.progress],
        ["Open issues and next steps", buckets.openIssues],
      ];
    },
  },
};

module.exports = {
  estimateTokenCount,
  estimateClaudeBodyTokens,
  anthropicMessageToSummaryText,
  applyClaudeContextCompression,
  resolveClaudeContextLimit,
  splitClaudeMessagesForCompression,
  expandSelectedToolPairs,
  appendClaudeCompressionSummary,
  buildClaudeCompressionSummary,
  buildClaudeCompressionSummaryText,
};
