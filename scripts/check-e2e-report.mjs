import { readFileSync } from "node:fs";

const report = readFileSync(new URL("../artifacts/e2e/results.xml", import.meta.url), "utf8");
const tests = (report.match(/<testcase\b/g) || []).length;
if (!tests || /<(?:failure|error|skipped)\b/.test(report)) {
  throw new Error("Browser gate requires executed test cases without failures, errors or skips");
}
console.log("Browser report: " + tests + " executed scenarios, no failures or skips");
