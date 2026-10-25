import http from 'node:http';
import net, { isIP } from 'node:net';
import { resolvePublicAddress } from '../sources/network.mjs';

// Local CONNECT-only proxy that every Chromium request must use. Unlike Playwright's
// `route`, it sees every redirect hop and every subresource, so the allowlist cannot be
// bypassed by a server-side redirect. DNS is resolved here through the shared SSRF
// guard and the socket is pinned to the checked public address.
export async function startEgressProxy({ policy, resolver, dial = (address, port) => net.connect({ host: address, port }), allowPorts = [443], maxConnections = 64, idleMs = 60_000 }) {
  const sockets = new Set();
  const stats = { allowed: 0, denied: 0 };
  const server = http.createServer((_req, res) => { stats.denied++; res.writeHead(403, { connection: 'close' }); res.end(); });
  server.on('connect', async (req, client, head) => {
    const deny = () => { stats.denied++; client.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n'); };
    client.on('error', () => client.destroy());
    const match = /^([A-Za-z0-9.-]{1,253}):(\d{1,5})$/.exec(req.url ?? '');
    if (!match) return deny();
    const host = match[1].toLowerCase(); const port = Number(match[2]);
    if (!allowPorts.includes(port) || isIP(host) || sockets.size >= maxConnections || !policy.allows(host)) return deny();
    let address;
    try { address = await resolvePublicAddress(host, resolver); } catch { return deny(); }
    if (client.destroyed) return;
    const upstream = dial(address.address, port, host);
    sockets.add(client); sockets.add(upstream);
    const drop = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
    upstream.setTimeout(idleMs, drop); client.setTimeout(idleMs, drop);
    upstream.on('error', drop); client.on('close', drop); upstream.on('close', drop);
    upstream.once('connect', () => {
      stats.allowed++;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    port: server.address().port, stats,
    async close() { server.close(); for (const socket of sockets) socket.destroy(); sockets.clear(); },
  };
}
