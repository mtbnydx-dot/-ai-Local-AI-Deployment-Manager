// The one shared context of the portal: language, translator, config, the key
// session and the small services pages call (navigate, toast, title).

import { createContext } from "preact";
import { useContext, useEffect } from "preact/hooks";

export const PortalContext = createContext(null);

export function usePortal() {
  return useContext(PortalContext);
}

/** Sets the document title to "<title> · <brand>" while the page is shown. */
export function usePageTitle(title) {
  const { setTitle } = usePortal();
  useEffect(() => {
    setTitle(title || "");
    return () => setTitle("");
  }, [title]);
}
