// Module resolution for console tests (07 §13.1). Importing this file
// registers a synchronous resolve hook (module.registerHooks, Node >= 22.15)
// that maps the console's relative `../vendor/…` and `../shared/…` paths to
// shared-public/vendor/ and shared-public/, exactly as the snapshot serves
// them under /c/<buildId>/. Static imports of a test file are linked before
// this hook exists, so tests import ui/ modules with `await import()`.

import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const CONSOLE_DIR = path.join(ROOT, "service-entry", "console");
export const SHARED_DIR = path.join(ROOT, "shared-public");

const MAPPINGS = [
  { from: pathToFileURL(path.join(CONSOLE_DIR, "vendor") + path.sep).href, to: pathToFileURL(path.join(SHARED_DIR, "vendor") + path.sep).href },
  { from: pathToFileURL(path.join(CONSOLE_DIR, "shared") + path.sep).href, to: pathToFileURL(SHARED_DIR + path.sep).href },
];

/** The file URL a console URL is served from, or the URL unchanged. */
export function mapConsoleUrl(url) {
  for (const { from, to } of MAPPINGS) {
    if (url.startsWith(from)) return to + url.slice(from.length);
  }
  return url;
}

let registered = false;
if (!registered) {
  registered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
        const target = new URL(specifier, context.parentURL).href;
        const mapped = mapConsoleUrl(target);
        // Vendored files are ES modules in a folder without a package.json
        // type marker; browsers load them as modules, so Node must too.
        if (mapped !== target) return { ...nextResolve(mapped, context), format: "module" };
      }
      return nextResolve(specifier, context);
    },
  });
}
