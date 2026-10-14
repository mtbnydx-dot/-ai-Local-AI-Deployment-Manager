// QrCode (07 §4.4): qrcode-generator loads on first use (loadQrcode(), 07
// §3.1), and the matrix is drawn as one SVG path of VNodes, never as markup
// strings. The code keeps a white field and black modules in both themes so
// scanners read it; the accessible name is `label`.

import { loadQrcode } from "../ui/vendor-lazy.js";
import { useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useEffect, useState } from "../ui/vendor.js";

const QUIET = 4;

/** Run-length SVG path data for an n x n matrix; `isDark(row, col)` tells the modules. */
export function qrPathData(isDark, n, quiet = QUIET) {
  const parts = [];
  for (let row = 0; row < n; row += 1) {
    let col = 0;
    while (col < n) {
      if (!isDark(row, col)) {
        col += 1;
        continue;
      }
      const start = col;
      while (col < n && isDark(row, col)) col += 1;
      parts.push(`M${start + quiet} ${row + quiet}h${col - start}v1h${start - col}z`);
    }
  }
  return parts.join("");
}

/** @param text what the code encodes  @param label accessible name  @param size CSS px */
export function QrCode({ text, label, size = 192, testid }) {
  const { t } = useT();
  const [state, setState] = useState({ status: "loading" });
  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    loadQrcode().then((qrcode) => {
      const qr = qrcode(0, "M");
      qr.addData(String(text ?? ""));
      qr.make();
      const n = qr.getModuleCount();
      if (alive) setState({ status: "ready", n, d: qrPathData((row, col) => qr.isDark(row, col), n) });
    }).catch(() => {
      if (alive) setState({ status: "error" });
    });
    return () => {
      alive = false;
    };
  }, [text]);

  if (state.status === "error") return html`<p class="field-error" role="alert" data-testid="qr-code.error">${t("common.qr.failed")}</p>`;
  if (state.status === "loading") return html`<span class="qr qr-loading" aria-busy="true" data-testid=${testid || "qr-code.root"}><span class="skeleton qr-placeholder"></span></span>`;
  const full = state.n + QUIET * 2;
  return html`<span class="qr" data-testid=${testid || "qr-code.root"}>
    <svg viewBox=${`0 0 ${full} ${full}`} width=${size} height=${size} role="img" aria-label=${label} shape-rendering="crispEdges" data-testid="qr-code.svg">
      <rect class="qr-bg" width=${full} height=${full} />
      <path class="qr-ink" d=${state.d} />
    </svg>
  </span>`;
}
