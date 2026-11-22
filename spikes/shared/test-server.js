// Servidor HTTP local para las pruebas de concepto de Callisto V0.1.
// Solo escucha en 127.0.0.1 y genera contenido determinista (no sirve archivos del disco).
'use strict';
const http = require('node:http');

const KB = 1024;
const MB = 1024 * KB;

function fillChunk(size, seed) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i + seed) & 0xff;
  return buf;
}

// Envía `size` bytes. mode: 'fast' (todo de golpe), 'slow' (512 KB y luego 64 KB cada 500 ms)
function streamBody(res, size, mode) {
  let sent = 0;
  const chunk = fillChunk(64 * KB, 7);
  if (mode === 'slow') {
    const first = Math.min(512 * KB, size);
    res.write(fillChunk(first, 7));
    sent = first;
    const timer = setInterval(() => {
      if (res.destroyed) return clearInterval(timer);
      const n = Math.min(64 * KB, size - sent);
      if (n <= 0) { clearInterval(timer); return res.end(); }
      res.write(chunk.subarray(0, n));
      sent += n;
    }, 500);
    res.on('close', () => clearInterval(timer));
    return;
  }
  const pump = () => {
    while (sent < size) {
      const n = Math.min(chunk.length, size - sent);
      sent += n;
      if (!res.write(chunk.subarray(0, n))) return res.once('drain', pump);
    }
    res.end();
  };
  pump();
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>Callisto download lab</title>
<h1>Callisto download lab</h1>
<form id="postform" method="POST" action="/form"><input name="q" value="1"></form>
<iframe id="frame" style="width:10px;height:10px"></iframe>
<script>
  window.makeBlobUrl = (size) => URL.createObjectURL(new Blob([new Uint8Array(size).fill(65)], {type: 'application/octet-stream'}));
  window.clickLink = (href, download) => {
    const a = document.createElement('a');
    a.href = href;
    if (download !== undefined) a.download = download;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
</script>`;

function createServer(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const size = Number(url.searchParams.get('size') || 1 * MB);
    const mode = url.searchParams.get('mode') || 'fast';
    const name = url.searchParams.get('name') || 'callisto-test.bin';

    if (url.pathname === '/' || url.pathname === '/lab') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }
    if (url.pathname === '/set-cookies') {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Set-Cookie': [
          `persistent_${url.searchParams.get('tag')}=1; Max-Age=86400; Path=/; SameSite=Lax`,
          `session_${url.searchParams.get('tag')}=1; Path=/; SameSite=Lax`,
        ],
      });
      return res.end('ok');
    }
    if (url.pathname === '/echo-headers') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(req.headers, null, 2));
    }
    if (url.pathname === '/file/attach') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Content-Length': String(size),
      });
      return streamBody(res, size, mode);
    }
    if (url.pathname === '/file/octet') {
      // Sin Content-Disposition: tipo no renderizable -> descarga
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) });
      return streamBody(res, size, mode);
    }
    if (url.pathname === '/file/text') {
      // Texto renderizable: solo se descarga con <a download>
      const body = 'x'.repeat(size);
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': String(size) });
      return res.end(body);
    }
    if (url.pathname === '/file/pdf-attach') {
      const body = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="doc.pdf"',
        'Content-Length': String(body.length),
      });
      return res.end(body);
    }
    if (url.pathname === '/redirect') {
      res.writeHead(302, { Location: `/file/attach?size=${size}&name=redirected.bin` });
      return res.end();
    }
    if (url.pathname === '/form') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        return res.end('method not allowed');
      }
      req.resume();
      req.on('end', () => {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="post-result.bin"',
          'Content-Length': String(size),
        });
        streamBody(res, size, 'fast');
      });
      return;
    }
    if (url.pathname === '/one-time') {
      // URL de un solo uso (simula enlaces firmados)
      const token = url.searchParams.get('t');
      if (server.usedTokens.has(token)) {
        res.writeHead(410, { 'Content-Type': 'text/plain' });
        return res.end('expired');
      }
      server.usedTokens.add(token);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="one-time.bin"',
        'Content-Length': String(size),
      });
      return streamBody(res, size, 'fast');
    }
    res.writeHead(404);
    res.end('not found');
  });
  server.usedTokens = new Set();
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

module.exports = { createServer, KB, MB };
