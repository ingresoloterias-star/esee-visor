// Esee Visor: servidor local que toma el video del DVR (protocolo EseeCloud/kp2p)
// y lo sirve a navegadores (Fire TV, iPhone, PC) dentro de la red de casa.
// Uso: node server.js
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Kp2pClient, PTZ } = require('./lib/kp2p');
const { Fmp4Muxer, TIMESCALE } = require('./lib/fmp4');
const { RecSearch, replay, dvrNow } = require('./lib/recordings');
const { buildZip } = require('./lib/zip');
const crypto = require('crypto');

const ROOT = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const cams = JSON.parse(fs.readFileSync(path.join(ROOT, 'cameras.json'), 'utf8'));
const CAMERA_SETTINGS_FILE = path.join(ROOT, 'camera-settings.json');
let cameraSettings = {};
try { cameraSettings = JSON.parse(fs.readFileSync(CAMERA_SETTINGS_FILE, 'utf8')); } catch { /* valores por defecto */ }
if (!cameraSettings || typeof cameraSettings !== 'object' || Array.isArray(cameraSettings)) cameraSettings = {};
const PORT = Number(process.env.PORT) || cams.port || 8080;
const { execFile, execFileSync } = require('child_process');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 }).trim();
const VERSION = (() => {
  let v = '0';
  try { v = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { /* sin package.json */ }
  try { v += '+' + git('rev-parse', '--short', 'HEAD'); } catch { /* sin git */ }
  return v;
})();
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const clipJobs = new Map();

// Actualización automática (solo si se inició con iniciar.bat): cada 10 minutos mira GitHub;
// si hay cambios, el servidor se cierra y iniciar.bat baja la versión nueva y lo reinicia.
// Las pantallas abiertas se recargan solas al ver que cambió la versión.
if (process.env.ESEE_AUTOUPDATE === '1') {
  let lastErr = '';
  const check = () => {
    execFile('git', ['fetch', '--quiet'], { cwd: ROOT, timeout: 60000, env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }) }, (err, out, stderr) => {
      if (err) { // dejar constancia en el log (una vez por tipo de error) para poder diagnosticarlo
        const msg = String(stderr || err.message).trim().split('\n').pop();
        if (msg !== lastErr) { lastErr = msg; log('no pude consultar GitHub para actualizar:', msg, '| usuario:', os.userInfo().username); }
        return;
      }
      if (lastErr) { lastErr = ''; log('la consulta a GitHub volvió a funcionar'); }
      try {
        if (git('rev-parse', 'HEAD') !== git('rev-parse', '@{u}')) { log('hay una versión nueva, reinicio para actualizar'); process.exit(0); }
      } catch (e) { log('no pude comparar versiones:', e.message); }
    });
  };
  setTimeout(check, 60 * 1000); // primera consulta al minuto, para ver pronto si falla
  setInterval(check, 10 * 60 * 1000);
}

const IDLE_MS = 12000;      // cuánto sigue abierto un canal sin espectadores
const HLS_KEEP = 6;         // segmentos HLS guardados por canal

// ---------- Un canal+calidad en reproducción ----------
class Feed {
  constructor(link, channel) {
    this.link = link; this.channel = channel;
    this.mux = new Fmp4Muxer();
    this.clients = new Set();
    this.gop = [];            // fragmentos desde el último cuadro clave
    this.segs = [];           // HLS: [{ n, dur, data }]
    this.cur = null; this.segN = 0;
    this.lastUse = Date.now(); this.frames = 0;
  }

  meta() { return Buffer.from(JSON.stringify({ codec: this.mux.codec, width: this.mux.width, height: this.mux.height })); }

  // Un cliente es { res, tag }: varias cámaras comparten una misma respuesta HTTP,
  // cada registro lleva su "tag" (posición de la cámara en el pedido).
  // Registro: [largo u32][tipo u8][tag u8][datos]. Tipos: 0 = formato (JSON), 1 = inicio MP4, 2 = fragmento, 3 = fragmento con cuadro clave.
  static write(client, type, payload) {
    const h = Buffer.alloc(6); h.writeUInt32BE(payload.length + 2, 0); h[4] = type; h[5] = client.tag;
    client.res.write(h); client.res.write(payload);
  }

  addClient(client) {
    this.clients.add(client); this.lastUse = Date.now();
    if (this.mux.init) {
      Feed.write(client, 0, this.meta()); Feed.write(client, 1, this.mux.init);
      this.gop.forEach((f, i) => Feed.write(client, i === 0 ? 3 : 2, f));
    }
    client.res.on('close', () => { this.clients.delete(client); this.lastUse = Date.now(); });
  }

  send(type, payload) {
    for (const client of this.clients) {
      if (client.res.writableLength > 8 * 1024 * 1024) { client.res.destroy(); this.clients.delete(client); continue; } // cliente trabado
      Feed.write(client, type, payload);
    }
  }

  push(frame) {
    const r = this.mux.push(frame);
    if (r.newInit) {
      // formato nuevo (o reinicio): el navegador rearma su reproductor al recibir el tipo 0
      this.gop = []; this.segs = []; this.cur = null;
      this.send(0, this.meta()); this.send(1, this.mux.init);
    }
    for (const f of r.frags) {
      this.frames++;
      if (f.key) {
        this.gop = [];
        if (this.cur && this.cur.parts.length) {
          this.segs.push({ n: this.cur.n, dur: this.cur.dur / TIMESCALE, data: Buffer.concat(this.cur.parts) });
          if (this.segs.length > HLS_KEEP) this.segs.shift();
        }
        this.cur = { n: ++this.segN, dur: 0, parts: [] };
      }
      this.gop.push(f.data);
      if (this.cur) { this.cur.parts.push(f.data); this.cur.dur += f.duration; }
      this.send(f.key ? 3 : 2, f.data);
    }
  }

  // Audio (G.711 A-law, 8 kHz): solo a los clientes que lo pidieron. Tipo 6 = [hora u64][muestras]
  pushAudio(f) {
    if (!f.enc.startsWith('G711A')) return;
    let head = null;
    for (const client of this.clients) {
      if (!client.audio) continue;
      if (!head) { head = Buffer.alloc(8); head.writeDoubleBE(f.ts, 0); head = Buffer.concat([head, f.data]); }
      Feed.write(client, 6, head);
    }
  }

  reset() { this.mux.reset(); this.gop = []; this.segs = []; this.cur = null; this.frames = 0; }
}

// ---------- Una conexión al DVR por calidad (0 = alta, 1 = baja) ----------
class DvrLink {
  constructor(stream) { this.stream = stream; this.feeds = new Map(); this.client = null; this.ready = false; this.retry = null; }

  feed(channel) {
    let f = this.feeds.get(channel);
    if (!f) {
      f = new Feed(this, channel); this.feeds.set(channel, f);
      log(`abro canal ${channel + 1} (${this.stream ? 'baja' : 'alta'})`);
      if (this.ready) this.client.openStream(channel, this.stream); else this.connect();
    }
    f.lastUse = Date.now();
    return f;
  }

  connect() {
    if (this.client) return;
    const c = this.client = new Kp2pClient({ host: cfg.host, port: cfg.port || 10000, user: cfg.user, password: cfg.password });
    c.on('login', (r) => {
      if (r !== 0) { log('el DVR rechazó usuario/clave (código ' + r + '). Revisá config.json'); c.close(); return; }
      this.ready = true;
      for (const ch of this.feeds.keys()) c.openStream(ch, this.stream);
      if (this.onReady) { const fn = this.onReady; this.onReady = null; fn(); }
    });
    c.on('video', (f) => { const feed = this.feeds.get(f.channel); if (feed) feed.push(f); });
    c.on('audio', (f) => { const feed = this.feeds.get(f.channel); if (feed) feed.pushAudio(f); });
    c.on('ptz', (r) => { if (r !== 0) log('PTZ respondió código', r); });
    c.on('error', (e) => log('DVR:', e.message));
    c.on('close', () => {
      if (this.client !== c) return;
      this.client = null; this.ready = false;
      for (const f of this.feeds.values()) f.reset();
      if (this.feeds.size && !this.retry) this.retry = setTimeout(() => { this.retry = null; if (this.feeds.size) this.connect(); }, 2000);
    });
    c.connect();
  }

  sweep() {
    const now = Date.now();
    for (const [ch, f] of this.feeds) {
      if (!f.clients.size && now - f.lastUse > IDLE_MS) {
        log(`cierro canal ${ch + 1} (${this.stream ? 'baja' : 'alta'})`);
        if (this.ready) this.client.closeStream(ch, this.stream);
        this.feeds.delete(ch);
      }
    }
    if (!this.feeds.size && this.client && !this.keepUntil) { const c = this.client; this.client = null; this.ready = false; c.close(); }
    if (this.keepUntil && now > this.keepUntil) this.keepUntil = 0;
  }
}

const links = [new DvrLink(0), new DvrLink(1)];
setInterval(() => links.forEach((l) => l.sweep()), 3000);

// ---------- Movimiento (PTZ) ----------
const ptzStopTimers = new Map();
function ptz(channel, action, speed) {
  const code = PTZ[action];
  if (code === undefined) return false;
  const link = links.find((l) => l.ready) || links[1];
  const doIt = () => link.client && link.client.ptz(channel, code, speed, 0);
  link.keepUntil = Date.now() + 20000;
  if (link.ready) doIt(); else { link.onReady = doIt; link.connect(); }
  clearTimeout(ptzStopTimers.get(channel));
  if (code !== PTZ.stop && code !== PTZ.presetGo && code !== PTZ.presetSet) {
    // seguro: si el control no manda "stop", frenar solo a los 6 s
    ptzStopTimers.set(channel, setTimeout(() => { if (link.client) link.client.ptz(channel, PTZ.stop, 0, 0); }, 6000));
  }
  return true;
}

const recSearch = new RecSearch(cfg);
const talk = new (require('./lib/talk').Talk)(cfg, (...a) => log(...a));

// ---------- eWeLink: botones (abrir reja/portón) asignables a la cámara que elijas ----------
const { Ewelink } = require('./lib/ewelink');
const ewe = new Ewelink(path.join(ROOT, 'ewelink.json'));
const ACTIONS_FILE = path.join(ROOT, 'actions.json');
let actions = [];
try { actions = JSON.parse(fs.readFileSync(ACTIONS_FILE, 'utf8')); } catch { /* sin botones configurados */ }
if (!Array.isArray(actions)) actions = [];
const saveActions = () => fs.writeFileSync(ACTIONS_FILE, JSON.stringify(actions, null, 2) + '\n');
const actionsFor = (ch) => actions.filter((a) => Number(a.channel) === ch);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eweRedirect = (req) => ewe.cfg.redirectUrl || ('https://' + reqHost(req) + '/ewelink/callback');
const ewePage = (msg) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>eWeLink</title><body style="font:16px/1.5 system-ui;background:#0b0d10;color:#e8ecf1;max-width:520px;margin:40px auto;padding:0 20px"><h2>eWeLink</h2><p>${esc(msg)}</p><p><a style="color:#3ea6ff" href="/">Volver a la app</a></p>`;

// ---------- Acceso con PIN (opcional: "pin" en config.json) ----------
const PIN = String(process.env.ESEE_PIN || cfg.pin || '');
const SECRET = PIN ? crypto.createHmac('sha256', PIN + '|' + cfg.password).update('esee-visor').digest() : null;
const YEAR = 365 * 86400000, FACE_SESSION = 12 * 3600000; // con PIN dura un año; con Face ID, 12 horas
function sessionCookie(ms) {
  const exp = String(Date.now() + ms);
  return `ev=${exp}.${crypto.createHmac('sha256', SECRET).update(exp).digest('hex')}; Path=/; Max-Age=${Math.floor(ms / 1000)}; HttpOnly; SameSite=Lax`;
}
const pinFails = new Map();
function authed(req) {
  if (!PIN) return true;
  const c = /(?:^|;\s*)ev=(\d{10,16})\.([0-9a-f]{64})(?:;|$)/.exec(req.headers.cookie || '');
  if (!c || Number(c[1]) < Date.now()) return false;
  return crypto.timingSafeEqual(Buffer.from(c[2], 'hex'), crypto.createHmac('sha256', SECRET).update(c[1]).digest());
}
async function readBody(req, max = 4000) { let b = ''; for await (const chunk of req) { b += chunk; if (b.length > max) break; } return b; }

// ---------- Llaves de acceso (passkeys): entrar con Face ID / huella en vez del PIN ----------
// Solo funcionan en páginas HTTPS con nombre (o en localhost). Se registran estando ya adentro con el PIN.
const PASSKEYS_FILE = path.join(ROOT, 'passkeys.json');
let passkeys = []; try { passkeys = JSON.parse(fs.readFileSync(PASSKEYS_FILE, 'utf8')); } catch { /* todavía no hay */ }
const savePasskeys = () => fs.writeFileSync(PASSKEYS_FILE, JSON.stringify(passkeys, null, 2) + '\n');
const challenges = new Map(); // desafío -> vencimiento
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
function reqHost(req) { return String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim(); }
const rpIdOf = (req) => reqHost(req).replace(/:\d+$/, '');
function newChallenge() {
  const now = Date.now(); for (const [k, v] of challenges) if (v < now) challenges.delete(k);
  const c = crypto.randomBytes(32).toString('base64url'); challenges.set(c, now + 120000); return c;
}
// Valida lo que firma el navegador: tipo de operación, desafío vigente y que venga de esta misma dirección
function checkClientData(req, b64, type) {
  const raw = Buffer.from(String(b64 || ''), 'base64url');
  let cd; try { cd = JSON.parse(raw.toString('utf8')); } catch { throw new Error('datos inválidos'); }
  if (cd.type !== type) throw new Error('operación inesperada');
  const exp = challenges.get(cd.challenge);
  if (!exp || exp < Date.now()) throw new Error('el pedido venció, probá de nuevo');
  challenges.delete(cd.challenge);
  // el origen debe ser esta misma dirección (por nombre; el puerto puede diferir detrás de un proxy como Tailscale)
  let o; try { o = new URL(cd.origin); } catch { throw new Error('origen inválido'); }
  const names = [req.headers['x-forwarded-host'], req.headers.host].filter(Boolean).map((h) => String(h).split(',')[0].trim().replace(/:\d+$/, '').toLowerCase());
  const local = o.hostname === 'localhost' || o.hostname === '127.0.0.1';
  if (!names.includes(o.hostname.toLowerCase()) || (o.protocol !== 'https:' && !local)) throw new Error(`origen no permitido (${cd.origin}; el servidor se ve como ${names.join(' / ')})`);
  return raw;
}

const html = (res, code, text) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(text); };

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const validChannel = (ch) => Number.isInteger(ch) && cams.cameras.some((c) => c.channel === ch);
const cameraPtzSpeed = (channel) => {
  const speed = Number(cameraSettings[channel]?.ptzSpeed);
  return Number.isInteger(speed) && speed >= 1 && speed <= 8 ? speed : 4;
};

function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }

function waitFor(test, ms) {
  return new Promise((resolve) => { const t0 = Date.now(); const tick = () => (test() || Date.now() - t0 > ms) ? resolve(test()) : setTimeout(tick, 150); tick(); });
}

// /safari: misma página, pero al agregarla a la pantalla de inicio del iPhone abre dentro de Safari
// (sin modo app). Ahí sí funciona la imagen flotante (PiP), que iOS no permite en apps web a pantalla completa.
function safariVariant(data) {
  return data.toString('utf8').replace(/^[ \t]*<meta name="(apple-)?mobile-web-app-capable"[^>]*>\r?\n/gm, '').replace('manifest.webmanifest', 'manifest-safari.webmanifest');
}

// Nombre de archivo (dentro del ZIP) a partir del nombre de la cámara, sin caracteres raros.
function clipFileName(ch) {
  const c = cams.cameras.find((x) => x.channel === ch);
  const base = String(c && c.name ? c.name : 'camara ' + (ch + 1)).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `${base || 'camara ' + (ch + 1)} (cam ${ch + 1}).mp4`;
}

// Prepara el tramo de UNA cámara a un archivo mp4. Promesa que resuelve al terminar.
// register(output) expone el flujo para poder cancelarlo (destruirlo) desde afuera.
function prepareClip(ch, start, end, includeAudio, file, onProgress, register) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(file);
    if (register) register(output);
    const timer = setTimeout(() => output.destroy(new Error('La cámara tardó demasiado en preparar el video')), 15 * 60 * 1000);
    timer.unref?.();
    output.once('error', (e) => { clearTimeout(timer); reject(e); });
    output.once('close', () => { clearTimeout(timer); if (!output.writableFinished) reject(new Error('Se interrumpió la preparación del video')); });
    output.once('finish', () => { clearTimeout(timer); resolve(); });
    replay(cfg, ch, start, output, log, end, onProgress, includeAudio);
  });
}

// Prepara el mismo tramo de una o varias cámaras. Con una cámara el resultado es un mp4;
// con varias, un ZIP con un mp4 por cámara (una sola descarga para el iPhone/Fire TV).
function createClipJob(chans, start, end, includeAudio = false) {
  const id = crypto.randomBytes(12).toString('hex');
  const stamp = new Date(start * 1000).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const multi = chans.length > 1;
  const job = { id, chans, start, end, includeAudio, progress: 0, status: 'preparing', error: '', cancelled: false, active: null,
    file: path.join(os.tmpdir(), 'esee-clip-' + id + (multi ? '.zip' : '.mp4')),
    name: multi ? `grabacion-${stamp}.zip` : `camara-${chans[0] + 1}-${stamp}.mp4`,
    mime: multi ? 'application/zip' : 'video/mp4', timer: null };
  clipJobs.set(id, job);
  const parts = [];
  const cleanup = () => { fs.promises.unlink(job.file).catch(() => {}); for (const pt of parts) fs.promises.unlink(pt.path).catch(() => {}); };
  const expire = (delay) => { clearTimeout(job.timer); job.timer = setTimeout(() => { cleanup(); clipJobs.delete(id); }, delay); job.timer.unref?.(); };
  const fail = (message) => { if (job.status !== 'preparing') return; if (job.cancelled) { job.status = 'cancelled'; } else { job.status = 'error'; job.error = message; } cleanup(); expire(job.cancelled ? 30000 : 5 * 60 * 1000); };

  const delay = (ms) => new Promise((r) => { const tm = setTimeout(r, ms); tm.unref?.(); });
  (async () => {
    const n = chans.length;
    for (let i = 0; i < n; i++) {
      if (job.cancelled) throw new Error('cancelado');
      const ch = chans[i];
      const file = multi ? path.join(os.tmpdir(), 'esee-part-' + id + '-' + ch + '.mp4') : job.file;
      let size = 0;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (job.cancelled) throw new Error('cancelado');
        // Pausa entre cámaras (y antes de reintentar) para que el DVR libere la sesión de reproducción anterior.
        if (i > 0 || attempt > 0) await delay(2000);
        await prepareClip(ch, start, end, includeAudio, file, (progress) => {
          if (job.status === 'preparing') job.progress = Math.min(99, Math.max(job.progress, Math.floor((i + (progress || 0) / 100) / n * 100)));
        }, (o) => { job.active = o; });
        job.active = null;
        size = fs.statSync(file).size;
        if (size >= 1000) break;
      }
      if (size < 1000) throw new Error(multi ? `La cámara ${ch + 1} no tiene video en ese tramo` : 'No se encontró video en el tramo elegido');
      if (multi) parts.push({ path: file, name: clipFileName(ch) });
    }
    if (multi) { await buildZip(parts, job.file); for (const pt of parts) fs.promises.unlink(pt.path).catch(() => {}); parts.length = 0; }
    const size = fs.statSync(job.file).size;
    if (size < 1000) throw new Error('No se encontró video en el tramo elegido');
    job.size = size; job.progress = 100; job.status = 'ready'; expire(15 * 60 * 1000);
  })().catch((e) => fail(e.message || 'No se pudo preparar el video'));

  return job;
}

// Cancela una preparación en curso: corta la sesión del DVR para liberarlo enseguida.
function cancelClipJob(id) {
  const job = clipJobs.get(id);
  if (job && job.status === 'preparing') { job.cancelled = true; if (job.active) try { job.active.destroy(new Error('cancelado')); } catch { /* ya cerrado */ } }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  // Por defecto la página se sirve en "variante Safari" (sin modo app), así el ícono de inicio del iPhone abre en Safari.
  // Con ?app=1 se sirve con modo app (pantalla completa, sin PiP). /safari queda por compatibilidad.
  // El ícono de inicio abre como app (pantalla completa). /safari queda para quien prefiera abrir en Safari.
  const safari = url.pathname === '/safari';
  const p = safari ? '/' : url.pathname;
  let m;
  try {
    // --- acceso ---
    if (p === '/api/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress, f = pinFails.get(ip);
      if (f && f.n >= 5 && Date.now() < f.until) return json(res, 429, { error: 'Demasiados intentos. Esperá un minuto.' });
      let q = {}; try { q = JSON.parse(await readBody(req)); } catch { /* cuerpo inválido */ }
      if (PIN && String(q.pin) === PIN) {
        pinFails.delete(ip);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookie(YEAR) });
        return res.end('{"ok":true}');
      }
      const n = (f && Date.now() < f.until ? f.n : 0) + 1; pinFails.set(ip, { n, until: Date.now() + 60000 });
      return json(res, 401, { error: 'PIN incorrecto' });
    }
    // Face ID: desafío (público), entrar (público) y registrar (solo ya adentro)
    if (p === '/api/passkey/challenge') {
      const rpId = rpIdOf(req);
      return json(res, 200, { challenge: newChallenge(), rpId, ids: passkeys.filter((k) => k.rpId === rpId).map((k) => k.id) });
    }
    if (p === '/api/passkey/login' && req.method === 'POST') {
      if (!PIN) return json(res, 400, { error: 'No hay PIN configurado' });
      try {
        const q = JSON.parse(await readBody(req, 20000));
        const key = passkeys.find((k) => k.id === q.id && k.rpId === rpIdOf(req));
        if (!key) throw new Error('este dispositivo no está registrado');
        const cdRaw = checkClientData(req, q.clientDataJSON, 'webauthn.get');
        const ad = Buffer.from(String(q.authenticatorData || ''), 'base64url');
        if (ad.length < 37 || !ad.subarray(0, 32).equals(sha256(key.rpId))) throw new Error('respuesta de otra dirección');
        if ((ad[32] & 0x05) !== 0x05) throw new Error('falta la verificación biométrica');
        const ok = crypto.verify('sha256', Buffer.concat([ad, sha256(cdRaw)]), { key: Buffer.from(key.publicKey, 'base64url'), format: 'der', type: 'spki' }, Buffer.from(String(q.signature || ''), 'base64url'));
        if (!ok) throw new Error('firma inválida');
        key.lastUsed = new Date().toISOString(); savePasskeys();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookie(FACE_SESSION) });
        return res.end('{"ok":true}');
      } catch (e) { log('Face ID: ingreso rechazado:', e.message); return json(res, 401, { error: e.message }); }
    }
    if (p === '/api/passkey/register' && req.method === 'POST') {
      if (!PIN || !authed(req)) { log('Face ID: registro sin sesión'); return json(res, 401, { error: 'La sesión venció: recargá, entrá con el PIN y probá de nuevo' }); }
      try {
        const q = JSON.parse(await readBody(req, 20000));
        checkClientData(req, q.clientDataJSON, 'webauthn.create');
        if (q.alg !== -7 && q.alg !== -257) throw new Error('tipo de llave no soportado');
        const pub = Buffer.from(String(q.publicKey || ''), 'base64url');
        crypto.createPublicKey({ key: pub, format: 'der', type: 'spki' }); // valida el formato
        if (!/^[A-Za-z0-9_-]{16,400}$/.test(String(q.id))) throw new Error('identificador inválido');
        passkeys = passkeys.filter((k) => k.id !== q.id);
        passkeys.push({ id: q.id, rpId: rpIdOf(req), publicKey: pub.toString('base64url'), alg: q.alg, name: String(q.name || 'dispositivo').slice(0, 60), created: new Date().toISOString() });
        savePasskeys();
        log('Face ID registrado para', passkeys[passkeys.length - 1].name);
        // desde ahora este dispositivo usa sesión corta: la cara se pide de nuevo al vencer
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookie(FACE_SESSION) });
        return res.end('{"ok":true}');
      } catch (e) { log('Face ID: no se pudo registrar:', e.message); return json(res, 400, { error: e.message }); }
    }

    if (!authed(req)) {
      if (p === '/' || p === '/index.html') return fs.readFile(path.join(ROOT, 'public', 'login.html'), (err, data) => html(res, err ? 500 : 200, err ? 'error' : safari ? safariVariant(data) : data));
      if (!p.endsWith('.webmanifest')) return json(res, 401, { error: 'Hace falta el PIN' });
    }

    if (p === '/api/info') return json(res, 200, { version: VERSION, pin: !!PIN, cameras: cams.cameras.map((c) => ({ channel: c.channel, name: c.name, ptz: !!c.ptz, ptzSpeed: cameraPtzSpeed(c.channel), actions: actionsFor(c.channel).map((a) => ({ id: a.id, label: a.label })) })) });

    // --- eWeLink: estado, conexión de la cuenta, dispositivos y configuración de botones ---
    if (p === '/api/ewelink/status') {
      if (!PIN) return json(res, 403, { error: 'Primero poné un PIN en config.json' });
      return json(res, 200, { hasApp: ewe.hasApp, linked: ewe.linked, region: ewe.cfg.region || '', redirectUrl: eweRedirect(req),
        devices: Object.entries(ewe.cfg.devices || {}).map(([id, d]) => ({ id, name: d.name, online: !!d.online, outlets: d.outlets || 0, ip: d.ip || '' })) });
    }
    if (p === '/ewelink/login') {
      if (!PIN || !authed(req)) return json(res, 401, { error: 'Entrá con el PIN primero' });
      if (!ewe.hasApp) return html(res, 200, ewePage('Falta cargar APPID y APP SECRET en el archivo ewelink.json y reiniciar.'));
      res.writeHead(302, { Location: ewe.authUrl(eweRedirect(req)) }); return res.end();
    }
    if (p === '/ewelink/callback') {
      try {
        const d = await ewe.exchange(url.searchParams.get('code'), url.searchParams.get('region'), eweRedirect(req), url.searchParams.get('state'));
        return html(res, 200, ewePage(`Cuenta conectada: ${Object.keys(d).length} dispositivos. Volvé a la configuración.`));
      } catch (e) { log('eWeLink:', e.message); return html(res, 200, ewePage('No se pudo conectar la cuenta: ' + e.message)); }
    }
    if (p === '/api/ewelink/sync' && req.method === 'POST') {
      if (!PIN) return json(res, 403, { error: 'Falta el PIN' });
      try { await ewe.syncDevices(); return json(res, 200, { ok: true }); } catch (e) { return json(res, 502, { error: e.message }); }
    }
    if (p === '/api/actions') {
      if (!PIN) return json(res, 403, { error: 'Primero poné un PIN en config.json' });
      if (req.method === 'POST') {
        let list; try { list = JSON.parse(await readBody(req, 20000)); } catch { return json(res, 400, { error: 'datos inválidos' }); }
        if (!Array.isArray(list)) return json(res, 400, { error: 'formato inválido' });
        const clean = [];
        for (const a of list.slice(0, 50)) {
          const ch = Number(a.channel), dev = String(a.device || '');
          if (!validChannel(ch) || !dev) continue;
          clean.push({ id: String(a.id || crypto.randomBytes(6).toString('hex')), channel: ch, label: String(a.label || 'Abrir').slice(0, 24) || 'Abrir',
            device: dev, do: ['pulse', 'toggle', 'on', 'off'].includes(a.do) ? a.do : 'pulse',
            outlet: a.outlet === undefined || a.outlet === null || a.outlet === '' ? undefined : Number(a.outlet),
            seconds: a.seconds ? Math.max(0.5, Math.min(10, Number(a.seconds))) : undefined });
        }
        actions = clean; saveActions();
        return json(res, 200, { ok: true, actions });
      }
      return json(res, 200, { actions });
    }
    // Forzar actualización desde la app: busca en GitHub y, si hay versión nueva, reinicia para bajarla
    if (p === '/api/update' && req.method === 'POST') {
      if (!PIN) return json(res, 403, { error: 'Falta el PIN' });
      execFile('git', ['fetch', '--quiet'], { cwd: ROOT, timeout: 60000, env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }) }, (err, out, stderr) => {
        if (err) return json(res, 502, { error: 'No se pudo consultar GitHub: ' + String(stderr || err.message).trim().split('\n').pop() });
        let local, remote;
        try { local = git('rev-parse', 'HEAD'); remote = git('rev-parse', '@{u}'); } catch (e) { return json(res, 500, { error: 'No se pudo comparar versiones: ' + e.message }); }
        if (local === remote) return json(res, 200, { updated: false, version: VERSION });
        json(res, 200, { updated: true });
        log('actualización forzada desde la app: reinicio para bajar la versión nueva');
        setTimeout(() => process.exit(0), 600); // el servicio hace git pull y reinicia
      });
      return;
    }

    if (p === '/api/action' && req.method === 'POST') {
      if (!PIN) return json(res, 403, { error: 'Los botones de acción necesitan un PIN' });
      let q = {}; try { q = JSON.parse(await readBody(req)); } catch { /* cuerpo inválido */ }
      const a = actions.find((x) => x.id === q.id) || actionsFor(Number(q.channel))[Number(q.index)];
      if (!a) return json(res, 404, { error: 'botón inexistente' });
      try { const via = await ewe.run(a); log(`acción "${a.label}" ejecutada por ${via}`); return json(res, 200, { ok: true, via }); }
      catch (e) { log(`acción "${a.label}" falló:`, e.message); return json(res, 502, { error: e.message }); }
    }

    if (p === '/api/camera-settings' && req.method === 'POST') {
      let q = {}; try { q = JSON.parse(await readBody(req, 2000)); } catch { /* pedido inválido */ }
      if (!q || typeof q !== 'object' || Array.isArray(q)) q = {};
      const ch = Number(q.channel), speed = Number(q.ptzSpeed);
      if (!validChannel(ch) || !Number.isInteger(speed) || speed < 1 || speed > 8) return json(res, 400, { error: 'ajuste inválido' });
      cameraSettings[ch] = { ...(cameraSettings[ch] || {}), ptzSpeed: speed };
      fs.writeFileSync(CAMERA_SETTINGS_FILE, JSON.stringify(cameraSettings, null, 2) + '\n');
      return json(res, 200, { channel: ch, ptzSpeed: speed });
    }

    // Video en vivo de una o varias cámaras por una sola conexión: /live?s=0:1,1:1,4:0  (canal:calidad); con &a=1 incluye el audio
    if (p === '/live') {
      const specs = (url.searchParams.get('s') || '').split(',').filter(Boolean).slice(0, 32).map((x) => x.split(':').map(Number));
      if (!specs.length || specs.some(([ch, st]) => !validChannel(ch) || (st !== 0 && st !== 1))) return json(res, 400, { error: 'pedido inválido' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      res.socket.setNoDelay(true);
      const audio = url.searchParams.get('a') === '1';
      specs.forEach(([ch, st], tag) => links[st].feed(ch).addClient({ res, tag, audio }));
      return;
    }

    if ((m = p.match(/^\/hls\/(\d+)\/([01])\/(index\.m3u8|init\.mp4|seg(\d+)\.m4s)$/))) {
      const ch = +m[1], st = +m[2];
      if (!validChannel(ch)) return json(res, 404, { error: 'canal inexistente' });
      const feed = links[st].feed(ch);
      if (m[3] === 'index.m3u8') {
        await waitFor(() => links[st].feeds.get(ch) === feed && feed.segs.length >= 2, 12000);
        const segs = feed.segs.slice(-4);
        if (!segs.length) { res.writeHead(503); return res.end(); }
        const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:' + Math.ceil(Math.max(...segs.map((s) => s.dur))), '#EXT-X-MEDIA-SEQUENCE:' + segs[0].n, '#EXT-X-MAP:URI="init.mp4"'];
        for (const s of segs) lines.push('#EXTINF:' + s.dur.toFixed(3) + ',', 'seg' + s.n + '.m4s');
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
        return res.end(lines.join('\n') + '\n');
      }
      if (m[3] === 'init.mp4') {
        if (!feed.mux.init) { res.writeHead(503); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
        return res.end(feed.mux.init);
      }
      const seg = feed.segs.find((s) => s.n === +m[4]);
      if (!seg) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'video/iso.segment', 'Cache-Control': 'no-store' });
      return res.end(seg.data);
    }

    // Grabaciones de un día: /api/rec/list?ch=0&day=2026-11-11
    if (p === '/api/rec/list') {
      const ch = Number(url.searchParams.get('ch'));
      const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(url.searchParams.get('day') || '');
      if (!validChannel(ch) || !d) return json(res, 400, { error: 'pedido inválido' });
      const begin = Date.UTC(+d[1], +d[2] - 1, +d[3]) / 1000;
      try { return json(res, 200, { begin, now: dvrNow(), segs: await recSearch.day(ch, begin) }); }
      catch (e) { log('búsqueda de grabaciones:', e.message); return json(res, 502, { error: e.message }); }
    }

    // Descargar un tramo como MP4: /api/rec/export?ch=0&start=<segundos DVR>&end=<segundos DVR>
    if (p === '/api/rec/export' && req.method === 'POST') {
      let q = {}; try { q = JSON.parse(await readBody(req, 2000)); } catch { /* pedido inválido */ }
      const chans = [...new Set((Array.isArray(q.chans) ? q.chans : [q.ch]).map(Number))];
      const start = Number(q.start), end = Number(q.end);
      if (!chans.length || chans.length > 16 || !chans.every(validChannel) || !Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= start || end - start > 7200 || end > dvrNow()) return json(res, 400, { error: 'Tramo inválido (máximo 2 horas)' });
      const job = createClipJob(chans, start, end, q.audio === true);
      return json(res, 202, { id: job.id });
    }
    if (p === '/api/rec/export/status') {
      const job = clipJobs.get(url.searchParams.get('id'));
      if (!job) return json(res, 404, { error: 'La preparación venció; volvé a intentarlo' });
      return json(res, 200, { status: job.status, progress: job.progress, error: job.error });
    }
    if (p === '/api/rec/export/cancel' && req.method === 'POST') {
      cancelClipJob(url.searchParams.get('id'));
      return json(res, 200, { ok: true });
    }
    if (p === '/api/rec/export/file') {
      const job = clipJobs.get(url.searchParams.get('id'));
      if (!job || job.status !== 'ready') return json(res, 404, { error: 'El video todavía no está listo' });
      res.writeHead(200, { 'Content-Type': job.mime || 'video/mp4', 'Content-Length': job.size, 'Content-Disposition': `attachment; filename="${job.name}"`, 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      res.socket.setNoDelay(true);
      const input = fs.createReadStream(job.file);
      input.once('error', (e) => { log('descarga de grabación:', e.message); res.destroy(e); });
      input.once('close', () => { fs.promises.unlink(job.file).catch(() => {}); clearTimeout(job.timer); clipJobs.delete(job.id); });
      input.pipe(res);
      return;
    }
    if (p === '/api/rec/export') {
      const ch = Number(url.searchParams.get('ch'));
      const start = Number(url.searchParams.get('start')), end = Number(url.searchParams.get('end'));
      if (!validChannel(ch) || !Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= start || end - start > 7200 || end > dvrNow()) return json(res, 400, { error: 'Tramo inválido (máximo 2 horas)' });
      const stamp = new Date(start * 1000).toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const tempFile = path.join(os.tmpdir(), 'esee-clip-' + crypto.randomBytes(16).toString('hex') + '.mp4');
      const output = fs.createWriteStream(tempFile);
      res.once('close', () => { if (!res.writableEnded) output.destroy(new Error('Descarga cancelada')); });
      try {
        await new Promise((resolve, reject) => {
          output.once('finish', resolve);
          output.once('error', reject);
          output.once('close', () => { if (!output.writableFinished) reject(new Error('No se pudo preparar el video')); });
        replay(cfg, ch, start, output, log, end, null, url.searchParams.get('audio') === '1');
        });
        const size = fs.statSync(tempFile).size;
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size, 'Content-Disposition': `attachment; filename="camara-${ch}-${stamp}.mp4"`, 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        res.socket.setNoDelay(true);
        const input = fs.createReadStream(tempFile);
        input.once('error', (e) => { log('descarga de grabación:', e.message); res.destroy(e); });
        input.once('close', () => fs.promises.unlink(tempFile).catch(() => {}));
        input.pipe(res);
      } catch (e) {
        fs.promises.unlink(tempFile).catch(() => {});
        if (!res.headersSent) return json(res, 502, { error: 'No se pudo preparar el tramo de video' });
        res.destroy(e);
      }
      return;
    }

    // Reproducir grabación: /rec?ch=0&t=<segundos DVR>
    if (p === '/rec') {
      const ch = Number(url.searchParams.get('ch')), t = Math.floor(Number(url.searchParams.get('t')));
      if (!validChannel(ch) || !(t > 0)) return json(res, 400, { error: 'pedido inválido' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      res.socket.setNoDelay(true);
      replay(cfg, ch, t, res, log);
      return;
    }

    // Diagnóstico que mandan las pantallas: se guarda lo último de cada dispositivo en diag.log
    if (p === '/api/diag' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 20000) break; }
      fs.appendFile(path.join(ROOT, 'diag.log'), new Date().toISOString() + ' ' + req.socket.remoteAddress + ' ' + body.slice(0, 20000) + '\n', () => {});
      return json(res, 200, { ok: true });
    }

    // Hablar por el parlante: el navegador manda tandas de audio G.711 A-law. /api/talk?ch=0  (con &stop=1 corta)
    if (p === '/api/talk' && req.method === 'POST') {
      const ch = Number(url.searchParams.get('ch'));
      if (!validChannel(ch)) return json(res, 404, { error: 'canal inexistente' });
      if (url.searchParams.get('stop') === '1') { talk.stop(ch); return json(res, 200, { ok: true }); }
      const parts = []; let n = 0;
      for await (const chunk of req) { parts.push(chunk); n += chunk.length; if (n > 32000) break; }
      if (n) talk.push(ch, Buffer.concat(parts, n), cams.talkFormat);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/ptz' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 2000) break; }
      const q = JSON.parse(body || '{}');
      const ch = Number(q.channel);
      if (!validChannel(ch)) return json(res, 404, { error: 'canal inexistente' });
      const speed = Math.max(0, Math.min(8, Number(q.speed) || 0));
      return json(res, ptz(ch, String(q.action), speed) ? 200 : 400, { ok: true });
    }

    // archivos estáticos
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const file = path.normalize(path.join(ROOT, 'public', rel));
    if (!file.startsWith(path.join(ROOT, 'public') + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('no encontrado'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(safari && rel === 'index.html' ? safariVariant(data) : data);
    });
  } catch (e) {
    log('error en', p, e.message);
    if (!res.headersSent) json(res, 500, { error: 'error interno' }); else res.destroy();
  }
});

server.listen(PORT, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  log(`Esee Visor ${VERSION} listo. Abrí en la tele o el celular:`);
  for (const ip of ips) log(`   http://${ip}:${PORT}`);
});
