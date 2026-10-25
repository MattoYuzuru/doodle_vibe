import { isIP } from 'node:net';

// Host allowlist for one login session. Presets name hosts explicitly; an unknown
// university gets only the registrable suffix of its own host. The policy is the
// single source of truth for both the egress proxy and the browser route.
const MULTI_PART = new Set(['co.uk', 'org.uk', 'ac.uk', 'com.au', 'com.cn', 'co.jp', 'com.br', 'co.il', 'com.tr', 'com.ua']);
export function suffixFor(hostname) {
  const labels = hostname.toLowerCase().split('.').filter(Boolean);
  if (labels.length < 2) return hostname.toLowerCase();
  const two = labels.slice(-2).join('.');
  return MULTI_PART.has(two) && labels.length >= 3 ? labels.slice(-3).join('.') : two;
}

export function createHostPolicy({ hosts = [], suffixes = [], maxHosts = 12 } = {}) {
  const exact = new Set(hosts.map(host => host.toLowerCase()));
  const wild = [...exact].filter(host => host.startsWith('*.')).map(host => host.slice(1));
  const tails = suffixes.map(suffix => `.${suffix.toLowerCase()}`);
  const bare = new Set(suffixes.map(suffix => suffix.toLowerCase()));
  const touched = new Set();
  const matches = host => exact.has(host) || bare.has(host) || wild.some(tail => host.endsWith(tail)) || tails.some(tail => host.endsWith(tail));
  return {
    // `contact` records the host for the distinct-host cap; plain checks do not.
    allows(hostname, { contact = true } = {}) {
      const host = String(hostname).toLowerCase().replace(/\.$/, '');
      if (!host.includes('.') || isIP(host) || host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || !matches(host)) return false;
      if (touched.has(host)) return true;
      if (contact && touched.size >= maxHosts) return false;
      if (contact) touched.add(host);
      return true;
    },
    contacted: () => [...touched],
  };
}
