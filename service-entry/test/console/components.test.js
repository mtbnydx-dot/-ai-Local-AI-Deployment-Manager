// CON-5 (07 §4.4): the pure parts of the primitive components, run in Node.
// Rendering, focus and ARIA behaviour are covered in a browser by
// tests/frontend/console/console-a11y.spec.js; here are the helpers that
// decide behaviour (tab keys, toast queue, copy routes, QR path data) and the
// rules every component file must follow.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const { CONSOLE_DIR } = await import("./loader.mjs");
const load = (file) => import(pathToFileURL(path.join(CONSOLE_DIR, file)).href);

const SPEC_COMPONENTS = {
  "button.js": "Button", "icon.js": "Icon", "card.js": "Card", "page-header.js": "PageHeader", "stat-tile.js": "StatTile",
  "status-badge.js": "StatusBadge", "tabs.js": "Tabs", "drawer.js": "Drawer", "dialog.js": "Dialog", "confirm-dialog.js": "ConfirmDialog",
  "toast.js": "Toast", "form-field.js": "FormField", "help-popover.js": "HelpPopover", "code-block.js": "CodeBlock", "empty-state.js": "EmptyState",
  "skeleton.js": "Skeleton", "progress-row.js": "ProgressRow", "stepper.js": "Stepper", "stacked-bar.js": "StackedBar", "diff-table.js": "DiffTable",
  "error-boundary.js": "ErrorBoundary", "qr-code.js": "QrCode",
};

test("every CON-5 component file exists and exports its component as a function", async () => {
  for (const [file, name] of Object.entries(SPEC_COMPONENTS)) {
    const module = await load(`components/${file}`);
    assert.equal(typeof module[name], "function", `${file} exports ${name}`);
  }
  const kit = await load("routes/system/ui-kit.js");
  assert.equal(typeof kit.default, "function");
  assert.equal(typeof kit.mountUiKit, "function");
});

test("components follow the shared rules: a testid hook and no inline style attribute", () => {
  const dir = path.join(CONSOLE_DIR, "components");
  for (const [file] of Object.entries(SPEC_COMPONENTS)) {
    const source = fs.readFileSync(path.join(dir, file), "utf8");
    assert.match(source, /data-testid|testid/, `${file} carries data-testid hooks`);
    assert.equal(/\sstyle="/.test(source), false, `${file} must not write a style attribute (CSP style-src 'self')`);
  }
});

test("nextTabIndex wraps, skips disabled tabs and ignores other keys", async () => {
  const { nextTabIndex } = await load("components/tabs.js");
  const tabs = [{ id: "a" }, { id: "b", disabled: true }, { id: "c" }, { id: "d" }];
  assert.equal(nextTabIndex(tabs, 0, "ArrowRight"), 2, "skips the disabled tab");
  assert.equal(nextTabIndex(tabs, 3, "ArrowRight"), 0, "wraps forward");
  assert.equal(nextTabIndex(tabs, 0, "ArrowLeft"), 3, "wraps backward");
  assert.equal(nextTabIndex(tabs, 2, "ArrowLeft"), 0);
  assert.equal(nextTabIndex(tabs, 2, "Home"), 0);
  assert.equal(nextTabIndex(tabs, 0, "End"), 3);
  assert.equal(nextTabIndex([{ id: "x", disabled: true }], 0, "ArrowRight"), -1, "nothing to move to");
  assert.equal(nextTabIndex([{ id: "x", disabled: true }, { id: "y" }], 1, "Home"), 1, "Home skips a disabled first tab");
  assert.equal(nextTabIndex(tabs, 0, "Enter"), -1);
  assert.equal(nextTabIndex(tabs, 0, "a"), -1);
});

test("the toast queue keeps 3, drops older non-errors first and notifies subscribers", async () => {
  const { createToasts, normalizeToast, TOAST_MAX } = await load("components/toast.js");
  assert.equal(TOAST_MAX, 3);
  const queue = createToasts();
  const seen = [];
  const off = queue.subscribe((items) => seen.push(items.length));
  queue.push({ level: "error", title: "e1" });
  queue.push({ level: "success", title: "s1" });
  queue.push({ level: "info", title: "i1" });
  queue.push({ level: "warn", title: "w1" });
  assert.deepEqual(queue.get().map((item) => item.title), ["e1", "i1", "w1"], "the oldest non-error (s1) went first");
  queue.push({ level: "error", title: "e2" });
  queue.push({ level: "error", title: "e3" });
  queue.push({ level: "error", title: "e4" });
  assert.equal(queue.get().length, 3);
  assert.deepEqual(queue.get().map((item) => item.title), ["e2", "e3", "e4"], "only errors left: the oldest goes");
  const id = queue.get()[0].id;
  queue.dismiss(id);
  assert.equal(queue.get().length, 2);
  off();
  queue.clear();
  assert.equal(queue.get().length, 0);
  assert.ok(seen.length >= 7 && !seen.includes(4), "never more than 3 in a notification");

  // useMutation pushes { tone, text, requestId }; the Toast API says level/body.
  assert.deepEqual(normalizeToast({ tone: "error", text: "boom", requestId: "r1" }, 9), { id: 9, level: "error", title: "", body: "boom", requestId: "r1", action: null });
  assert.equal(normalizeToast({ tone: "danger" }, 1).level, "error");
  assert.equal(normalizeToast({ level: "bogus" }, 1).level, "info");
});

test("copyText uses the async clipboard when it is allowed and secure", async () => {
  const { copyText } = await load("components/code-block.js");
  const written = [];
  const saved = { navigator: globalThis.navigator, isSecureContext: globalThis.isSecureContext };
  try {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (text) => written.push(text) } } });
    globalThis.isSecureContext = true;
    assert.equal(await copyText("abc"), true);
    assert.deepEqual(written, ["abc"]);
  } finally {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: saved.navigator });
    globalThis.isSecureContext = saved.isSecureContext;
  }
});

test("copyText falls back to a textarea and execCommand when the clipboard is denied or insecure", async () => {
  const { copyText } = await load("components/code-block.js");
  const calls = [];
  const area = { style: {}, setAttribute() {}, focus() {}, select() {}, setSelectionRange() {}, remove() { calls.push("removed"); } };
  const host = { appendChild(node) { calls.push(`appended:${node === area}`); } };
  const fakeDocument = (result) => ({
    body: host,
    activeElement: { closest: () => null, focus: () => calls.push("focus restored") },
    createElement: (tag) => (tag === "textarea" ? area : null),
    execCommand: (command) => {
      calls.push(`exec:${command}:${area.value}`);
      return result;
    },
  });
  const saved = { navigator: globalThis.navigator, isSecureContext: globalThis.isSecureContext, document: globalThis.document };
  try {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => { throw new DOMException("denied", "NotAllowedError"); } } } });
    globalThis.isSecureContext = true;
    globalThis.document = fakeDocument(true);
    assert.equal(await copyText("secret-free text"), true, "permission denied -> textarea route");
    assert.deepEqual(calls, ["appended:true", "exec:copy:secret-free text", "removed", "focus restored"]);

    calls.length = 0;
    globalThis.isSecureContext = false;
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => assert.fail("never called when insecure") } } });
    assert.equal(await copyText("lan"), true, "insecure context -> textarea route");

    calls.length = 0;
    globalThis.document = fakeDocument(false);
    assert.equal(await copyText("x"), false, "execCommand refusing means the person copies by hand");
    globalThis.document = undefined;
    assert.equal(await copyText("x"), false, "no document at all");
  } finally {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: saved.navigator });
    globalThis.isSecureContext = saved.isSecureContext;
    if (saved.document === undefined) delete globalThis.document;
    else globalThis.document = saved.document;
  }
});

test("qrPathData draws run-length rows and qrcode-generator feeds it through the lazy loader", async () => {
  const { qrPathData } = await load("components/qr-code.js");
  const grid = ["1101", "0000", "0111", "1000"].map((row) => [...row].map((cell) => cell === "1"));
  assert.equal(qrPathData((r, c) => grid[r][c], 4, 0), "M0 0h2v1h-2zM3 0h1v1h-1zM1 2h3v1h-3zM0 3h1v1h-1z");
  assert.equal(qrPathData((r, c) => grid[r][c], 4, 4).startsWith("M4 4h2v1h-2z"), true, "a 4-module quiet zone offsets every run");
  assert.equal(qrPathData(() => false, 3), "");

  const { loadQrcode } = await load("ui/vendor-lazy.js");
  const qrcode = await loadQrcode();
  const qr = qrcode(0, "M");
  qr.addData("https://example.invalid/pair#code=0000");
  qr.make();
  const n = qr.getModuleCount();
  assert.ok(n >= 21 && (n - 17) % 4 === 0, `module count ${n} is a QR version size`);
  const d = qrPathData((r, c) => qr.isDark(r, c), n);
  let dark = 0;
  for (let r = 0; r < n; r += 1) for (let c = 0; c < n; c += 1) if (qr.isDark(r, c)) dark += 1;
  const drawn = [...d.matchAll(/h(\d+)v1/g)].reduce((sum, match) => sum + Number(match[1]), 0);
  assert.equal(drawn, dark, "the path covers exactly the dark modules");
  assert.equal(/[<>"']/.test(d), false, "path data holds no markup");
});

test("diagnosticsOf keeps the code and request id and drops the query string", async () => {
  const { diagnosticsOf } = await load("components/error-boundary.js");
  const saved = globalThis.location;
  try {
    Object.defineProperty(globalThis, "location", { configurable: true, value: { pathname: "/models", search: "?token=secret", href: "http://h/models?token=secret" } });
    const text = diagnosticsOf(Object.assign(new Error("x".repeat(500)), { code: "boom", requestId: "req_1" }));
    const data = JSON.parse(text);
    assert.equal(data.code, "boom");
    assert.equal(data.requestId, "req_1");
    assert.equal(data.path, "/models");
    assert.equal(data.message.length, 300);
    assert.equal(text.includes("secret"), false);
  } finally {
    if (saved === undefined) delete globalThis.location;
    else Object.defineProperty(globalThis, "location", { configurable: true, value: saved });
  }
});

test("every ui-kit section file is registered in SECTIONS and loads lazily", async () => {
  const shell = fs.readFileSync(path.join(CONSOLE_DIR, "routes", "system", "ui-kit.js"), "utf8");
  const dir = path.join(CONSOLE_DIR, "routes", "system", "ui-kit");
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".js")).sort();
  assert.ok(files.length >= 3, "the kit has at least the three CON-5 sections");
  for (const file of files) {
    assert.ok(shell.includes(`() => import("./ui-kit/${file}")`), `${file} has a lazy loader in SECTIONS`);
    assert.equal(typeof (await load(`routes/system/ui-kit/${file}`)).default, "function", `${file} default-exports a component`);
  }
  assert.equal(/^import .* from "\.\/ui-kit\//m.test(shell), false, "the shell never imports a section statically (07 §11 route budget)");
});
