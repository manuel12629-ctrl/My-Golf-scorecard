/* Online-Sicherung der Golf Scorecard mit eigenen Konten.
   POST /api/sync  {action, …}
   - login {name, pw, newPw?}       Anmelden. Erstes Mal: Name + bisheriges gemeinsames Passwort (GOLF_PASSWORD), dann eigenes festlegen.
   - (ohne action) {changes}        Abgleich, braucht das Token im Header «Authorization: Bearer …». Antwort: nur, was dieses Konto sehen darf.
   - setpw {old, newPw}             Eigenes Passwort ändern.
   - users                          Liste der Konten.
   - create {name, pw, hi, gender}  Neues Konto anlegen (jedes angemeldete Konto darf das).
   - reset {pid, pw}                Admin: Startpasswort setzen, muss beim nächsten Anmelden geändert werden.
   - setadmin {pid, admin}          Admin: Admin-Recht geben oder entziehen.
   - remove {pid}                   Admin: Konto mit allen Runden und Trainings löschen.
   - bags                           Bag aus den Tageskopien (nur eigenes Profil, Admin alle).
   Daten in Netlify Blobs (Store «golf-scorecard»): «db» Daten, «accounts» Passwort-Hashes, «backup/JJJJ-MM-TT» Tageskopien. */
import { getStore } from '@netlify/blobs';
import { mergeDb, emptyDb } from '../lib/merge.mjs';
import { ID, hashPw, checkPw, sameSecret, makeToken, readToken, emptyAccounts, adminCount, findPid, norm, viewDb, filterChanges } from '../lib/access.mjs';

const MAX_BODY = 6 * 1024 * 1024;
const reply = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});
const slow = () => new Promise(r => setTimeout(r, 400 + Math.random() * 300));
const COLORS = ['#1D6842', '#BF3F2B', '#2D5A88', '#6B4FA0', '#A66A14', '#1E7F86', '#8A3B6E', '#4F6B2A'];

/* Blob lesen und nur schreiben, wenn seit dem Lesen niemand anders geschrieben hat (sonst neu versuchen) */
async function update(store, key, empty, fn) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = await store.getWithMetadata(key, { type: 'json' });
    const base = (cur && cur.data) || empty();
    const res = await fn(structuredClone(base), base);
    if (res && res.skip) return { value: base, out: res.out };
    const next = res && res.value ? res.value : null;
    if (!next) return { value: base, out: res && res.out };
    const w = cur ? await store.setJSON(key, next, { onlyIfMatch: cur.etag }) : await store.setJSON(key, next, { onlyIfNew: true });
    if (w.modified) return { value: next, out: res.out, written: true };
    await new Promise(r => setTimeout(r, 80 + Math.random() * 200));
  }
  throw new Error('busy');
}
const readJSON = async (store, key, empty) => { const c = await store.getWithMetadata(key, { type: 'json' }); return (c && c.data) || empty(); };
async function backup(store, db) { const day = new Date().toISOString().slice(0, 10); try { await store.setJSON('backup/' + day, db); } catch {} }
const pwOk = pw => typeof pw === 'string' && pw.length >= 6 && pw.length <= 200;

export default async (req) => {
  if (req.method !== 'POST') return reply({ error: 'method' }, 405);
  const secret = process.env.GOLF_PASSWORD || '';
  if (secret.length < 6) return reply({ error: 'not_configured' }, 503);
  const text = await req.text();
  if (text.length > MAX_BODY) return reply({ error: 'too_large' }, 413);
  let body; try { body = JSON.parse(text || '{}'); } catch { return reply({ error: 'bad_json' }, 400); }
  const store = getStore({ name: 'golf-scorecard', consistency: 'strong' });

  try {
    /* ---------- Anmelden ---------- */
    if (body.action === 'login') {
      const db = await readJSON(store, 'db', emptyDb);
      const pid = findPid(db, body.name);
      if (!pid) { await slow(); return reply({ error: 'login' }, 401); }
      const isManuel = norm(db.profiles[pid].name) === 'manuel';
      const r = await update(store, 'accounts', emptyAccounts, (acc) => {
        const u = acc.users[pid];
        if (!u) {   // noch kein eigenes Passwort: einmalig mit dem gemeinsamen Passwort
          if (!sameSecret(body.pw, secret)) return { out: { error: 'login' } };
          if (!body.newPw) return { out: { need: 'new', first: true } };
          if (!pwOk(body.newPw)) return { out: { error: 'weak' } };
          if (sameSecret(body.newPw, secret)) return { out: { error: 'same' } };
          const noAdmin = adminCount(acc) === 0, manuelExists = !!findPid(db, 'Manuel');
          acc.users[pid] = { ...hashPw(body.newPw), admin: noAdmin && (isManuel || !manuelExists), mustChange: false, tv: 1, createdAt: Date.now() };
          return { value: acc, out: { ok: true } };
        }
        if (!checkPw(body.pw, u)) return { out: { error: 'login' } };
        if (u.mustChange) {
          if (!body.newPw) return { out: { need: 'new' } };
          if (!pwOk(body.newPw)) return { out: { error: 'weak' } };
          if (body.newPw === body.pw) return { out: { error: 'same' } };
          acc.users[pid] = { ...u, ...hashPw(body.newPw), mustChange: false, tv: (u.tv || 1) + 1 };
          return { value: acc, out: { ok: true } };
        }
        return { out: { ok: true } };
      });
      if (r.out.error) { if (r.out.error === 'login') await slow(); return reply(r.out, r.out.error === 'login' ? 401 : 400); }
      if (r.out.need) return reply(r.out);
      const u = r.value.users[pid];
      return reply({ ok: true, token: makeToken(secret, pid, u.tv), pid, admin: !!u.admin, name: db.profiles[pid].name });
    }

    /* ---------- ab hier angemeldet ---------- */
    const accounts = await readJSON(store, 'accounts', emptyAccounts);
    const h = req.headers.get('authorization') || '';
    const me = readToken(secret, h.startsWith('Bearer ') ? h.slice(7) : '', accounts);
    if (!me) { await slow(); return reply({ error: 'unauthorized' }, 401); }

    if (body.action === 'setpw') {
      const r = await update(store, 'accounts', emptyAccounts, (acc) => {
        const u = acc.users[me.pid];
        if (!u || !checkPw(body.old, u)) return { out: { error: 'old' } };
        if (!pwOk(body.newPw)) return { out: { error: 'weak' } };
        acc.users[me.pid] = { ...u, ...hashPw(body.newPw), mustChange: false, tv: (u.tv || 1) + 1 };
        return { value: acc, out: { ok: true } };
      });
      if (r.out.error) return reply(r.out, 400);
      return reply({ ok: true, token: makeToken(secret, me.pid, r.value.users[me.pid].tv) });
    }

    if (body.action === 'users') {
      const db = await readJSON(store, 'db', emptyDb);
      const list = Object.entries(db.profiles || {}).filter(([id, p]) => p).map(([id, p]) => {
        const u = accounts.users[id];
        const o = { id, name: p.name, color: p.color, admin: !!(u && u.admin) };
        if (me.admin) { o.hasPw = !!u; o.mustChange = !!(u && u.mustChange); }
        return o;
      });
      return reply({ ok: true, users: list, me });
    }

    if (body.action === 'create') {
      const name = String(body.name || '').trim().slice(0, 40);
      if (!name) return reply({ error: 'name' }, 400);
      if (!pwOk(body.pw)) return reply({ error: 'weak' }, 400);
      const pid = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const hi = body.hi === '' || body.hi == null || isNaN(+body.hi) ? null : Math.round(+body.hi * 10) / 10;
      const r = await update(store, 'db', emptyDb, (db) => {
        if (findPid(db, name)) return { out: { error: 'exists' } };
        const used = new Set(Object.values(db.profiles || {}).map(p => p && p.color));
        db.profiles[pid] = { name, hi, gender: body.gender === 'w' ? 'w' : 'm', color: COLORS.find(c => !used.has(c)) || COLORS[0], share: [], _t: Date.now() };
        db.serverAt = Date.now();
        return { value: db, out: { ok: true } };
      });
      if (r.out.error) return reply(r.out, 400);
      await update(store, 'accounts', emptyAccounts, (acc) => { acc.users[pid] = { ...hashPw(body.pw), admin: false, mustChange: true, tv: 1, createdAt: Date.now() }; return { value: acc, out: {} }; });
      await backup(store, r.value);
      return reply({ ok: true, pid });
    }

    if (body.action === 'reset' || body.action === 'setadmin' || body.action === 'remove') {
      if (!me.admin) return reply({ error: 'forbidden' }, 403);
      const pid = String(body.pid || '');
      if (!ID.test(pid)) return reply({ error: 'pid' }, 400);
      if (body.action === 'reset') {
        if (!pwOk(body.pw)) return reply({ error: 'weak' }, 400);
        const db = await readJSON(store, 'db', emptyDb);
        if (!db.profiles[pid]) return reply({ error: 'pid' }, 400);
        await update(store, 'accounts', emptyAccounts, (acc) => { const u = acc.users[pid] || { admin: false, tv: 0, createdAt: Date.now() };
          acc.users[pid] = { ...u, ...hashPw(body.pw), mustChange: true, tv: (u.tv || 0) + 1 }; return { value: acc, out: {} }; });
        return reply({ ok: true });
      }
      if (body.action === 'setadmin') {
        const r = await update(store, 'accounts', emptyAccounts, (acc) => { const u = acc.users[pid];
          if (!u) return { out: { error: 'nopw' } };
          if (!body.admin && u.admin && adminCount(acc) <= 1) return { out: { error: 'lastadmin' } };
          acc.users[pid] = { ...u, admin: !!body.admin }; return { value: acc, out: { ok: true } }; });
        return r.out.error ? reply(r.out, 400) : reply({ ok: true });
      }
      // remove: Konto, Profil, Runden und Trainings des Kontos löschen
      if (pid === me.pid) return reply({ error: 'self' }, 400);
      const now = Date.now();
      const r = await update(store, 'db', emptyDb, (db) => {
        if (!db.profiles[pid]) return { out: { ok: true } };
        delete db.profiles[pid]; db.deleted['profiles/' + pid] = now;
        for (const col of ['rounds', 'training', 'swings']) for (const [id, o] of Object.entries(db[col] || {})) if (o && o.profileId === pid) { delete db[col][id]; db.deleted[col + '/' + id] = now; }
        for (const p of Object.values(db.profiles)) if (p && Array.isArray(p.share)) p.share = p.share.filter(x => x !== pid);
        db.serverAt = now;
        return { value: db, out: { ok: true } };
      });
      await update(store, 'accounts', emptyAccounts, (acc) => { if (!acc.users[pid]) return { out: {} }; delete acc.users[pid]; return { value: acc, out: {} }; });
      if (r.written) await backup(store, r.value);
      return reply({ ok: true });
    }

    if (body.action === 'bags') {
      const { blobs } = await store.list({ prefix: 'backup/' });
      const keys = blobs.map(b => b.key).filter(k => /^backup\/\d{4}-\d{2}-\d{2}$/.test(k)).sort().reverse().slice(0, 60);
      const days = [];
      for (const key of keys) {
        let db = null; try { db = await store.get(key, { type: 'json' }); } catch {}
        if (!db || !db.profiles) continue;
        const profiles = {};
        for (const [id, p] of Object.entries(db.profiles)) if (p && p.bag && (id === me.pid || me.admin)) profiles[id] = { name: p.name, bag: p.bag };
        days.push({ day: key.slice(7), profiles });
      }
      return reply({ ok: true, days });
    }

    /* ---------- Standbilder der Schwung-Videos: pro Video ein Blob «swimg/<id>» {owner, f:{phase: JPEG}} ----------
       Das Video selbst bleibt auf dem Handy. Schreiben darf der Besitzer (und der Admin), lesen wer die Runden sehen darf. */
    if (body.action === 'swimg') {
      const id = String(body.id || ''), op = body.op;
      if (!ID.test(id)) return reply({ error: 'bad_id' }, 400);
      const key = 'swimg/' + id;
      if (op === 'get') {
        const cur = await store.get(key, { type: 'json' }).catch(() => null);
        if (!cur) return reply({ ok: true, f: {} });
        if (cur.owner !== me.pid && !me.admin) {
          const db = await readJSON(store, 'db', emptyDb), p = (db.profiles || {})[cur.owner];
          if (!(p && Array.isArray(p.share) && p.share.includes(me.pid))) return reply({ error: 'forbidden' }, 403);
        }
        return reply({ ok: true, f: cur.f || {} });
      }
      if (op === 'put' || op === 'del') {
        const k = String(body.k ?? ''), img = body.img;
        if (op === 'put' && (!/^[0-7]$/.test(k) || typeof img !== 'string' || !img.startsWith('data:image/jpeg;base64,') || img.length > 400000)) return reply({ error: 'bad_img' }, 400);
        const owner = String(body.owner || me.pid);
        if (owner !== me.pid && !me.admin) return reply({ error: 'forbidden' }, 403);
        const r = await update(store, key, () => ({ owner, f: {} }), (cur) => {
          if (cur.owner !== me.pid && !me.admin) return { out: { error: 'forbidden' } };
          if (op === 'del') { if (k) delete cur.f[k]; else cur.f = {}; } else cur.f[k] = img;
          return { value: cur, out: { ok: true } };
        });
        if (r.out && r.out.error) return reply(r.out, 403);
        if (op === 'del' && !k) { try { await store.delete(key); } catch {} }
        return reply({ ok: true });
      }
      return reply({ error: 'bad_op' }, 400);
    }

    /* ---------- Abgleich ---------- */
    let rejected = [];
    const r = await update(store, 'db', emptyDb, (db, base) => {
      const f = filterChanges(base, body.changes || {}, me); rejected = f.rejected;
      const merged = mergeDb(base, f.ok);
      const { serverAt: _a, ...b1 } = base; const { serverAt: _b, ...m1 } = merged;
      if (JSON.stringify(b1) === JSON.stringify(m1)) return { skip: true };
      merged.serverAt = Date.now();
      return { value: merged, out: {} };
    });
    if (r.written) await backup(store, r.value);
    return reply({ ok: true, db: viewDb(r.value, me), me, rejected });
  } catch (e) {
    if (String(e && e.message) === 'busy') return reply({ error: 'busy' }, 409);
    throw e;
  }
};

export const config = { path: '/api/sync' };
