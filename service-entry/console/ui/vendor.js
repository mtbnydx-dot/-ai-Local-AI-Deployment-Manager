// The only static imports of vendored code (07 C1b, §3.1). Every other
// console module takes Preact, its hooks, htm and the icon subset from here
// (or from ui/html.js and ui/hooks.js), so a version upgrade is a path
// change in this file plus a test run. The paths are relative to the
// snapshot's /c/<buildId>/ui/, where vendor/ is shared-public/vendor/.
//
// Preact 11 compatibility (07 C1): no defaultProps on function components,
// no this.base, no string refs, no `options` hooks and no preact/compat, so
// `options` is deliberately not re-exported.

export {
  Component,
  Fragment,
  cloneElement,
  createContext,
  createRef,
  h,
  isValidElement,
  render,
  toChildArray,
} from "../vendor/preact/10.29.8/preact.module.js";
export {
  useCallback,
  useContext,
  useEffect,
  useErrorBoundary,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "../vendor/preact/10.29.8/hooks.module.js";
export { default as htm } from "../vendor/htm/3.1.1/htm.module.js";
export { defaultAttributes as iconAttributes, icons } from "../vendor/lucide/0.454.0/icons.js";
