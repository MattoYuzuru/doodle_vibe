import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { suites } from "./test-catalog.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const group = process.argv[2];
if (!suites[group]?.length) throw new Error("Choose an explicit suite group: unit or integration");
const reportDir = join(root, "artifacts", group);
await mkdir(reportDir, { recursive: true });
const results = [];
const xml = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

async function stage(destination) {
  const source = join(root, "jarvis-app");
  await mkdir(join(destination, "ops", "stand"), { recursive: true });
  // Deliberately exclude keys, JSON state, credentials, caches and student files.
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isFile() && /\.(mjs|py|md)$/.test(entry.name)) await copyFile(join(source, entry.name), join(destination, entry.name));
  }
  for (const entry of await readdir(join(source, "ops", "stand"), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".mjs")) await copyFile(join(source, "ops", "stand", entry.name), join(destination, "ops", "stand", entry.name));
  }
  await symlink(join(source, "node_modules"), join(destination, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await copyFile(join(root, "scripts", "loopback-only.cjs"), join(destination, "loopback-only.cjs"));
  await writeFile(join(destination, "calendar-base.txt"), "https://calendar.example.test\n");
}

function execute(file, cwd, fixtureHome) {
  return new Promise((done) => {
    // Allowlist environment variables rather than forwarding developer credentials.
    const env = {};
    for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "PYTHON", "CI"]) if (process.env[key] !== undefined) env[key] = process.env[key];
    Object.assign(env, {
      HOME: fixtureHome, USERPROFILE: fixtureHome, APPDATA: fixtureHome, LOCALAPPDATA: fixtureHome,
      TZ: "Europe/Moscow", MOODLE_DIRECT: "0", SESSION_WATCH: "0", CAL_TUNNEL: "0", BACKUP: "0", GUARD_WATCH: "0",
      NODE_OPTIONS: '--require="' + join(cwd, "loopback-only.cjs") + '"',
    });
    let output = "", timedOut = false;
    const child = spawn(process.execPath, [join("ops", "stand", file)], { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const stop = (signal) => { try { process.platform === "win32" ? child.kill(signal) : process.kill(-child.pid, signal); } catch { /* already exited */ } };
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    let forced;
    const timer = setTimeout(() => { timedOut = true; stop("SIGTERM"); forced = setTimeout(() => stop("SIGKILL"), 3000); }, 120_000);
    child.on("error", (error) => { output += error.stack; });
    child.on("close", (code, signal) => {
      clearTimeout(timer); clearTimeout(forced);
      // Also clean up descendants left behind by an interrupted fixture server.
      stop("SIGTERM");
      const assertions = (output.match(/^PASS\s/gm) || []).length;
      const ok = code === 0 && !timedOut && !/^FAIL\s|DOODLE_TEST_NETWORK_BLOCKED/m.test(output);
      done({ ok, code, signal, timedOut, assertions, output });
    });
  });
}

for (const file of suites[group]) {
  const temporary = await mkdtemp(join(tmpdir(), "doodle-ci-"));
  const app = join(temporary, "app"), fixtureHome = join(temporary, "fixture-home");
  const started = Date.now();
  try {
    await mkdir(fixtureHome, { recursive: true });
    await stage(app);
    const result = await execute(file, app, fixtureHome);
    results.push({ file, seconds: (Date.now() - started) / 1000, ...result });
    await writeFile(join(reportDir, file + ".log"), result.output);
    console.log((result.ok ? "PASS " : "FAIL ") + file + (result.assertions ? " (" + result.assertions + " checks)" : " (native assertions)"));
    if (!result.ok) console.error(result.output.slice(-14_000));
  } catch (error) {
    results.push({ file, seconds: (Date.now() - started) / 1000, ok: false, output: error.stack });
    console.error("FAIL " + file + ": " + error.message);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
const failed = results.filter((r) => !r.ok).length;
await writeFile(join(reportDir, "results.xml"), '<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="' + group + '" tests="' + results.length + '" failures="' + failed + '" skipped="0">\n' + results.map((r) => '<testcase name="' + xml(r.file) + '" time="' + r.seconds + '">' + (r.ok ? "" : '<failure message="Fixture suite failed">' + xml(r.output) + '</failure>') + '</testcase>').join("\n") + "\n</testsuite>\n");
console.log(group + ": " + results.length + " suites, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
