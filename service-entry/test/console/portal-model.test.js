// CON-21: the drafts behind the portal page forms (console/lib/portal-model.js),
// checked against the real 05 key store: a draft the console accepts becomes a
// body the store accepts, and the store's field errors land on the form's fields.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import {
  announcementBody,
  announcementProblems,
  blankAnnouncement,
  draftFromAnnouncement,
  draftFromMeta,
  metaBody,
  metaProblems,
  parseAliases,
  serverProblems,
} from "../../console/lib/portal-model.js";
import { fromDatetimeLocal } from "../../console/lib/time-range.js";

const require = createRequire(import.meta.url);

const NOW = Date.parse("2026-10-14T12:00:00Z");

test("a blank announcement starts now, unpublished, for everyone", () => {
  const draft = blankAnnouncement(NOW);
  assert.equal(draft.severity, "info");
  assert.equal(draft.audience, "all");
  assert.equal(draft.published, false);
  assert.ok(fromDatetimeLocal(draft.startsAt) !== null);
  assert.deepEqual(Object.keys(announcementProblems(draft)).sort(), ["titleEn", "titleZh"]);
});

test("an announcement draft is checked lightly and becomes the body 05 takes", () => {
  const draft = { ...blankAnnouncement(NOW), titleZh: " 维护 ", titleEn: " Maintenance ", bodyZh: "今晚", bodyEn: "Tonight", severity: "maintenance", published: true, audience: "keys", endsAt: "2099-01-01T10:00" };
  assert.deepEqual(announcementProblems(draft), {});
  const body = announcementBody(draft);
  assert.deepEqual(body.title, { zh: "维护", en: "Maintenance" });
  assert.deepEqual(body.body, { zh: "今晚", en: "Tonight" });
  assert.equal(body.severity, "maintenance");
  assert.equal(body.audience, "keys");
  assert.equal(body.published, true);
  assert.match(body.startsAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(body.endsAt, /^2099-/);
  assert.equal(announcementBody({ ...draft, endsAt: "" }).endsAt, null);

  assert.equal(announcementProblems({ ...draft, titleEn: "x".repeat(201) }).titleEn, "too_long");
  assert.equal(announcementProblems({ ...draft, bodyZh: "x".repeat(4001) }).bodyZh, "too_long");
  assert.equal(announcementProblems({ ...draft, startsAt: "" }).startsAt, "required");
  assert.equal(announcementProblems({ ...draft, endsAt: "1999-01-01T00:00" }).endsAt, "invalid", "an end before the start");
  assert.equal(announcementProblems({ ...draft, endsAt: "soon" }).endsAt, "invalid");
});

test("an announcement round-trips through the real key store", () => {
  const { createKeysStore } = require("../../lib/keys-store.js");
  const { DatabaseSync } = require("node:sqlite");
  const store = createKeysStore({ DatabaseSync, file: ":memory:" });
  const draft = { ...blankAnnouncement(NOW), titleZh: "公告", titleEn: "Notice", severity: "incident", published: true };
  const created = store.createAnnouncement(announcementBody(draft), { actor: "test" });
  assert.equal(created.severity, "incident");
  const again = draftFromAnnouncement(created);
  assert.equal(again.titleEn, "Notice");
  assert.equal(again.titleZh, "公告");
  assert.equal(again.published, true);
  assert.equal(again.severity, "incident");
  assert.equal(announcementBody(again).title.en, "Notice");
  store.close?.();
});

test("a model description draft becomes the PUT body, with aliases split and de-duplicated", () => {
  assert.deepEqual(parseAliases("a, b\nb ,, c"), ["a", "b", "c"]);
  const draft = { ...draftFromMeta(null), nameEn: " Qwen ", descriptionZh: "好用", aliases: "q, qwen", recommended: true, sort: "-2" };
  assert.deepEqual(metaProblems(draft), {});
  assert.deepEqual(metaBody(draft), {
    displayName: { zh: "", en: "Qwen" },
    description: { zh: "好用", en: "" },
    aliases: ["q", "qwen"],
    hidden: false,
    recommended: true,
    sort: -2,
  });
  assert.equal(metaProblems({ ...draft, sort: "1.5" }).sort, "invalid");
  assert.equal(metaProblems({ ...draft, nameZh: "x".repeat(121) }).nameZh, "too_long");
  assert.equal(metaProblems({ ...draft, descriptionEn: "x".repeat(2001) }).descriptionEn, "too_long");
  assert.equal(metaProblems({ ...draft, aliases: Array.from({ length: 21 }, (_, i) => `a${i}`).join(",") }).aliases, "too_long");
});

test("model metadata round-trips through the real key store", () => {
  const { createKeysStore } = require("../../lib/keys-store.js");
  const { DatabaseSync } = require("node:sqlite");
  const store = createKeysStore({ DatabaseSync, file: ":memory:" });
  const draft = { ...draftFromMeta(null), nameZh: "千问", nameEn: "Qwen", aliases: "q", recommended: true, hidden: false, sort: "3" };
  const saved = store.upsertModelMeta("qwen3.8-flash", metaBody(draft), { actor: "test" });
  const again = draftFromMeta(saved);
  assert.deepEqual([again.nameZh, again.nameEn, again.aliases, again.recommended, again.sort], ["千问", "Qwen", "q", true, "3"]);
  store.close?.();
});

test("serverProblems maps the store's field names onto the form's", () => {
  const error = { fieldErrors: [{ field: "title.zh", code: "required" }, { field: "displayName.en", code: "too_long" }, { field: "endsAt", code: "out_of_range" }, { field: "title.zh", code: "invalid" }, { field: null, code: "x" }] };
  assert.deepEqual(serverProblems(error), { titleZh: "required", nameEn: "too_long", endsAt: "out_of_range" });
  assert.deepEqual(serverProblems(null), {});
});
