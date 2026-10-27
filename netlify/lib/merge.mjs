/* Zusammenführen von zwei Datenständen (Server und Handy).
   Regel: pro Eintrag gewinnt der neuere Stand (updatedAt bzw. _t). Gelöschte Einträge bleiben gelöscht,
   ausser sie wurden nach dem Löschen wieder geändert. So geht keine Eingabe verloren. */
/* Bag sicher zusammenführen: jeder Schläger einzeln nach seinem Zeitstempel (_t), nichts geht verloren,
   was nicht ausdrücklich gelöscht wurde (del: Zeitpunkt des Löschens pro Schläger). Ein Profil ohne Bag löscht nie einen Bag. */
const bagT = o => (o && +o._t) || 0;
const bagHas = v => v!==undefined && v!==null && v!=='';
function bagPick(a, b){
  if(!a) return b; if(!b) return a;
  const ta=bagT(a), tb=bagT(b);
  if(ta!==tb) return ta>tb ? a : b;
  const o={...a};   // gleicher Zeitstempel: Felder vereinen, bei Widerspruch fest nach Wert entscheiden (auf Handy und Server gleich)
  Object.keys(b).forEach(k=>{ const x=o[k], y=b[k]; if(!bagHas(x)) o[k]=y; else if(bagHas(y) && String(y)>String(x)) o[k]=y; }); return o;
}
export function mergeBag(a, b){
  a = (a && typeof a==='object') ? a : null; b = (b && typeof b==='object') ? b : null;
  if(!a && !b) return undefined;
  a = a || {}; b = b || {};
  const del = {...(a.del||{})};
  Object.entries(b.del||{}).forEach(([k,t])=>{ if(typeof t==='number' && (!del[k] || t>del[k])) del[k]=t; });
  const clubs = {};
  new Set([...Object.keys(a.clubs||{}), ...Object.keys(b.clubs||{})]).forEach(id=>{
    const c = bagPick((a.clubs||{})[id], (b.clubs||{})[id]);
    if(c && !(del[id] && del[id] >= bagT(c))) clubs[id] = c;
  });
  const cm = {};
  [...(a.custom||[]), ...(b.custom||[])].forEach(c=>{ if(c && c.id) cm[c.id] = bagPick(cm[c.id], c); });
  const custom = Object.values(cm).filter(c=>!(del[c.id] && del[c.id] >= bagT(c))).sort((x,y)=>String(x.id)<String(y.id)?-1:1);
  const out = {clubs, custom, del};
  if(a.done || b.done) out.done = true;
  return out;
}
export function mergeProfile(cur, inc){
  if(!cur) return inc; if(!inc) return cur;
  const tc = (cur && (cur.updatedAt || cur._t)) || 0, ti = (inc && (inc.updatedAt || inc._t)) || 0;
  const strip = o => { const {bag, ...r} = o; return JSON.stringify(Object.keys(r).sort().map(k=>[k, r[k]])); };
  const newer = ti !== tc ? (ti > tc ? inc : cur) : (strip(inc) > strip(cur) ? inc : cur);
  const out = {...newer};
  const bag = mergeBag(cur.bag, inc.bag);
  if(bag) out.bag = bag; else delete out.bag;
  out._t = Math.max(tc, ti);
  return out;
}
const canon = v => JSON.stringify(v, (k, x) => (x && typeof x==='object' && !Array.isArray(x)) ? Object.keys(x).sort().reduce((o,kk)=>(o[kk]=x[kk],o),{}) : x);

export const COLS = ['rounds', 'courses', 'profiles', 'training'];
const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const tOf = o => (o && (o.updatedAt || o._t)) || 0;
export const emptyDb = () => ({ rounds: {}, courses: {}, profiles: {}, training: {}, deleted: {} });

export function mergeDb(base, inc) {
  const out = { ...emptyDb(), ...structuredClone(base || {}) };
  COLS.forEach(c => { out[c] = out[c] || {}; });
  out.deleted = out.deleted || {};
  const del = out.deleted;
  for (const [k, t] of Object.entries((inc && inc.deleted) || {})) {
    const [col, id] = String(k).split('/');
    if (!COLS.includes(col) || !ID.test(id || '') || typeof t !== 'number') continue;
    if (!del[k] || t > del[k]) del[k] = t;
  }
  for (const col of COLS) {
    for (const [id, o] of Object.entries((inc && inc[col]) || {})) {
      if (!ID.test(id) || !o || typeof o !== 'object' || Array.isArray(o)) continue;
      if (col === 'rounds' && (o.mem || o.guest)) continue;           // Gastrunden bleiben auf dem Handy
      const cur = out[col][id];
      if (col === 'profiles' && cur) { out[col][id] = mergeProfile(cur, o); continue; }   // Bag nie verlieren
      if (!cur || tOf(o) > tOf(cur)) out[col][id] = o;
    }
    for (const id of Object.keys(out[col])) {
      const kd = del[col + '/' + id];
      if (kd && kd >= tOf(out[col][id])) delete out[col][id];
    }
  }
  return out;
}
