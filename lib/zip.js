// Escritor de ZIP mínimo, sin dependencias (método STORED, sin compresión).
// Los mp4 ya vienen comprimidos, así que STORED es rápido y el archivo abre
// en iPhone (Archivos), Fire TV y Windows sin problemas.
// Dos pasadas por archivo: primero calcula el CRC32, después copia los datos,
// así no carga el video entero en memoria (los clips pueden pesar cientos de MB).
'use strict';
const fs = require('fs');

const zlibCrc = (() => { try { return require('zlib').crc32; } catch { return null; } })();
let TABLE;
function crc32(buf, prev = 0) {
  if (zlibCrc) return zlibCrc(buf, prev) >>> 0; // misma semántica encadenable
  if (!TABLE) {
    TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); TABLE[n] = c >>> 0; }
  }
  let c = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = (TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

const MAX = 0xfffffffe; // sin ZIP64: cada archivo y el total deben entrar en 32 bits

// entries: [{ path, name }]  ·  outPath: archivo .zip a crear
async function buildZip(entries, outPath) {
  const out = fs.createWriteStream(outPath);
  const put = (buf) => new Promise((ok, no) => { if (out.write(buf)) ok(); else out.once('drain', ok); out.once('error', no); });
  const copy = (p) => new Promise((ok, no) => {
    const rs = fs.createReadStream(p);
    rs.on('error', no); rs.on('end', ok);
    rs.on('data', (d) => { if (!out.write(d)) { rs.pause(); out.once('drain', () => rs.resume()); } });
  });
  const crcOf = (p) => new Promise((ok, no) => {
    let crc = 0; const rs = fs.createReadStream(p);
    rs.on('error', no); rs.on('data', (d) => { crc = crc32(d, crc); }); rs.on('end', () => ok(crc));
  });

  try {
    const records = [];
    let offset = 0;
    for (const e of entries) {
      const size = fs.statSync(e.path).size;
      if (size > MAX || offset > MAX) throw new Error('El paquete es demasiado grande; elegí menos cámaras o un tramo más corto');
      const crc = await crcOf(e.path);
      const nameBuf = Buffer.from(e.name, 'utf8');
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0); // firma local
      h.writeUInt16LE(20, 4);         // versión necesaria
      h.writeUInt16LE(0x0800, 6);     // bit 11: nombres en UTF-8
      h.writeUInt16LE(0, 8);          // método 0 = STORED
      h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12); // fecha/hora ficticia válida
      h.writeUInt32LE(crc, 14);
      h.writeUInt32LE(size, 18);      // tamaño comprimido
      h.writeUInt32LE(size, 22);      // tamaño real
      h.writeUInt16LE(nameBuf.length, 26);
      h.writeUInt16LE(0, 28);
      await put(h); await put(nameBuf); await copy(e.path);
      records.push({ nameBuf, crc, size, offset });
      offset += 30 + nameBuf.length + size;
    }
    const cdStart = offset; let cdSize = 0;
    for (const r of records) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); // firma directorio central
      c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
      c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14);
      c.writeUInt32LE(r.crc, 16);
      c.writeUInt32LE(r.size, 20); c.writeUInt32LE(r.size, 24);
      c.writeUInt16LE(r.nameBuf.length, 28);
      c.writeUInt16LE(0, 30); c.writeUInt16LE(0, 32); c.writeUInt16LE(0, 34);
      c.writeUInt16LE(0, 36); c.writeUInt32LE(0, 38);
      c.writeUInt32LE(r.offset, 42);
      await put(c); await put(r.nameBuf);
      cdSize += 46 + r.nameBuf.length;
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(records.length, 8); eocd.writeUInt16LE(records.length, 10);
    eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(cdStart, 16);
    await put(eocd);
    await new Promise((ok, no) => out.end((e) => e ? no(e) : ok()));
  } catch (e) {
    out.destroy(); throw e;
  }
}

module.exports = { buildZip };
