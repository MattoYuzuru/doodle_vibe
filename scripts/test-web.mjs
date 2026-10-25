// Unit tests of pure Mini App modules (mascot state and similar). They run in plain Node with a fixed clock and
// synthetic data: no browser, network, backend or secrets.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "jarvis-app", "web", "tests");
const files = readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).map((f) => join(dir, f));
if (!files.length) throw new Error("No web unit tests found in " + dir);
const result = spawnSync(process.execPath, ["--import", join(root, "scripts", "web-ts-hooks.mjs"), "--test", ...files], {
  stdio: "inherit",
  // Same idea as scripts/test.mjs: pass only what Node needs, never the developer's credentials.
  env: Object.fromEntries(["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "CI"]
    .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]).concat([["TZ", "UTC"]])),
});
process.exitCode = result.status ?? 1;
