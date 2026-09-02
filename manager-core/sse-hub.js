"use strict";

// Minimal Server-Sent Events hub for the manager consoles. Browsers subscribe
// to /api/events; the manager pushes job snapshots instead of being polled
// every second while a download or launch is active.
function createSseHub(options = {}) {
  const heartbeatMs = Math.max(1000, Number(options.heartbeatMs || 15000));
  const clients = new Set();
  const throttleTimers = new Map();
  let heartbeatTimer = null;

  function ensureHeartbeat() {
    if (heartbeatTimer || !clients.size) return;
    heartbeatTimer = setInterval(() => {
      if (!clients.size) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        return;
      }
      for (const client of clients) {
        try {
          client.write(`: ping ${Date.now()}\n\n`);
        } catch {
          clients.delete(client);
        }
      }
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  }

  function handleRequest(req, res) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(`retry: 3000\n\n`);
    clients.add(res);
    ensureHeartbeat();
    const drop = () => clients.delete(res);
    req.on("close", drop);
    res.on("close", drop);
    res.on("error", drop);
  }

  function broadcast(event, data) {
    if (!clients.size) return 0;
    const payload = `event: ${String(event)}\ndata: ${JSON.stringify(data)}\n\n`;
    let delivered = 0;
    for (const client of clients) {
      try {
        client.write(payload);
        delivered += 1;
      } catch {
        clients.delete(client);
      }
    }
    return delivered;
  }

  // Coalesces bursts: sends immediately when idle, then at most once per
  // interval, always ending with a trailing send carrying the latest data.
  function broadcastThrottled(event, buildData, intervalMs = 700) {
    if (!clients.size) return;
    const key = String(event);
    const timer = throttleTimers.get(key);
    if (timer) {
      timer.pending = buildData;
      return;
    }
    const send = (build) => {
      try {
        broadcast(key, typeof build === "function" ? build() : build);
      } catch {
        // A snapshot builder failure must never break the caller's path.
      }
    };
    send(buildData);
    const entry = {
      pending: null,
      handle: setTimeout(() => {
        throttleTimers.delete(key);
        if (entry.pending) broadcastThrottled(key, entry.pending, intervalMs);
      }, Math.max(50, intervalMs)),
    };
    entry.handle.unref?.();
    throttleTimers.set(key, entry);
  }

  function close() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    for (const entry of throttleTimers.values()) clearTimeout(entry.handle);
    throttleTimers.clear();
    for (const client of clients) {
      try {
        client.end();
      } catch {
        // Already gone.
      }
    }
    clients.clear();
  }

  return {
    handleRequest,
    broadcast,
    broadcastThrottled,
    close,
    clientCount: () => clients.size,
  };
}

module.exports = { createSseHub };
