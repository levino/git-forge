# git-forge

Serverlose Git-Forge mit föderierten Sicherungskopien. Konzept und
Entscheidungen in `KONZEPT.md` — vor Änderungen an Architektur oder Formaten
dort nachlesen und es mitpflegen.

## Regeln

- **Eine Sprache:** TypeScript. Nur Web-Standard-APIs (`fetch`, Streams,
  WebCrypto, `DecompressionStream`); kein WebAssembly, keine `node:*`-Importe im
  Kern.
- **Kern-Logik als pure Funktionen**; HTTP-, UI- und Sync-Schichten rufen
  dieselben Funktionen, keine doppelte Rechte-Logik.
- **Anbieter nur über Adapter** (Speicher, Datenbank, Zeitsteuerung, E-Mail).
  Der Kern kennt keine Cloudflare-Typen.
- **Datenbank: nur SQLite-SQL**, damit D1, Durable Objects, libSQL und eine
  SQLite-Datei gleichermaßen funktionieren.
- **Nichts ganz im Speicher:** Packs und LFS-Objekte werden gestreamt.
- **Rechte immer aus dem geprüften Token bzw. der Sitzung**, nie aus Angaben des
  Clients.
- **Formate sind dauerhaft:** Bucket-Layout und Protokoll-Einträge nur
  rückwärtskompatibel ändern.
- **Kompatibilität mit echtem `git` und `git-lfs`** wird mit den echten Clients
  getestet, nicht nur mit eigenen Mocks.
- **Keine Secrets committen.**
- Dokumentation auf Deutsch.
- **Keine Code-Kommentare.** Erläuterungen gehören in `KONZEPT.md` bzw. die
  README des Pakets.
- **Alles direkt auf `main`.** Vor jedem Push grün: `pnpm run typecheck` und
  `pnpm test` im Root.
- **Speicher ist nur fortschreibend:** Das `Storage`-Interface kennt kein
  Löschen.
