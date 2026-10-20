# Golf Scorecard

Persönliche Golf-Scorekarte als einzelne Webseite. Läuft im Browser, auf dem Handy auch als App vom Startbildschirm und ohne Empfang.

- `index.html`: die ganze App (HTML, CSS, JavaScript, Lochbilder)
- `sw.js`: Offline-Speicher, damit die App auf dem Platz ohne Internet startet
- `manifest.webmanifest`, `icon-*.png`, `apple-touch-icon.png`: Name und Symbol für den Startbildschirm
- `netlify.toml`: Einstellungen für Netlify (kein Build, Seite nicht in Suchmaschinen)
- `robots.txt`: Suchmaschinen fernhalten

Datenschutz: Eine Content-Security-Policy sperrt alle Verbindungen zu fremden Seiten. Runden werden nur im Browser des Geräts gespeichert (localStorage). In diesem Repository liegen keine persönlichen Daten.

Lochbilder 18 und 9 Loch: Strokesaver 2026 von migrosgolf.ch, 6 Loch: Platzplan der Scorekarte 2026. Nur für den privaten Gebrauch.
