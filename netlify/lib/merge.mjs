/* Zusammenführen von zwei Datenständen (Server und Handy).
   Regel: pro Eintrag gewinnt der neuere Stand (updatedAt bzw. _t). Gelöschte Einträge bleiben gelöscht,
   ausser sie wurden nach dem Löschen wieder geändert. So geht keine Eingabe verloren. */
export const COLS = ['rounds', 'courses', 'profiles'];
const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const tOf = o => (o && (o.updatedAt || o._t)) || 0;
export const emptyDb = () => ({ rounds: {}, courses: {}, profiles: {}, deleted: {} });

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
      if (!cur || tOf(o) > tOf(cur)) out[col][id] = o;
    }
    for (const id of Object.keys(out[col])) {
      const kd = del[col + '/' + id];
      if (kd && kd >= tOf(out[col][id])) delete out[col][id];
    }
  }
  return out;
}
