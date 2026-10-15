"use strict";

// A stand-in platform component for the lifecycle tests: an HTTP server on
// STUB_PORT that answers /health, reports a running download when
// <STUB_DIR>/busy exists, and exits on POST /shutdown.

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const port = Number(process.env.STUB_PORT);
const dir = process.env.STUB_DIR || ".";

const server = http.createServer((req, res) => {
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.method === "POST" && req.url === "/shutdown") {
    send(200, { ok: true });
    setTimeout(() => process.exit(0), 20);
  } else if (req.url === "/health") send(200, { ok: true, id: process.env.STUB_ID });
  else if (req.url.startsWith("/api/jobs")) {
    const busy = fs.existsSync(path.join(dir, "busy"));
    send(200, { jobs: busy ? [{ id: "job-1", type: "download", status: "running", title: "fixture model" }] : [] });
  } else send(404, { ok: false });
});
server.listen(port, "127.0.0.1");
