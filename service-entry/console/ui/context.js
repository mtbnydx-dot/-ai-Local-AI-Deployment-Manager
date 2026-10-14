// The console's services, shared through one Preact context (07 §3.2 step 4).
//
// app.js creates them once per tab: api (lib/api.js), cache (lib/store.js),
// events (lib/events.js), router (lib/router.js), i18n (lib/i18n.js),
// formatters (lib/format.js), prefs (lib/prefs.js createPrefsStore), role (a
// lib/store.js signal), toasts, visibility and the bootstrap. Components read
// them with useServices() or the narrower hooks in ui/hooks.js.

import { createContext, useContext } from "./vendor.js";

export const ServicesContext = createContext(null);

const REQUIRED = ["api", "cache", "i18n"];

/**
 * Freezes the service bag after checking the services every hook relies on.
 * Optional ones (events, router, formatters, prefs, role, toasts, visibility,
 * bootstrap) may be absent in tests and in the ui-kit page.
 */
export function createServices(services) {
  for (const name of REQUIRED) {
    if (!services?.[name]) throw new TypeError(`createServices needs ${name}`);
  }
  return Object.freeze({ ...services });
}

export function useServices() {
  const services = useContext(ServicesContext);
  if (!services) throw new Error("useServices() must run inside <ServicesContext.Provider>");
  return services;
}
