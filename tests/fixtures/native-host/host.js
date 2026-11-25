// Programa de prueba para la mensajería con programas instalados (protocolo de Chrome: largo de 4 bytes + JSON UTF-8)
let buf = Buffer.alloc(0);
const send = (obj) => {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
};
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
    const len = buf.readUInt32LE(0);
    const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
    buf = buf.subarray(4 + len);
    if (msg.cmd === 'exit') process.exit(0);
    if (msg.cmd === 'big') send({ big: 'x'.repeat(300000) });
    else send({ echo: msg.text, origin: process.argv[2], parent: (process.argv[3] || '').split('=')[0] });
  }
});
process.stdin.on('end', () => process.exit(0));
