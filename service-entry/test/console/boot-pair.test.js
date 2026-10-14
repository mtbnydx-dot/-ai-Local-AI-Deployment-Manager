// 07 §3.2 step 1: the `#pair=` code is read, stripped from the address bar
// before anything else runs, sent only in the pair POST, and an invalid code
// ends on the PairingScreen.

import assert from "node:assert/strict";
import test from "node:test";

import { extractPairCode, pairingScreenState, runBootPair, stripPairFragment } from "../../console/lib/boot-pair.js";

const CODE = "Pq7x-Fake_Code42";

function harness(href, log) {
  const [rest, hash = ""] = href.split("#");
  const [pathname, search = ""] = rest.split("?");
  const location = { pathname, search: search ? `?${search}` : "", hash: hash ? `#${hash}` : "" };
  const history = {
    state: { scroll: 3 },
    replaceState(state, title, url) {
      log.push(["replaceState", url, state]);
      location.hash = "";
    },
  };
  return { location, history };
}

test("extractPairCode reads well-formed codes only", () => {
  assert.equal(extractPairCode({ hash: `#pair=${CODE}` }), CODE);
  assert.equal(extractPairCode({ hash: `#pair=${encodeURIComponent(CODE)}&x=1` }), CODE);
  assert.equal(extractPairCode({ hash: "#pair=" }), null);
  assert.equal(extractPairCode({ hash: "#pair=<script>" }), null);
  assert.equal(extractPairCode({ hash: "#pair=%E0%A4%A" }), null);
  assert.equal(extractPairCode({ hash: "#key=abcdef" }), null);
  assert.equal(extractPairCode({ hash: "" }), null);
  assert.equal(extractPairCode(null), null);
});

test("stripPairFragment keeps the path, query and history state", () => {
  const log = [];
  const { location, history } = harness(`/overview?x=1#pair=${CODE}`, log);
  assert.equal(stripPairFragment({ history, location }), true);
  assert.deepEqual(log, [["replaceState", "/overview?x=1", { scroll: 3 }]]);
  assert.equal(stripPairFragment({ history, location }), false, "nothing left to strip");
});

test("the fragment is stripped before the pair request, which alone carries the code", async () => {
  const log = [];
  const { location, history } = harness(`/#pair=${CODE}`, log);
  const result = await runBootPair({
    location,
    history,
    pair: async (code) => {
      log.push(["pair", code, location.hash]);
      return { ok: true, csrfToken: "csrf-fake" };
    },
    reloadBootstrap: async () => {
      log.push(["bootstrap"]);
      return { ok: true, role: "owner" };
    },
  });
  assert.deepEqual(log.map((entry) => entry[0]), ["replaceState", "pair", "bootstrap"]);
  assert.equal(log[0][1], "/");
  assert.deepEqual(log[1], ["pair", CODE, ""], "the address bar was already clean when the request went out");
  assert.deepEqual(result, { status: "paired", csrfToken: "csrf-fake", bootstrap: { ok: true, role: "owner" } });
});

test("the strip happens synchronously, before the first await", () => {
  const log = [];
  const { location, history } = harness(`/#pair=${CODE}`, log);
  const pending = runBootPair({ location, history, pair: () => new Promise(() => {}), reloadBootstrap: async () => null });
  assert.deepEqual(log.map((entry) => entry[0]), ["replaceState"]);
  assert.equal(location.hash, "");
  assert.ok(pending instanceof Promise);
});

test("an invalid code gives the PairingScreen state and never echoes the code", async () => {
  const log = [];
  const { location, history } = harness(`/#pair=${CODE}`, log);
  const rejected = await runBootPair({
    location,
    history,
    pair: async () => {
      const error = new Error(`pair_code_invalid for ${CODE}`);
      error.code = "pair_code_invalid";
      error.status = 400;
      throw error;
    },
    reloadBootstrap: async () => assert.fail("no bootstrap re-read after a failed pair"),
  });
  assert.deepEqual(rejected, { status: "invalid", screen: { reason: "invalid" } });
  assert.equal(JSON.stringify(rejected).includes(CODE), false);

  const malformed = await runBootPair({ ...harness("/#pair=<bad>", []), pair: async () => assert.fail("a malformed code is never sent"), reloadBootstrap: async () => null });
  assert.deepEqual(malformed, { status: "invalid", screen: { reason: "invalid" } });

  const down = await runBootPair({
    ...harness(`/#pair=${CODE}`, []),
    pair: async () => {
      const error = new Error(`network ${CODE}`);
      error.code = "network_error";
      throw error;
    },
    reloadBootstrap: async () => null,
  });
  assert.deepEqual(down, { status: "failed", errorCode: "network_error", screen: { reason: "unpaired" } });
  assert.equal(JSON.stringify(down).includes(CODE), false);
});

test("no fragment means no pairing work", async () => {
  const log = [];
  const result = await runBootPair({ ...harness("/overview", log), pair: async () => assert.fail("not called"), reloadBootstrap: async () => null });
  assert.deepEqual(result, { status: "none" });
  assert.deepEqual(log, []);
});

test("pairingScreenState fills the 05 pair command and allowlists the reason", () => {
  assert.deepEqual(pairingScreenState({ reason: "invalid", session: { autoPairAvailable: true, pairCommand: "node service-entry\\scripts\\admin-pair.js --open" } }),
    { reason: "invalid", autoPairAvailable: true, pairCommand: "node service-entry\\scripts\\admin-pair.js --open" });
  assert.deepEqual(pairingScreenState({ reason: "weird" }), { reason: "unpaired", autoPairAvailable: false, pairCommand: "platform admin pair" });
});
