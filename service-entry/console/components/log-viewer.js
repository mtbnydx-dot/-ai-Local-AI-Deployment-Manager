// LogViewer (07 §4.4): a tail of an instance, job or component log. It keeps
// a 5000-line ring buffer, highlights a search, filters by level, follows the
// end of the log, and pauses following as soon as the person scrolls up
// ("jump to latest" resumes). The text is shown exactly as the server
// redacted it; nothing here parses or rewrites secrets.
//
// Where lines come from:
//   instance  GET /api/m/<managerId>/instances/<id>/logs?tail=&since=   (01, polled)
//   job       GET /api/m/<managerId>/jobs/<id>                          (polled)
//   component GET /api/platform/components/<id>/logs?tail=              (06, polled)
// Polling runs every `pollMs` (2 s) while the tab is visible. A reply with a
// cursor is appended to the buffer; a reply without one replaces it (the
// server returned a fresh tail). `load` replaces the built-in fetch.

import { describeError } from "../lib/api.js";
import { useServices } from "../ui/context.js";
import { useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "../ui/vendor.js";
import { Button } from "./button.js";
import { copyText } from "./code-block.js";

export const RING_LIMIT = 5000;
const BOTTOM_SLACK = 8;

const LEVEL_RANK = { error: 3, warn: 2, info: 1, other: 0 };
const ERROR_RE = /\b(?:ERROR|FATAL|CRITICAL|Traceback)\b|\[E\]/;
const WARN_RE = /\bWARN(?:ING)?\b|\[W\]/i;
const INFO_RE = /\bINFO\b|\[I\]/;

/** "error" | "warn" | "info" | "other" for one log line. */
export function levelOf(line) {
  const text = String(line ?? "");
  if (ERROR_RE.test(text)) return "error";
  if (WARN_RE.test(text)) return "warn";
  if (INFO_RE.test(text)) return "info";
  return "other";
}

/** Whether `line` passes a level filter: "all", or a minimum severity ("error" is within "warn" is within "info"). */
export function passesLevel(line, filter) {
  if (!filter || filter === "all") return true;
  const level = levelOf(line);
  return level !== "other" && LEVEL_RANK[level] >= (LEVEL_RANK[filter] ?? 0);
}

/** `existing` plus `added`, trimmed to the newest `limit` lines. */
export function appendLines(existing, added, limit = RING_LIMIT) {
  const merged = added.length ? existing.concat(added) : existing;
  return merged.length > limit ? merged.slice(merged.length - limit) : merged;
}

function lineText(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const body = entry.message ?? entry.text ?? entry.line ?? "";
    const text = typeof body === "string" ? body : JSON.stringify(body);
    const stamp = typeof entry.at === "string" ? entry.at : typeof entry.ts === "string" ? entry.ts : "";
    return stamp ? `${stamp} ${text}` : text;
  }
  return String(entry ?? "");
}

/** Lines out of the several reply shapes of 01 and 06: { lines } | { text } | { logs } | { log } | an array. */
export function normalizeLogPayload(payload) {
  let source = payload;
  if (payload && !Array.isArray(payload) && typeof payload === "object") {
    source = payload.lines ?? payload.text ?? payload.logs ?? payload.log ?? payload.job?.logs ?? payload.job?.log ?? "";
  }
  const lines = Array.isArray(source) ? source.map(lineText) : String(source ?? "").split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const cursor = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.cursor ?? payload.nextSince ?? null : null;
  return { lines, cursor: typeof cursor === "string" || typeof cursor === "number" ? cursor : null };
}

/** The request for one poll of a `source`; null when the kind is unknown. */
export function logRequest(source, { tail, cursor } = {}) {
  const raw = source?.id;
  if (raw === undefined || raw === null || raw === "") return null;
  const id = encodeURIComponent(String(raw));
  if (source.kind === "instance" && source.managerId) {
    return { manager: source.managerId, path: `/instances/${id}/logs`, query: { tail, since: cursor ?? undefined } };
  }
  if (source.kind === "job" && source.managerId) return { manager: source.managerId, path: `/jobs/${id}`, query: {} };
  if (source.kind === "component") return { path: `/api/platform/components/${id}/logs`, query: { tail } };
  return null;
}

/** Splits `line` around case-insensitive matches of `query`: [{ text, match }]. */
export function highlightParts(line, query) {
  const needle = String(query || "").toLowerCase();
  if (!needle) return [{ text: line, match: false }];
  const lower = line.toLowerCase();
  const parts = [];
  let at = 0;
  for (let found = lower.indexOf(needle); found >= 0; found = lower.indexOf(needle, at)) {
    if (found > at) parts.push({ text: line.slice(at, found), match: false });
    parts.push({ text: line.slice(found, found + needle.length), match: true });
    at = found + needle.length;
  }
  if (at < line.length) parts.push({ text: line.slice(at), match: false });
  return parts.length ? parts : [{ text: line, match: false }];
}

function download(name, text) {
  try {
    const url = globalThis.URL.createObjectURL(new globalThis.Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = globalThis.document.createElement("a");
    link.href = url;
    link.download = name;
    link.rel = "noopener";
    globalThis.document.body.appendChild(link);
    link.click();
    link.remove();
    globalThis.setTimeout(() => globalThis.URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

function tabHidden(services) {
  try {
    if (services.visibility?.hidden) return Boolean(services.visibility.hidden());
    return Boolean(globalThis.document?.hidden);
  } catch {
    return false;
  }
}

// source { kind: job|instance|component, managerId, id }; follow is the initial follow state;
// load({ tail, cursor }) returns a payload and replaces the built-in fetch; lines seeds a static log.
export function LogViewer({ source, follow = true, initialTail = 500, pollMs = 2000, load, lines: seed, label, testid }) {
  const { t } = useT();
  const services = useServices();
  const [lines, setLines] = useState(() => (Array.isArray(seed) ? appendLines([], seed.map(lineText)) : []));
  const [following, setFollowing] = useState(Boolean(follow));
  const [pausedByScroll, setPausedByScroll] = useState(false);
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState("all");
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState("");
  const box = useRef(null);
  const cursor = useRef(null);
  const lastTop = useRef(0);
  const followRef = useRef(following);
  followRef.current = following;
  const live = Boolean(load) || logRequest(source) !== null;

  const poll = useCallback(async () => {
    try {
      let payload;
      if (load) payload = await load({ tail: initialTail, cursor: cursor.current });
      else {
        const request = logRequest(source, { tail: initialTail, cursor: cursor.current });
        const client = request.manager ? services.api.manager(request.manager) : services.api;
        payload = await client.get(request.path, { query: request.query });
      }
      const next = normalizeLogPayload(payload);
      cursor.current = next.cursor;
      setLines((current) => (next.cursor !== null ? appendLines(current, next.lines) : next.lines.slice(-RING_LIMIT)));
      setError(null);
    } catch (failure) {
      setError(describeError(failure, services.i18n));
    }
  }, [load, source?.kind, source?.managerId, source?.id, initialTail, services]);

  useEffect(() => {
    if (!live) return undefined;
    cursor.current = null;
    let alive = true;
    const run = () => {
      if (alive && !tabHidden(services)) poll();
    };
    run();
    const timer = globalThis.setInterval(run, Math.max(250, pollMs));
    return () => {
      alive = false;
      globalThis.clearInterval(timer);
    };
  }, [poll, pollMs, live]);

  const shown = useMemo(() => (level === "all" ? lines : lines.filter((line) => passesLevel(line, level))), [lines, level]);
  const matches = useMemo(() => {
    const needle = query.toLowerCase();
    return needle ? shown.reduce((count, line) => count + (line.toLowerCase().includes(needle) ? 1 : 0), 0) : 0;
  }, [shown, query]);

  useEffect(() => {
    const element = box.current;
    if (following && element) {
      element.scrollTop = element.scrollHeight;
      lastTop.current = element.scrollTop;
    }
  }, [shown, following]);

  function pause() {
    if (followRef.current) {
      setFollowing(false);
      setPausedByScroll(true);
    }
  }

  function onScroll() {
    const element = box.current;
    if (!element) return;
    const distance = element.scrollHeight - element.clientHeight - element.scrollTop;
    if (element.scrollTop < lastTop.current - 1 && distance > BOTTOM_SLACK) pause();
    else if (distance <= BOTTOM_SLACK && pausedByScroll) {
      setFollowing(true);
      setPausedByScroll(false);
    }
    lastTop.current = element.scrollTop;
  }

  function jumpToLatest() {
    setFollowing(true);
    setPausedByScroll(false);
    const element = box.current;
    if (element) element.scrollTop = element.scrollHeight;
  }

  function toggleFollow() {
    if (following) {
      setFollowing(false);
      setPausedByScroll(false);
    } else jumpToLatest();
  }

  async function onCopy() {
    const ok = await copyText(shown.join("\n"));
    setNotice(ok ? t("common.copied") : t("common.copyFailed"));
  }

  function onDownload() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    download(`${source?.kind || "log"}-${source?.id || "tail"}-${stamp}.txt`.replace(/[^\w.-]/g, "_"), `${shown.join("\n")}\n`);
  }

  const levelOptions = [["all", t("common.log.levelAll")], ["error", t("common.log.levelError")], ["warn", t("common.log.levelWarn")], ["info", t("common.log.levelInfo")]];
  return html`<div class="log-viewer" data-testid=${testid || "log-viewer.root"} data-following=${following ? "true" : "false"}>
    <div class="log-toolbar row">
      <label class="sr-only" for="log-search-input">${t("common.log.search")}</label>
      <input id="log-search-input" class="input log-search" type="search" value=${query} placeholder=${t("common.log.search")} data-testid="log-viewer.search"
        onInput=${(event) => setQuery(event.currentTarget.value)} />
      <label class="sr-only" for="log-level-select">${t("common.log.level")}</label>
      <select id="log-level-select" class="select log-level" value=${level} data-testid="log-viewer.level" onChange=${(event) => setLevel(event.currentTarget.value)}>
        ${levelOptions.map(([value, text]) => html`<option key=${value} value=${value} selected=${value === level}>${text}</option>`)}
      </select>
      <${Button} size="sm" aria-pressed=${following ? "true" : "false"} onClick=${toggleFollow} testid="log-viewer.follow">${t("common.log.follow")}<//>
      <${Button} size="sm" onClick=${onCopy} testid="log-viewer.copy">${t("common.copy")}<//>
      <${Button} size="sm" onClick=${onDownload} testid="log-viewer.download">${t("common.log.download")}<//>
      <span class="muted small" role="status" data-testid="log-viewer.count">${query ? t("common.log.matches", { count: matches }) : t("common.log.lines", { count: shown.length })}${notice ? ` · ${notice}` : ""}</span>
    </div>
    ${error ? html`<p class="text-danger small" role="alert" data-testid="log-viewer.error">${error}</p>` : null}
    <div class="log-box-wrap">
      <div class="log-box" ref=${box} role="log" aria-live="off" aria-label=${label || t("common.log.label")} tabindex="0"
        onScroll=${onScroll} onWheel=${(event) => event.deltaY < 0 && pause()} data-testid="log-viewer.log">
        ${shown.length ? shown.map((line, index) => html`<div key=${index} class=${`log-line log-${levelOf(line)}`} data-testid="log-viewer.line">${highlightParts(line, query).map((part, at) => (part.match ? html`<mark key=${at}>${part.text}</mark>` : part.text))}</div>`)
          : html`<p class="muted small log-empty">${t("common.log.empty")}</p>`}
      </div>
      ${!following ? html`<${Button} size="sm" variant="primary" icon="chevron-down" class="log-jump" onClick=${jumpToLatest} testid="log-viewer.jump">${t("common.log.jump")}<//>` : null}
    </div>
  </div>`;
}
