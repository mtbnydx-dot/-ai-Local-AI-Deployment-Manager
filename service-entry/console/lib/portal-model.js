// Drafts of the portal page forms (07 §6.10, 05 §12.7, §13.1): announcements
// and public model descriptions. A draft holds the form's strings; `…Body`
// turns it into the request body 05's store validates again, and `…Problems`
// is the light check that keeps an obviously wrong form from being sent.
// No DOM and no requests.

import { fromDatetimeLocal, toDatetimeLocal } from "./time-range.js";

export const ANNOUNCEMENT_SEVERITIES = Object.freeze(["info", "maintenance", "incident"]);
export const ANNOUNCEMENT_AUDIENCES = Object.freeze(["all", "keys"]);
const TITLE_MAX = 200;
const BODY_MAX = 4000;
const NAME_MAX = 120;
const DESCRIPTION_MAX = 2000;
const ALIASES_MAX = 20;
const ALIAS_MAX = 128;

export function blankAnnouncement(now = Date.now()) {
  return { severity: "info", titleZh: "", titleEn: "", bodyZh: "", bodyEn: "", startsAt: toDatetimeLocal(now), endsAt: "", audience: "all", published: false };
}

export function draftFromAnnouncement(item) {
  return {
    severity: ANNOUNCEMENT_SEVERITIES.includes(item?.severity) ? item.severity : "info",
    titleZh: String(item?.title?.zh ?? ""),
    titleEn: String(item?.title?.en ?? ""),
    bodyZh: String(item?.body?.zh ?? ""),
    bodyEn: String(item?.body?.en ?? ""),
    startsAt: toDatetimeLocal(Date.parse(item?.startsAt ?? "")),
    endsAt: item?.endsAt ? toDatetimeLocal(Date.parse(item.endsAt)) : "",
    audience: ANNOUNCEMENT_AUDIENCES.includes(item?.audience) ? item.audience : "all",
    published: item?.published === true,
  };
}

/** `{ [field]: code }` with codes from access.err.* (`required`, `too_long`, `invalid`); empty when the draft is fine. */
export function announcementProblems(draft) {
  const problems = {};
  for (const [field, value] of [["titleZh", draft.titleZh], ["titleEn", draft.titleEn]]) {
    const text = String(value).trim();
    if (!text) problems[field] = "required";
    else if (text.length > TITLE_MAX) problems[field] = "too_long";
  }
  for (const [field, value] of [["bodyZh", draft.bodyZh], ["bodyEn", draft.bodyEn]]) {
    if (String(value).length > BODY_MAX) problems[field] = "too_long";
  }
  const starts = fromDatetimeLocal(draft.startsAt);
  const ends = draft.endsAt ? fromDatetimeLocal(draft.endsAt) : null;
  if (starts === null) problems.startsAt = "required";
  if (draft.endsAt && ends === null) problems.endsAt = "invalid";
  else if (starts !== null && ends !== null && ends <= starts) problems.endsAt = "invalid";
  return problems;
}

/** The POST or PATCH body of an announcement draft. */
export function announcementBody(draft) {
  const starts = fromDatetimeLocal(draft.startsAt);
  const ends = draft.endsAt ? fromDatetimeLocal(draft.endsAt) : null;
  return {
    severity: draft.severity,
    title: { zh: draft.titleZh.trim(), en: draft.titleEn.trim() },
    body: { zh: draft.bodyZh, en: draft.bodyEn },
    startsAt: new Date(starts).toISOString(),
    endsAt: ends === null ? null : new Date(ends).toISOString(),
    audience: draft.audience,
    published: Boolean(draft.published),
  };
}

export function draftFromMeta(meta) {
  return {
    nameZh: String(meta?.displayName?.zh ?? ""),
    nameEn: String(meta?.displayName?.en ?? ""),
    descriptionZh: String(meta?.description?.zh ?? ""),
    descriptionEn: String(meta?.description?.en ?? ""),
    aliases: (Array.isArray(meta?.aliases) ? meta.aliases : []).join(", "),
    hidden: meta?.hidden === true,
    recommended: meta?.recommended === true,
    sort: String(Number.isFinite(Number(meta?.sort)) ? Number(meta.sort) : 0),
  };
}

export function parseAliases(text) {
  return [...new Set(String(text ?? "").split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

export function metaProblems(draft) {
  const problems = {};
  if (draft.nameZh.length > NAME_MAX) problems.nameZh = "too_long";
  if (draft.nameEn.length > NAME_MAX) problems.nameEn = "too_long";
  if (draft.descriptionZh.length > DESCRIPTION_MAX) problems.descriptionZh = "too_long";
  if (draft.descriptionEn.length > DESCRIPTION_MAX) problems.descriptionEn = "too_long";
  const aliases = parseAliases(draft.aliases);
  if (aliases.length > ALIASES_MAX || aliases.some((alias) => alias.length > ALIAS_MAX)) problems.aliases = "too_long";
  if (!/^-?\d{1,7}$/.test(String(draft.sort).trim())) problems.sort = "invalid";
  return problems;
}

/** The PUT body of a model description draft. */
export function metaBody(draft) {
  return {
    displayName: { zh: draft.nameZh.trim(), en: draft.nameEn.trim() },
    description: { zh: draft.descriptionZh.trim(), en: draft.descriptionEn.trim() },
    aliases: parseAliases(draft.aliases),
    hidden: Boolean(draft.hidden),
    recommended: Boolean(draft.recommended),
    sort: Number(String(draft.sort).trim()),
  };
}

const SERVER_FIELDS = Object.freeze({
  "title.zh": "titleZh",
  "title.en": "titleEn",
  "body.zh": "bodyZh",
  "body.en": "bodyEn",
  "displayName.zh": "nameZh",
  "displayName.en": "nameEn",
  "description.zh": "descriptionZh",
  "description.en": "descriptionEn",
});

/** The server's field errors of a failed save, keyed by the form's own field names. */
export function serverProblems(error) {
  const problems = {};
  for (const item of Array.isArray(error?.fieldErrors) ? error.fieldErrors : []) {
    const field = SERVER_FIELDS[item?.field] || item?.field;
    if (field && !problems[field]) problems[field] = item.code || "invalid";
  }
  return problems;
}
