// ui-kit section: DataTable (sort, chooser, CSV, windowing, cards), LogViewer
// and MarkdownViewer.

import { useT } from "../../../ui/hooks.js";
import { html } from "../../../ui/html.js";
import { useMemo } from "../../../ui/vendor.js";
import { Card } from "../../../components/card.js";
import { DataTable } from "../../../components/data-table.js";
import { LogViewer } from "../../../components/log-viewer.js";
import { MarkdownViewer } from "../../../components/markdown-viewer.js";
import { MARKDOWN_SAMPLE, TABLE_ROWS, bigRows, createLogFeed } from "../../../data/ui-kit-fixtures.js";

export default function DataSection() {
  const { t } = useT();
  const big = useMemo(() => bigRows(), []);
  const feed = useMemo(() => createLogFeed(), []);
  const columns = [
    { id: "name", header: t("uikit.col.name"), sort: true },
    { id: "gpu", header: t("uikit.col.gpu"), sort: true, align: "end", hideable: true },
    { id: "tokens", header: t("uikit.col.tokens"), sort: true, align: "end" },
    { id: "note", header: t("uikit.col.note"), hideable: true, defaultHidden: true },
  ];
  const bigColumns = [
    { id: "n", header: t("uikit.col.n"), sort: true, align: "end" },
    { id: "name", header: t("uikit.col.name"), sort: true },
    { id: "score", header: t("uikit.col.score"), sort: true, align: "end", hideable: true },
  ];
  return html`
    <${Card} id="uikit-data-table" title=${t("uikit.dataTable")}>
      <div class="stack">
        <${DataTable} id="uikit-table" caption=${t("uikit.captionModels")} columns=${columns} rows=${TABLE_ROWS} exportName="uikit-table" responsive="cards" testid="uikit.table" />
        <${DataTable} id="uikit-big" caption=${t("uikit.captionNumbers")} columns=${bigColumns} rows=${big} exportName="uikit-big" testid="uikit.table-big" />
      </div>
    <//>

    <${Card} id="uikit-log-viewer" title=${t("uikit.logViewer")}>
      <${LogViewer} source=${{ kind: "component", id: "uikit" }} load=${feed} pollMs=${1000} testid="uikit.log" />
    <//>

    <${Card} id="uikit-markdown" title=${t("uikit.markdown")}>
      <${MarkdownViewer} source=${MARKDOWN_SAMPLE} testid="uikit.markdown-view" />
    <//>`;
}
