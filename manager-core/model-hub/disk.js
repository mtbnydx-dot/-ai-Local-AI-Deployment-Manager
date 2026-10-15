"use strict";

// Disk accounting of the download queue (03 §8): which drive a target is on,
// how much is free there, and the reserve the queue never fills.
//
//   volumeOf(p)                         "X:" (the drive of the real path), "/" off Windows
//   freeBytes(p, { statfs })            free bytes of the volume holding p (nearest existing ancestor)
//   reserveBytes(free, settings)        max(5 % of free, storage.reserveGb)
//   availableBytes({ free, pending, reserve })   free − pending − reserve, never below 0
//   createDiskGuard({ statfs, volumeOf }) → { volumeOf, freeBytes, reserveBytes }
//
// The root-aware usage view (03 §13.5, computeUsage) comes with HUB-9; this
// file holds only what the queue needs to decide `waiting/disk` and
// `disk_full`.

const fsp = require("node:fs/promises");
const { measureDiskFreeBytes } = require("../download-resume-check");
const { volumeOf } = require("./library");

const GIB = 1024 ** 3;
const RESERVE_FRACTION = 0.05;
const DEFAULT_RESERVE_GB = 10;

function settingNumber(settings, key, fallback) {
  const source = typeof settings === "function" ? settings() : settings;
  let current = source;
  for (const segment of key.split(".")) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, segment)) return fallback;
    current = current[segment];
  }
  const value = Number(current);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** The reserve the queue keeps free on a volume: max(5 % of free, storage.reserveGb). */
function reserveBytes(free, settings) {
  const freeBytes = Number(free);
  const fraction = Number.isFinite(freeBytes) && freeBytes > 0 ? freeBytes * RESERVE_FRACTION : 0;
  return Math.round(Math.max(fraction, settingNumber(settings, "storage.reserveGb", DEFAULT_RESERVE_GB) * GIB));
}

/** Free bytes of the volume holding `target`; null when no ancestor can be measured. */
function freeBytes(target, { statfs = fsp.statfs } = {}) {
  // measureDiskFreeBytes starts at the parent, so the target itself need not exist yet.
  return measureDiskFreeBytes(target, statfs);
}

function availableBytes({ free, pending = 0, reserve = 0 } = {}) {
  const value = Number(free) - Math.max(0, Number(pending) || 0) - Math.max(0, Number(reserve) || 0);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** The queue's `disk` dependency; tests replace statfs (or the whole object). */
function createDiskGuard(options = {}) {
  const statfs = typeof options.statfs === "function" ? options.statfs : fsp.statfs;
  const volume = typeof options.volumeOf === "function" ? options.volumeOf : volumeOf;
  return {
    volumeOf: (target) => volume(target),
    freeBytes: (target) => freeBytes(target, { statfs }),
    reserveBytes,
  };
}

module.exports = {
  DEFAULT_RESERVE_GB,
  RESERVE_FRACTION,
  availableBytes,
  createDiskGuard,
  freeBytes,
  reserveBytes,
  volumeOf,
};
