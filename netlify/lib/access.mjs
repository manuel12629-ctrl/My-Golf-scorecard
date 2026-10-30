/* Konten, Anmeldung und Rechte der Golf Scorecard.
   Passwörter liegen nur als scrypt-Hash im Blob «accounts», nie in der Datenbank «db» und nie im Klartext.
   Anmeldung gibt ein signiertes Token zurück (HMAC mit dem Geheimnis GOLF_PASSWORD aus Netlify).
   Wer was sehen darf: eigene Daten, Daten von Konten, die für einen freigegeben haben (profile.share), Runden aus
   gemeinsamen Flights, und als Admin alles. Der Bag bleibt immer privat (nur Besitzer und Admin). */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const ID = /^[A-Za-z0-9_-]{1,64}$/;
const b64u = b => Buffer.from(b).toString('base64url');
export const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

export function hashPw(pw, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(String(pw), salt, 32).toString('hex') };
}
export function checkPw(pw, acc) {
  if (!acc || !acc.hash || !acc.salt) return false;
  const a = Buffer.from(scryptSync(String(pw), acc.salt, 32).toString('hex'));
  const b = Buffer.from(acc.hash);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function sameSecret(a, b) {
  const x = createHmac('sha256', 'cmp').update(String(a)).digest(), y = createHmac('sha256', 'cmp').update(String(b)).digest();
  return timingSafeEqual(x, y);
}
const sign = (secret, s) => b64u(createHmac('sha256', secret).update(s).digest());
export function makeToken(secret, pid, tv, days = 365) {
  const exp = Math.floor(Date.now() / 1000) + days * 86400;
  const s = `${pid}.${tv}.${exp}`;
  return `${s}.${sign(secret, s)}`;
}
export function readToken(secret, token, accounts) {
  const p = String(token || '').split('.');
  if (p.length !== 4 || !ID.test(p[0])) return null;
  const s = `${p[0]}.${p[1]}.${p[2]}`;
  const want = Buffer.from(sign(secret, s)), got = Buffer.from(p[3]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  if (+p[2] < Date.now() / 1000) return null;
  const acc = accounts.users[p[0]];
  if (!acc || String(acc.tv) !== p[1]) return null;
  return { pid: p[0], admin: !!acc.admin };
}
export const emptyAccounts = () => ({ users: {} });
export const adminCount = accounts => Object.values(accounts.users).filter(u => u.admin).length;
export function findPid(db, name) {
  const n = norm(name); if (!n) return null;
  const hit = Object.entries(db.profiles || {}).find(([id, p]) => p && norm(p.name) === n);
  return hit ? hit[0] : null;
}

/* --- Sichtbarkeit --- */
export function viewer(db, me) {
  const shared = new Set(Object.entries(db.profiles || {}).filter(([id, p]) => id === me.pid || me.admin || (Array.isArray(p.share) && p.share.includes(me.pid))).map(([id]) => id));
  const myGroups = new Set(Object.values(db.rounds || {}).filter(r => r && (r.profileId === me.pid || r.by === me.pid)).map(r => r.groupId));
  return { me, shared, myGroups };
}
export const canSeeRound = (v, r) => !!r && (v.shared.has(r.profileId) || r.by === v.me.pid || v.myGroups.has(r.groupId));
export const canSeeTraining = (v, t) => !!t && v.shared.has(t.profileId);
export const canSeeSwing = (v, w) => !!w && v.shared.has(w.profileId);
export function viewDb(db, me) {
  const v = viewer(db, me), out = { rounds: {}, courses: {}, profiles: {}, training: {}, swings: {}, deleted: db.deleted || {}, serverAt: db.serverAt };
  out.courses = db.courses || {};
  for (const [id, r] of Object.entries(db.rounds || {})) if (canSeeRound(v, r)) out.rounds[id] = r;
  for (const [id, t] of Object.entries(db.training || {})) if (canSeeTraining(v, t)) out.training[id] = t;
  for (const [id, w] of Object.entries(db.swings || {})) if (canSeeSwing(v, w)) out.swings[id] = w;
  for (const [id, p] of Object.entries(db.profiles || {})) {
    if (!p) continue;
    if (v.shared.has(id)) { const q = { ...p }; if (id !== me.pid && !me.admin) delete q.bag; out.profiles[id] = q; }
    else out.profiles[id] = { name: p.name, color: p.color, gender: p.gender, share: p.share || [], _t: p._t || 0, min: true };
  }
  return out;
}

/* --- Schreibrechte: nur erlaubte Änderungen kommen in die Datenbank --- */
export function filterChanges(db, inc, me) {
  const ok = { rounds: {}, courses: {}, profiles: {}, training: {}, swings: {}, deleted: {} }, rejected = [];
  const may = {
    rounds: (id, o) => { const cur = (db.rounds || {})[id];
      if (me.admin) return true;
      if (cur) return (cur.profileId === me.pid || cur.by === me.pid) && (!o || o.profileId === cur.profileId);
      if (!o) return false;
      if (o.profileId === me.pid || o.by === me.pid) return true;
      // ältere Geräte kennen «by» noch nicht: neue Runde gehört zu einem Flight, in dem ich mitspiele
      const g = o.groupId;
      return !!g && (Object.values(db.rounds || {}).some(r => r && r.groupId === g && (r.profileId === me.pid || r.by === me.pid))
        || Object.values((inc && inc.rounds) || {}).some(r => r && r.groupId === g && r.profileId === me.pid)); },
    training: (id, o) => { const cur = (db.training || {})[id]; if (me.admin) return true;
      return cur ? cur.profileId === me.pid && (!o || o.profileId === me.pid) : !!o && o.profileId === me.pid; },
    swings: (id, o) => { const cur = (db.swings || {})[id]; if (me.admin) return true;
      return cur ? cur.profileId === me.pid && (!o || o.profileId === me.pid) : !!o && o.profileId === me.pid; },
    profiles: (id, o) => !!(db.profiles || {})[id] && (id === me.pid || me.admin) && !!o,
    courses: () => true
  };
  for (const col of ['rounds', 'courses', 'profiles', 'training', 'swings']) {
    for (const [id, o] of Object.entries((inc && inc[col]) || {})) {
      if (!ID.test(id) || !o || typeof o !== 'object') continue;
      if (may[col](id, o)) ok[col][id] = o; else rejected.push(col + '/' + id);
    }
  }
  for (const [k, t] of Object.entries((inc && inc.deleted) || {})) {
    const [col, id] = String(k).split('/');
    if (typeof t !== 'number' || !ID.test(id || '')) continue;
    if (col === 'profiles') { if (me.admin) ok.deleted[k] = t; continue; }
    if (!may[col]) continue;
    const cur = (db[col] || {})[id];
    if (!cur || may[col](id, null)) ok.deleted[k] = t; else rejected.push(k);
  }
  return { ok, rejected };
}
