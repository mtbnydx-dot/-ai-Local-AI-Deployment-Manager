"use strict";

// Chat template detector (docs/overhaul/02-models.md §5). The template is found
// in this order: chat_template.jinja, tokenizer_config.json#chat_template
// (a string, or a named list where "default" wins), chat_template.json (the
// processor form), then the GGUF key tokenizer.chat_template. Its sha256 is
// taken over the text with CRLF turned into LF, so the same template hashes
// the same on every checkout.
//
// The text is untrusted: it is hashed and kept in the facts cache only (the
// card carries it only when an admin asks for it). Matching it against the
// template signatures is the knowledge layer's job (MOD-7), not this file's.

const crypto = require("node:crypto");
const { readJsonFile, readTextFile, fileEntry } = require("./inventory");

const COPY = Object.freeze({
  missing: {
    zh: "没有找到聊天模板（chat_template.jinja、tokenizer_config.json 或 GGUF），工具调用和思考格式未知。",
    en: "No chat template was found (chat_template.jinja, tokenizer_config.json or GGUF); the tool-call and reasoning formats are unknown.",
  },
  tooLarge: (bytes) => ({
    zh: `GGUF 中的聊天模板有 ${bytes} 字节，超过读取上限，没有计算指纹。`,
    en: `The GGUF chat template is ${bytes} bytes, over the read limit; it was not fingerprinted.`,
  }),
  namedList: (name) => ({
    zh: `tokenizer_config.json 中有多个具名模板，使用了 "${name}"。`,
    en: `tokenizer_config.json holds several named templates; "${name}" was used.`,
  }),
});

function normalizeTemplateText(text) {
  return String(text).replace(/\r\n/g, "\n");
}

function templateSha256(text) {
  return crypto.createHash("sha256").update(normalizeTemplateText(text), "utf8").digest("hex");
}

function fromTokenizerConfig(value) {
  if (typeof value === "string" && value.length) return { text: value, pointer: "/chat_template" };
  if (!Array.isArray(value)) return null;
  const named = value.filter((item) => item && typeof item.name === "string" && typeof item.template === "string");
  if (!named.length) return null;
  const index = Math.max(0, named.findIndex((item) => item.name === "default"));
  const chosen = named[index];
  return { text: chosen.template, pointer: `/chat_template/${value.indexOf(chosen)}/template`, name: named.length > 1 ? chosen.name : null };
}

function record(facts, found) {
  const text = normalizeTemplateText(found.text);
  facts.set("/template/source", found.source, found.evidence, "declared", found.note);
  facts.set("/template/sha256", templateSha256(text), found.evidence, "detected");
  facts.set("/template/bytes", Buffer.byteLength(text, "utf8"), found.evidence, "detected");
  return { text, source: found.source, sha256: templateSha256(text) };
}

/**
 * Writes /template/{source,sha256,bytes}. options: {ggufKv, ggufFile} for a
 * GGUF card; ggufOnly skips the folder's files (a single-file GGUF card).
 * Returns {text, source, sha256} or null when there is none.
 */
function detectTemplate(inv, facts, { ggufKv = null, ggufFile = null, ggufOnly = false } = {}) {
  const found = ggufOnly ? null : folderTemplate(inv, facts);
  if (found) return found;
  return ggufTemplate(facts, ggufKv, ggufFile);
}

function folderTemplate(inv, facts) {
  if (fileEntry(inv, "chat_template.jinja")) {
    const text = readTextFile(inv, "chat_template.jinja", facts);
    if (typeof text === "string" && text.length) {
      return record(facts, { text, source: "chat_template.jinja", evidence: { kind: "file", ref: "chat_template.jinja" } });
    }
  }
  const tokenizerConfig = readJsonFile(inv, "tokenizer_config.json", facts);
  const fromTokenizer = tokenizerConfig ? fromTokenizerConfig(tokenizerConfig.chat_template) : null;
  if (fromTokenizer) {
    return record(facts, {
      text: fromTokenizer.text,
      source: "tokenizer_config.json",
      evidence: { kind: "file", ref: `tokenizer_config.json#${fromTokenizer.pointer}` },
      note: fromTokenizer.name ? COPY.namedList(fromTokenizer.name) : undefined,
    });
  }
  const processor = readJsonFile(inv, "chat_template.json", facts);
  if (processor && typeof processor.chat_template === "string" && processor.chat_template.length) {
    return record(facts, { text: processor.chat_template, source: "chat_template.json", evidence: { kind: "file", ref: "chat_template.json#/chat_template" } });
  }
  return null;
}

function ggufTemplate(facts, kv, file) {
  const value = kv ? kv["tokenizer.chat_template"] : undefined;
  const evidence = { kind: "gguf", ref: `${file}#tokenizer.chat_template` };
  if (typeof value === "string" && value.length) return record(facts, { text: value, source: "gguf", evidence });
  if (value && typeof value === "object" && Number.isSafeInteger(value.$string)) {
    facts.set("/template/source", "gguf", evidence, "declared");
    facts.set("/template/bytes", value.$string, evidence, "declared");
    facts.warn("template_too_large", COPY.tooLarge(value.$string));
    return null;
  }
  facts.set("/template/source", "none", { kind: "file", ref: null }, "detected");
  facts.warn("template_missing", COPY.missing);
  return null;
}

module.exports = {
  detectTemplate,
  normalizeTemplateText,
  templateSha256,
};
