// Slayer Online - server (Node.js)
// Fitur: chat global, kehadiran pemain, PvP bebas, RANKED 1v1 (Elo), akun + simpanan cloud, ekspor/impor data.
// Jalankan:  npm i  &&  node server.js     (PORT bawaan 8080)
// Penyimpanan permanen: isi env GAS_URL + GAS_SECRET (Google Sheets via Apps Script, lihat Code.gs) atau DATABASE_URL (PostgreSQL).
//   Tanpa itu data hanya di file JSON lokal, yang hilang saat redeploy/restart di hosting gratis.
const fs = require('fs');
const crypto = require('crypto');
const { openStore } = require('./store');

const DB = {};    // rating ranked: id pemain -> {n, r, w, l}
const AC = {};    // akun: username -> {salt, hash, pid, save, at, bak, ths, snaps}
const META = {};  // rahasia server (sec.k = kunci tanda tangan ekspor)
let ST = null;

// ===== Penyimpanan: tandai data yang berubah, tulis berkala + saat shutdown =====
const dirty = { acc: new Set(), rat: new Set(), meta: new Set() };
const SRC = { acc: AC, rat: DB, meta: META };
const mark = (kind, key) => dirty[kind].add(key);
let flushing = null, lastFlush = 0;
async function runFlush(force) {
  if (!force && ST.gap && Date.now() - lastFlush < ST.gap) return; // penyimpanan lambat (Apps Script): tulis rutin dijarangkan
  const items = [];
  for (const kind in dirty) {
    for (const key of dirty[kind]) if (SRC[kind][key] !== undefined) items.push([kind, key, SRC[kind][key]]);
    dirty[kind].clear();
  }
  if (!items.length) return;
  lastFlush = Date.now();
  try { await ST.putMany(items); }
  catch (e) { console.error('Gagal menyimpan ke penyimpanan:', e.message); for (const [k, key] of items) dirty[k].add(key); }
}
function flush(force) {
  if (flushing) return flushing;
  const p = runFlush(force).finally(() => { if (flushing === p) flushing = null; });
  return (flushing = p);
}
// Tulis sekarang dan TUNGGU sampai benar-benar tersimpan (dipakai saat daftar/login/impor).
async function persist(kind, key) {
  mark(kind, key);
  for (let i = 0; i < 3 && dirty[kind].has(key); i++) await flush(true);
  if (dirty[kind].has(key)) throw new Error('penyimpanan gagal');
}

async function init(opts) {
  ST = await openStore(opts);
  Object.assign(DB, ST.mem.rat); Object.assign(AC, ST.mem.acc); Object.assign(META, ST.mem.meta);
  if (!META.sec || !META.sec.k) { META.sec = { k: crypto.randomBytes(32).toString('hex') }; mark('meta', 'sec'); }
  // Migrasi token lama (teks biasa) -> hash
  for (const e in AC) { const a = AC[e]; if (a.tok) { a.ths = (a.ths || []).concat(sha(a.tok)); delete a.tok; mark('acc', e); } }
  indexTokens();
  weeklyCheck();
  await flush(true);
  return ST;
}

// ===== Util =====
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const GEN = ['m', 'f'], AVN = 12, okAv = v => Number.isInteger(v) && v >= 0 && v < AVN;
const okUser = e => /^[a-z0-9_]{3,14}$/.test(e);
const hashSave = s => sha(JSON.stringify(s)); // hanya untuk ekspor lama (sebelum v2)
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const canon = v => Array.isArray(v) ? '[' + v.map(x => x === undefined ? 'null' : canon(x)).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
  : JSON.stringify(v);
const NODB = 'Maaf! data akun tiada dalam database';
const clean = (s, n) => String(s == null ? '' : s).replace(/[<>&]/g, '').slice(0, n);

// ===== Validasi save: hanya kolom yang dikenal, nilai dibatasi =====
// Event Hyperweb Spidey (limited 90 hari). Ubah EV.start bila event dimulai ulang.
const EV = { start: Date.UTC(2026, 10, 4), days: 90, need: 30, test: false }; // misi: kalahkan 30 musuh di Classic (dihitung klien). test: true = Spidey sah tanpa misi (untuk uji).
// ===== MAIL DARI DEV =====
// Tambah entri di sini (atau isi env MAILS_JSON) lalu redeploy. Pemain melihatnya di tombol "Mail" di lobi.
// Format: { id: 'unik-maks-24-huruf/angka/-/_', t: 'Judul', b: 'Isi', ts: Date.UTC(2027,0,1), exp: 0 (0 = tidak kedaluwarsa), gold: 0, dia: 0 }
// Contoh pampasan bug:  { id: 'komp-bug1', t: 'Pampasan bug', b: 'Maaf atas gangguan kemarin.', ts: Date.UTC(2026,10,5), gold: 500, dia: 20 }
const MAILS = (() => { let a = []; try { a = JSON.parse(process.env.MAILS_JSON || '[]'); } catch (e) {} return a.concat([
  { id: 'open-world', t: 'Kabar dari Developer', b: '*Open world*_ akan hadir dalam kurun waktu terdekat, silakan menikmati gamenya._\n\n ~developer Slayer online~', ts: Date.UTC(2026, 10, 5, 12), gold: 0, dia: 0 },
  { id: 'welcome', t: 'Selamat datang di Slayer Online!', b: 'Cek mail ini untuk kabar update, event, dan hadiah dari dev.', ts: Date.UTC(2026, 10, 5), gold: 0, dia: 0 },
]); })();
const KAT = ['biasa', 'api', 'air', 'ais', 'magma', 'getah', 'kaca', 'kram', 'tombak', 'kunai', 'spidey', 'punch', 'fenik', 'void'], TIT = ['ds', 'dr', 'pd', 'ls'], SKIN = ['fenik', 'void', 'sakura', 'zamrud', 'shogun', 'frost', 'lava', 'galaxy', 'naga'];
const KSKIDS = ['biasa', 'api', 'air', 'ais', 'magma', 'getah', 'kaca', 'kram'].flatMap(w => [w + '1', w + '2']);
// ===== SURVIVAL + RESET MINGGUAN + GELAR TOP =====
// Minggu berganti tiap Senin 00:00 (WIB/MYT-ish: 16:00 UTC hari Minggu). Saat pergantian: top 10 Ranked (Elo) & top 10 Survival
// dapat gelar "Top N" selama 7 hari, lalu rating Elo dan papan Survival di-reset.
const WEEK = 7 * 864e5, WK0 = Date.UTC(2026, 10, 1, 16, 0, 0), SV_MIN = 120, SV_MAX = 3 * 3600, SV_KEEP = 100;
const weekOf = t => Math.floor((t - WK0) / WEEK), nextReset = t => WK0 + (weekOf(t) + 1) * WEEK;
const svBoard = () => { if (!META.svb || typeof META.svb.e !== 'object') META.svb = { e: {} }; return META.svb.e; };
const topTitles = acc => { const a = acc && AC[acc], now = Date.now(); return a && Array.isArray(a.top) ? a.top.filter(x => x && x.exp > now) : []; };
const topBest = acc => { const l = topTitles(acc).slice().sort((a, b) => a.n - b.n || (a.k === 'r' ? -1 : 1)); return l.length ? l[0].id : ''; };
const svSorted = () => Object.entries(svBoard()).sort((a, b) => b[1].t - a[1].t);
function weeklyCheck(now) {
  now = now || Date.now(); const cur = weekOf(now);
  if (!META.wk || typeof META.wk.w !== 'number') { META.wk = { w: cur }; mark('meta', 'wk'); return false; }
  if (cur <= META.wk.w) return false;
  const pid2acc = {}; for (const e in AC) pid2acc[AC[e].pid] = e;
  const elo = Object.entries(DB).filter(([, r]) => (r.w || 0) + (r.l || 0) > 0).sort((a, b) => b[1].r - a[1].r || (b[1].w || 0) - (a[1].w || 0)).slice(0, 10);
  const sv = svSorted().slice(0, 10), exp = now + 7 * 864e5;
  for (const e in AC) if (AC[e].top && AC[e].top.length) { AC[e].top = []; mark('acc', e); }
  const give = (pid, k, i) => { const e = pid2acc[pid]; if (e) { (AC[e].top = AC[e].top || []).push({ k, n: i + 1, id: 't' + k + (i + 1), exp }); mark('acc', e); } };
  elo.forEach(([pid], i) => give(pid, 'r', i)); sv.forEach(([pid], i) => give(pid, 's', i));
  META.lw = { at: now, r: elo.map(([, r]) => ({ n: r.n, r: r.r })), s: sv.map(([, r]) => ({ n: r.n, t: r.t, w: r.w })) }; mark('meta', 'lw');
  for (const id in DB) { const r = DB[id]; r.r = 1000; r.w = 0; r.l = 0; mark('rat', id); }
  META.svb = { e: {} }; mark('meta', 'svb');
  META.wk = { w: cur }; mark('meta', 'wk');
  return true;
}
const int = (v, lo, hi, d) => { v = Math.floor(+v); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : (d === undefined ? lo : d); };
const num = (v, lo, hi, d) => { v = +v; return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : (d === undefined ? lo : d); };
const uniq = (a, ok) => Array.isArray(a) ? [...new Set(a.filter(x => ok.includes(x)))] : [];
// Mengembalikan save bersih, atau null bila ditolak (data tidak masuk akal / hasil ubahan).
function cleanSave(s, owner) {
  try {
    if (!s || typeof s !== 'object' || typeof s.lvl !== 'number') return null;
    if (JSON.stringify(s).length > 30000) return null;
    if (s.lvl < 1 || s.lvl > 300 || (+s.gold || 0) > 5e6 || (+s.dia || 0) > 1e5) return null;
    const gear = (Array.isArray(s.gear) ? s.gear : []).slice(0, 300).filter(g => g && typeof g === 'object').map(g => {
      const a = g.t === 'a';
      return { t: a ? 'a' : 'b', n: clean(g.n, 24), v: int(g.v, 0, a ? 600 : 120), c: int(g.c, 1, 9999, 1) };
    });
    const up = {};
    if (s.up && typeof s.up === 'object') for (const k of KAT) if (s.up[k] !== undefined) up[k] = int(s.up[k], 0, 10);
    const idx = v => (Number.isInteger(v) && v >= 0 && v < gear.length) ? v : undefined;
    const evk = int(s.evk, 0, EV.need), lgc = int(s.lg && s.lg.c, 0, 20); // login harian: One Punch hanya sah bila 20 hari terkumpul
    const mlOk = Array.isArray(s.ml) ? s.ml.filter(x => typeof x === 'string' && /^[a-z0-9_-]{1,24}!?$/i.test(x)).slice(-80) : []; // kill Classic event; Spidey hanya sah bila misi selesai
    const o = {
      lvl: int(s.lvl, 1, 300), xp: num(s.xp, 0, 1e7), hp: num(s.hp, 0, 1e5, 80), mp: num(s.mp, 0, 1e4, 38),
      gold: int(s.gold, 0, 5e6), dia: int(s.dia, 0, 1e5), pots: int(s.pots, 0, 99999),
      qi: int(s.qi, 0, 50), qc: int(s.qc, 0, 99),
      eq: KAT.includes(s.eq) && (s.eq !== 'spidey' || evk >= EV.need || EV.test) && (s.eq !== 'punch' || lgc >= 20) ? s.eq : 'biasa', evk, gear, up, ea: idx(s.ea), eb: idx(s.eb),
      sk: uniq(s.sk, SKIN), skin: SKIN.includes(s.skin) ? s.skin : undefined,
      ksk: uniq(s.ksk, KSKIDS), kse: (() => { const r = {}; if (s.kse && typeof s.kse === 'object') for (const w of KAT) { const v = s.kse[w]; if (typeof v === 'string' && KSKIDS.includes(v) && v.startsWith(w) && v.length === w.length + 1) r[w] = v; } return r; })(),
      dinv: uniq(s.dinv, KAT).filter(x => x !== 'spidey' || evk >= EV.need || EV.test).filter(x => x !== 'punch' || lgc >= 20), best: int(s.best, 0, 200),
      ti: uniq(s.ti, TIT), title: TIT.includes(s.title) ? s.title : undefined,
      name: clean(s.name, 14) || undefined, rk: s.rk === undefined ? undefined : num(s.rk, 0, 5000, 1000),
      tb: owner ? int(s.tb, 0, 1) : 0, own: owner ? 1 : 0,
      stp: int(s.stp, 0, 6, 0), end: int(s.end, 0, 7, 0), // progres Story
      kh: (Array.isArray(s.kh) ? s.kh : []).slice(0, 6).map(v => int(v, -60, 60, 0)), kp: (Array.isArray(s.kp) ? s.kp : []).slice(0, 6).map(v => int(v, -60, 60, 0)), // skor dialog (penentu ending)
      lend: int(s.lend, 0, 3, 0),
      lg: { c: lgc, d: int(s.lg && s.lg.d, 0, 99999, 0) }, ml: mlOk, // login harian + mail yang sudah dibaca/diambil // ending terakhir → reputasi Season 2 (1=A pahlawan gugur, 2=B pahlawan, 3=C pengkhianat)
    };
    return o;
  } catch (e) { return null; }
}
const older = (a, b) => a.lvl < b.lvl || (a.lvl === b.lvl && a.xp < b.xp); // a lebih lama dari b?

// ===== Token sesi: disimpan sebagai hash (maks. 5 perangkat per akun) =====
const TKI = new Map(); // hash token -> username
function indexTokens() { TKI.clear(); for (const e in AC) for (const h of AC[e].ths || []) TKI.set(h, e); }

// ===== Tanda tangan ekspor (HMAC): file ekspor tidak bisa diubah/dipalsukan =====
const secret = () => process.env.EXPORT_SECRET || META.sec.k;
const sign = b => crypto.createHmac('sha256', secret()).update(b.v + '|' + b.u + '|' + b.t + '|' + canon(b.s)).digest('hex');
const FRESH = { lvl: 1, xp: 0, hp: 80, mp: 38, gold: 0, pots: 0, dia: 0, qi: 0, qc: 0, eq: 'biasa', gear: [], up: {}, sk: [], dinv: [], ti: [], best: 0 };

// Pemilik: username dicadangkan. Kata sandinya TIDAK ada di kode; isi lewat env OWNER_PW di hosting.
// Akun pemilik membawa progres sendiri; semua akun baru lain mulai dari nol (0 emas, 0 diamond).
const OWNER = 'razz';

const MAXHP = 1000, SEC1 = 150, SEC2 = 180, MAXDMG = 600, MAXHEAL = 300;
const FAILS = new Map(); // percobaan login gagal per username (di memori)

class Hub {
  constructor() { this.P = new Map(); this.q = []; this.q2 = []; this.PT = new Map(); this.M = new Set(); }
  send(p, m) { if (p && p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(m)); }
  all(m, except) { for (const p of this.P.values()) if (p !== except) this.send(p, m); }
  rec(p) { return DB[p.id] || (DB[p.id] = { n: p.n, r: 1000, w: 0, l: 0 }); }

  connect(ws) { return { ws, id: null, n: 'Pemain', m: null, tk: 8, tl: Date.now(), hl: 0 }; }

  handle(p, m) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || m.id.length < 4 || m.id.length > 20) return;
    if (!p.id) {
      p.id = m.id;
      const old = this.P.get(p.id);
      if (old && old !== p) { this.send(old, { t: 'kick' }); try { old.ws.close(); } catch (e) {} } // id sama dipakai perangkat lain
      this.P.set(p.id, p); this.cnt();
    } else if (p.id !== m.id) return;
    if (m.n) { p.n = clean(m.n, 14) || 'Pemain'; this.rec(p).n = p.n; }
    const bad = e => { console.error(e); this.fail(p, 'Server gagal memproses. Coba lagi.'); };
    switch (m.t) {
      case 'join': { const r = this.rec(p); this.send(p, { t: 'me', r: r.r, w: r.w, l: r.l }); break; }
      case 'st': {
        p.inv = !!m.inv; p.invT = Date.now(); p.x = +m.x || 0; p.y = +m.y || 0;
        const mt = p.m;
        if (mt) {
          // tampilan: senjata, skin, skin katana, gerak, arah bidik, gelar (divalidasi whitelist; hanya visual)
          const out = {
            t: 'st', id: p.id, x: p.x, y: p.y, f: m.f < 0 ? -1 : 1, n: p.n,
            e: KAT.includes(m.e) ? m.e : 'biasa', sk: SKIN.includes(m.sk) ? m.sk : '',
            ks: KSKIDS.includes(m.ks) ? m.ks : '', tt: topBest(p.acc) || (TIT.includes(m.tt) ? m.tt : ''), g: (p.acc && AC[p.acc] && AC[p.acc].g) || '',
            mv: m.mv ? 1 : 0, sw: m.sw ? 1 : 0, aa: num(m.aa, -4, 4, 0),
            pd: Array.isArray(m.pd) ? [num(m.pd[0], -1, 1, 0), num(m.pd[1], -1, 1, 0)] : undefined // arah bidik One Punch saat charge
          };
          const js = JSON.stringify(out);
          for (const x of mt.ps) if (x !== p && x.ws && x.ws.readyState === 1 && x.ws.bufferedAmount < 32768) x.ws.send(js);
        }
        break;
      }
      case 'ping': this.send(p, { t: 'pong', ts: m.ts }); break;
      case 'chat': this.all({ t: 'chat', n: p.n, msg: clean(m.msg, 80) }, p); break;
      case 'queue': if (!(p.acc && AC[p.acc] && AC[p.acc].g)) { this.send(p, { t: 'pcancel' }); this.send(p, { t: 'gate' }); break; } this.queue(p, m.mode === 2 ? 2 : 1); break;
      case 'party': this.party(p, m); break;
      case 'rdy': {
        const mt = p.m;
        if (mt && !mt.go) { mt.rd.add(p.id); if (mt.rd.size >= mt.ps.length) { mt.go = 1; mt.goAt = Date.now() + 3000; const g = { t: 'go', in: 3 }; for (const x of mt.ps) this.send(x, g); } }
        break;
      }
      case 'fx': { // efek serangan/skill (visual saja): jenis, indeks skill, arah bidik, charge, skin katana
        const mt = p.m, n = Date.now();
        if (mt && n - (p.fxT || 0) > 30) {
          p.fxT = n;
          const out = { t: 'fx', id: p.id, k: m.k ? 1 : 0, w: KAT.includes(m.w) ? m.w : 'biasa', i: int(m.i, -1, 9, -1), aa: num(m.aa, -4, 4, 0), f: m.f < 0 ? -1 : 1, ch: num(m.ch, 0, 1, 0), ks: KSKIDS.includes(m.ks) ? m.ks : '',
            pn: Array.isArray(m.pn) ? [int(m.pn[0], 0, 1, 0), int(m.pn[1], 0, 1, 0), num(m.pn[2], -1, 1, 1), num(m.pn[3], -1, 1, 0), int(m.pn[4], 0, 1, 0)] : undefined }; // pn: kombo One Punch
          for (const x of mt.ps) if (x !== p) this.send(x, out);
        }
        break;
      }
      case 'pu': { // One Punch skill (charge/lepas/batal) — visual saja
        const mt = p.m, n = Date.now(), sg = ['c', 'r', 'x'].includes(m.s) ? m.s : null;
        if (mt && sg && n - (p.puT || 0) > 20) {
          p.puT = n;
          const out = { t: 'pu', id: p.id, s: sg, dx: num(m.dx, -1, 1, 1), dy: num(m.dy, -1, 1, 0), k: num(m.k, 0, 1, 1), rsc: num(m.rsc, 0.5, 3, 2.35) };
          for (const x of mt.ps) if (x !== p) this.send(x, out);
        }
        break;
      }
      case 'qc': { // quick chat Ranked: hanya indeks frasa preset (0-5), tanpa teks bebas; jeda 1,2 dtk per pemain
        const mt = p.m, n = Date.now(), qi = (Number.isInteger(m.i) && m.i >= 0 && m.i <= 5) ? m.i : -1;
        if (mt && mt.go && qi >= 0 && n - (p.qcT || 0) > 1200) {
          p.qcT = n; const out = { t: 'qc', id: p.id, i: qi };
          for (const x of mt.ps) if (x !== p) this.send(x, out);
        }
        break;
      }
      case 'lift': { // efek terangkat (visual saja): diteruskan ke seisi pertandingan
        const mt = p.m, n = Date.now();
        if (mt && mt.go && n - (p.lvT || 0) > 40) {
          p.lvT = n; const to = clean(m.to, 20);
          if (mt.tm[to] !== undefined && mt.tm[to] !== mt.tm[p.id]) { const out = { t: 'lift', id: p.id, to, h: int(m.h, 0, 140, 0) }; for (const x of mt.ps) if (x !== p) this.send(x, out); }
        }
        break;
      }
      case 'svs': p.svT0 = Date.now(); break; // Survival dimulai: waktu dihitung SERVER
      case 'sve': { const r = this.svEnd(p, m.w); if (r) this.send(p, Object.assign({ t: 'sver' }, r)); break; }
      case 'cancel': this.dequeue(p); break;
      case 'dmg': this.dmg(p, m.d, m.to); break;
      case 'heal': this.heal(p, m.d); break;
      case 'reg': this.reg(p, m).catch(bad); break;
      case 'login': this.login(p, m).catch(bad); break;
      case 'tok': this.tok(p, m.tok); break;
      case 'sv': this.sv(p, m); break;
      case 'gen': this.setProfile(p, m).catch(() => this.send(p, { t: 'gen', ok: 0, msg: 'Server gagal menyimpan. Coba lagi.' })); break;
      case 'logout': {
        const a = p.acc && AC[p.acc];
        if (a && p.th) { a.ths = (a.ths || []).filter(x => x !== p.th); TKI.delete(p.th); mark('acc', p.acc); }
        p.acc = null; p.th = null; break;
      }
      case 'exp': {
        const a = p.acc && AC[p.acc];
        if (!a || !a.save) { this.send(p, { t: 'exp', ok: 0 }); break; }
        const blob = { v: 2, u: p.acc, t: Date.now(), s: a.save }; blob.sig = sign(blob);
        this.send(p, { t: 'exp', ok: 1, blob }); break;
      }
      case 'imp': this.imp(p, m).catch(() => this.send(p, { t: 'imp', ok: 0, msg: 'Server gagal menyimpan. Coba lagi.' })); break;
      case 'lb': {
        const now = Date.now(), srt = svSorted(), p2a = {}; for (const e in AC) p2a[AC[e].pid] = AC[e];
        const avOf = id => { const a = p2a[id]; return a ? (a.av | 0) : -1; };
        this.send(p, { t: 'lb', list: Object.entries(DB).filter(([, x]) => (x.w || 0) + (x.l || 0) > 0).sort((a, b) => b[1].r - a[1].r).slice(0, 10).map(([id, x]) => ({ n: x.n, r: x.r, w: x.w, l: x.l, av: avOf(id) })),
          sv: srt.slice(0, 10).map(([id, x]) => ({ n: x.n, t: x.t, w: x.w, av: avOf(id), me: id === p.id ? 1 : 0 })), mysv: (srt.findIndex(([id]) => id === p.id) + 1) || 0, rst: nextReset(now), svmin: SV_MIN,
          top: topTitles(p.acc), lw: META.lw || null });
        break;
      }
    }
  }

  cnt() { let r = 0; for (const x of this.M) r += x.ps.length; const m = { t: 'cnt', n: this.P.size, r, q: this.q.length, q2: this.q2.reduce((a, t) => a + t.ps.length, 0) }; for (const p of this.P.values()) this.send(p, m); }
  // ----- Akun -----
  fail(p, msg, extra) { this.send(p, Object.assign({ t: 'acc', ok: 0, msg }, extra)); }
  // Buat token sesi, SIMPAN ke penyimpanan, baru kirim balasan sukses.
  async session(p, e, full) {
    const a = AC[e], tok = crypto.randomBytes(24).toString('hex'), h = sha(tok);
    a.ths = (a.ths || []).concat(h);
    while (a.ths.length > 5) TKI.delete(a.ths.shift());
    TKI.set(h, e);
    try { await persist('acc', e); }
    catch (x) { a.ths = a.ths.filter(y => y !== h); TKI.delete(h); throw x; }
    p.acc = e; p.th = h;
    this.send(p, { t: 'acc', ok: 1, e, tok, pid: a.pid, own: e === OWNER ? 1 : 0, save: full ? a.save : undefined, top: topTitles(e), g: a.g || '', av: a.av | 0 });
  }
  async reg(p, m) {
    const e = String(m.e || '').trim().toLowerCase();
    if (!okUser(e) || typeof m.pw !== 'string' || m.pw.length < 6 || m.pw.length > 64) return this.fail(p, 'Username (3-14 huruf kecil/angka/_) atau kata sandi (min. 6) tidak valid.');
    if (!GEN.includes(m.g)) return this.fail(p, 'Pilih gender dulu. Gender tidak bisa diubah setelah akun dibuat.');
    if (!okAv(m.av)) return this.fail(p, 'Pilih avatar profil.');
    if (AC[e]) return this.fail(p, 'Username sudah dipakai. Gunakan Masuk.');
    if (e === OWNER && !(process.env.OWNER_PW && safeEq(m.pw, process.env.OWNER_PW))) return this.fail(p, 'Username ini dicadangkan.');
    let sv = JSON.parse(JSON.stringify(FRESH));
    if (e === OWNER) { sv = cleanSave(m.save, true); if (!sv) return this.fail(p, 'Data lokal tidak valid, tidak bisa dipautkan.'); }
    const salt = crypto.randomBytes(16).toString('hex');
    AC[e] = { salt, hash: hashPw(m.pw, salt), pid: p.id, save: sv, at: Date.now(), ths: [], g: m.g, av: m.av };
    try { await this.session(p, e, e !== OWNER); }
    catch (x) { delete AC[e]; dirty.acc.delete(e); console.error('reg gagal:', x.message); this.fail(p, 'Server gagal menyimpan akun ke database. Coba lagi sebentar lagi.'); }
  }
  // Gender hanya boleh diset SEKALI (akun lama yang belum punya) dan tidak bisa diubah lagi. Avatar boleh diganti.
  async setProfile(p, m) {
    const a = p.acc && AC[p.acc];
    if (!a) return this.send(p, { t: 'gen', ok: 0, msg: 'Belum masuk akun.' });
    const og = a.g, oa = a.av;
    if (!a.g) { if (!GEN.includes(m.g)) return this.send(p, { t: 'gen', ok: 0, msg: 'Gender tidak valid.' }); a.g = m.g; }
    if (m.av !== undefined) { if (!okAv(m.av)) return this.send(p, { t: 'gen', ok: 0, msg: 'Avatar tidak valid.' }); a.av = m.av; }
    try { await persist('acc', p.acc); }
    catch (x) { a.g = og; a.av = oa; if (og === undefined) delete a.g; return this.send(p, { t: 'gen', ok: 0, msg: 'Server gagal menyimpan. Coba lagi.' }); }
    this.send(p, { t: 'gen', ok: 1, g: a.g, av: a.av | 0 });
  }
  async login(p, m) {
    const now = Date.now();
    if ((p.lf || 0) >= 5 && now - p.lft < 60000) return this.fail(p, 'Terlalu banyak percobaan. Tunggu 1 menit.');
    const e = String(m.e || '').trim().toLowerCase(), a = AC[e];
    const fr = FAILS.get(e);
    if (fr && fr.n >= 10 && now - fr.t < 60000) return this.fail(p, 'Terlalu banyak percobaan pada akun ini. Tunggu 1 menit.');
    let ok = false;
    if (a && typeof m.pw === 'string' && m.pw.length <= 64) {
      const h = Buffer.from(hashPw(m.pw, a.salt), 'hex'), g = Buffer.from(a.hash, 'hex');
      ok = h.length === g.length && crypto.timingSafeEqual(h, g);
    }
    if (!ok) { p.lf = (p.lf || 0) + 1; p.lft = now; if (a) FAILS.set(e, { n: (fr && now - fr.t < 60000 ? fr.n : 0) + 1, t: now }); return this.fail(p, 'Username atau kata sandi salah.'); }
    p.lf = 0; FAILS.delete(e);
    try { await this.session(p, e, true); }
    catch (x) { console.error('login gagal:', x.message); this.fail(p, 'Server gagal menyimpan sesi. Coba lagi sebentar lagi.'); }
  }
  tok(p, t) {
    const bad = () => this.fail(p, 'Sesi berakhir. Silakan masuk lagi.', { bad: 1 });
    if (typeof t !== 'string' || t.length < 10 || t.length > 100) return bad();
    const h = sha(t), e = TKI.get(h), a = e && AC[e];
    if (!a) return bad();
    p.acc = e; p.th = h;
    this.send(p, { t: 'acc', ok: 1, e, tok: t, pid: a.pid, own: e === OWNER ? 1 : 0, top: topTitles(e), g: a.g || '', av: a.av | 0 });
  }

  // ----- Simpan cloud -----
  sv(p, m) {
    const a = p.acc && AC[p.acc], now = Date.now();
    if (!a || a.pid !== p.id) return this.send(p, { t: 'svr', ok: 0, msg: 'Belum masuk akun.' });
    if (now - (p.svt || 0) < 2000) return; // terlalu sering: abaikan, klien akan mengulang
    const s = cleanSave(m.save, p.acc === OWNER);
    if (!s) { p.svt = now; return this.send(p, { t: 'svr', ok: 0, msg: 'Data ditolak server.' }); }
    const c = a.save;
    if (c) { s.stp = Math.max(s.stp || 0, c.stp || 0); s.end = (s.end || 0) | (c.end || 0); } // progres Story tidak boleh mundur
    // Login harian: maksimal +1 hari per klaim, hanya jika harinya lebih baru, tidak boleh mundur
    if (c) { const a = c.lg || { c: 0, d: 0 }, b = s.lg || { c: 0, d: 0 }; s.lg = { c: Math.max(a.c, Math.min(b.c, a.c + (b.d > a.d ? 1 : 0))), d: Math.max(a.d, Math.min(b.d, Math.floor(Date.now() / 864e5) + 1)) }; }
    // Perlindungan: perangkat dengan data LEBIH LAMA tidak boleh menimpa progres cloud yang lebih maju.
    if (c && older(s, c)) return this.send(p, { t: 'svr', ok: 0, stale: 1, save: c });
    p.svt = now;
    if (c && (!a.bakT || now - a.bakT > 15 * 60 * 1000)) { a.bak = (a.bak || []).concat({ t: a.at || now, s: c }).slice(-5); a.bakT = now; } // cadangan bergulir
    a.save = s; a.at = now; mark('acc', p.acc);
    this.send(p, { t: 'svr', ok: 1, at: now });
  }
  async imp(p, m) {
    const now = Date.now();
    if ((p.il || 0) >= 5 && now - p.ilt < 60000) return this.send(p, { t: 'imp', ok: 0, msg: NODB });
    const a = p.acc && AC[p.acc], b = m.blob;
    let s = null;
    // Valid hanya jika: akun yang masuk = pemilik data, dan data benar-benar dikeluarkan server ini (tanda tangan cocok).
    if (a && b && typeof b === 'object' && b.u === p.acc && b.s && typeof b.s === 'object') {
      const c = cleanSave(b.s, p.acc === OWNER);
      if (c) {
        const sigOk = b.v === 2 && typeof b.sig === 'string' && typeof b.t === 'number' && b.t <= now + 60000 && safeEq(b.sig, sign({ v: 2, u: b.u, t: b.t, s: b.s }));
        const legacy = !b.sig && (a.snaps || []).includes(hashSave(b.s)); // ekspor lama
        if (sigOk || legacy) s = c;
      }
    }
    if (!s) { p.il = (p.il || 0) + 1; p.ilt = now; return this.send(p, { t: 'imp', ok: 0, msg: NODB }); }
    p.il = 0;
    if (a.save) { a.bak = (a.bak || []).concat({ t: a.at || now, s: a.save }).slice(-5); a.bakT = now; } // progres sebelum impor ikut dicadangkan
    a.save = s; a.at = now;
    await persist('acc', p.acc);
    this.send(p, { t: 'imp', ok: 1, save: s });
  }

  // ----- Party 2v2: kode 4 karakter, maksimal 2 pemain -----
  ptSend(pt) { const m = { t: 'pty', code: pt.code, ms: pt.ms.map(x => x.n) }; for (const x of pt.ms) this.send(x, m); }
  ptLeave(p) {
    const pt = p.pt; if (!pt) return;
    this.dequeue(p);
    p.pt = null; pt.ms = pt.ms.filter(x => x !== p);
    if (!pt.ms.length) this.PT.delete(pt.code); else this.ptSend(pt);
    this.send(p, { t: 'pty', code: null, ms: [] });
  }
  party(p, m) {
    if (m.a === 'leave') return this.ptLeave(p);
    if (p.m) return;
    if (m.a === 'new') {
      this.ptLeave(p);
      const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code;
      do { code = ''; for (let i = 0; i < 4; i++) code += A[crypto.randomInt(A.length)]; } while (this.PT.has(code));
      const pt = { code, ms: [p] }; this.PT.set(code, pt); p.pt = pt; this.ptSend(pt);
    } else if (m.a === 'join') {
      const pt = this.PT.get(String(m.code || '').trim().toUpperCase());
      if (pt && pt.ms.includes(p)) return;
      if (!pt || pt.ms.length >= 2) return this.send(p, { t: 'pty', err: 'Kode tidak ditemukan atau party penuh.', code: p.pt ? p.pt.code : null, ms: p.pt ? p.pt.ms.map(x => x.n) : [] });
      this.ptLeave(p); pt.ms.push(p); p.pt = pt; this.ptSend(pt);
    }
  }

  // ----- Antrean -----
  inQ(p) { return this.q.includes(p) || this.q2.some(t => t.ps.includes(p)); }
  dequeue(p) {
    this.q = this.q.filter(x => x !== p);
    const gone = this.q2.filter(t => t.ps.includes(p));
    this.q2 = this.q2.filter(t => !t.ps.includes(p));
    for (const t of gone) for (const x of t.ps) if (x !== p) this.send(x, { t: 'pcancel' });
  }
  queue(p, mode) {
    if (p.m || this.inQ(p)) return;
    if (mode === 2) {
      let ps = [p];
      if (p.pt && p.pt.ms.length === 2) { ps = p.pt.ms.slice(); if (ps.some(x => x.m || this.inQ(x))) return; }
      this.q2.push({ ps, t: Date.now() });
      for (const x of ps) if (x !== p) this.send(x, { t: 'pq' });
      this.pair2();
    } else { p.qt = Date.now(); this.q.push(p); this.pair(); }
  }
  pair() {
    const now = Date.now();
    for (let guard = 0; guard < 50 && this.q.length >= 2; guard++) {
      let best = null;
      for (let i = 0; i < this.q.length; i++) for (let j = i + 1; j < this.q.length; j++) {
        const a = this.q[i], b = this.q[j], d = Math.abs(this.rec(a).r - this.rec(b).r);
        const wait = (now - Math.min(a.qt, b.qt)) / 1000;
        if (d <= 200 + wait * 25 && (!best || d < best.d)) best = { a, b, d };
      }
      if (!best) return;
      this.q = this.q.filter(x => x !== best.a && x !== best.b);
      this.launch([best.a, best.b], 1);
    }
  }
  // 2v2: tiket = 1 pemain solo atau 1 party (2 pemain). Susun total 4 pemain dengan selisih rating terkecil.
  pair2() {
    const now = Date.now();
    for (let guard = 0; guard < 20; guard++) {
      if (this.q2.reduce((a, t) => a + t.ps.length, 0) < 4) return;
      const list = this.q2.slice(0, 12);
      let pick = null;
      for (const t0 of list) {
        const win = 200 + (now - t0.t) / 1000 * 25, rest = list.filter(x => x !== t0);
        let best = null;
        const tryset = set => {
          if (set.reduce((a, x) => a + x.ps.length, 0) !== 4) return;
          const rs = []; for (const x of set) for (const y of x.ps) rs.push(this.rec(y).r);
          const sp = Math.max(...rs) - Math.min(...rs);
          if (sp <= win && (!best || sp < best.sp)) best = { set, sp };
        };
        for (let i = 0; i < rest.length; i++) {
          tryset([t0, rest[i]]);
          for (let j = i + 1; j < rest.length; j++) {
            tryset([t0, rest[i], rest[j]]);
            for (let k = j + 1; k < rest.length; k++) tryset([t0, rest[i], rest[j], rest[k]]);
          }
        }
        if (best) { pick = best.set; break; }
      }
      if (!pick) return;
      this.q2 = this.q2.filter(t => !pick.includes(t));
      const pty = pick.filter(t => t.ps.length === 2), sol = pick.filter(t => t.ps.length === 1).map(t => t.ps[0]);
      let A, B;
      if (pty.length === 2) { A = pty[0].ps; B = pty[1].ps; }
      else if (pty.length === 1) { A = pty[0].ps; B = sol; }
      else { sol.sort((a, b) => this.rec(b).r - this.rec(a).r); A = [sol[0], sol[3]]; B = [sol[1], sol[2]]; } // terkuat + terlemah vs dua tengah
      this.launch(A.concat(B), 2, [0, 0, 1, 1]);
    }
  }

  // ----- Pertandingan (1v1 atau 2v2) -----
  launch(ps, mode, teams) {
    const tm = {}, slot = {}, n = [0, 0];
    ps.forEach((x, i) => { const t = teams ? teams[i] : i; tm[x.id] = t; slot[x.id] = n[t]++; });
    const mt = { ps, tm, slot, mode, hp: {}, t: mode === 2 ? SEC2 : SEC1, done: 0, go: 0, rd: new Set(), wt: 0 };
    for (const x of ps) { mt.hp[x.id] = MAXHP; x.m = mt; x.db = null; x.dbt = 0; x.hl = 0; }
    this.M.add(mt);
    const info = x => ({ id: x.id, n: x.n, r: this.rec(x).r, side: tm[x.id], slot: slot[x.id] });
    for (const x of ps) this.send(x, { t: 'match', mode, sec: mt.t, side: tm[x.id], slot: slot[x.id], ps: ps.filter(y => y !== x).map(y => Object.assign(info(y), { al: tm[y.id] === tm[x.id] ? 1 : 0 })) });
    return mt;
  }
  // Akhir run Survival. Durasi = selisih jam SERVER (klien tidak bisa memalsukan). Masuk papan bila >= SV_MIN detik.
  svEnd(p, wv) {
    const t0 = p.svT0; if (!t0 || !p.id) return null; p.svT0 = 0;
    const t = Math.round(Math.min(SV_MAX, (Date.now() - t0) / 1000) * 10) / 10, w = int(wv, 0, Math.floor(t / 1.5) + 1, 0);
    const e = svBoard(), rec = e[p.id]; let ok = 0;
    if (t >= SV_MIN) {
      ok = 1;
      if (!rec || t > rec.t) {
        e[p.id] = { n: clean(p.n, 14), t, w };
        const ks = Object.keys(e); if (ks.length > SV_KEEP) { ks.sort((a, b) => e[a].t - e[b].t); for (const k of ks.slice(0, ks.length - SV_KEEP)) delete e[k]; }
        mark('meta', 'svb');
      }
    }
    const rank = (svSorted().findIndex(([id]) => id === p.id) + 1) || 0;
    return { tm: t, w, ok, min: SV_MIN, rank, best: e[p.id] ? e[p.id].t : 0, pb: ok && (!rec || t > rec.t) ? 1 : 0 };
  }
  bucket(p) { const now = Date.now(); p.tk = Math.min(8, p.tk + (now - p.tl) / 1000 * 8); p.tl = now; if (p.tk < 1) return false; p.tk--; return true; }
  dmg(p, d, to) {
    const mt = p.m; if (!mt || mt.done || !mt.go || Date.now() < mt.goAt || !this.bucket(p)) return;
    if (mt.hp[p.id] <= 0) return; // sudah gugur
    const foes = mt.ps.filter(x => mt.tm[x.id] !== mt.tm[p.id] && mt.hp[x.id] > 0);
    const o = to ? foes.find(x => x.id === to) : (foes.length === 1 ? foes[0] : null);
    if (!o) return;
    if (Math.hypot((p.x || 0) - (o.x || 0), (p.y || 0) - (o.y || 0)) > 240) return; // di luar jangkauan
    if (o.inv && Date.now() - o.invT < 400) return; // lawan sedang dash (kebal)
    // anggaran damage: kapasitas 800, pulih 300/detik (batas wajar serangan normal + skill)
    const now = Date.now();
    p.db = Math.min(800, (p.db == null ? 800 : p.db) + (now - (p.dbt || now)) / 1000 * 300); p.dbt = now;
    d = Math.max(0, Math.min(MAXDMG, p.db, +d || 0)); p.db -= d;
    mt.hp[o.id] = Math.max(0, mt.hp[o.id] - d);
    this.hp(mt);
    if (!mt.ps.some(x => mt.tm[x.id] !== mt.tm[p.id] && mt.hp[x.id] > 0)) this.end(mt, mt.tm[p.id]);
  }
  heal(p, d) {
    const mt = p.m, now = Date.now(); if (!mt || mt.done || !mt.go || now - p.hl < 2000 || mt.hp[p.id] <= 0) return;
    p.hl = now; mt.hp[p.id] = Math.min(MAXHP, mt.hp[p.id] + Math.max(0, Math.min(MAXHEAL, +d || 0))); this.hp(mt);
  }
  hp(mt) { const m = { t: 'hp', h: Object.assign({}, mt.hp) }; for (const x of mt.ps) this.send(x, m); }
  teamHp(mt, t) { let s = 0; for (const x of mt.ps) if (mt.tm[x.id] === t) s += mt.hp[x.id]; return s; }
  // wt = tim pemenang (0/1), null = seri. Elo dihitung dari rata-rata rating tiap tim; rating dipakai bersama untuk 1v1 dan 2v2.
  end(mt, wt) {
    if (mt.done) return; mt.done = 1; this.M.delete(mt);
    for (const x of mt.ps) x.m = null;
    const delta = {};
    if (wt === 0 || wt === 1) {
      const W = mt.ps.filter(x => mt.tm[x.id] === wt), L = mt.ps.filter(x => mt.tm[x.id] !== wt);
      const avg = t => t.reduce((a, x) => a + this.rec(x).r, 0) / t.length;
      const E = 1 / (1 + Math.pow(10, (avg(L) - avg(W)) / 400)), d = Math.max(1, Math.round(32 * (1 - E)));
      for (const x of W) { const r = this.rec(x); r.r += d; r.w++; delta[x.id] = d; mark('rat', x.id); }
      for (const x of L) { const r = this.rec(x), dl = Math.min(d, r.r); r.r -= dl; r.l++; delta[x.id] = -dl; mark('rat', x.id); }
    }
    const ws = (wt === 0 || wt === 1) ? mt.ps.filter(x => mt.tm[x.id] === wt).map(x => x.id) : [];
    for (const x of mt.ps) { const r = this.rec(x); this.send(x, { t: 'end', mode: mt.mode, w: ws[0] || null, ws, r: r.r, d: delta[x.id] || 0, wins: r.w, losses: r.l }); }
  }
  tick() {
    this.tc = (this.tc || 0) + 1;
    if (this.tc % 3 === 0 && ST) flush(false).catch(() => {}); // simpan data yang berubah tiap ~3 detik
    if (this.tc % 5 === 0) this.cnt();
    if (this.tc % 30 === 0 && weeklyCheck()) {
      flush(true).catch(() => {});
      for (const x of this.P.values()) { this.send(x, { t: 'top', top: topTitles(x.acc), reset: 1 }); const r = this.rec(x); this.send(x, { t: 'me', r: r.r, w: r.w, l: r.l }); }
    }
    this.pair(); this.pair2();
    for (const mt of [...this.M]) {
      if (!mt.go) { if (++mt.wt > 20) this.end(mt, null); continue; }
      if (--mt.t > 0) continue;
      const a = this.teamHp(mt, 0), b = this.teamHp(mt, 1);
      this.end(mt, a === b ? null : a > b ? 0 : 1);
    }
  }
  close(p) {
    if (p.svT0) this.svEnd(p, 0);
    this.dequeue(p); this.ptLeave(p);
    const mt = p.m;
    if (mt && !mt.done) { // pemain putus: dianggap gugur; jika seluruh timnya gugur, tim lawan menang
      mt.hp[p.id] = 0; mt.rd.add(p.id); p.m = null; this.hp(mt);
      const t = mt.tm[p.id];
      if (!mt.ps.some(x => mt.tm[x.id] === t && mt.hp[x.id] > 0)) this.end(mt, 1 - t);
    }
    if (p.id && this.P.get(p.id) === p) { this.P.delete(p.id); this.all({ t: 'leave', id: p.id }); this.cnt(); }
  }
}


// ===== LAPORAN / CADANGAN → email developer =====
// Atur lewat environment variable (Render > Environment):
//   REPORT_TO   alamat email developer penerima
//   SMTP_HOST   mis. smtp.gmail.com     SMTP_PORT  465 (TLS) atau 587 (STARTTLS)
//   SMTP_USER   akun SMTP               SMTP_PASS  kata sandi / App Password
//   SMTP_FROM   (opsional) pengirim, default = SMTP_USER
// Tanpa pengaturan itu laporan tetap disimpan di reports.jsonl dan dicetak di log server.
const nettls = { net: require('net'), tls: require('tls') };
function smtpSend(o) {
  return new Promise((resolve, reject) => {
    let sock = null, buf = '', cur = [], waiters = [], closed = false;
    const timer = setTimeout(() => fail(new Error('smtp timeout')), 20000);
    const fail = e => { if (closed) return; closed = true; clearTimeout(timer); try { sock && sock.destroy(); } catch (_) {} reject(e); };
    const done = () => { if (closed) return; closed = true; clearTimeout(timer); try { sock.end(); } catch (_) {} resolve(); };
    const pump = () => {
      for (;;) {
        const i = buf.indexOf('\r\n'); if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2); cur.push(line);
        if (/^\d{3}( |$)/.test(line)) { const r = cur; cur = []; const w = waiters.shift(); if (w) w(r); }
      }
    };
    const attach = s => { sock = s; s.setEncoding('utf8'); s.on('data', d => { buf += d; pump(); }); s.on('error', fail); s.on('close', () => { if (!closed) fail(new Error('smtp closed')); }); };
    const read = () => new Promise(r => waiters.push(r));
    const cmd = async (c, ok) => {
      if (c !== null) sock.write(c + '\r\n');
      const r = await read(); const code = +r[r.length - 1].slice(0, 3);
      if (ok && !ok.includes(code)) throw new Error('smtp ' + code + ' ' + r.join(' ').slice(0, 120));
      return r;
    };
    (async () => {
      const secure = o.port === 465;
      await new Promise((res, rej) => {
        const s = secure ? nettls.tls.connect({ host: o.host, port: o.port, servername: o.host }, res) : nettls.net.connect({ host: o.host, port: o.port }, res);
        s.once('error', rej); attach(s);
      });
      await cmd(null, [220]);
      let ex = await cmd('EHLO slayer-online', [250]);
      if (!secure && !o.plain && ex.some(l => /STARTTLS/i.test(l))) {
        await cmd('STARTTLS', [220]);
        const old = sock; old.removeAllListeners('data'); old.removeAllListeners('close'); old.removeAllListeners('error');
        await new Promise((res, rej) => { const t = nettls.tls.connect({ socket: old, servername: o.host }, res); t.once('error', rej); attach(t); });
        buf = ''; cur = [];
        ex = await cmd('EHLO slayer-online', [250]);
      }
      if (o.user) {
        await cmd('AUTH LOGIN', [334]);
        await cmd(Buffer.from(o.user).toString('base64'), [334]);
        await cmd(Buffer.from(o.pass || '').toString('base64'), [235]);
      }
      await cmd('MAIL FROM:<' + o.from + '>', [250]);
      await cmd('RCPT TO:<' + o.to + '>', [250, 251]);
      await cmd('DATA', [354]);
      const body = ['From: Slayer Online <' + o.from + '>', 'To: <' + o.to + '>', 'Subject: =?UTF-8?B?' + Buffer.from(o.subject).toString('base64') + '?=', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(o.text).toString('base64').replace(/.{1,76}/g, '$&\r\n')].join('\r\n');
      sock.write(body + '\r\n.\r\n'); await cmd(null, [250]);
      try { sock.write('QUIT\r\n'); } catch (_) {}
      done();
    })().catch(fail);
  });
}
const RP = { ip: new Map(), day: 0, n: 0 };
const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r/g, '').trim().slice(0, n);
function handleReport(req, res) {
  const out = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
  let size = 0; const chunks = []; let dead = false;
  req.on('data', c => { size += c.length; if (size > 4096) { dead = true; out(413, { ok: false, e: 'Laporan terlalu panjang.' }); req.destroy(); return; } chunks.push(c); });
  req.on('end', async () => {
    if (dead) return;
    let j; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return out(400, { ok: false, e: 'Data tidak valid.' }); }
    const k = ['bug', 'saran', 'lain'].includes(j.k) ? j.k : 'lain', t = clip(j.t, 500);
    if (t.length < 10) return out(400, { ok: false, e: 'Tulis minimal 10 karakter.' });
    const ip = String((req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '?').trim().slice(0, 64), now = Date.now(), day = Math.floor(now / 864e5);
    if (RP.day !== day) { RP.day = day; RP.n = 0; RP.ip.clear(); }
    const arr = (RP.ip.get(ip) || []).filter(x => now - x < 36e5);
    if (arr.length >= 3 || RP.n >= 300) return out(429, { ok: false, e: 'Terlalu banyak laporan. Coba lagi nanti.' });
    arr.push(now); RP.ip.set(ip, arr); RP.n++;
    const label = { bug: 'Laporan bug', saran: 'Cadangan', lain: 'Lainnya' }[k], nm = clip(j.n, 14).replace(/[\r\n]/g, ' ') || 'Slayer';
    const rec = { ts: new Date(now).toISOString(), k, n: nm, lv: Math.max(0, Math.min(999, j.lv | 0)), w: clip(j.w, 12), ip, t };
    try { fs.appendFile(path.join(process.env.DATA_DIR || __dirname, 'reports.jsonl'), JSON.stringify(rec) + '\n', () => {}); } catch (e) {}
    console.log('[LAPORAN]', JSON.stringify(rec));
    const to = process.env.REPORT_TO, host = process.env.SMTP_HOST;
    if (to && host) {
      const user = process.env.SMTP_USER || '', port = +process.env.SMTP_PORT || 587;
      try {
        await smtpSend({ host, port, user, pass: process.env.SMTP_PASS || '', from: process.env.SMTP_FROM || user || to, to, plain: process.env.SMTP_PLAIN === '1',
          subject: '[Slayer Online] ' + label + ' dari ' + nm, text: label + '\nDari: ' + nm + ' (Lv ' + rec.lv + ', senjata ' + (rec.w || '-') + ')\nWaktu: ' + rec.ts + '\nIP: ' + ip + '\n\n' + t + '\n' });
      } catch (e) { console.error('Gagal kirim email laporan:', e.message); }
    } else console.warn('REPORT_TO / SMTP_HOST belum diisi: laporan hanya disimpan di reports.jsonl dan log.');
    out(200, { ok: true });
  });
}
// Service worker minimal: dipakai untuk menampilkan notifikasi lokal (pengingat login harian) dan membuka game saat notifikasi diketuk.
const SW_JS = `self.addEventListener('install',e=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(l=>{for(const c of l){if('focus' in c)return c.focus()}return self.clients.openWindow('/')}))});`;
module.exports = { Hub, DB, AC, META, init, flush, persist, cleanSave, sign, sha, SW_JS, weeklyCheck, svBoard, topTitles };

if (require.main === module) {
  const http = require('http'), path = require('path');
  const { WebSocketServer } = require('ws');
  const PORT = process.env.PORT || 8080;
  (async () => {
    await init();
    console.log('Penyimpanan: ' + ({ postgres: 'PostgreSQL (permanen)', gas: 'Google Sheets via Apps Script (permanen)', file: 'FILE LOKAL (hilang saat redeploy di hosting gratis; isi GAS_URL + GAS_SECRET)' })[ST.kind] + ' | akun dimuat: ' + Object.keys(AC).length);
    // Server yang sama menyajikan game (index.html) dan menerima koneksi WebSocket.
    const server = http.createServer((req, res) => {
      if (req.url === '/health') { res.end('ok ' + ST.kind); return; }
      if (req.url.split('?')[0] === '/sw.js') { res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' }); res.end(SW_JS); return; }
      if (req.method === 'POST' && req.url.split('?')[0] === '/report') { handleReport(req, res); return; }
      if (req.url.split('?')[0] === '/mail.json') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(MAILS)); return; }
      fs.readFile(path.join(__dirname, 'index.html'), (e, d) => {
        if (e) { res.writeHead(404); res.end('index.html tidak ditemukan'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d);
      });
    });
    const wss = new WebSocketServer({ server, maxPayload: 65536, perMessageDeflate: false });
    const hub = new Hub();
    setInterval(() => hub.tick(), 1000);
    wss.on('connection', ws => {
      const p = hub.connect(ws);
      try { ws._socket.setNoDelay(true); } catch (e) {}
      ws.on('message', d => { let m; try { m = JSON.parse(d); } catch (e) { return; } try { hub.handle(p, m); } catch (e) { console.error(e); } });
      ws.on('close', () => hub.close(p));
      ws.on('error', () => {});
    });
    server.listen(PORT, () => console.log('Slayer Online siap di port ' + PORT));
    // Simpan semua yang tertunda sebelum proses berhenti (Render mengirim SIGTERM saat redeploy).
    const stop = async () => { setTimeout(() => process.exit(1), 8000).unref(); try { await flush(true); } catch (e) {} process.exit(0); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
  })().catch(e => { console.error('Gagal memulai server:', e); process.exit(1); });
}
