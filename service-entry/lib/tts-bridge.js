"use strict";
const crypto = require("node:crypto");

function signedTtsHeaders(token, { owner = "", requestId = "", method = "GET", path = "/", policy = {} } = {}) {
  const context = Buffer.from(JSON.stringify({ owner, requestId, method, path, policy, timestamp: Date.now() })).toString("base64url");
  return { "x-tts-context": context, "x-tts-context-signature": crypto.createHmac("sha256", token).update(context).digest("base64url") };
}

function createTtsReconciler({ getStore, getToken, getPort, getKey, fetchImpl = fetch, onError = console.warn }) {
  let active = null;
  async function flush() {
    if (active) return active;
    active = (async () => {
      const pending = getStore().listPendingTtsRequests();
      for (let offset = 0; offset < pending.length; offset += 4) {
        await Promise.all(pending.slice(offset, offset + 4).map(async (meter) => {
          try {
            const path = `/internal/receipts/${meter.requestId}`;
            const headers = signedTtsHeaders(getToken(), { owner: `${meter.managerId}:${meter.clientId}`, requestId: meter.requestId, path });
            if (getKey()) headers.authorization = `Bearer ${getKey()}`;
            const response = await fetchImpl(`http://127.0.0.1:${getPort()}${path}`, { headers, signal: AbortSignal.timeout(3000), redirect: "error" });
            if (response.status === 404 && Date.now() - Date.parse(meter.createdAt) > 30 * 60 * 1000) {
              getStore().recordTtsUsage({ ...meter, status: 504, ok: false, audioMs: 0, durationSource: "missing" });
            } else if (response.ok) {
              const receipt = await response.json();
              if (receipt.complete) getStore().recordTtsUsage({ ...meter, ...receipt, status: receipt.ok ? 200 : 502 });
            }
          } catch (error) {
            // The pending SQLite row remains the retry queue, including after restart.
            if (error.code && !["ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"].includes(error.code)) onError(`TTS settlement pending: ${error.message}`);
          }
        }));
      }
    })().finally(() => { active = null; });
    return active;
  }
  return { flush };
}

module.exports = { signedTtsHeaders, createTtsReconciler };
