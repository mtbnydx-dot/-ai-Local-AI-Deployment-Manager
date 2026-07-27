#!/usr/bin/env node

"use strict";

const http = require("node:http");

const upstream = new URL(process.env.CLIPROXY_BASE_URL || "http://127.0.0.1:18318");
const host = upstream.hostname;
const port = Number(upstream.port || (upstream.protocol === "https:" ? 443 : 80));

const server = http.createServer((request, response) => {
  const status = request.url === "/v1/models" ? 200 : 404;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(status === 200 ? '{"data":[]}' : '{"error":"not_found"}');
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
server.listen(port, host);
