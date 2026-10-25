import { createHash } from 'node:crypto';

// Minimal RFC 6455 server endpoint for the login stream: one text/binary message type,
// masked client frames only, bounded message size. No extensions, no compression.
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptWebSocket(req, socket, head, { maxMessage = 65_536, onMessage, onClose }) {
  const key = req.headers['sec-websocket-key'];
  if (String(req.headers.upgrade).toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key)) {
    socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true); socket.setTimeout(0);
  let buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0);
  let fragments = []; let fragmentBytes = 0; let fragmentOpcode = 0; let closed = false;
  const write = (opcode, payload) => {
    if (closed || socket.destroyed) return false;
    const length = payload.length;
    const header = length < 126 ? Buffer.from([0x80 | opcode, length]) : length < 65_536
      ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 255])
      : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(length), 2); return h; })();
    return socket.write(Buffer.concat([header, payload]));
  };
  const finish = code => { if (closed) return; closed = true; socket.destroy(); onClose?.(code); };
  const close = (code = 1000) => {
    if (closed) return;
    const payload = Buffer.alloc(2); payload.writeUInt16BE(code);
    write(8, payload);
    socket.end(); finish(code);
  };
  function parse() {
    while (buffer.length >= 2 && !closed) {
      const fin = (buffer[0] & 0x80) !== 0; const opcode = buffer[0] & 0x0f; const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f; let offset = 2;
      if ((buffer[0] & 0x70) || !masked) return close(1002);
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffer.length < 10) return; const big = buffer.readBigUInt64BE(2); if (big > BigInt(maxMessage)) return close(1009); length = Number(big); offset = 10; }
      if (length > maxMessage) return close(1009);
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buffer = buffer.subarray(offset + 4 + length);
      if (opcode >= 8) {
        if (!fin || length > 125) return close(1002);
        if (opcode === 8) return close(1000);
        if (opcode === 9) write(10, payload);
        continue;
      }
      if (opcode === 0) {
        if (!fragmentOpcode) return close(1002);
      } else if (fragmentOpcode) return close(1002);
      else if (opcode !== 1 && opcode !== 2) return close(1003);
      else fragmentOpcode = opcode;
      fragmentBytes += payload.length; fragments.push(payload);
      if (fragmentBytes > maxMessage) return close(1009);
      if (fin) {
        const message = Buffer.concat(fragments); const type = fragmentOpcode;
        fragments = []; fragmentBytes = 0; fragmentOpcode = 0;
        onMessage?.(type === 1 ? 'text' : 'binary', message);
      }
    }
  }
  socket.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); if (buffer.length > maxMessage * 2 + 64) return close(1009); parse(); });
  socket.on('error', () => finish(1006));
  socket.on('close', () => finish(1006));
  if (buffer.length) parse();
  return {
    sendText: text => write(1, Buffer.from(text)),
    sendBinary: data => write(2, data),
    get buffered() { return socket.writableLength; },
    close, destroy: () => finish(1006),
  };
}
