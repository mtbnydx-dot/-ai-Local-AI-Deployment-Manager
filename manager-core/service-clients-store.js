const {
  applyServiceClientUsage,
  createServiceClientRecord,
  deleteServiceClientRecord,
  normalizeServiceClientsLedger,
  redactServiceClient,
  redactServiceClientsLedger,
  resolveServiceClientForApiKey,
  rotateServiceClientKeyRecord,
  updateServiceClientRecord,
} = require("./service-policy");

function createServiceClientsStore(options = {}) {
  const file = options.file;
  const readJsonFile = options.readJsonFile;
  const writeJsonFile = options.writeJsonFile;
  const usageStore = options.usageStore || null;
  const engine = options.engine || inferServiceClientEngine(options.managerId);
  let cache = null;

  async function getServiceClientsLedger() {
    if (cache) return cache;
    cache = normalizeServiceClientsLedger(await readJsonFile(file, {}));
    return cache;
  }

  async function saveServiceClientsLedger(ledger) {
    cache = normalizeServiceClientsLedger({
      ...ledger,
      updatedAt: new Date().toISOString(),
    });
    await writeJsonFile(file, cache);
    persistClients(cache);
    return cache;
  }

  function persistClients(ledger) {
    if (!usageStore?.persistClients) return;
    Promise.resolve()
      .then(() => usageStore.persistClients(ledger))
      .catch(() => {});
  }

  function persistUsageEvent(event) {
    if (!usageStore?.persistUsageEvent) return;
    Promise.resolve()
      .then(() => usageStore.persistUsageEvent(event))
      .catch(() => {});
  }

  function deleteClientFromUsageStore(id) {
    if (!usageStore?.deleteClient) return;
    Promise.resolve()
      .then(() => usageStore.deleteClient(id))
      .catch(() => {});
  }

  async function createServiceClient(input = {}) {
    const ledger = await getServiceClientsLedger();
    const result = createServiceClientRecord(ledger, input, { engine });
    await saveServiceClientsLedger(result.ledger);
    return { ok: true, apiKey: result.apiKey, client: redactServiceClient(result.client) };
  }

  async function updateServiceClient(id, input = {}) {
    const ledger = await getServiceClientsLedger();
    const result = updateServiceClientRecord(ledger, id, input);
    await saveServiceClientsLedger(result.ledger);
    return { ok: true, client: redactServiceClient(result.client) };
  }

  async function rotateServiceClientKey(id) {
    const ledger = await getServiceClientsLedger();
    const result = rotateServiceClientKeyRecord(ledger, id, { engine });
    await saveServiceClientsLedger(result.ledger);
    return { ok: true, apiKey: result.apiKey, client: redactServiceClient(result.client) };
  }

  async function deleteServiceClient(id) {
    const ledger = await getServiceClientsLedger();
    const result = deleteServiceClientRecord(ledger, id);
    await saveServiceClientsLedger(result.ledger);
    deleteClientFromUsageStore(id);
    return { ok: true, removed: result.removed, id: result.id };
  }

  async function resolveForApiKey(apiKey) {
    const ledger = await getServiceClientsLedger();
    return resolveServiceClientForApiKey(ledger, apiKey);
  }

  async function recordUsage(clientId, event = {}) {
    if (!clientId) return;
    const ledger = await getServiceClientsLedger();
    const index = ledger.clients.findIndex((client) => client.id === clientId);
    if (index < 0) return;
    const result = applyServiceClientUsage(ledger.clients[index], event);
    if (!result) return;
    ledger.clients[index] = result.client;
    await saveServiceClientsLedger(ledger);
    persistUsageEvent(result.event);
  }

  return {
    getServiceClientsLedger,
    saveServiceClientsLedger,
    redactServiceClientsLedger,
    createServiceClient,
    updateServiceClient,
    rotateServiceClientKey,
    deleteServiceClient,
    resolveServiceClientForApiKey: resolveForApiKey,
    recordServiceClientGatewayUsage: recordUsage,
  };
}

function inferServiceClientEngine(managerId = "") {
  const text = String(managerId || "").toLowerCase();
  if (text.includes("llama")) return "llama";
  if (text.includes("vllm")) return "vllm";
  return text || "local";
}

module.exports = {
  createServiceClientsStore,
  inferServiceClientEngine,
};
