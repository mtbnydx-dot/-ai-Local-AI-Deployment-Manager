// Playground (05 §12.6). Talks to the key's own /v1/models and
// /v1/chat/completions from the browser: streaming, a Stop button, TTFT,
// tokens per second and cost per answer, and "Copy as curl / Python / Node"
// built from the very request object that is sent. The conversation lives in
// this tab's memory only.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { html } from "../lib/html.js";
import { usePortal, usePageTitle } from "../lib/context.js";
import { useResource } from "../lib/hooks.js";
import { ApiError, getKeyModels } from "../lib/api.js";
import { formatCredits, formatInteger, formatMilliseconds } from "../lib/format.js";
import {
  DEFAULT_MAX_TOKENS, MAX_MESSAGE_CHARS, MAX_SYSTEM_CHARS, SNIPPET_RENDERERS,
  buildChatRequest, clampNumber, computeCost, keyIsInsertable, maxTokensCap, pickModel, readPlaygroundModels, runChat,
} from "../lib/playground.js";
import { templateContext } from "../lib/snippets.js";
import { CodeBlock } from "../components/code-block.js";
import { EmptyState, ErrorNotice, Loading, errorMessage } from "../components/notice.js";

const FORMATS = ["curl", "python", "node"];
let counter = 0;
const nextId = () => `m${(counter += 1)}`;

function wantedModel() {
  try {
    return new URLSearchParams(window.location.search).get("model") || "";
  } catch {
    return "";
  }
}

function Stats({ stats, model }) {
  const { t, lang } = usePortal();
  if (!stats) return null;
  const dash = "—";
  const cost = !stats.estimated ? computeCost(model?.pricing, { inputTokens: stats.inputTokens, cachedTokens: stats.cachedTokens, outputTokens: stats.outputTokens }) : null;
  const approx = stats.estimated ? "≈ " : "";
  return html`<dl class="msg-stats" data-testid="msg-stats">
    <div><dt>${t("pg.stat.tokens")}</dt><dd data-stat="tokens">${stats.inputTokens === null ? "" : html`${t("pg.stat.in")} ${formatInteger(stats.inputTokens, lang)}${stats.cachedTokens ? ` (${t("pg.stat.cached", { count: formatInteger(stats.cachedTokens, lang) })})` : ""} · `}${t("pg.stat.out")} ${approx}${formatInteger(stats.outputTokens, lang)}</dd></div>
    <div><dt>${t("pg.stat.ttft")}</dt><dd data-stat="ttft">${formatMilliseconds(stats.ttftMs) || dash}</dd></div>
    <div><dt>${t("pg.stat.speed")}</dt><dd data-stat="speed">${stats.tokensPerSecond === null ? dash : html`${approx}${stats.tokensPerSecond} ${t("pg.stat.tps")}`}</dd></div>
    <div><dt>${t("pg.stat.cost")}</dt><dd data-stat="cost">${cost === null ? dash : html`${formatCredits(cost)} ${t("pg.stat.credits")}`}</dd></div>
  </dl>`;
}

function Message({ message, model }) {
  const { t } = usePortal();
  const mine = message.role === "user";
  return html`<article class=${`msg msg-${message.role}`} data-role=${message.role} data-status=${message.status || "done"}>
    <h3 class="msg-role">${mine ? t("pg.you") : t("pg.assistant")}</h3>
    ${message.reasoning ? html`<details class="msg-reasoning"><summary>${t("pg.thinking")}</summary><p class="msg-text">${message.reasoning}</p></details>` : null}
    ${message.content || mine ? html`<p class="msg-text" data-testid=${mine ? "user-text" : "assistant-text"}>${message.content}</p>` : null}
    ${message.status === "streaming" && !message.content && !message.reasoning ? html`<p class="muted" role="status">${t("pg.waiting")}</p>` : null}
    ${message.status === "stopped" ? html`<p class="muted small" data-testid="stopped-note">${t("pg.stopped")}</p>` : null}
    ${message.error ? html`<div class="notice notice-error" role="alert"><p>${errorMessage(t, message.error)}</p>
      ${message.error.requestId ? html`<p class="muted small">${t("common.request_id")} <code>${message.error.requestId}</code></p>` : null}
      ${[401, 403].includes(message.error.status) && message.error.code !== "scope_denied" ? html`<p><a href="/me">${t("pg.fix_key")}</a></p>` : null}</div>` : null}
    ${message.stats ? html`<${Stats} stats=${message.stats} model=${model} />` : null}
  </article>`;
}

function Controls({ model, models, settings, onChange, disabled }) {
  const { t } = usePortal();
  const cap = maxTokensCap(model);
  return html`<section class="card pg-controls" aria-labelledby="pg-controls-title">
    <h2 id="pg-controls-title" class="section-title">${t("pg.controls")}</h2>
    <div class="field">
      <label for="pg-model">${t("pg.model")}</label>
      <select id="pg-model" value=${model.id} disabled=${disabled} onChange=${(event) => onChange({ modelId: event.currentTarget.value })}>
        ${models.map((item) => html`<option value=${item.id} selected=${item.id === model.id}>${item.name === item.id ? item.id : `${item.name} (${item.id})`}</option>`)}
      </select>
      <p class="muted small">${t("pg.model_help")}</p>
    </div>
    <div class="field">
      <label for="pg-system">${t("pg.system")}</label>
      <textarea id="pg-system" rows="3" maxlength=${MAX_SYSTEM_CHARS} value=${settings.system} placeholder=${t("pg.system_placeholder")} onInput=${(event) => onChange({ system: event.currentTarget.value })}></textarea>
      <p class="muted small">${t("pg.system_help")}</p>
    </div>
    <div class="field">
      <label for="pg-temperature">${t("pg.temperature")}</label>
      <input id="pg-temperature" type="number" min="0" max="2" step="0.1" value=${settings.temperature} inputmode="decimal" onInput=${(event) => onChange({ temperature: event.currentTarget.value })} />
      <p class="muted small">${t("pg.temperature_help")}</p>
    </div>
    <div class="field">
      <label for="pg-top-p">${t("pg.top_p")}</label>
      <input id="pg-top-p" type="number" min="0" max="1" step="0.05" value=${settings.topP} inputmode="decimal" onInput=${(event) => onChange({ topP: event.currentTarget.value })} />
      <p class="muted small">${t("pg.top_p_help")}</p>
    </div>
    <div class="field">
      <label for="pg-max-tokens">${t("pg.max_tokens")}</label>
      <input id="pg-max-tokens" type="number" min="1" max=${cap} step="1" value=${settings.maxTokens} inputmode="numeric" onInput=${(event) => onChange({ maxTokens: event.currentTarget.value })} />
      <p class="muted small">${t("pg.max_tokens_help", { max: formatInteger(cap) })}</p>
    </div>
    ${model.reasoningToggle
      ? html`<div class="field">
        <label for="pg-reasoning">${t("pg.reasoning")}</label>
        <select id="pg-reasoning" value=${settings.reasoning} onChange=${(event) => onChange({ reasoning: event.currentTarget.value })}>
          <option value="default" selected=${settings.reasoning === "default"}>${t("pg.reasoning_default")}</option>
          <option value="on" selected=${settings.reasoning === "on"}>${t("pg.reasoning_on")}</option>
          <option value="off" selected=${settings.reasoning === "off"}>${t("pg.reasoning_off")}</option>
        </select>
        <p class="muted small">${t("pg.reasoning_help")}</p>
      </div>`
      : null}
    <p class="muted small pg-privacy">${t("pg.privacy")}</p>
  </section>`;
}

function CopyAs({ request, previewing, keyValue }) {
  const { t, config } = usePortal();
  const [format, setFormat] = useState("curl");
  const [includeKey, setIncludeKey] = useState(false);
  const insertable = keyIsInsertable(keyValue);
  const base = templateContext({ config, origin: window.location.origin }).OPENAI_BASE;
  const code = SNIPPET_RENDERERS[format](request, { baseUrl: base, key: keyValue, includeKey: includeKey && insertable });
  return html`<section class="card pg-copy" aria-labelledby="pg-copy-title" data-testid="copy-as">
    <h2 id="pg-copy-title" class="section-title">${t("pg.copy.title")}</h2>
    <p class="muted small">${previewing ? t("pg.copy.preview") : t("pg.copy.last")}</p>
    <div class="toolbar">
      <div class="filters" role="group" aria-label=${t("pg.copy.format")}>
        ${FORMATS.map((name) => html`<button type="button" class=${`filter${format === name ? " is-on" : ""}`} aria-pressed=${String(format === name)} data-format=${name} onClick=${() => setFormat(name)}>${t(`pg.copy.${name}`)}</button>`)}
      </div>
      <label class="check">
        <input type="checkbox" checked=${includeKey && insertable} disabled=${!insertable} onChange=${(event) => setIncludeKey(event.currentTarget.checked)} />
        <span>${t("pg.copy.include_key")}</span>
      </label>
    </div>
    ${includeKey && insertable ? html`<p class="notice notice-warn" role="status">${t("pg.copy.key_warning")}</p>` : html`<p class="muted small">${t("pg.copy.env_hint")}</p>`}
    <${CodeBlock} code=${code} language=${format} label=${t(`pg.copy.label_${format}`)} />
  </section>`;
}

function Chat({ keyValue, models }) {
  const { t, lang } = usePortal();
  const wanted = useMemo(wantedModel, []);
  const [modelId, setModelId] = useState(() => pickModel(models, wanted)?.id || "");
  const model = models.find((item) => item.id === modelId) || models[0];
  const [settings, setSettings] = useState({ system: "", temperature: "0.7", topP: "1", maxTokens: String(Math.min(DEFAULT_MAX_TOKENS, maxTokensCap(model))), reasoning: "default" });
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [lastRequest, setLastRequest] = useState(null);
  const controller = useRef(null);
  const endRef = useRef(null);

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    const end = endRef.current;
    if (end && typeof end.scrollIntoView === "function") end.scrollIntoView({ block: "nearest" });
  }, [messages]);

  function change(patch) {
    if (patch.modelId !== undefined) {
      setModelId(patch.modelId);
      const next = models.find((item) => item.id === patch.modelId);
      // A different model has a different output cap and may not have the reasoning toggle.
      setSettings((previous) => ({
        ...previous,
        reasoning: next?.reasoningToggle ? previous.reasoning : "default",
        maxTokens: String(Math.min(Number(previous.maxTokens) || DEFAULT_MAX_TOKENS, maxTokensCap(next))),
      }));
      return;
    }
    setSettings((previous) => ({ ...previous, ...patch }));
  }

  const history = messages.filter((item) => item.status !== "error" && (item.role === "user" || item.content)).map((item) => ({ role: item.role, content: item.content }));
  const numbers = () => ({
    temperature: clampNumber(settings.temperature, 0, 2, 0.7),
    topP: clampNumber(settings.topP, 0, 1, 1),
    maxTokens: Math.floor(clampNumber(settings.maxTokens, 1, maxTokensCap(model), Math.min(DEFAULT_MAX_TOKENS, maxTokensCap(model)))),
  });
  const requestFor = (extra) => buildChatRequest({ model: model.id, system: settings.system, messages: [...history, extra], reasoning: settings.reasoning, ...numbers() }, model);
  const preview = requestFor({ role: "user", content: draft.trim() || t("pg.example_prompt") });

  async function send(event) {
    event?.preventDefault();
    const text = draft.trim().slice(0, MAX_MESSAGE_CHARS);
    if (!text || running) return;
    const request = requestFor({ role: "user", content: text });
    const answerId = nextId();
    setLastRequest(request);
    setDraft("");
    setRunning(true);
    setMessages((list) => [...list, { id: nextId(), role: "user", content: text }, { id: answerId, role: "assistant", content: "", reasoning: "", status: "streaming" }]);
    const patch = (change) => setMessages((list) => list.map((item) => (item.id === answerId ? { ...item, ...change(item) } : item)));
    controller.current = new AbortController();
    try {
      const stats = await runChat({
        request,
        key: keyValue,
        signal: controller.current.signal,
        onDelta: (delta) => patch((item) => ({ content: item.content + delta.content, reasoning: item.reasoning + delta.reasoning })),
      });
      patch(() => ({ status: stats.stopped ? "stopped" : "done", stats }));
    } catch (error) {
      patch(() => ({ status: "error", error: error instanceof ApiError ? error : new ApiError("Request failed", { code: "generic" }) }));
    } finally {
      controller.current = null;
      setRunning(false);
    }
  }

  const stop = () => controller.current?.abort();
  const clear = () => {
    controller.current?.abort();
    setMessages([]);
    setLastRequest(null);
  };

  return html`<div class="pg-layout">
    <${Controls} model=${model} models=${models} settings=${settings} onChange=${change} disabled=${running} />
    <div class="pg-main">
      <section class="card pg-chat" aria-labelledby="pg-chat-title">
        <div class="card-head">
          <h2 id="pg-chat-title" class="section-title">${t("pg.conversation")}</h2>
          <button type="button" class="btn btn-small" onClick=${clear} disabled=${!messages.length}>${t("pg.clear")}</button>
        </div>
        <div class="msg-list" role="log" aria-busy=${String(running)} aria-label=${t("pg.conversation")} data-testid="transcript">
          ${messages.length ? messages.map((item) => html`<${Message} key=${item.id} message=${item} model=${model} />`) : html`<p class="muted">${t("pg.empty")}</p>`}
          <div ref=${endRef}></div>
        </div>
        <form class="pg-form" onSubmit=${send}>
          <div class="field">
            <label for="pg-input">${t("pg.input")}</label>
            <textarea id="pg-input" rows="3" maxlength=${MAX_MESSAGE_CHARS} value=${draft} placeholder=${t("pg.input_placeholder")}
              onInput=${(event) => setDraft(event.currentTarget.value)}
              onKeyDown=${(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) send(event); }}></textarea>
          </div>
          <p class="card-actions">
            <button type="submit" class="btn btn-primary" disabled=${running || !draft.trim()}>${t("pg.send")}</button>
            ${running ? html`<button type="button" class="btn" onClick=${stop}>${t("pg.stop")}</button>` : null}
            <span class="muted small">${t("pg.send_hint")}</span>
          </p>
        </form>
      </section>
      <${CopyAs} request=${lastRequest || preview} previewing=${!lastRequest} keyValue=${keyValue} />
    </div>
  </div>`;
}

export default function PlaygroundPage() {
  const { t, key, config } = usePortal();
  usePageTitle(t("nav.playground"));
  const list = useResource((signal) => getKeyModels(key, { signal }), [key], { enabled: Boolean(key) && config.features?.playground !== false });
  const models = useMemo(() => (list.data ? readPlaygroundModels(list.data) : null), [list.data]);
  const rejected = [401, 403].includes(list.error?.status) && list.error?.code !== "scope_denied";

  let body;
  if (config.features?.playground === false) {
    body = html`<${EmptyState} title=${t("pg.disabled")}><p class="muted">${t("pg.disabled_hint")}</p><//>`;
  } else if (!key) {
    body = html`<section class="card" aria-labelledby="pg-nokey-title"><h2 id="pg-nokey-title" class="section-title">${t("pg.need_key")}</h2>
      <p class="card-text">${t("pg.need_key_text")}</p><p class="card-actions"><a class="btn btn-primary" href="/me">${t("pg.need_key_link")}</a></p></section>`;
  } else if (list.error && !models) {
    body = rejected
      ? html`<p class="notice notice-warn" role="alert">${t("pg.key_rejected")} <a href="/me">${t("models.key_manage")}</a></p>`
      : html`<${ErrorNotice} error=${list.error} onRetry=${list.reload} />`;
  } else if (!models) {
    body = html`<${Loading} />`;
  } else if (!models.length) {
    body = html`<${EmptyState} title=${t("pg.no_models")}><p class="muted">${t("pg.no_models_hint")}</p><//>`;
  } else {
    body = html`<${Chat} key=${key} keyValue=${key} models=${models} />`;
  }
  return html`<div class="page page-playground">
    <h1>${t("pg.title")}</h1>
    <p class="lead">${t("pg.lead")}</p>
    ${body}
  </div>`;
}
