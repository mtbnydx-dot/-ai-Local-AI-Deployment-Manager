"use strict";

// The body a legacy manager form posts when the user changes nothing: the
// controls of <form id="startForm"> read from the shipped index.html the way
// FormData reads them (statically disabled controls and unchecked boxes are
// left out, a select sends its selected or first option), then the payload
// builders' common rules: every named checkbox becomes a boolean and number
// inputs become numbers. Tests build their "untouched form" fixtures from this
// so a default added to the form cannot drift past them.

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const FORMS = Object.freeze({
  vllm: path.join(REPO_ROOT, "vllm-manager", "public", "index.html"),
  llama: path.join(REPO_ROOT, "llama-manager", "public", "index.html"),
});

function attributes(tag) {
  const attrs = {};
  const body = tag.replace(/^<\w+/, "").replace(/\/?>$/, "");
  for (const match of body.matchAll(/([A-Za-z_:][\w:.-]*)(?:\s*=\s*"([^"]*)")?/g)) attrs[match[1].toLowerCase()] = match[2] ?? "";
  return attrs;
}

function decodeEntities(text) {
  return text.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function formSource(html, formId) {
  const start = html.indexOf(`<form id="${formId}"`);
  if (start < 0) throw new Error(`No <form id="${formId}"> in the page.`);
  const end = html.indexOf("</form>", start);
  return html.slice(start, end);
}

/**
 * legacyFormDefaults(manager, { formId? }) → the body the form posts untouched.
 * manager: "vllm" | "llama" (or an index.html path).
 */
function legacyFormDefaults(manager, { formId = "startForm" } = {}) {
  const file = FORMS[manager] || manager;
  const source = formSource(fs.readFileSync(file, "utf8"), formId);
  const body = {};
  const controls = /<input\b[^>]*>|<select\b[^>]*>[\s\S]*?<\/select>|<textarea\b[^>]*>[\s\S]*?<\/textarea>/g;
  for (const match of source.matchAll(controls)) {
    const control = match[0];
    const tag = /^<\w+\b[^>]*>/.exec(control)[0];
    const attrs = attributes(tag);
    const name = attrs.name;
    if (!name || Object.hasOwn(attrs, "disabled")) continue;
    if (control.startsWith("<select")) {
      const options = [...control.matchAll(/<option\b[^>]*>/g)].map((item) => attributes(item[0]));
      const chosen = options.find((option) => Object.hasOwn(option, "selected")) || options[0];
      body[name] = decodeEntities(chosen?.value ?? "");
    } else if (control.startsWith("<textarea")) {
      body[name] = decodeEntities(/<textarea\b[^>]*>([\s\S]*?)<\/textarea>/.exec(control)[1]);
    } else {
      const type = String(attrs.type || "text").toLowerCase();
      if (["button", "submit", "reset", "image", "file"].includes(type)) continue;
      if (type === "checkbox") body[name] = Object.hasOwn(attrs, "checked");
      else if (type === "radio") {
        if (Object.hasOwn(attrs, "checked")) body[name] = decodeEntities(attrs.value ?? "on");
      } else if (type === "number") body[name] = attrs.value === undefined || attrs.value === "" ? "" : Number(attrs.value);
      else body[name] = decodeEntities(attrs.value ?? "");
    }
  }
  // The GPU picker is rendered at runtime; nothing is selected by default.
  body.gpuDeviceIds = [];
  return body;
}

module.exports = { FORMS, legacyFormDefaults };
