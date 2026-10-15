// Error text of the Access pages: the catalog line for the codes these pages
// can meet (`access.apiError.<code>`), else the console-wide description
// (lib/api.js describeError) which falls back to the server's own message.

import { describeError } from "../../lib/api.js";
import { tk } from "../../lib/i18n.js";

export function accessError(error, i18n) {
  const key = tk("access.apiError.", error?.code || "");
  if (error?.code && i18n.has(key)) return i18n.t(key);
  return describeError(error, i18n);
}

/** An Error that ConfirmDialog shows as `message` (an Error without its own code reads as the generic "something went wrong"). */
export function shown(message) {
  return Object.assign(new Error(message), { code: "access_message" });
}
