// Vendored libraries that load on demand only (07 C1b, §3.1, §11): uPlot
// for charts and qrcode-generator for pairing and key-share QR codes. Only
// components/time-series-chart.js calls loadUplot() and only
// components/qr-code.js calls loadQrcode(); the static import closure of
// app.js never contains them. Each loads once per page.

const UPLOT_STYLESHEET = "../vendor/uplot/1.6.32/uPlot.min.css";

let uplot = null;
let qrcode = null;

/** uPlot's constructor (the module's default export). */
export function loadUplot() {
  if (!uplot) {
    uplot = import("../vendor/uplot/1.6.32/uPlot.esm.js").then((module) => module.default, (error) => {
      uplot = null;
      throw error;
    });
  }
  return uplot;
}

/** The URL of uPlot's stylesheet, for a <link> next to the first chart. */
export function uplotStylesheetUrl() {
  return new URL(UPLOT_STYLESHEET, import.meta.url).href;
}

/** qrcode-generator's `qrcode(typeNumber, errorCorrectionLevel)` (the module's default export). */
export function loadQrcode() {
  if (!qrcode) {
    qrcode = import("../vendor/qrcode/2.0.4/qrcode.mjs").then((module) => module.default, (error) => {
      qrcode = null;
      throw error;
    });
  }
  return qrcode;
}
