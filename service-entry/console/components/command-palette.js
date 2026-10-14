// CommandPalette (07 §4.4, §9): Ctrl/Cmd+K opens a dialog with a combobox and
// a listbox (aria-activedescendant keeps focus in the input). Sources: pages,
// actions and entities (deployments from the fleet cache). Matching is fuzzy
// over the label in both languages plus aliases (lib/fuzzy.js), so a Chinese
// speaker finds "Overview" by typing either name.
//
// app-shell.js loads this module on first use, so it stays out of the
// static import closure of app.js.

import { fuzzyFilter } from "../lib/fuzzy.js";
import { tk } from "../lib/i18n.js";
import { isLockedFor, navHref, NAV_ITEMS } from "../data/nav.js";
import { useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useId, useMemo, useState } from "../ui/vendor.js";
import { Modal } from "./dialog.js";

export const GROUP_ORDER = Object.freeze(["pages", "actions", "entities"]);
const MAX_RESULTS = 12;

function instanceLabel(instance) {
  const model = Array.isArray(instance?.models) ? instance.models.find((item) => item?.id)?.id : null;
  return String(model || instance?.id || instance?.instanceId || "");
}

/**
 * The commands for a role.
 * @param i18n the active language; other the other language (or null) for matching
 * @param instances fleet instances for the entity source
 * @param actions { copyGateway, toggleTheme, toggleLocale, toggleDensity }: functions, absent ones are left out
 * @returns Array<{ id, group, label, altLabel, aliases, href?, run? }>
 */
export function buildCommands({ role = "viewer", i18n, other = null, instances = [], actions = {} } = {}) {
  const owner = role === "owner";
  const label = (key) => i18n.t(key);
  const alt = (key) => (other ? other.t(key) : "");
  const entry = (id, group, key, extra) => ({ id, group, label: label(key), altLabel: alt(key), aliases: [], ...extra });
  const commands = [];
  for (const item of NAV_ITEMS) {
    if (isLockedFor(item, role)) continue;
    commands.push(entry(`page:${item.id}`, "pages", item.labelKey, { href: navHref(item, role), aliases: [item.id] }));
  }
  commands.push(entry("page:preferences", "pages", "shell.palette.preferences", { href: "/system/preferences", aliases: ["settings", "prefs", "preferences"] }));
  if (owner) commands.push(entry("page:sessions", "pages", "shell.palette.sessions", { href: "/access/sessions", aliases: ["settings", "sessions", "pair"] }));
  if (owner) {
    commands.push(entry("action:new-deployment", "actions", "shell.palette.newDeployment", { href: "/deployments/new", aliases: ["deploy", "launch", "wizard"] }));
    commands.push(entry("action:download-model", "actions", "shell.palette.downloadModel", { href: "/models/discover", aliases: ["download", "huggingface", "pull"] }));
    commands.push(entry("action:doctor", "actions", "shell.palette.runDoctor", { href: "/system/doctor", aliases: ["doctor", "check", "diagnose"] }));
  }
  if (actions.copyGateway) commands.push(entry("action:copy-gateway", "actions", "shell.palette.copyGateway", { run: actions.copyGateway, aliases: ["url", "endpoint", "openai"] }));
  if (actions.toggleTheme) commands.push(entry("action:theme", "actions", "shell.palette.toggleTheme", { run: actions.toggleTheme, aliases: ["dark", "light", "appearance"] }));
  if (actions.toggleLocale) commands.push(entry("action:locale", "actions", "shell.palette.toggleLocale", { run: actions.toggleLocale, aliases: ["language", "english", "chinese"] }));
  if (actions.toggleDensity) commands.push(entry("action:density", "actions", "shell.palette.toggleDensity", { run: actions.toggleDensity, aliases: ["compact", "comfortable"] }));
  for (const instance of Array.isArray(instances) ? instances : []) {
    const id = instance?.id ?? instance?.instanceId;
    const text = instanceLabel(instance);
    if (typeof id !== "string" || !text) continue;
    commands.push({ id: `deployment:${id}`, group: "entities", label: text, altLabel: "", aliases: [id], href: `/deployments/${encodeURIComponent(id)}` });
  }
  return commands;
}

/** The commands matching `query`, best first, at most MAX_RESULTS; an empty query lists pages, then actions, then entities. */
export function filterCommands(commands, query) {
  const order = (command) => GROUP_ORDER.indexOf(command.group);
  const found = fuzzyFilter(commands, query, { fields: (command) => [command.label, command.altLabel, ...command.aliases].filter(Boolean), limit: 200 }).map(({ item }) => item);
  if (String(query || "").trim()) return found.slice(0, MAX_RESULTS);
  return [...found].sort((a, b) => order(a) - order(b)).slice(0, MAX_RESULTS);
}

// commands from buildCommands(); onRun(command) navigates or runs it; onClose closes the dialog.
export function CommandPalette({ commands, onRun, onClose, testid }) {
  const { t } = useT();
  const id = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = useMemo(() => filterCommands(commands, query), [commands, query]);
  const index = Math.min(active, Math.max(0, results.length - 1));
  const optionId = (position) => `${id}-o${position}`;

  function onKeyDown(event) {
    if (!results.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      onRun(results[index]);
    }
  }

  return html`<${Modal} class="dialog palette" labelId=${`${id}-t`} onRequestClose=${() => onClose()} initialFocus="input" testid=${testid || "command-palette.root"}>
    <h2 id=${`${id}-t`} class="sr-only">${t("shell.palette.title")}</h2>
    <div class="palette-body">
      <input class="input" type="text" role="combobox" aria-expanded="true" aria-controls=${`${id}-l`} aria-autocomplete="list"
        aria-activedescendant=${results.length ? optionId(index) : undefined} aria-label=${t("shell.palette.title")} placeholder=${t("shell.palette.placeholder")}
        autocomplete="off" spellcheck="false" value=${query} onInput=${(event) => {
          setQuery(event.currentTarget.value);
          setActive(0);
        }} onKeyDown=${onKeyDown} data-testid="command-palette.input" />
      <ul id=${`${id}-l`} role="listbox" aria-label=${t("shell.palette.results")} class="palette-list" data-testid="command-palette.list">
        ${results.map((command, position) => html`<li key=${command.id} id=${optionId(position)} role="option" aria-selected=${position === index ? "true" : "false"} class="menu-item palette-option"
          data-active=${position === index ? "true" : "false"} data-command=${command.id} data-testid="command-palette.option"
          onPointerMove=${() => setActive(position)} onClick=${() => onRun(command)}>
          <span class="grow truncate">${command.label}</span>
          <span class="xsmall muted">${t(tk("shell.palette.group.", command.group))}</span>
        </li>`)}
      </ul>
      ${results.length ? null : html`<p class="muted small" role="status" data-testid="command-palette.empty">${t("shell.palette.empty")}</p>`}
    </div>
  <//>`;
}
