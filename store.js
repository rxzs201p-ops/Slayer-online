// Slayer Online - lapisan penyimpanan. Pilihan (urutan prioritas):
//   DATABASE_URL        -> PostgreSQL
//   GAS_URL+GAS_SECRET  -> Google Sheets (Drive) lewat Google Apps Script (lihat Code.gs)
//   (tidak ada)         -> file JSON lokal (HILANG di hosting gratis seperti Render saat restart/redeploy)
// Semua data disimpan sebagai pasangan kunci -> JSON:
//   acc:<username>  akun (hash sandi, token, save, backup)
//   rat:<id pemain> rating ranked
//   meta:<nama>     rahasia server (kunci tanda tangan ekspor)
const fs = require('fs');
const KINDS = ['acc', 'rat', 'meta'];
const split = k => { const i = k.indexOf(':'); return [k.slice(0, i), k.slice(i + 1)]; };

function fileStore(files) {
  const mem = { acc: {}, rat: {}, meta: {} };
  const write = kind => {
    const f = files[kind]; if (!f) return;
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(mem[kind]));
    fs.renameSync(tmp, f); // tulis atomik: file tidak pernah setengah jadi
  };
  return {
    kind: 'file',
    async load() {
      for (const k of KINDS) { try { if (files[k]) mem[k] = JSON.parse(fs.readFileSync(files[k], 'utf8')); } catch (e) {} }
      return mem;
    },
    async putMany(items) {
      const touched = new Set();
      for (const [kind, key, val] of items) { mem[kind][key] = val; touched.add(kind); }
      for (const k of touched) write(k);
    },
  };
}

function pgStore(pool) {
  return {
    kind: 'postgres',
    async load() {
      await pool.query('CREATE TABLE IF NOT EXISTS kv (k text PRIMARY KEY, v jsonb NOT NULL, u timestamptz NOT NULL DEFAULT now())');
      const r = await pool.query('SELECT k, v FROM kv');
      const mem = { acc: {}, rat: {}, meta: {} };
      for (const row of r.rows) { const [kind, key] = split(row.k); if (mem[kind]) mem[kind][key] = row.v; }
      return mem;
    },
    async putMany(items) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        for (const [kind, key, val] of items)
          await c.query('INSERT INTO kv (k, v) VALUES ($1, $2::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, u = now()', [kind + ':' + key, JSON.stringify(val)]);
        await c.query('COMMIT');
      } catch (e) {
        try { await c.query('ROLLBACK'); } catch (x) {}
        throw e;
      } finally { c.release(); }
    },
  };
}

// Google Sheets lewat Apps Script web app. Lambat (~1-3 dtk per panggilan), jadi server menulis berkelompok.
function gasStore(url, secret) {
  const call = async body => {
    let last;
    for (let i = 0; i < 3; i++) {
      const ac = new AbortController(), to = setTimeout(() => ac.abort(), 25000);
      try {
        const r = await fetch(url, { method: 'POST', redirect: 'follow', signal: ac.signal, headers: { 'content-type': 'text/plain;charset=utf-8' }, body: JSON.stringify(Object.assign({ secret }, body)) });
        const t = await r.text(); let j;
        try { j = JSON.parse(t); } catch (e) { const x = new Error('balasan bukan JSON: cek deploy Apps Script (akses harus "Anyone", URL berakhiran /exec)'); x.fatal = true; throw x; }
        if (!j.ok) { const x = new Error('Apps Script menolak: ' + j.err + (/secret/.test(String(j.err)) ? ' (GAS_SECRET harus sama dengan SECRET di Code.gs)' : '')); x.fatal = /secret|json|op/.test(String(j.err)); throw x; }
        return j;
      } catch (e) {
        last = e; if (e.fatal) throw e;
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      } finally { clearTimeout(to); }
    }
    throw last;
  };
  return {
    kind: 'gas',
    gap: 15000, // jarak minimal antar penulisan rutin (ms); daftar/impor/shutdown tetap langsung
    async load() {
      const j = await call({ op: 'load' });
      const mem = { acc: {}, rat: {}, meta: {} };
      for (const row of j.rows || []) {
        const [kind, key] = split(row.k);
        if (!mem[kind]) continue;
        try { mem[kind][key] = JSON.parse(row.v); } catch (e) { console.error('Data rusak dilewati: ' + row.k); }
      }
      return mem;
    },
    async putMany(items) {
      for (let i = 0; i < items.length; i += 25)
        await call({ op: 'put', items: items.slice(i, i + 25).map(([kind, key, val]) => ({ k: kind + ':' + key, v: JSON.stringify(val) })) });
    },
  };
}

// opts: { url, pool, gas:{url,secret}, accFile, ratFile, metaFile }
async function openStore(opts = {}) {
  const files = {
    acc: opts.accFile || process.env.ACCOUNTS || 'accounts.json',
    rat: opts.ratFile || process.env.RATINGS || 'ratings.json',
    meta: opts.metaFile || process.env.META || 'meta.json',
  };
  const url = opts.url !== undefined ? opts.url : process.env.DATABASE_URL;
  const gas = opts.gas || (process.env.GAS_URL ? { url: process.env.GAS_URL, secret: process.env.GAS_SECRET } : null);
  let st;
  if (opts.pool || url) {
    let pool = opts.pool;
    if (!pool) {
      const { Pool } = require('pg');
      // SSL diatur sendiri (sslmode di URL dibuang supaya tidak menimpa pengaturan ini)
      const clean = url.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
      pool = new Pool({ connectionString: clean, max: 3, connectionTimeoutMillis: 15000, idleTimeoutMillis: 30000, ssl: /@(localhost|127\.0\.0\.1)/.test(url) ? false : { rejectUnauthorized: false } });
      pool.on('error', e => console.error('Postgres:', e.message));
    }
    st = pgStore(pool);
  } else if (gas && gas.url) {
    if (!gas.secret) throw new Error('GAS_SECRET belum diisi (harus sama dengan SECRET di Code.gs)');
    st = gasStore(gas.url, gas.secret);
  } else st = fileStore(files);

  const mem = await st.load(); // gagal di sini = server berhenti (lebih aman daripada jalan dengan data kosong)

  // Migrasi sekali jalan: penyimpanan cloud masih kosong tetapi ada file lokal lama -> salin.
  if (st.kind !== 'file' && !Object.keys(mem.acc).length && !Object.keys(mem.rat).length) {
    const old = await fileStore(files).load(), items = [];
    for (const k of ['acc', 'rat']) for (const key in old[k]) items.push([k, key, old[k][key]]);
    if (items.length) {
      await st.putMany(items);
      for (const [k, key, v] of items) mem[k][key] = v;
      console.log('Migrasi dari file lokal ke penyimpanan cloud: ' + items.length + ' data.');
    }
  }
  st.mem = mem;
  return st;
}

module.exports = { openStore, fileStore, pgStore, gasStore };
