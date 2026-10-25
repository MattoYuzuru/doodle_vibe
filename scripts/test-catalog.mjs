// Explicit coverage: these legacy suites are run from isolated, code-only copies.
// Windows file-lock suites and the full OpenClaw simulation are not part of this gate.
export const suites = {
  unit: [
    "admission-test.mjs", "moodle-plan-test.mjs", "attendance-test.mjs",
    "calendar-test.mjs", "cal-tunnel-test.mjs", "ratelimit-test.mjs",
    "tunnel-url-test.mjs", "tunnel-mainapp-test.mjs",
  ],
  integration: [
    "pace-test.mjs", "sheets-test.mjs", "course-sheets-test.mjs",
    "ej-cred-test.mjs", "deadlines-disk-test.mjs", "tg-retry-test.mjs",
    "consent-test.mjs", "purge-test.mjs",
  ],
};
