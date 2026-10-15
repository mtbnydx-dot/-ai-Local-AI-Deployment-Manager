// Playground /playground (07 §6.6, C13), replacing the classic console's
// multi-turn test bench.
//
// This is one of the two modules that call fetch() directly (the other is
// lib/api.js): the gateway streams server-sent events, which the JSON client
// cannot carry. An owner sends no key. The request goes with the session cookie
// (same-origin) plus api.csrfHeaders(), and 05 attributes it to the
// `console-session` principal. A key field appears only after the gateway
// answered 401 or when the owner asks to test with a specific key; the typed
// key lives in component state, is sent as `Authorization: Bearer`, is never
// stored, logged or shown again, and disappears when the page unmounts.
//
// The transcript and the key live in memory only. No storage is written here.

import { Button } from "../components/button.js";
import { Card } from "../components/card.js";
import { CodeBlock } from "../components/code-block.js";
import { Drawer } from "../components/drawer.js";
import { EmptyState } from "../components/empty-state.js";
import { FormField } from "../components/form-field.js";
import { Icon } from "../components/icon.js";
import { PageHeader } from "../components/page-header.js";
import { describeRoute } from "../lib/route-header.js";
import { parseSseChunk } from "../lib/sse-parse.js";
import { useServices } from "../ui/context.js";
import { useDebounced, useMediaQuery, useQuery, useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useCallback, useEffect, useRef, useState } from "../ui/vendor.js";

const AUTO_TARGET = "auto";
const TOOL_PRESET = Object.freeze({
  tools: [{
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather for a city",
      parameters: { type: "object", properties: { city: { type: "string", description: "City name" } }, required: ["city"] },
    },
  }],
  tool_choice: "auto",
});
// A 1x1 PNG: enough to prove that image input reaches the model.
const VISION_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const KEY_DEBOUNCE_MS = 400;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in test/console/playground.test.js)

/** The gateway base path (host-relative) for a target value: "auto", "engine:<id>" or "external:<id>". */
export function gatewayPath(target) {
  const value = String(target || AUTO_TARGET);
  if (value.startsWith("engine:")) return `/gateway/${encodeURIComponent(value.slice(7))}/openai/v1`;
  if (value.startsWith("external:")) return `/gateway/external/${encodeURIComponent(value.slice(9))}/openai/v1`;
  return "/gateway/auto/openai/v1";
}

function isPlain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Deep merge of plain objects; arrays and scalars in `patch` replace. Returns a new object. */
export function mergePatch(base, patch) {
  if (!isPlain(patch)) return base;
  const out = { ...(isPlain(base) ? base : {}) };
  for (const [name, value] of Object.entries(patch)) {
    out[name] = isPlain(value) && isPlain(out[name]) ? mergePatch(out[name], value) : value;
  }
  return out;
}

/** The ModelCard's optional reasoning toggle `{ on, off }`, or null (05 C8). */
export function reasoningToggleOf(model) {
  const controls = model?.controls;
  const toggle = controls?.reasoningToggle ?? controls?.reasoning_toggle;
  return isPlain(toggle) && (isPlain(toggle.on) || isPlain(toggle.off)) ? toggle : null;
}

/**
 * The chat request body. `reasoning` is merged only when the model's card has
 * the toggle; otherwise the switch only shows or hides `reasoning_content`.
 */
export function buildChatBody({ model, messages, system, temperature, topP, maxTokens, tools = false, showReasoning = true, toggle = null }) {
  const list = [];
  if (typeof system === "string" && system.trim()) list.push({ role: "system", content: system.trim() });
  list.push(...messages);
  let body = { model, messages: list, stream: true, stream_options: { include_usage: true } };
  const number = (value) => (value === "" || value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value));
  if (number(temperature) !== null) body.temperature = number(temperature);
  if (number(topP) !== null) body.top_p = number(topP);
  if (number(maxTokens) !== null) body.max_tokens = Math.trunc(number(maxTokens));
  if (tools) body = { ...body, tools: TOOL_PRESET.tools, tool_choice: TOOL_PRESET.tool_choice };
  if (toggle) body = mergePatch(body, showReasoning ? toggle.on : toggle.off);
  return body;
}

function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

/** The request as a curl command. The key is always `$API_KEY`. */
export function curlCommand({ origin = "", path, body }) {
  return [
    `curl ${shellQuote(`${origin}${path}/chat/completions`)} \\`,
    `  -H "Authorization: Bearer $API_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d ${shellQuote(JSON.stringify(body, null, 2))}`,
  ].join("\n");
}

/** The request as a Python script (openai client). The key is read from `API_KEY`. */
export function pythonSnippet({ origin = "", path, body }) {
  const { model, messages, stream, stream_options: _ignored, ...rest } = body;
  const extra = Object.keys(rest).length ? `,\n    ${Object.entries(rest).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(",\n    ")}` : "";
  return [
    "import os",
    "from openai import OpenAI",
    "",
    `client = OpenAI(base_url=${JSON.stringify(`${origin}${path}`)}, api_key=os.environ["API_KEY"])`,
    "stream = client.chat.completions.create(",
    `    model=${JSON.stringify(model)},`,
    `    messages=${JSON.stringify(messages, null, 4).replace(/\n/g, "\n    ")},`,
    `    stream=${stream ? "True" : "False"}${extra},`,
    ")",
    "for chunk in stream:",
    "    if chunk.choices and chunk.choices[0].delta.content:",
    "        print(chunk.choices[0].delta.content, end=\"\")",
  ].join("\n");
}

/** Folds one streamed chunk's delta into `{ content, reasoning, toolCalls }`; returns the next state. */
export function applyDelta(state, chunk) {
  const delta = chunk?.choices?.[0]?.delta;
  if (!isPlain(delta)) return state;
  const next = { content: state.content, reasoning: state.reasoning, toolCalls: state.toolCalls };
  if (typeof delta.content === "string") next.content += delta.content;
  const reasoning = delta.reasoning_content ?? delta.reasoning;
  if (typeof reasoning === "string") next.reasoning += reasoning;
  if (Array.isArray(delta.tool_calls)) {
    next.toolCalls = state.toolCalls.map((call) => ({ ...call }));
    for (const part of delta.tool_calls) {
      const index = Number.isInteger(part?.index) ? part.index : next.toolCalls.length;
      const call = next.toolCalls[index] || { id: "", name: "", arguments: "" };
      if (typeof part.id === "string") call.id = part.id;
      if (typeof part.function?.name === "string") call.name += part.function.name;
      if (typeof part.function?.arguments === "string") call.arguments += part.function.arguments;
      next.toolCalls[index] = call;
    }
  }
  return next;
}

/** True when the chunk carries output (the moment that ends the time to first token). */
export function hasOutput(chunk) {
  const delta = chunk?.choices?.[0]?.delta;
  if (!isPlain(delta)) return false;
  return Boolean(delta.content || delta.reasoning_content || delta.reasoning || (Array.isArray(delta.tool_calls) && delta.tool_calls.length));
}

/** { ttftMs, totalMs, tokens, tokensPerSecond } from the timings and the final `usage`. */
export function computeStats({ startedAt, firstAt, endedAt, usage }) {
  const totalMs = Math.max(0, endedAt - startedAt);
  const ttftMs = firstAt === null || firstAt === undefined ? null : Math.max(0, firstAt - startedAt);
  const tokens = Number.isFinite(usage?.completion_tokens) ? usage.completion_tokens : null;
  let tokensPerSecond = null;
  if (tokens !== null && tokens > 0) {
    const generationMs = ttftMs !== null && totalMs - ttftMs > 0 ? totalMs - ttftMs : totalMs;
    if (generationMs > 0) tokensPerSecond = tokens / (generationMs / 1000);
  }
  return { ttftMs, totalMs, tokens, tokensPerSecond };
}

/** A tool call as the JSON a CodeBlock shows. */
export function toolCallJson(call) {
  let args = call.arguments;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    // Keep the raw text of a half-streamed or invalid argument string.
  }
  return JSON.stringify({ id: call.id || undefined, name: call.name, arguments: args }, null, 2);
}

// ---------------------------------------------------------------------------
// Gateway requests (the only fetch() calls of the page)

async function isCsrfInvalid(response) {
  if (response.status !== 403) return false;
  try {
    const body = await response.clone().json();
    return body?.error?.code === "csrf_invalid" || body?.code === "csrf_invalid";
  } catch {
    return false;
  }
}

/**
 * One gateway request with the session cookie and `x-csrf-token`, plus
 * `Authorization` only when a key was typed. A 403 `csrf_invalid` re-reads
 * /api/session and retries once (07 §3.4).
 */
export async function gatewayFetch(api, url, { method = "GET", body, signal, key = "" } = {}) {
  const build = () => ({
    method,
    signal,
    credentials: "same-origin",
    headers: {
      accept: body === undefined ? "application/json" : "text/event-stream, application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...api.csrfHeaders(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let response = await fetch(url, build());
  if (await isCsrfInvalid(response)) {
    try {
      const session = await api.get("/api/session");
      if (typeof session?.csrfToken === "string" && session.csrfToken) {
        api.setCsrfToken(session.csrfToken);
        response = await fetch(url, build());
      }
    } catch {
      // The csrf_invalid answer below is what the person sees.
    }
  }
  return response;
}

async function errorOf(response) {
  let message = "";
  let code = "";
  try {
    const body = await response.json();
    message = String(body?.error?.message ?? body?.message ?? (typeof body?.error === "string" ? body.error : "") ?? "");
    code = String(body?.error?.code ?? body?.code ?? "");
  } catch {
    // A non-JSON error body has no message to show.
  }
  return { status: response.status, code, message, requestId: response.headers.get("x-request-id") || null };
}

const now = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

// ---------------------------------------------------------------------------
// Page

function Controls({ values, set, models, modelsState, targets, toggle, needKey, keyOpen, setKeyOpen, apiKey, setApiKey }) {
  const { t } = useT();
  const field = (id, label, help, control, extra = {}) => html`<${FormField} id=${id} label=${label} hint=${help} ...${extra}>${control}<//>`;
  return html`<div class="stack" data-testid="playground.config">
    ${field("pg-target", t("playground.target.label"), t("playground.target.help"), html`<select id="pg-target" class="select" value=${values.target} data-testid="playground.target"
      onChange=${(event) => set({ target: event.currentTarget.value })}>
      <option value=${AUTO_TARGET}>${t("playground.target.auto")}</option>
      ${targets.map((item) => html`<option key=${item.value} value=${item.value}>${item.label}</option>`)}
    </select>`)}
    ${field("pg-model", t("playground.model.label"), modelsState === "failed" ? t("playground.model.failed") : null, html`<select id="pg-model" class="select" value=${values.model} data-testid="playground.model"
      onChange=${(event) => set({ model: event.currentTarget.value })}>
      ${models.length ? models.map((model) => html`<option key=${model.id} value=${model.id}>${model.id}</option>`) : html`<option value="">${modelsState === "loading" ? t("playground.model.loading") : t("playground.model.none")}</option>`}
    </select>`)}
    ${field("pg-system", t("playground.system.label"), null, html`<textarea id="pg-system" class="textarea" rows="3" value=${values.system} placeholder=${t("playground.system.placeholder")} data-testid="playground.system"
      onInput=${(event) => set({ system: event.currentTarget.value })}></textarea>`)}
    ${field("pg-temperature", t("playground.temperature.label"), t("playground.temperature.help"), html`<input id="pg-temperature" class="input" type="number" min="0" max="2" step="0.1" value=${values.temperature} data-testid="playground.temperature"
      onInput=${(event) => set({ temperature: event.currentTarget.value })} />`)}
    ${field("pg-top-p", t("playground.topP.label"), t("playground.topP.help"), html`<input id="pg-top-p" class="input" type="number" min="0" max="1" step="0.05" value=${values.topP} data-testid="playground.top-p"
      onInput=${(event) => set({ topP: event.currentTarget.value })} />`)}
    ${field("pg-max-tokens", t("playground.maxTokens.label"), t("playground.maxTokens.help"), html`<input id="pg-max-tokens" class="input" type="number" min="1" step="1" value=${values.maxTokens} data-testid="playground.max-tokens"
      onInput=${(event) => set({ maxTokens: event.currentTarget.value })} />`)}
    <div class="field">
      <label class="check sf-switch-wrap">
        <input type="checkbox" role="switch" class="sf-switch" checked=${values.showReasoning} data-testid="playground.reasoning-toggle"
          onChange=${(event) => set({ showReasoning: event.currentTarget.checked })} />
        <span>${t("playground.reasoning.label")}</span>
      </label>
      <p class="field-hint">${toggle ? t("playground.reasoning.helpToggle") : t("playground.reasoning.helpShow")}</p>
    </div>
    ${needKey || keyOpen
      ? html`<div class="stack-sm" data-testid="playground.key-panel">
        ${field("pg-key", t("playground.key.label"), needKey ? t("playground.key.needed") : t("playground.key.help"), html`<input id="pg-key" class="input" type="password" autocomplete="off" spellcheck="false" value=${apiKey} data-testid="playground.key"
          onInput=${(event) => setApiKey(event.currentTarget.value)} />`)}
        <div class="row"><${Button} size="sm" label=${t("playground.key.forget")} testid="playground.key-forget" onClick=${() => { setApiKey(""); setKeyOpen(false); }} /></div>
      </div>`
      : html`<div><${Button} size="sm" icon="key-round" label=${t("playground.key.open")} testid="playground.key-open" onClick=${() => setKeyOpen(true)} /></div>`}
  </div>`;
}

function MessageStats({ message }) {
  const { t } = useT();
  const { formatters, bootstrap } = useServices();
  const stats = message.stats;
  const parts = [];
  if (stats) {
    if (stats.ttftMs !== null) parts.push(t("playground.stats.ttft", { value: formatters.duration(stats.ttftMs) }));
    parts.push(t("playground.stats.total", { value: formatters.duration(stats.totalMs) }));
    if (stats.tokensPerSecond !== null) parts.push(formatters.rate(stats.tokensPerSecond, t("playground.stats.unit")));
    if (stats.tokens !== null) parts.push(t("playground.stats.tokens", { count: stats.tokens }));
  }
  const telemetry = Boolean(bootstrap?.features?.telemetry);
  return html`<span class="pg-meta" data-testid="playground.stats">
    ${message.route ? html`<span class="badge badge-neutral" title=${t("playground.route.title")} data-testid="playground.route">${message.route}</span>` : null}
    ${parts.length ? html`<span class="pg-timing" data-testid="playground.timing">${parts.join(" · ")}</span>` : null}
    ${message.requestId
      ? (telemetry
        ? html`<a class="pg-request" href=${`/observability/requests/${encodeURIComponent(message.requestId)}`} data-testid="playground.request-link">${t("playground.request.label", { id: message.requestId })}</a>`
        : html`<span class="pg-request" data-testid="playground.request-id">${t("playground.request.label", { id: message.requestId })}</span>`)
      : null}
  </span>`;
}

function Turn({ message, showReasoning }) {
  const { t } = useT();
  const user = message.role === "user";
  return html`<article class=${`pg-turn ${user ? "pg-user" : "pg-assistant"}`} data-testid=${user ? "playground.turn.user" : "playground.turn.assistant"} data-pending=${message.pending ? "true" : "false"}>
    <header class="pg-turn-head">
      <strong>${user ? t("playground.role.user") : t("playground.role.assistant")}</strong>
      ${user ? null : html`<${MessageStats} message=${message} />`}
    </header>
    ${!user && showReasoning && message.reasoning
      ? html`<details class="pg-reasoning" open=${message.pending} data-testid="playground.reasoning">
        <summary>${t("playground.reasoning.block")}</summary>
        <div class="pg-body pg-body-muted" data-testid="playground.reasoning-text">${message.reasoning}</div>
      </details>`
      : null}
    ${message.image ? html`<p class="muted small">${t("playground.vision.attached")}</p>` : null}
    ${message.content
      ? html`<div class="pg-body" data-testid=${user ? "playground.user-text" : "playground.content"}>${message.content}</div>`
      : (message.pending && !message.toolCalls?.length && !message.reasoning ? html`<div class="pg-body muted">${t("playground.pending")}</div>` : null)}
    ${(message.toolCalls || []).map((call, index) => html`<div key=${index} class="pg-tool" data-testid="playground.tool-call">
      <div class="small muted">${t("playground.toolCall")}</div>
      <${CodeBlock} code=${toolCallJson(call)} language="json" wrap />
    </div>`)}
    ${message.error
      ? html`<p class="pg-error" role="alert" data-testid="playground.error">${message.error}</p>`
      : null}
    ${message.stopped ? html`<p class="muted small">${t("playground.stopped")}</p>` : null}
  </article>`;
}

export default function Playground() {
  const { t } = useT();
  const { api, bootstrap } = useServices();
  const narrow = useMediaQuery("(max-width: 767px)");
  const [values, setValues] = useState({ target: AUTO_TARGET, model: "", system: "", temperature: "", topP: "", maxTokens: "", showReasoning: true });
  const [apiKey, setApiKey] = useState("");
  const [keyOpen, setKeyOpen] = useState(false);
  const [needKey, setNeedKey] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [preset, setPreset] = useState(null);
  const [streaming, setStreaming] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [models, setModels] = useState({ state: "loading", list: [] });
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const keyRef = useRef(apiKey);
  keyRef.current = apiKey;
  const controllerRef = useRef(null);
  const counter = useRef(0);
  const transcriptRef = useRef(null);
  const set = useCallback((patch) => setValues((current) => ({ ...current, ...patch })), []);
  const appliedKey = useDebounced(apiKey, KEY_DEBOUNCE_MS);
  // A 401 shows the key field and keeps it, so a typed key never vanishes once it works.
  const requireKey = () => {
    setNeedKey(true);
    setKeyOpen(true);
  };

  // Targets: engines and external endpoints, when the entry lists them (01).
  const engines = useQuery(["playground", "engines"], () => api.get("/api/engines"), { ttlMs: 30000 });
  const externals = useQuery(["playground", "external"], () => api.get("/api/engines/external/endpoints"), { ttlMs: 30000 });
  const targets = [
    ...(Array.isArray(engines.data?.engines) ? engines.data.engines.filter((item) => item?.engineId).map((item) => ({ value: `engine:${item.engineId}`, label: t("playground.target.engine", { id: item.label || item.engineId }) })) : []),
    ...(Array.isArray(externals.data?.endpoints) ? externals.data.endpoints.filter((item) => item?.endpointId || item?.id).map((item) => {
      const id = item.endpointId || item.id;
      return { value: `external:${id}`, label: t("playground.target.external", { id: item.label || item.name || id }) };
    }) : []),
  ];

  // Nothing is left behind on navigation: the stream stops, the key is dropped.
  useEffect(() => () => {
    controllerRef.current?.abort();
    keyRef.current = "";
  }, []);

  // Models of the chosen target (and key).
  useEffect(() => {
    const controller = new AbortController();
    setModels((current) => ({ state: "loading", list: current.list }));
    (async () => {
      try {
        const response = await gatewayFetch(api, `${gatewayPath(values.target)}/models`, { signal: controller.signal, key: appliedKey });
        if (!response.ok) {
          const error = await errorOf(response);
          if (error.status === 401) requireKey();
          setModels({ state: "failed", list: [] });
          return;
        }
        const payload = await response.json();
        setNeedKey(false);
        setModels({ state: "ready", list: Array.isArray(payload?.data) ? payload.data.filter((item) => item && typeof item.id === "string") : [] });
      } catch {
        if (!controller.signal.aborted) setModels({ state: "failed", list: [] });
      }
    })();
    return () => controller.abort();
  }, [values.target, appliedKey]);

  // Keep a valid model selected.
  useEffect(() => {
    if (!models.list.length) return;
    if (!models.list.some((model) => model.id === values.model)) set({ model: models.list[0].id });
  }, [models.list]);

  useEffect(() => {
    const element = transcriptRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages]);

  const model = models.list.find((item) => item.id === values.model) || null;
  const toggle = reasoningToggleOf(model);
  const visionOk = Boolean(model?.capabilities?.vision);

  const bodyFor = (history, withTools) => buildChatBody({
    model: values.model, messages: history, system: values.system, temperature: values.temperature, topP: values.topP,
    maxTokens: values.maxTokens, tools: withTools, showReasoning: values.showReasoning, toggle,
  });

  const patchMessage = (id, update) => setMessages((list) => list.map((item) => (item.id === id ? { ...item, ...(typeof update === "function" ? update(item) : update) } : item)));

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    if (!values.model) {
      patchStatus(t("playground.model.pick"));
      return;
    }
    const withImage = preset === "vision";
    const withTools = preset === "tools";
    const id = (counter.current += 1);
    const user = { id: `u${id}`, role: "user", content: text, image: withImage };
    const assistant = { id: `a${id}`, role: "assistant", content: "", reasoning: "", toolCalls: [], pending: true, route: "", requestId: null, stats: null };
    const history = messagesRef.current
      .filter((item) => !item.error && (item.role === "user" || item.content))
      .map((item) => ({ role: item.role, content: item.image ? [{ type: "text", text: item.content }, { type: "image_url", image_url: { url: VISION_IMAGE } }] : item.content }));
    history.push({ role: "user", content: withImage ? [{ type: "text", text }, { type: "image_url", image_url: { url: VISION_IMAGE } }] : text });
    setMessages((list) => [...list, user, assistant]);
    setInput("");
    setStreaming(true);

    const controller = new AbortController();
    controllerRef.current = controller;
    const startedAt = now();
    let firstAt = null;
    let usage = null;
    let state = { content: "", reasoning: "", toolCalls: [] };
    try {
      const response = await gatewayFetch(api, `${gatewayPath(values.target)}/chat/completions`, { method: "POST", body: bodyFor(history, withTools), signal: controller.signal, key: keyRef.current });
      const route = describeRoute(response)?.text || "";
      const requestId = response.headers.get("x-request-id") || null;
      patchMessage(assistant.id, { route, requestId });
      if (!response.ok) {
        const error = await errorOf(response);
        if (error.status === 401) requireKey();
        patchMessage(assistant.id, { pending: false, error: t("playground.error.status", { status: error.status, message: error.message || error.code || "" }), requestId: error.requestId || requestId });
        return;
      }
      if (/\bjson\b/i.test(response.headers.get("content-type") || "") && !/event-stream/i.test(response.headers.get("content-type") || "")) {
        const payload = await response.json();
        const choice = payload?.choices?.[0]?.message || {};
        state = applyDelta(state, { choices: [{ delta: { content: choice.content, reasoning_content: choice.reasoning_content, tool_calls: (choice.tool_calls || []).map((call, index) => ({ ...call, index })) } }] });
        usage = payload?.usage || null;
        firstAt = now();
      } else {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parsed = parseSseChunk(buffer);
          buffer = parsed.rest;
          let changed = false;
          for (const event of parsed.events) {
            if (event.done || !event.data) continue;
            if (event.data.usage) usage = event.data.usage;
            if (firstAt === null && hasOutput(event.data)) firstAt = now();
            const next = applyDelta(state, event.data);
            if (next !== state) changed = true;
            state = next;
          }
          if (changed) patchMessage(assistant.id, { content: state.content, reasoning: state.reasoning, toolCalls: state.toolCalls });
        }
      }
      patchMessage(assistant.id, { content: state.content, reasoning: state.reasoning, toolCalls: state.toolCalls, pending: false, stats: computeStats({ startedAt, firstAt, endedAt: now(), usage }) });
    } catch (error) {
      if (controller.signal.aborted) {
        patchMessage(assistant.id, { content: state.content, reasoning: state.reasoning, toolCalls: state.toolCalls, pending: false, stopped: true, stats: computeStats({ startedAt, firstAt, endedAt: now(), usage }) });
      } else {
        patchMessage(assistant.id, { pending: false, error: t("playground.error.network") });
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setStreaming(false);
    }
  }

  function patchStatus(text) {
    setMessages((list) => [...list, { id: `n${(counter.current += 1)}`, role: "assistant", content: "", error: text }]);
  }

  function choosePreset(name) {
    if (preset === name) {
      setPreset(null);
      return;
    }
    setPreset(name);
    setInput(t(name === "tools" ? "playground.preset.toolsPrompt" : "playground.preset.visionPrompt"));
  }

  function stop() {
    controllerRef.current?.abort();
  }

  function clear() {
    stop();
    setMessages([]);
  }

  const exportBody = () => {
    const last = [...messagesRef.current].reverse().find((item) => item.role === "user");
    const history = messagesRef.current.filter((item) => !item.error && (item.role === "user" || item.content)).map((item) => ({ role: item.role, content: item.content }));
    return bodyFor(history.length ? history : [{ role: "user", content: last?.content || t("playground.preset.toolsPrompt") }], preset === "tools");
  };
  const origin = globalThis.location?.origin || "";
  const [exportKind, setExportKind] = useState(null);
  const exportCode = exportKind
    ? (exportKind === "curl" ? curlCommand({ origin, path: gatewayPath(values.target), body: exportBody() }) : pythonSnippet({ origin, path: gatewayPath(values.target), body: exportBody() }))
    : "";

  const controls = html`<${Controls} values=${values} set=${set} models=${models.list} modelsState=${models.state} targets=${targets} toggle=${toggle}
    needKey=${needKey} keyOpen=${keyOpen} setKeyOpen=${setKeyOpen} apiKey=${apiKey} setApiKey=${setApiKey} />`;

  return html`<div class="stack" data-testid="playground.root">
    <${PageHeader} title=${t("playground.title")} subtitle=${t("playground.subtitle")}
      actions=${narrow ? html`<${Button} icon="settings" label=${t("playground.config.open")} testid="playground.config-open" onClick=${() => setDrawer(true)} />` : null} />
    <div class="pg-layout">
      ${narrow ? null : html`<${Card} title=${t("playground.config.title")} testid="playground.config-card">${controls}<//>`}
      <section class="pg-main stack" aria-label=${t("playground.transcript.label")}>
        <div class="pg-transcript" ref=${transcriptRef} role="log" aria-live="polite" tabindex="0" data-testid="playground.transcript">
          ${messages.length
            ? messages.map((message) => html`<${Turn} key=${message.id} message=${message} showReasoning=${values.showReasoning} />`)
            : html`<${EmptyState} icon="message-square" title=${t("playground.empty.title")} body=${t("playground.empty.body")} action=${{ label: t("playground.preset.tools"), onClick: () => choosePreset("tools") }} testid="playground.empty" />`}
        </div>
        <form class="pg-composer stack-sm" onSubmit=${(event) => { event.preventDefault(); send(); }} data-testid="playground.form">
          <div class="row">
            <${Button} size="sm" label=${t("playground.preset.tools")} testid="playground.preset-tools" onClick=${() => choosePreset("tools")} class=${preset === "tools" ? "pg-preset-on" : ""} aria-pressed=${preset === "tools"} />
            ${visionOk ? html`<${Button} size="sm" label=${t("playground.preset.vision")} testid="playground.preset-vision" onClick=${() => choosePreset("vision")} class=${preset === "vision" ? "pg-preset-on" : ""} aria-pressed=${preset === "vision"} />` : null}
            <${Button} size="sm" icon="copy" label=${t("playground.export.curl")} testid="playground.export-curl" onClick=${() => setExportKind(exportKind === "curl" ? null : "curl")} />
            <${Button} size="sm" icon="copy" label=${t("playground.export.python")} testid="playground.export-python" onClick=${() => setExportKind(exportKind === "python" ? null : "python")} />
            <${Button} size="sm" label=${t("playground.clear")} testid="playground.clear" disabled=${!messages.length} onClick=${clear} />
          </div>
          ${exportKind ? html`<${CodeBlock} code=${exportCode} language=${exportKind === "curl" ? "bash" : "python"} testid="playground.export-code" />` : null}
          <label class="sr-only" for="pg-input">${t("playground.input.label")}</label>
          <textarea id="pg-input" class="textarea" rows="3" value=${input} placeholder=${t("playground.input.placeholder")} data-testid="playground.input"
            onInput=${(event) => setInput(event.currentTarget.value)}
            onKeyDown=${(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send(); } }}></textarea>
          <div class="row">
            <${Button} variant="primary" type="submit" label=${t("playground.send")} busy=${streaming} testid="playground.send" />
            ${streaming ? html`<${Button} variant="danger" label=${t("playground.stop")} testid="playground.stop" onClick=${stop} />` : null}
            <span class="muted small">${t("playground.privacy")}</span>
          </div>
        </form>
      </section>
    </div>
    ${narrow ? html`<${Drawer} open=${drawer} title=${t("playground.config.title")} onClose=${() => setDrawer(false)} testid="playground.drawer">${controls}<//>` : null}
  </div>`;
}
