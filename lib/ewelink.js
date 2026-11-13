// eWeLink (Sonoff y compatibles): conexión de la cuenta por OAuth y control de dispositivos.
// La cuenta se usa para obtener la lista de dispositivos y sus claves; el control se hace
// primero por red local (rápido, sin internet) y, si falla, por la nube.
// Documentación: https://coolkit-technologies.github.io/eWeLink-API/#/en/OAuth2.0
'use strict';
const crypto = require('crypto');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');

const sign = (secret, msg) => crypto.createHmac('sha256', secret).update(Buffer.from(msg, 'utf8')).digest('base64');
const nonce = () => crypto.randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9]/g, 'x').slice(0, 8);
const apiHost = (region) => `https://${region}-apia.coolkit.${region === 'cn' ? 'cn' : 'cc'}`;

class Ewelink {
  constructor(file) { this.file = file; this.cfg = {}; this.states = new Map(); this.load(); }

  load() { try { this.cfg = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.cfg = {}; } if (!this.cfg.devices) this.cfg.devices = {}; }
  save() { fs.writeFileSync(this.file, JSON.stringify(this.cfg, null, 2) + '\n'); }
  get hasApp() { return !!(this.cfg.appId && this.cfg.appSecret) && !/^PEGAR/.test(this.cfg.appId); }
  get linked() { return !!(this.cfg.rt && this.cfg.region); }

  // Página de inicio de sesión de eWeLink (la clave de la cuenta se escribe ahí, nunca acá)
  authUrl(redirectUrl) {
    const seq = Date.now().toString();
    this.state = crypto.randomBytes(8).toString('hex');
    const q = new URLSearchParams({ state: this.state, clientId: this.cfg.appId, authorization: sign(this.cfg.appSecret, `${this.cfg.appId}_${seq}`), seq, redirectUrl, nonce: nonce(), grantType: 'authorization_code', showQRCode: 'false' });
    return 'https://c2ccdn.coolkit.cc/oauth/index.html?' + q.toString();
  }

  async call(method, path, { body, bearer, region } = {}) {
    const text = body ? JSON.stringify(body) : '';
    const headers = { 'X-CK-Appid': this.cfg.appId, 'X-CK-Nonce': nonce(), 'Content-Type': 'application/json' };
    headers.Authorization = bearer ? 'Bearer ' + bearer : 'Sign ' + sign(this.cfg.appSecret, text);
    const r = await fetch(apiHost(region || this.cfg.region) + path, { method, headers, body: text || undefined, signal: AbortSignal.timeout(12000) });
    const j = await r.json().catch(() => ({ error: r.status, msg: 'respuesta inválida' }));
    if (j.error !== 0) { const e = new Error(`eWeLink respondió ${j.error}: ${j.msg || ''}`); e.code = j.error; throw e; }
    return j.data || {};
  }

  async exchange(code, region, redirectUrl, state) {
    if (!this.state || state !== this.state) throw new Error('la respuesta no corresponde a este inicio de sesión');
    this.state = null;
    const d = await this.call('POST', '/v2/user/oauth/token', { region, body: { code, redirectUrl, grantType: 'authorization_code' } });
    Object.assign(this.cfg, { region, at: d.accessToken, rt: d.refreshToken, atExp: d.atExpiredTime, rtExp: d.rtExpiredTime });
    this.save();
    return this.syncDevices();
  }

  async token() {
    if (!this.linked) throw new Error('la cuenta de eWeLink no está conectada');
    if (this.cfg.at && this.cfg.atExp && Date.now() < this.cfg.atExp - 86400000) return this.cfg.at;
    const d = await this.call('POST', '/v2/user/refresh', { body: { rt: this.cfg.rt } });
    Object.assign(this.cfg, { at: d.at, rt: d.rt, atExp: Date.now() + 29 * 86400000 });
    this.save();
    return this.cfg.at;
  }

  // Trae nombre y clave de cada dispositivo. eWeLink devuelve, por defecto, solo el "hogar" actual,
  // así que recorremos todos los hogares; y, si se configuraron, consulta por ID los que igual falten.
  async syncDevices() {
    const bearerFirst = await this.token();
    const things = [];
    const seen = new Set();
    const addThings = (list) => {
      for (const t of list || []) {
        const id = String(t.itemData && t.itemData.deviceid || '').toLowerCase();
        if (!id || seen.has(id)) continue;
        seen.add(id); things.push(t);
      }
    };
    // Lista de hogares (si falla, seguimos con el hogar por defecto)
    let families = [];
    try { families = (await this.call('GET', '/v2/family', { bearer: bearerFirst })).familyList || []; } catch { /* usamos el hogar por defecto */ }
    const familyIds = [...new Set(families.map((f) => String(f.id || '')).filter(Boolean))];
    if (!familyIds.length) familyIds.push(''); // sin lista: el hogar actual
    for (const fid of familyIds) {
      try { addThings((await this.call('GET', '/v2/device/thing?num=0' + (fid ? '&familyid=' + encodeURIComponent(fid) : ''), { bearer: bearerFirst })).thingList); }
      catch { /* un hogar que falla no frena a los demás */ }
    }
    const listedIds = seen;
    const extraIds = [...new Set((Array.isArray(this.cfg.includeDeviceIds) ? this.cfg.includeDeviceIds : []).map((id) => String(id || '').trim().toLowerCase()).filter((id) => /^[0-9a-f]{10,20}$/.test(id) && !listedIds.has(id)))];
    const bearer = await this.token();
    for (let i = 0; i < extraIds.length; i += 10) {
      const batch = extraIds.slice(i, i + 10);
      const extra = await this.call('POST', '/v2/device/thing', {
        bearer,
        body: { thingList: batch.map((id) => ({ itemType: 1, id })) }
      });
      things.push(...(extra.thingList || []));
    }
    const out = {};
    for (const t of things) {
      const it = t.itemData || {};
      if (!it.deviceid || !it.devicekey) continue;
      const old = this.cfg.devices[it.deviceid] || {};
      out[it.deviceid] = { name: it.name || it.deviceid, devicekey: it.devicekey, uiid: it.extra && it.extra.uiid, online: !!it.online, outlets: it.params && Array.isArray(it.params.switches) ? it.params.switches.length : 0, ip: old.ip };
    }
    this.cfg.devices = out; this.save();
    await this.discover().catch(() => {});
    return out;
  }

  // Busca los dispositivos en la red local (mDNS) y anota su IP
  discover(ms = 2500) {
    return new Promise((resolve) => {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const found = {};
      const done = () => { try { s.close(); } catch { /* ya cerrado */ } let ch = false; for (const [id, ip] of Object.entries(found)) { const d = this.cfg.devices[id]; if (d && d.ip !== ip) { d.ip = ip; ch = true; } } if (ch) this.save(); resolve(found); };
      s.on('error', done);
      s.on('message', (m, r) => { const id = (m.toString('latin1').match(/eWeLink_([0-9a-f]{10})/i) || [])[1]; if (id) found[id.toLowerCase()] = r.address; });
      s.bind(5353, () => {
        const q = Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]), ...'_ewelink._tcp.local'.split('.').flatMap((p) => [Buffer.from([p.length]), Buffer.from(p)]), Buffer.from([0, 0, 12, 0, 1])]);
        for (const i of Object.values(os.networkInterfaces()).flat()) {
          if (!i || i.family !== 'IPv4' || i.internal) continue;
          try { s.addMembership('224.0.0.251', i.address); s.setMulticastInterface(i.address); s.send(q, 5353, '224.0.0.251'); } catch { /* interfaz sin multicast */ }
        }
        setTimeout(done, ms);
      });
    });
  }

  async lan(id, path, data) {
    const d = this.cfg.devices[id];
    if (!d || !d.ip) throw new Error('sin IP local');
    const iv = crypto.randomBytes(16);
    const c = crypto.createCipheriv('aes-128-cbc', crypto.createHash('md5').update(d.devicekey).digest(), iv);
    const enc = Buffer.concat([c.update(JSON.stringify(data), 'utf8'), c.final()]).toString('base64');
    const body = { sequence: Date.now().toString(), deviceid: id, selfApikey: '123', iv: iv.toString('base64'), encrypt: true, data: enc };
    const r = await fetch(`http://${d.ip}:8081/zeroconf/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    if (j.error !== 0) throw new Error('el dispositivo respondió error ' + j.error);
  }

  // Enciende o apaga. outlet: número de canal en dispositivos de varios canales.
  async set(id, on, outlet) {
    const d = this.cfg.devices[id];
    if (!d) throw new Error('dispositivo desconocido: ' + id);
    const sw = on ? 'on' : 'off';
    const multi = outlet !== undefined && outlet !== null;
    const params = multi ? { switches: [{ switch: sw, outlet: Number(outlet) }] } : { switch: sw };
    let lanErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await this.lan(id, multi ? 'switches' : 'switch', params); this.states.set(id + ':' + (outlet || 0), on); return 'local'; }
      catch (e) { lanErr = e; if (attempt === 0) await this.discover(1500).catch(() => {}); }
    }
    try {
      await this.call('POST', '/v2/device/thing/status', { bearer: await this.token(), body: { type: 1, id, params } });
      this.states.set(id + ':' + (outlet || 0), on);
      return 'nube';
    } catch (e) { throw new Error(`no respondió por red local (${lanErr.message}) ni por la nube (${e.message})`); }
  }

  async get(id, outlet) {
    try {
      const d = await this.call('GET', `/v2/device/thing/status?type=1&id=${id}&params=switch%7Cswitches`, { bearer: await this.token() });
      const p = d.params || {};
      if (Array.isArray(p.switches)) { const s = p.switches.find((x) => x.outlet === Number(outlet || 0)); return !!s && s.switch === 'on'; }
      return p.switch === 'on';
    } catch { return !!this.states.get(id + ':' + (outlet || 0)); }
  }

  // Ejecuta una acción configurada: { device, do: on|off|toggle|pulse, outlet?, seconds? }
  async run(a) {
    const id = String(a.device || '').toLowerCase();
    if (a.do === 'off') return this.set(id, false, a.outlet);
    if (a.do === 'toggle') return this.set(id, !(await this.get(id, a.outlet)), a.outlet);
    const how = await this.set(id, true, a.outlet);
    if (a.do === 'pulse') setTimeout(() => this.set(id, false, a.outlet).catch(() => {}), Math.max(0.5, Number(a.seconds) || 1) * 1000);
    return how;
  }
}

module.exports = { Ewelink };
