# Golf Scorecard

Persönliche Golf-Scorekarte als Webseite. Läuft im Browser, auf dem Handy auch als App vom Startbildschirm und ohne Empfang.

- `index.html`: die ganze App (HTML, CSS, JavaScript, Lochbilder)
- `sw.js`: Offline-Speicher, damit die App auf dem Platz ohne Internet startet
- `netlify/functions/sync.mjs`: Online-Sicherung unter `/api/sync`, speichert in Netlify Blobs
- `netlify/lib/merge.mjs`: Regeln zum Zusammenführen (neuerer Stand gewinnt, Gelöschtes bleibt gelöscht)
- `package.json`: braucht nur `@netlify/blobs`
- `manifest.webmanifest`, `icon-*.png`, `apple-touch-icon.png`: Name und Symbol für den Startbildschirm
- `netlify.toml`: Einstellungen für Netlify (kein Build-Befehl, Funktionen, Seite nicht in Suchmaschinen)

## Online-Sicherung einrichten
In Netlify unter Project configuration → Environment variables die Variable `GOLF_PASSWORD` setzen (mindestens 6 Zeichen). Dieses Passwort geben alle Spieler einmal in der App ein.

## Datenschutz
Die App verbindet sich nur mit ihrer eigenen Adresse (Content-Security-Policy). Runden werden sofort im Browser gespeichert (localStorage) und zusätzlich im eigenen Netlify-Konto gesichert. Gäste und Übungsrunden bleiben auf dem Handy. Pro Tag legt der Server eine Kopie unter `backup/JJJJ-MM-TT` ab.

Lochbilder 18 und 9 Loch: Strokesaver 2026 von migrosgolf.ch, 6 Loch: Platzplan der Scorekarte 2026. Nur für den privaten Gebrauch.
