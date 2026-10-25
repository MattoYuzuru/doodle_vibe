// Defense against accidental live-provider calls from trusted synthetic tests.
// This is a regression guard, not a sandbox for hostile code.
const net = require("node:net");
const dns = require("node:dns");
const allowed = (host) => !host || host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host) || /^::ffff:127\./.test(host);
function deny(host) {
  process.stderr.write("DOODLE_TEST_NETWORK_BLOCKED " + String(host) + "\n");
  const error = new Error("Synthetic tests may only connect to loopback");
  error.code = "E_TEST_EXTERNAL_NETWORK";
  throw error;
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const arg = args[0];
  const options = Array.isArray(arg) ? arg[0] : arg;
  const host = typeof options === "object" && options !== null ? options.host || options.hostname : typeof args[1] === "string" ? args[1] : undefined;
  if (!allowed(host)) deny(host);
  return connect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function (host, ...args) {
  if (!allowed(host)) deny(host);
  return lookup.call(this, host, ...args);
};
