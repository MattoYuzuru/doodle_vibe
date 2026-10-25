// Lets Node run Mini App TypeScript modules in unit tests without a bundler: the web code imports
// "./urgency" without an extension (Vite resolves it), so a failed relative import is retried with ".ts".
// Node strips the types itself; only erasable TypeScript syntax is supported.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (!/^\.{1,2}\//.test(specifier) || /\.[cm]?[jt]sx?$/.test(specifier)) throw error;
      return next(specifier + ".ts", context);
    }
  },
});
