"use strict";

// The data behind the portal's /docs/errors page (05 §10.2, §12.4). The page is
// generated from the error taxonomy: this module turns PUBLIC_ERROR_TAXONOMY
// into portal/data/error-taxonomy.json, which the buildless portal fetches.
// test/portal-docs.test.js fails when the file drifts from the taxonomy;
// regenerate it with:  node service-entry/lib/portal-error-docs.js --write

const fs = require("node:fs");
const path = require("node:path");
const { PUBLIC_ERROR_TAXONOMY } = require("./public-errors");

const DATA_PATH = path.join(__dirname, "..", "portal", "data", "error-taxonomy.json");

/** The portal's view of the taxonomy: codes, statuses, types, stable message and zh/en copy. */
function buildErrorDocs(taxonomy = PUBLIC_ERROR_TAXONOMY) {
  return {
    schemaVersion: 1,
    errors: taxonomy.map((item) => ({
      code: item.code,
      status: item.status,
      anthropicStatus: item.anthropicStatus,
      openaiType: item.openaiType,
      anthropicType: item.anthropicType,
      message: item.message,
      param: item.param,
      retryAfter: item.retryAfterSeconds !== null,
      copy: {
        "zh-CN": { title: item.copy["zh-CN"].title, explanation: item.copy["zh-CN"].explanation, steps: [...item.copy["zh-CN"].steps] },
        "en-US": { title: item.copy["en-US"].title, explanation: item.copy["en-US"].explanation, steps: [...item.copy["en-US"].steps] },
      },
    })),
  };
}

function serializeErrorDocs(taxonomy) {
  return `${JSON.stringify(buildErrorDocs(taxonomy), null, 2)}\n`;
}

if (require.main === module) {
  if (process.argv.includes("--write")) {
    fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
    fs.writeFileSync(DATA_PATH, serializeErrorDocs());
    process.stdout.write("portal/data/error-taxonomy.json written\n");
  } else {
    process.stdout.write(serializeErrorDocs());
  }
}

module.exports = { DATA_PATH, buildErrorDocs, serializeErrorDocs };
