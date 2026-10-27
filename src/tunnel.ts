import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createServer, type Server, type Socket } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';

export const protocol = 'fughetta-worker.v1';
const chunk = 16 * 1024;
const limit = 1 << 20;

function frame(opcode: number, payload: Buffer): Buffer {
  const size = payload.length;
  const head = size < 126 ? Buffer.from([0x80 | opcode, 0x80 | size])
    : size < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, size >> 8, size & 0xff])
    : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(size)); return b; })()]);
  const mask = randomBytes(4);
  const body = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; ++i) body[i] = payload[i]! ^ mask[i & 3]!;
  return Buffer.concat([head, mask, body]);
}

// Opens the Worker tunnel at `url` (http or https) and resolves with the upgraded socket once the gateway accepts the subprotocol.
// No Origin header is sent: the gateway refuses browser origins on this route.
export function open(url: string, ca?: Buffer, timeout = 30_000): Promise<{ socket: Socket; rest: Buffer }> {
  const key = randomBytes(16).toString('base64');
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? httpsRequest : httpRequest)(url, {
      ca, headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': key, 'sec-websocket-protocol': protocol },
    });
    const timer = setTimeout(() => req.destroy(new Error(`${url} did not open within ${timeout / 1000} seconds`)), timeout);
    req.on('upgrade', (res, socket: Socket, rest: Buffer) => {
      clearTimeout(timer);
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if (res.headers['sec-websocket-accept'] !== accept || res.headers['sec-websocket-protocol'] !== protocol) {
        socket.destroy(); reject(new Error('The gateway answered the Worker tunnel without its subprotocol')); return;
      }
      resolve({ socket, rest });
    });
    req.on('response', res => {
      clearTimeout(timer);
      const chunks: Buffer[] = [];
      res.on('data', (data: Buffer) => chunks.push(data));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let message = body;
        try { message = JSON.parse(body).message ?? body; } catch {}
        reject(new Error(`The gateway refused the Worker tunnel: HTTP ${res.statusCode}: ${message}`));
      });
    });
    req.on('error', error => { clearTimeout(timer); reject(error); });
    req.end();
  });
}

// Moves bytes between a local connection and an open tunnel in binary messages, with backpressure in both directions.
export function bridge(local: Socket, remote: Socket, rest: Buffer): void {
  let pending = rest;
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    if (remote.writable) remote.end(frame(8, Buffer.alloc(0)));
    local.end(); // Delivers what the Worker has not read yet, such as a revocation sent just before the close.
    remote.destroySoon();
  };
  local.on('data', (data: Buffer) => {
    let ok = true;
    for (let at = 0; at < data.length; at += chunk) ok = remote.write(frame(2, data.subarray(at, at + chunk))) && ok;
    if (!ok) { local.pause(); remote.once('drain', () => local.resume()); }
  });
  const read = (data: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, data]) : data;
    for (;;) {
      if (pending.length < 2) return;
      const opcode = pending[0]! & 0x0f;
      if (pending[1]! & 0x80) { finish(); return; } // A server must not mask its frames.
      let size = pending[1]! & 0x7f;
      let at = 2;
      if (size === 126) { if (pending.length < 4) return; size = pending.readUInt16BE(2); at = 4; }
      else if (size === 127) {
        if (pending.length < 10) return;
        const big = pending.readBigUInt64BE(2);
        if (big > BigInt(limit)) { finish(); return; }
        size = Number(big); at = 10;
      }
      if (size > limit) { finish(); return; }
      if (pending.length < at + size) return;
      const payload = pending.subarray(at, at + size);
      pending = pending.subarray(at + size);
      if (opcode === 8) { finish(); return; }
      if (opcode === 9) remote.write(frame(10, Buffer.from(payload)));
      else if ((opcode === 0 || opcode === 2) && !local.write(payload)) { remote.pause(); local.once('drain', () => remote.resume()); }
    }
  };
  remote.on('data', read);
  local.on('end', finish);
  remote.on('end', finish);
  local.on('error', finish);
  remote.on('error', finish);
  local.on('close', finish);
  remote.on('close', finish);
  if (rest.length) { pending = Buffer.alloc(0); read(rest); }
}

// Listens on a loopback port; each connection gets its own tunnel. The Worker connects here with plain TCP.
export async function relay(url: string, ca?: Buffer, log: (line: string) => void = console.error): Promise<{ address: string; server: Server }> {
  const server = createServer(local => {
    local.pause();
    open(url, ca).then(({ socket, rest }) => { bridge(local, socket, rest); local.resume(); },
      error => { log(`fug: ${(error as Error).message}`); local.destroy(); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { address: `127.0.0.1:${(server.address() as { port: number }).port}`, server };
}
