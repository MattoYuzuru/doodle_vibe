import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { suites } from "./test-catalog.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const fail = (message) => { failures++; console.error(message); };
function walk(directory, recursive = true) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? recursive ? walk(path) : [] : entry.isFile() ? [path] : [];
  });
}
const javascript = [...walk(join(root, "scripts")), ...walk(join(root, "tests")), ...walk(join(root,"backend","src")), ...walk(join(root,"backend","scripts")), ...walk(join(root,"backend","test")), ...walk(join(root, "jarvis-app"), false), ...walk(join(root, "jarvis-app", "ops", "stand"))].filter((file) => /\.(mjs|cjs)$/.test(file));
for (const file of javascript) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) fail(result.stderr || "Cannot check " + file);
}
for (const [group, files] of Object.entries(suites)) {
  if (!files.length || new Set(files).size !== files.length) fail("Empty or duplicate test group: " + group);
  for (const file of files) if (!existsSync(join(root, "jarvis-app", "ops", "stand", file))) fail("Missing test: " + file);
}
// Only maintained onboarding/design docs are canonical; legacy operation journals are historical.
const documents = ["README.md", "CONTRIBUTING.md", "AGENTS.md", "CLAUDE.md"].map((file) => join(root, file)).filter(existsSync).concat(walk(join(root, "docs")).filter((file) => extname(file) === ".md"));
for (const file of documents) {
  const body = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
  for (const match of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim().replace(/^<|>$/g, "");
    if (!raw || /^(?:[a-z][a-z\d+.-]*:|#)/i.test(raw)) continue;
    const target = decodeURIComponent(raw.split("#")[0].replace(/:\d+$/, ""));
    if (!target) continue;
    if (target.startsWith("/")) { fail("Nonportable absolute documentation link in " + file + ": " + raw); continue; }
    if (!existsSync(resolve(dirname(file), target))) fail("Broken documentation link in " + file + ": " + raw);
  }
}
console.log("Checked " + javascript.length + " JavaScript files, " + documents.length + " maintained Markdown documents and the test catalog.");
process.exitCode = failures ? 1 : 0;
