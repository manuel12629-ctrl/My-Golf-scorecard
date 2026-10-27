/* Online-Sicherung der Golf Scorecard.
   POST /api/sync mit {changes} und dem Passwort im Header «Authorization: Bearer …».
   Speichert alles in Netlify Blobs (Store «golf-scorecard») und gibt den vollständigen Stand zurück.
   Das Passwort steht nur in der Netlify-Umgebungsvariable GOLF_PASSWORD, nie im Code. */
import { getStore } from '@netlify/blobs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mergeDb, emptyDb } from '../lib/merge.mjs';

const KEY = 'db';
const MAX_BODY = 6 * 1024 * 1024;
const reply = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});
const sha = s => createHash('sha256').update(String(s)).digest();

function checkPassword(req) {
  const pw = process.env.GOLF_PASSWORD || '';
  if (pw.length < 6) return 'missing';
  const h = req.headers.get('authorization') || '';
  const given = h.startsWith('Bearer ') ? h.slice(7) : '';
  return timingSafeEqual(sha(given), sha(pw)) ? 'ok' : 'wrong';
}

export default async (req) => {
  if (req.method !== 'POST') return reply({ error: 'method' }, 405);
  const auth = checkPassword(req);
  if (auth === 'missing') return reply({ error: 'not_configured' }, 503);
  if (auth === 'wrong') { await new Promise(r => setTimeout(r, 400)); return reply({ error: 'unauthorized' }, 401); }

  const text = await req.text();
  if (text.length > MAX_BODY) return reply({ error: 'too_large' }, 413);
  let body; try { body = JSON.parse(text || '{}'); } catch { return reply({ error: 'bad_json' }, 400); }

  const store = getStore({ name: 'golf-scorecard', consistency: 'strong' });
  // Nur lesen: aus den Tageskopien den Bag jedes Profils zurückgeben, damit verlorene Schlägerwerte wiederhergestellt werden können
  if (body.action === 'bags') {
    const { blobs } = await store.list({ prefix: 'backup/' });
    const keys = blobs.map(b => b.key).filter(k => /^backup\/\d{4}-\d{2}-\d{2}$/.test(k)).sort().reverse().slice(0, 60);
    const days = [];
    for (const key of keys) {
      let db = null; try { db = await store.get(key, { type: 'json' }); } catch {}
      if (!db || !db.profiles) continue;
      const profiles = {};
      for (const [id, p] of Object.entries(db.profiles)) if (p && p.bag) profiles[id] = { name: p.name, bag: p.bag };
      days.push({ day: key.slice(7), profiles });
    }
    return reply({ ok: true, days });
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = await store.getWithMetadata(KEY, { type: 'json' });
    const base = (cur && cur.data) || emptyDb();
    const merged = mergeDb(base, body.changes || {});
    const { serverAt: _a, ...b1 } = base; const { serverAt: _b, ...m1 } = merged;
    if (cur && JSON.stringify(b1) === JSON.stringify(m1)) return reply({ ok: true, db: base });
    merged.serverAt = Date.now();
    // Nur schreiben, wenn seit dem Lesen niemand anders geschrieben hat. Sonst neu lesen und nochmals zusammenführen.
    const res = cur ? await store.setJSON(KEY, merged, { onlyIfMatch: cur.etag })
                    : await store.setJSON(KEY, merged, { onlyIfNew: true });
    if (res.modified) {
      const day = new Date().toISOString().slice(0, 10);
      try { await store.setJSON('backup/' + day, merged); } catch {}   // Tageskopie: letzter Stand jedes Tages
      return reply({ ok: true, db: merged });
    }
    await new Promise(r => setTimeout(r, 80 + Math.random() * 200));
  }
  return reply({ error: 'busy' }, 409);
};

export const config = { path: '/api/sync' };
