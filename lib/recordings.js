// Grabaciones del DVR: búsqueda por día y reproducción desde una hora dada.
// Las horas del DVR son "hora de pared" expresada como segundos Unix (sin zona horaria);
// acá se las llama "segundos DVR" y la página las muestra tal cual.
'use strict';
const { Kp2pClient, CMD } = require('./kp2p');
const { Fmp4Muxer } = require('./fmp4');

const dvrNow = () => Math.floor(Date.now() / 1000) - new Date().getTimezoneOffset() * 60;

// Pedido de grabaciones. cmd: 1 buscar, 2 detener, 3 reproducir, 4 pausar, 5 continuar
function recReq(cmd, channels, type, begin, end, index, count) {
  const s = Buffer.alloc(52);
  s.writeUInt32LE(cmd, 0);
  for (const c of channels) s[8 + (c >> 3)] |= 1 << (c & 7);
  s.writeUInt32LE(type >>> 0, 24); s.writeUInt32LE(begin >>> 0, 32); s.writeUInt32LE(end >>> 0, 36);
  s.writeUInt32LE(index >>> 0, 44); s.writeUInt32LE(count >>> 0, 48);
  return s;
}

class RecSearch {
  constructor(cfg) { this.cfg = cfg; this.client = null; this.ready = null; this.pending = null; this.chain = Promise.resolve(); this.cache = new Map(); this.idle = null; }

  connect() {
    if (this.ready) return this.ready;
    const p = this.ready = new Promise((resolve, reject) => {
      const c = this.client = new Kp2pClient(this.cfg);
      const fail = (e) => {
        if (this.client === c) { this.client = null; this.ready = null; }
        if (this.pending) { const pend = this.pending; this.pending = null; pend.reject(e); }
        reject(e);
      };
      c.on('login', (r) => { if (r === 0) resolve(c); else { c.close(); fail(new Error('el DVR rechazó la clave')); } });
      c.on('error', (e) => fail(e));
      c.on('close', () => fail(new Error('conexión con el DVR cerrada')));
      c.on('api', (a) => { if (a.cmd === CMD.REPLAY_RSP && this.pending) this.pending.onPage(a); });
      c.connect();
    });
    p.catch(() => {});
    return p;
  }

  drop() { clearTimeout(this.idle); if (this.client) { const c = this.client; this.client = null; this.ready = null; c.close(); } }

  // Todas las grabaciones de un canal entre dos horas: [[inicio, fin, tipo], ...] (tipo 1 continua, 2 movimiento)
  search(ch, begin, end) {
    const job = this.chain.then(() => this._search(ch, begin, end));
    this.chain = job.catch(() => {});
    return job;
  }

  async _search(ch, begin, end) {
    clearTimeout(this.idle);
    const c = await this.connect();
    try {
      const out = []; let index = 0;
      for (let page = 0; page < 80; page++) {
        const a = await new Promise((resolve, reject) => {
          const t = setTimeout(() => { this.pending = null; reject(new Error('el DVR no respondió la búsqueda')); }, 8000);
          this.pending = { onPage: (x) => { clearTimeout(t); this.pending = null; resolve(x); }, reject: (e) => { clearTimeout(t); reject(e); } };
          c._api(CMD.REPLAY_REQ, recReq(1, [ch], 15, begin, end, index, 100));
        });
        const p = a.payload;
        if (a.result !== 0 || p.length < 52) break;
        const count = p.readUInt32LE(44), total = p.readUInt32LE(48);
        for (let o = 52; o + 20 <= p.length; o += 20) out.push([p.readUInt32LE(o + 8), p.readUInt32LE(o + 12), p.readUInt32LE(o + 4)]);
        index += count;
        if (!count || index >= total) break;
      }
      return out;
    } catch (e) { this.drop(); throw e; } finally {
      this.idle = setTimeout(() => this.drop(), 30000);
    }
  }

  // Grabaciones de un día (inicio del día en segundos DVR), unidas y con caché corto
  async day(ch, dayStart) {
    const key = ch + ':' + dayStart, now = dvrNow();
    const hit = this.cache.get(key);
    const ttl = dayStart + 86400 > now ? 20000 : 10 * 60000; // el día de hoy cambia; los pasados no
    if (hit && Date.now() - hit.at < ttl) return hit.segs;
    const raw = await this.search(ch, dayStart, Math.min(dayStart + 86400, now + 60));
    raw.sort((a, b) => a[0] - b[0]);
    const segs = [];
    for (const [b0, e0, t] of raw) {
      const b = Math.max(b0, dayStart), e = Math.min(e0, dayStart + 86400);
      if (e <= b) continue;
      const last = segs[segs.length - 1];
      if (last && last[2] === t && b - last[1] <= 2) last[1] = Math.max(last[1], e); else segs.push([b, e, t]);
    }
    this.cache.set(key, { at: Date.now(), segs });
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
    return segs;
  }
}

// Reproduce un canal desde la hora t (segundos DVR) hacia una respuesta HTTP.
// Registros: [largo u32][tipo u8][0][datos]. Tipos: 0 formato, 1 inicio MP4, 2 fragmento, 3 fragmento clave,
// 5 ancla de tiempo (JSON {m: segundos de video, ts: hora DVR en ms}), 6 audio, 7 fin.
// El DVR manda más rápido que el tiempo real: se lo pausa cuando el navegador deja de leer.
function replay(cfg, ch, t, res, log, exportEnd = null, onProgress = null, includeAudio = false) {
  const c = new Kp2pClient(cfg);
  const mux = new Fmp4Muxer(exportEnd === null ? 0 : Math.round((exportEnd - t) * 90000), exportEnd !== null && includeAudio);
  let closed = false, paused = false, offset = null, lastFrame = Date.now(), frames = 0, pendingWall = null, videoBaseWall = null;
  const queuedAudio = [];
  const write = (type, payload) => {
    const h = Buffer.alloc(6); h.writeUInt32BE(payload.length + 2, 0); h[4] = type;
    res.write(h); res.write(payload);
  };
  const ctl = (cmd) => { try { c._api(CMD.REPLAY_REQ, recReq(cmd, [ch], 0, 0, 0, 0, 0)); } catch { /* conexión caída */ } };
  const pushAudio = (f) => {
    if (videoBaseWall === null || !includeAudio || exportEnd === null) return;
    const wall = f.ts + offset, rel = Math.round((wall - videoBaseWall) * 8);
    let trim = Math.max(0, -rel);
    const available = Math.floor((exportEnd * 1000 - wall) * 8);
    if (trim >= f.data.length || available <= trim) return;
    const data = f.data.subarray(trim, Math.min(f.data.length, available));
    const frag = mux.pushAudio(data, Math.max(0, rel + trim));
    if (frag) res.write(frag);
  };
  const stop = () => {
    if (closed) return; closed = true; clearInterval(timer);
    ctl(2); setTimeout(() => c.close(), 250);
  };
  const timer = setInterval(() => {
    // Si todavía no llegó ningún cuadro, darle más tiempo al DVR para conectar y posicionarse
    // (al bajar varias cámaras seguidas tarda en liberar la sesión anterior). Ya con video, 7s = fin.
    const limit = (exportEnd !== null && frames === 0) ? 25000 : 7000;
    if (!paused && Date.now() - lastFrame > limit) { // no hay más grabación (o el DVR nunca arrancó)
      if (exportEnd !== null && onProgress) onProgress(99);
      if (!res.writableEnded) { if (exportEnd !== null) res.end(); else { write(7, Buffer.alloc(0)); res.end(); } }
      stop();
    }
  }, 1000);

  c.on('login', (r) => {
    if (r !== 0) { res.destroy(); return stop(); }
    c._api(CMD.REPLAY_REQ, recReq(3, [ch], 15, t, exportEnd === null ? t + 86400 : exportEnd, 0, 0));
  });
  c.on('replay', (f) => {
    if (closed || f.channel !== ch) return;
    if (f.kind === 'audio') {
      if (exportEnd !== null) {
        if (!includeAudio || !f.enc.startsWith('G711A')) return;
        if (offset === null || videoBaseWall === null) { if (queuedAudio.length < 500) queuedAudio.push(f); return; }
        pushAudio(f); return;
      }
      if (offset === null || !f.enc.startsWith('G711A')) return;
      const h = Buffer.alloc(8); h.writeDoubleBE(f.ts + offset, 0);
      write(6, Buffer.concat([h, f.data]));
      return;
    }
    if (f.kind !== 'video') return;
    lastFrame = Date.now(); frames++;
    if (offset === null) { // el reloj de los cuadros puede diferir del índice del DVR: alinear con lo pedido
      offset = t * 1000 - f.ts;
      if (offset < -5000 || offset > 90000) offset = 0;
    }
    const wall = f.ts + offset;
    if (exportEnd !== null && onProgress) onProgress(Math.max(1, Math.min(98, (wall / 1000 - t) / (exportEnd - t) * 100)));
    const r = mux.push(f);
    if (r.newInit) {
      if (exportEnd !== null) res.write(mux.init);
      else { write(0, Buffer.from(JSON.stringify({ codec: mux.codec, width: mux.width, height: mux.height }))); write(1, mux.init); }
    }
    if (exportEnd !== null && includeAudio && videoBaseWall === null && mux.baseTs !== null) {
      videoBaseWall = mux.baseTs + offset;
      while (queuedAudio.length) pushAudio(queuedAudio.shift());
    }
    if (r.jump && exportEnd === null) write(5, Buffer.from(JSON.stringify({ m: r.jump.media, ts: r.jump.ts + offset })));
    for (const fr of r.frags) {
      if (exportEnd !== null) { if (pendingWall !== null && pendingWall / 1000 <= exportEnd) res.write(fr.data); }
      else write(fr.key ? 3 : 2, fr.data);
    }
    if (exportEnd !== null && wall / 1000 > exportEnd) { if (onProgress) onProgress(100); res.end(); return stop(); }
    pendingWall = wall;
    if (!paused && res.writableLength > 1500000) { paused = true; ctl(4); }
  });
  res.on('drain', () => { if (paused && !closed) { paused = false; lastFrame = Date.now(); ctl(5); } });
  res.on('close', stop);
  c.on('error', (e) => { if (log) log('grabación:', e.message); });
  c.on('close', () => { clearInterval(timer); closed = true; if (!res.writableEnded) res.end(); });
  c.connect();
}

module.exports = { RecSearch, replay, dvrNow };
