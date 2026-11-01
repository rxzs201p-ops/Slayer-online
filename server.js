// Slayer Online - server (Node.js)
// Fitur: chat global, kehadiran pemain, PvP bebas, dan RANKED 1v1 dengan rating Elo.
// Jalankan:  npm i ws  &&  node server.js     (PORT bawaan 8080)
// Rating disimpan di ratings.json (ubah dengan env RATINGS).
// Catatan: pemain dikenali dari ID acak yang disimpan di browser, belum ada akun/kata sandi.
const fs = require('fs');
const FILE = process.env.RATINGS || 'ratings.json';
let DB = {};
try { DB = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {}
const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(DB)); } catch (e) {} };

const MAXHP = 1000, MATCH_SEC = 150, MAXDMG = 600, MAXHEAL = 300;
const clean = (s, n) => String(s == null ? '' : s).replace(/[<>&]/g, '').slice(0, n);

class Hub {
  constructor() { this.P = new Map(); this.q = []; this.M = new Set(); }
  send(p, m) { if (p && p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(m)); }
  all(m, except) { for (const p of this.P.values()) if (p !== except) this.send(p, m); }
  rec(p) { return DB[p.id] || (DB[p.id] = { n: p.n, r: 1000, w: 0, l: 0 }); }

  connect(ws) { return { ws, id: null, n: 'Pemain', m: null, tk: 8, tl: Date.now(), hl: 0 }; }

  handle(p, m) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || m.id.length < 4 || m.id.length > 20) return;
    if (!p.id) {
      p.id = m.id;
      const old = this.P.get(p.id);
      if (old && old !== p) try { old.ws.close(); } catch (e) {}
      this.P.set(p.id, p);
    } else if (p.id !== m.id) return;
    if (m.n) { p.n = clean(m.n, 14) || 'Pemain'; this.rec(p).n = p.n; }
    switch (m.t) {
      case 'join': { const r = this.rec(p); this.send(p, { t: 'me', r: r.r, w: r.w, l: r.l }); break; }
      case 'st': {
        const o = p.m ? (p.m.a === p ? p.m.b : p.m.a) : null;
        p.inv = !!m.inv; p.invT = Date.now();
        const out = { t: 'st', id: p.id, x: +m.x || 0, y: +m.y || 0, f: m.f < 0 ? -1 : 1, n: p.n };
        if (o) this.send(o, out);
        else for (const q of this.P.values()) if (q !== p && !q.m) this.send(q, out);
        break;
      }
      case 'chat': this.all({ t: 'chat', n: p.n, msg: clean(m.msg, 80) }); break;
      case 'hit': { const o = this.P.get(m.to); if (o && !p.m && !o.m) this.send(o, { t: 'hit', id: p.id, to: o.id, d: Math.min(60, Math.max(0, +m.d || 0)) }); break; }
      case 'queue': this.queue(p); break;
      case 'cancel': this.q = this.q.filter(x => x !== p); break;
      case 'dmg': this.dmg(p, m.d); break;
      case 'heal': this.heal(p, m.d); break;
      case 'lb': this.send(p, { t: 'lb', list: Object.values(DB).sort((a, b) => b.r - a.r).slice(0, 10).map(x => ({ n: x.n, r: x.r })) }); break;
    }
  }

  queue(p) {
    if (p.m || this.q.includes(p)) return;
    p.qt = Date.now(); this.q.push(p); this.pair();
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
      this.start(best.a, best.b);
    }
  }
  start(a, b) {
    const mt = { a, b, hp: { [a.id]: MAXHP, [b.id]: MAXHP }, t: MATCH_SEC, done: 0 };
    a.m = b.m = mt; this.M.add(mt);
    this.send(a, { t: 'match', side: 0, opp: { id: b.id, n: b.n, r: this.rec(b).r } });
    this.send(b, { t: 'match', side: 1, opp: { id: a.id, n: a.n, r: this.rec(a).r } });
  }
  bucket(p) { const now = Date.now(); p.tk = Math.min(8, p.tk + (now - p.tl) / 1000 * 8); p.tl = now; if (p.tk < 1) return false; p.tk--; return true; }
  dmg(p, d) {
    const mt = p.m; if (!mt || mt.done || !this.bucket(p)) return;
    const o = mt.a === p ? mt.b : mt.a;
    if (o.inv && Date.now() - o.invT < 400) return; // lawan sedang dash (kebal)
    // anggaran damage: kapasitas 800, pulih 300/detik (batas wajar serangan normal + skill)
    const now = Date.now();
    p.db = Math.min(800, (p.db == null ? 800 : p.db) + (now - (p.dbt || now)) / 1000 * 300); p.dbt = now;
    d = Math.max(0, Math.min(MAXDMG, p.db, +d || 0)); p.db -= d;
    mt.hp[o.id] = Math.max(0, mt.hp[o.id] - d);
    this.hp(mt);
    if (mt.hp[o.id] <= 0) this.end(mt, p);
  }
  heal(p, d) {
    const mt = p.m, now = Date.now(); if (!mt || mt.done || now - p.hl < 2000) return;
    p.hl = now; mt.hp[p.id] = Math.min(MAXHP, mt.hp[p.id] + Math.max(0, Math.min(MAXHEAL, +d || 0))); this.hp(mt);
  }
  hp(mt) { const m = { t: 'hp', h: Object.assign({}, mt.hp) }; this.send(mt.a, m); this.send(mt.b, m); }
  end(mt, w) {
    if (mt.done) return; mt.done = 1; this.M.delete(mt);
    const { a, b } = mt; a.m = b.m = null;
    let da = 0, db = 0;
    if (w) {
      const l = w === a ? b : a, rw = this.rec(w), rl = this.rec(l);
      const E = 1 / (1 + Math.pow(10, (rl.r - rw.r) / 400)), d = Math.max(1, Math.round(32 * (1 - E)));
      const dl = Math.min(d, rl.r);
      rw.r += d; rl.r -= dl; rw.w++; rl.l++;
      if (w === a) { da = d; db = -dl; } else { db = d; da = -dl; }
      save();
    }
    this.send(a, { t: 'end', w: w ? w.id : null, r: this.rec(a).r, d: da, wins: this.rec(a).w, losses: this.rec(a).l });
    this.send(b, { t: 'end', w: w ? w.id : null, r: this.rec(b).r, d: db, wins: this.rec(b).w, losses: this.rec(b).l });
  }
  tick() {
    this.pair();
    for (const mt of [...this.M]) {
      if (--mt.t > 0) continue;
      const ha = mt.hp[mt.a.id], hb = mt.hp[mt.b.id];
      this.end(mt, ha === hb ? null : ha > hb ? mt.a : mt.b);
    }
  }
  close(p) {
    this.q = this.q.filter(x => x !== p);
    if (p.m) { const mt = p.m; this.end(mt, mt.a === p ? mt.b : mt.a); }
    if (p.id && this.P.get(p.id) === p) { this.P.delete(p.id); this.all({ t: 'leave', id: p.id }); }
  }
}

module.exports = { Hub, DB };

if (require.main === module) {
  const http = require('http'), path = require('path');
  const { WebSocketServer } = require('ws');
  const PORT = process.env.PORT || 8080;
  // Server yang sama menyajikan game (index.html) dan menerima koneksi WebSocket.
  const server = http.createServer((req, res) => {
    if (req.url === '/health') { res.end('ok'); return; }
    fs.readFile(path.join(__dirname, 'index.html'), (e, d) => {
      if (e) { res.writeHead(404); res.end('index.html tidak ditemukan'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d);
    });
  });
  const wss = new WebSocketServer({ server, maxPayload: 2048 });
  const hub = new Hub();
  setInterval(() => hub.tick(), 1000);
  wss.on('connection', ws => {
    const p = hub.connect(ws);
    ws.on('message', d => { let m; try { m = JSON.parse(d); } catch (e) { return; } try { hub.handle(p, m); } catch (e) { console.error(e); } });
    ws.on('close', () => hub.close(p));
    ws.on('error', () => {});
  });
  server.listen(PORT, () => console.log('Slayer Online siap di port ' + PORT));
}
