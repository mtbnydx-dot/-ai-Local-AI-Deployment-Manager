"use strict";

// The inspect worker (docs/overhaul/02-models.md §3 placement rules): runs the
// local detectors on a worker_threads thread so header parsing never blocks a
// manager's event loop. inspect.js sends one job at a time:
//   { id, dir, file, depth, inventory }  ->  { id, ok: true, facts }
//                                         |  { id, ok: false, error: { code, message } }

const { parentPort } = require("node:worker_threads");
const { collectLocalFacts } = require("./inspect");

parentPort.on("message", async (message) => {
  const id = message?.id;
  try {
    const facts = await collectLocalFacts(message.dir, {
      file: message.file || null,
      depth: message.depth,
      inventory: message.inventory,
    });
    parentPort.postMessage({ id, ok: true, facts });
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: { code: typeof error?.code === "string" ? error.code : "inspect_failed", message: String(error?.message || error) },
    });
  }
});
