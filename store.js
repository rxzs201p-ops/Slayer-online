// Slayer Online - lapisan penyimpanan.
// Ada DATABASE_URL  -> PostgreSQL (permanen, selamat dari redeploy/restart).
// Tidak ada         -> file JSON lokal (HILANG di hosting gratis seperti Render saat restart/redeploy).
// Semua data disimpan sebagai pasangan kunci -> JSON di satu tabel: kv(k, v, u).
//   acc:<username>  akun (hash sandi, token, save, backup)
//   rat:<id pemain> rating ranked
//   meta:<nama>     rahasia server (kunci tanda tangan ekspor)
const fs = require('fs');
const KINDS = ['acc', 'rat', 'meta'];

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
      for (const row of r.rows) {
        const i = row.k.indexOf(':'), kind = row.k.slice(0, i);
        if (mem[kind]) mem[kind][row.k.slice(i + 1)] = row.v;
      }
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

// opts: { url, pool, accFile, ratFile, metaFile }
async function openStore(opts = {}) {
  const files = {
    acc: opts.accFile || process.env.ACCOUNTS || 'accounts.json',
    rat: opts.ratFile || process.env.RATINGS || 'ratings.json',
    meta: opts.metaFile || process.env.META || 'meta.json',
  };
  const url = opts.url !== undefined ? opts.url : process.env.DATABASE_URL;
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
  } else st = fileStore(files);

  const mem = await st.load();

  // Migrasi sekali jalan: database masih kosong tetapi ada file lokal lama -> salin ke database.
  if (st.kind === 'postgres' && !Object.keys(mem.acc).length && !Object.keys(mem.rat).length) {
    const old = await fileStore(files).load(), items = [];
    for (const k of ['acc', 'rat']) for (const key in old[k]) items.push([k, key, old[k][key]]);
    if (items.length) {
      await st.putMany(items);
      for (const [k, key, v] of items) mem[k][key] = v;
      console.log('Migrasi dari file lokal ke database: ' + items.length + ' data.');
    }
  }
  st.mem = mem;
  return st;
}

module.exports = { openStore, fileStore, pgStore };
