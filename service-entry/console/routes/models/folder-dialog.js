// The folder browser of the Storage page (07 §6.4 "Register folder", parity
// with the legacy /model-storage folder dialog): the machine's drives, then
// folders one level at a time with a filter, "load more" for long folders and
// an address bar. It only lists folders (GET /model-storage/directories on a
// manager, which refuses anything but a loopback caller); choosing one hands
// the path back, nothing is created or registered here.

import { describeError } from "../../lib/api.js";
import { cleanPath, folderChoosable } from "../../lib/storage-model.js";
import { Button } from "../../components/button.js";
import { Dialog } from "../../components/dialog.js";
import { useServices } from "../../ui/context.js";
import { useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useEffect, useId, useRef, useState } from "../../ui/vendor.js";

const EMPTY = Object.freeze({ path: "", parent: null, directories: [], total: 0, nextOffset: null });

/** @param managerApi api.manager(id) of the manager that serves /model-storage  @param start the path to open first */
export function FolderDialog({ open, start, managerApi, onChoose, onClose }) {
  const { i18n } = useServices();
  const { t } = useT();
  const id = useId();
  const [address, setAddress] = useState("");
  const [filter, setFilter] = useState("");
  const [view, setView] = useState(EMPTY);
  const [state, setState] = useState({ loading: false, error: "" });
  const request = useRef(0);
  const current = useRef("");
  const typing = useRef(null);
  const applied = useRef("");

  async function browse(path, { more = false, query = "" } = {}) {
    const token = (request.current += 1);
    const requested = cleanPath(path);
    globalThis.clearTimeout(typing.current);
    applied.current = query;
    if (!more && !query) setFilter("");
    setState({ loading: true, error: "" });
    if (!more) setAddress(requested);
    try {
      const offset = more ? view.nextOffset : 0;
      const data = await managerApi.get("/model-storage/directories", { query: { path: requested, query, offset } });
      if (token !== request.current) return;
      current.current = data.path || "";
      setAddress(data.path || "");
      setView((previous) => ({ ...data, directories: more ? [...previous.directories, ...(data.directories || [])] : data.directories || [] }));
      setState({ loading: false, error: "" });
    } catch (error) {
      if (token !== request.current) return;
      setView({ ...EMPTY, path: requested, parent: requested ? "" : null });
      setState({ loading: false, error: describeError(error, i18n) });
    }
  }

  useEffect(() => {
    if (!open) return undefined;
    browse(start || "");
    return () => {
      request.current += 1;
      globalThis.clearTimeout(typing.current);
    };
  }, [open]);
  // The filter asks the server once typing paused for 200 ms; opening another folder clears it.
  function onFilter(value) {
    setFilter(value);
    globalThis.clearTimeout(typing.current);
    typing.current = globalThis.setTimeout(() => browse(current.current, { query: value }), 200);
  }

  const choosable = folderChoosable(view.path);
  const footer = html`
    <${Button} onClick=${() => onClose?.()} testid="folder.cancel">${t("common.cancel")}<//>
    <${Button} variant="primary" disabled=${!choosable} onClick=${() => onChoose?.(view.path)} testid="folder.choose">${t("hub.storage.folder.choose")}<//>`;
  return html`<${Dialog} open=${open} title=${t("hub.storage.folder.title")} onClose=${() => onClose?.()} footer=${footer} testid="folder.dialog">
    <div class="stack-sm">
      <p class="small muted">${t("hub.storage.folder.lead")}</p>
      <form class="field" onSubmit=${(event) => {
        event.preventDefault();
        browse(address);
      }}>
        <label class="field-label" for=${`${id}-a`}>${t("hub.storage.folder.address")}</label>
        <div class="row-nowrap">
          <input id=${`${id}-a`} class="input mono grow" value=${address} autocomplete="off" spellcheck="false" placeholder=${t("hub.storage.folder.addressHint")}
            onInput=${(event) => setAddress(event.currentTarget.value)} data-testid="folder.address" />
          <${Button} type="submit" testid="folder.open">${t("hub.storage.folder.open")}<//>
        </div>
      </form>
      <div class="row">
        <${Button} size="sm" onClick=${() => browse("")} testid="folder.drives">${t("hub.storage.folder.drives")}<//>
        <${Button} size="sm" disabled=${view.parent === null} onClick=${() => browse(view.parent || "")} testid="folder.up">${t("hub.storage.folder.up")}<//>
        <input class="input grow" type="search" value=${filter} placeholder=${t("hub.storage.folder.filter")} aria-label=${t("hub.storage.folder.filter")}
          autocomplete="off" onInput=${(event) => onFilter(event.currentTarget.value)} data-testid="folder.filter" />
      </div>
      <div role="status" class="small muted" data-testid="folder.status">${state.loading ? t("hub.storage.folder.loading") : state.error || (view.total ? t(view.path ? "hub.storage.folder.count" : "hub.storage.folder.driveCount", { count: view.total }) : t("hub.storage.folder.none"))}</div>
      <div class="stack-sm folder-list" aria-label=${t("hub.storage.folder.list")} data-testid="folder.list">
        ${view.directories.map((item) => html`<${Button} key=${item.path} variant="ghost" size="sm" onClick=${() => browse(item.path)} title=${item.path} testid="folder.item">${item.name}<//>`)}
      </div>
      ${view.nextOffset !== null && view.nextOffset !== undefined ? html`<${Button} size="sm" busy=${state.loading} onClick=${() => browse(view.path, { more: true, query: applied.current })} testid="folder.more">${t("hub.storage.folder.more")}<//>` : null}
      <div class="field">
        <span class="field-label">${t("hub.storage.folder.selected")}</span>
        <code class="code-inline mono" data-user-content="" data-testid="folder.selected">${view.path || t("hub.storage.folder.selectedNone")}</code>
      </div>
    </div>
  <//>`;
}
