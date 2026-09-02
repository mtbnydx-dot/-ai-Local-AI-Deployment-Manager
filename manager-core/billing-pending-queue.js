"use strict";

const crypto = require("node:crypto");

function createBillingPendingQueue(options = {}) {
  const file = options.file;
  const readJsonFile = options.readJsonFile;
  const writeJsonFile = options.writeJsonFile;
  const authorize = options.authorize;
  const settle = options.settle;
  const maxItems = Math.max(20, Number(options.maxItems || 500));
  const flushIntervalMs = Math.max(5_000, Number(options.flushIntervalMs || 30_000));
  const onError = typeof options.onError === "function" ? options.onError : () => {};
  let items = [];
  let timer = null;
  let flushing = Promise.resolve();

  async function load() {
    if (!file || typeof readJsonFile !== "function") return items;
    try {
      const parsed = await readJsonFile(file, { items: [] });
      items = Array.isArray(parsed?.items) ? parsed.items.slice(-maxItems) : [];
    } catch (error) {
      onError(error);
      items = [];
    }
    return items;
  }

  async function save() {
    if (!file || typeof writeJsonFile !== "function") return;
    await writeJsonFile(file, {
      version: 1,
      updatedAt: new Date().toISOString(),
      items,
    });
  }

  function enqueue(event = {}) {
    items.push({
      id: String(event.id || crypto.randomUUID()),
      at: event.at || new Date().toISOString(),
      authorizeInput: event.authorizeInput || null,
      settleInput: event.settleInput || null,
    });
    if (items.length > maxItems) items = items.slice(-maxItems);
    save().catch(onError);
    return items[items.length - 1];
  }

  async function flush() {
    const pending = items.slice();
    if (!pending.length) return { flushed: 0, remaining: 0 };
    const remain = [];
    let flushed = 0;
    for (const item of pending) {
      try {
        if (item.authorizeInput && typeof authorize === "function") {
          const authorized = await authorize(item.authorizeInput);
          if (authorized?.ok === false && authorized?.allowed === false) {
            throw new Error(authorized.code || "authorize_failed");
          }
        }
        if (item.settleInput && typeof settle === "function") {
          const settlement = await settle(item.settleInput);
          if (settlement?.ok === false) throw new Error(settlement.code || "settle_failed");
        }
        flushed += 1;
      } catch (error) {
        remain.push(item);
        onError(error);
      }
    }
    items = remain;
    await save().catch(onError);
    return { flushed, remaining: remain.length };
  }

  function flushQueued() {
    flushing = flushing.catch(() => {}).then(() => flush());
    return flushing;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      flushQueued().catch(onError);
    }, flushIntervalMs);
    timer.unref?.();
  }

  async function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    return flushQueued();
  }

  return {
    load,
    save,
    enqueue,
    flush: flushQueued,
    start,
    stop,
    size: () => items.length,
    items: () => items.slice(),
  };
}

module.exports = {
  createBillingPendingQueue,
};
