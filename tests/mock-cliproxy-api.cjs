#!/usr/bin/env node

"use strict";

const http = require("node:http");

const upstream = new URL(process.env.CLIPROXY_BASE_URL || "http://127.0.0.1:18318");
const host = process.env.CLIPROXY_LISTEN_HOST || upstream.hostname;
const port = Number(upstream.port || (upstream.protocol === "https:" ? 443 : 80));
const identityHeaders = process.env.CLIPROXY_IDENTITY_HEADERS !== "0";

const server = http.createServer((request, response) => {
  const status = request.url === "/v1/models" ? 200 : 404;
  response.writeHead(status, {
    "content-type": "application/json",
    ...(identityHeaders ? {
      "x-cpa-version": "test",
      "access-control-expose-headers": "X-CPA-VERSION",
    } : {}),
  });
  response.end(status === 200 ? '{"data":[]}' : '{"error":"not_found"}');
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
server.listen(port, host);
