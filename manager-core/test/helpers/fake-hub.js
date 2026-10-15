"use strict";

// A fake service-entry for the manager hub-shim tests (03 §20). It listens on
// an ephemeral loopback port and verifies every request with
// manager-core/internal-auth.js exactly as the entry does: machine signature
// over method + path + query + principal + ts + sha256(body), from a loopback
// socket. Unsigned or badly signed requests get 401 and never reach a route.
// It serves the hub download routes the shim calls and a downloads SSE stream
// the test can push events into. Nothing here talks to a real service.

const http = require("node:http");
const internalAuth = require("../../internal-auth");

const FAKE_TRUST_TOKEN = "fake-hub-trust-token-0123456789abcdef";

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function envelope(code, message) {
  return { ok: false, error: { code, message } };
}

async function startFakeHub({ token = FAKE_TRUST_TOKEN, jobs = [], logs = {} } = {}) {
  const state = {
    jobs: jobs.map((job) => JSON.parse(JSON.stringify(job))),
    logs: { ...logs },
    requests: [],
    rejected: [],
    streams: new Set(),
    // "ok" | "hub-down" (503 hub_unavailable) | "reject" (401 for everything)
    mode: "ok",
  };

  function find(id) {
    return state.jobs.find((job) => job.id === id) || state.jobs.find((job) => (job.legacyIds || []).includes(id)) || null;
  }

  function route(req, res, url, body) {
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write(": open\n\n");
      state.streams.add(res);
      res.on("close", () => state.streams.delete(res));
      return;
    }
    if (state.mode === "hub-down") return json(res, 503, envelope("hub_unavailable", "The model hub is not running."));
    if (parts[0] !== "api" || parts[1] !== "hub" || parts[2] !== "downloads") return json(res, 404, envelope("not_found", "No route."));
    if (req.method === "GET" && parts.length === 3) {
      const owner = url.searchParams.get("owner");
      const list = state.jobs.filter((job) => !owner || job.ownerManagerId === owner);
      return json(res, 200, { ok: true, jobs: list, aggregate: { activeCount: 0, queuedCount: 0, speedBps: 0, etaSeconds: null }, nextCursor: null });
    }
    const job = find(parts[3]);
    if (!job) return json(res, 404, envelope("download_not_found", "No such download."));
    const action = parts[4] || "";
    if (req.method === "GET" && !action) return json(res, 200, { ok: true, job });
    if (req.method === "GET" && action === "logs") {
      const lines = state.logs[job.id] || [];
      const tail = Number(url.searchParams.get("tail")) || 200;
      return json(res, 200, { ok: true, lines: lines.slice(-tail), total: lines.length });
    }
    if (req.method === "GET" && action === "resume-check") {
      return json(res, 200, { ok: true, complete: false, bytesRemaining: 10, jobId: job.id, state: job.state, outputName: job.target?.outputName });
    }
    if (req.method === "POST" && ["pause", "resume", "cancel"].includes(action)) {
      if (action === "pause" && job.state === "paused") return json(res, 409, envelope("invalid_state", "The download is already paused."));
      job.state = { pause: "paused", resume: "queued", cancel: "cancelled" }[action];
      return json(res, 200, { ok: true, job, ...(action === "cancel" ? { reclaimedBytes: 0 } : {}) });
    }
    return json(res, 404, envelope("not_found", "No route."));
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url, "http://127.0.0.1");
      const verdict = internalAuth.verifyMachineSignature(req, token);
      const bodyOk = verdict.ok && internalAuth.bodySha256Hex(raw) === verdict.bodySha256;
      if (!verdict.ok || !bodyOk || state.mode === "reject") {
        state.rejected.push({ method: req.method, url: req.url, code: verdict.ok ? "body_mismatch" : verdict.code });
        return json(res, 401, envelope("internal_signature_invalid", "Bad signature."));
      }
      let body = null;
      try { body = raw.length ? JSON.parse(raw.toString("utf8")) : null; } catch {}
      state.requests.push({ method: req.method, url: req.url, principal: verdict.principal, requestId: req.headers["x-request-id"] || null, body });
      route(req, res, url, body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    port,
    token,
    state,
    baseUrl: `http://127.0.0.1:${port}`,
    push(type, data = {}) {
      for (const stream of state.streams) stream.write(`id: ${Date.now()}\nevent: ${type}\ndata: ${JSON.stringify({ type, data })}\n\n`);
    },
    async close() {
      for (const stream of state.streams) stream.destroy();
      state.streams.clear();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { FAKE_TRUST_TOKEN, startFakeHub };
