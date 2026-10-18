# Serverlose Git-Forge mit Sicherungskopien — Konzept

Arbeitstitel. Stand: 18.10.2026. Entwurf zur Diskussion, noch kein Code.

## 1. Ziel

Eine schlanke, serverlose Git-Forge mit eingebautem LFS und einer Bedienung
nach dem Vorbild von GitHub. Jede Instanz kann von anderen Instanzen gesichert
werden: Wer ein Repo für schützenswert hält, startet dieselbe Software als
Sicherungs-Instanz, mit eigenem Speicher und eigenen Nutzern. Das ist eine
leichte Form der Föderation: kein gemeinsamer Admin, keine gemeinsame Datenbank,
nur ein signiertes Protokoll, dem man folgt.

Erster Anwendungsfall: das digitale Dorfarchiv Rössing (Texte, Content
Collections, Fotos, Scans, Videos; ~100 GB auf absehbare Zeit). Die Forge selbst
ist aber nicht archivspezifisch.

**Ziele**

- `git push` / `git clone` / `git lfs` mit Standard-Clients über HTTPS.
- Anmeldung über die Dorf-ID (ZITADEL); Apps als Maschinen-Konten; Notzugang
  ohne Identitätsanbieter.
- Rechte pro Repo und pro Zugriffsebene (öffentlich / Mitglieder / vertraulich).
- Vorschläge prüfen und übernehmen (einfache PRs, nur konfliktfreier Merge).
- Weboberfläche zum Ansehen, Formulare zum Einreichen ohne Git.
- Jede Kopie ist ein Bucket (oder ein Ordner auf Pi/NAS), aus dem ein normales
  `git clone` funktioniert — auch ohne diese Software.
- Kopien in fremder Hand, die nur fortschreiben und sich gegenseitig prüfen.

**Nicht-Ziele**

Issues, Wiki, CI/Actions, Paketregister, SSH-Zugang, Föderation, Forks über
Instanzgrenzen.

## 1a. Funktionsumfang

**Muss (erste Version)**

- **Repos:** `git push`/`clone` über HTTPS, Git LFS; Dateibaum, Commits, Diffs,
  Markdown-Darstellung.
- **LFS im Browser:** Vorschau von Bildern, Videos, Audio und PDFs direkt aus dem
  Bucket, Download.
- **Issues:** anlegen, kommentieren, Labels, Zuständige, schließen/wieder öffnen,
  Verweise (`#12`), Anhänge.
- **Pull Requests:** aus einem Branch anlegen, Diff ansehen, Kommentare (allgemein
  und an Zeilen), Reviews (zustimmen / Änderungen erbitten), übernehmen (Merge,
  Squash oder Rebase — nur konfliktfrei), schließen.
- **Discussions:** getrennt von Issues; Kategorien, Threads, Antwort als Lösung
  markieren.
- **Zugriffsmanagement:** Anmeldung per OIDC (ZITADEL), Organisationen und Teams,
  Rollen pro Repo (lesen, triage, schreiben, verwalten, admin), öffentliche und
  private Repos, persönliche Tokens, Apps als Maschinen-Konten mit begrenzten
  Rechten, Notzugang.
- **Sicherungen:** Protokoll, Sicherungs-Betriebsart, Kopien-Übersicht.

**Sollte (bald danach)**

- Branch-Schutz (kein Force-Push, Review-Pflicht).
- Benachrichtigungen und E-Mail, Webhooks.
- Reaktionen, Suche in Issues und Discussions.
- Dateien im Browser bearbeiten und hochladen (Commit per Formular).
- Releases.

**Später / vielleicht**

- Actions (über Compute-Adapter), Pages.
- Teil-Sichtbarkeit innerhalb eines Repos (Ebenen, abgeleitete Sichten).

**Nicht vorgesehen**

Codespaces, Copilot, Code-Suche, Packages, Projects, Sicherheitsscans, SSH.

## 2. Grundsätze

1. **Lesen braucht keinen Server.** Git über „dumb HTTP“ und LFS-Objekte unter
   ihrem Hash sind statische Dateien.
2. **Die Daten überleben die Software.** Fällt der Code weg, bleiben klonbare
   Git-Repos, ein LFS-Ordner und ein signiertes Protokoll im JSON-Format.
3. **Nur anhängen.** Kein Knoten löscht automatisch. Force-Pushes werden
   archiviert, nicht übernommen-und-vergessen.
4. **Vertrauen über Signaturen und Nachrechnen, nicht über Behauptungen.**
5. **Eine Sprache:** TypeScript, nur Web-Standard-APIs (`fetch`, Streams,
   `DecompressionStream`, WebCrypto). Kein WebAssembly.
6. **Plattformen austauschbar.** Speicher und Zeitsteuerung sind Adapter.
7. **Rechte immer aus dem geprüften Token**, nie aus Angaben des Clients.
8. **Kern-Logik als pure Funktionen**; HTTP-, UI- und Sync-Schichten rufen
   dieselben Funktionen.

## 3. Zwei Betriebsarten, eine Software

| | **Forge** | **Sicherung** |
|---|---|---|
| Zweck | Arbeiten: pushen, PRs, Einreichen, Weboberfläche | Repos anderer Instanzen sichern und lesbar halten |
| Schreiben | ja (Push, Merge, Formulare) | nein — nur Abgleich von der Quelle |
| Weboberfläche | voll | nur lesen (Dateien, Verlauf, Kopien-Status) |
| Eigene Nutzer | ja (eigener OIDC-Anbieter) | ja (eigener OIDC-Anbieter), regelt Lesezugriff auf die Sicherung |
| Läuft auf | Cloudflare Worker + Bucket | Worker / Deno / Bunny + Bucket, oder Pi/NAS (Bun-Binary) |

Dazu die Querschnittsrolle **Prüfer**: Jede Instanz kann fremde Kopien von außen
prüfen und signierte Ergebnisse veröffentlichen.

Beide Betriebsarten sind derselbe Code mit einem Schalter. Eine Sicherung kann
deshalb im Notfall zur Forge **befördert** werden (siehe 3a).

## 3a. Instanzen und Föderation

- **Jede Instanz ist souverän:** eigener Bucket, eigener Identitätsanbieter,
  eigene Nutzer und Rechte, eigener Instanz-Schlüssel. Keine Instanz kann einer
  anderen etwas befehlen.
- **Eine Sicherung folgt einem Repo einer Quell-Instanz.** Sie liest dessen
  signiertes Protokoll und die Daten — von der Quelle oder von anderen
  Sicherungen desselben Repos.
- **Zugang der Sicherung zur Quelle:**
  - öffentliche Repos: keiner nötig;
  - private Repos, verschlüsselt gesichert: keiner nötig (Quelle veröffentlicht
    das Chiffrat);
  - private Repos im Klartext: die Quelle registriert die Sicherung als **App**
    (Maschinen-Konto mit Leserecht auf bestimmte Repos), jederzeit widerrufbar.
- **Nutzer der Sicherung sind unabhängig von der Quelle.** Wer in der Sicherung
  lesen darf, entscheidet deren Betreiber. Fällt die Quelle samt ihrem
  Identitätsanbieter weg, bleibt die Sicherung mit ihren eigenen Nutzern
  benutzbar.
- **Beförderung:** Fällt die Quelle dauerhaft aus, schaltet der Betreiber einer
  Sicherung auf „Forge“ um. Das Protokoll wird mit dem eigenen Schlüssel
  fortgesetzt (Eintrag `schluessel`, Übergabe telefonisch bestätigt), andere
  Sicherungen folgen nach Bestätigung der neuen Quelle.
- **Kopien-Übersicht:** Jede Instanz zeigt für ihre Repos, welche Sicherungen
  es gibt, bei welchen Anbietern und wann sie zuletzt geprüft wurden.

## 3b. Funktionen und Bausteine

Fast alles läuft serverlos; echte Rechner braucht nur, was fremden Code
ausführt (CI, Entwicklungsumgebungen) — die werden bei Bedarf per API gestartet.

| Funktion | Baustein |
|---|---|
| Git, Dateien, Diffs, Blame | Worker + Bucket, teure Ergebnisse zwischenspeichern |
| LFS | Worker signiert, Client lädt direkt in den Bucket |
| Issues, PRs, Kommentare, Reviews, Labels | Durable Object pro Repo mit SQLite (oder D1) |
| Nutzer, Organisationen, Teams, Apps | OIDC-Anbieter + DB |
| Benachrichtigungen, Webhooks, E-Mail | Queues, Cron, E-Mail-Dienst |
| Live-Updates | Durable Objects mit WebSockets |
| Suche in Issues | SQLite FTS5 |
| Releases, Pages | Bucket + CDN |
| CI | Compute-Adapter (Cloudflare Containers, Fly Machines, Hetzner Cloud, …), Ausführung z. B. mit `act` |

**Protokoll als Wahrheit, Datenbank als Index.** Alles Erhaltenswerte —
auch Issues, Kommentare, PR-Diskussionen und Reviews — wird als Eintrag ins
signierte Protokoll geschrieben. Die Datenbank der Forge ist nur ein schneller
Index darüber und lässt sich aus dem Protokoll neu aufbauen. Sicherungen
bekommen so auch Issues und PRs mit, ohne von Cloudflare abzuhängen.

## 4. Bucket-Format

```
<repo>/
  git/                              # klonbar per dumb HTTP
    HEAD
    info/refs
    objects/info/packs
    objects/pack/pack-<sha>.pack
    objects/pack/pack-<sha>.idx
  log/
    000000000001.json               # signierte Einträge, fortlaufend
    000000000002.json
    ...
    head.json                       # letzter Eintrag (nur Komfort, per CAS)
  lfs/
    objects/<oid[0:2]>/<oid[2:4]>/<oid>
    chunks/<oid>.json               # SHA-256 je 4-MiB-Block (für Stichproben)
  views/
    oeffentlich/git/...             # abgeleitete Sicht, eigener Verlauf
  enc/                              # verschlüsselte Vollkopie (age), optional
  keys.json                         # öffentliche Schlüssel der Herausgeber
  README.txt                        # Klartext: was ist das, wie liest man es
```

- Packs werden nie gelöscht. Kompaktierung schreibt ein neues, größeres Pack
  und nimmt die alten erst nach Ablauf einer Frist aus `objects/info/packs`.
- Archivierte Stände nach Force-Push: `refs/archiv/<zeit>/<branch>`.
- Git-Objektformat bleibt SHA-1 (Kompatibilität). Signaturen und LFS nutzen
  SHA-256.

## 5. Protokoll (Log-Einträge)

Jede Datei in `log/` ist ein Eintrag:

```json
{
  "seq": 42,
  "prev": "sha256:…",            
  "zeit": "2026-10-18T12:00:00Z",
  "typ": "refs",                 
  "daten": { … },
  "signatur": { "schluessel": "ed25519:…", "wert": "…" }
}
```

`prev` ist der Hash des vorigen Eintrags → Hash-Kette, Lücken und Fälschungen
fallen auf.

| `typ` | `daten` |
|---|---|
| `refs` | Ref-Änderungen `{ref, alt, neu}`, optional Push-Zertifikat des Pushenden |
| `pack` | neues Pack `{name, groesse, sha256}` |
| `lfs` | neue LFS-Objekte `[{oid, groesse}]` |
| `sicht` | neuer Stand einer abgeleiteten Sicht |
| `sperre` | Objekt/Pfad nicht mehr ausliefern (Grund, Frist) |
| `schluessel` | Herausgeber-Schlüssel hinzufügen/entfernen (zusätzlich telefonisch bestätigt) |
| `kopie` | Kopie an-/abmelden `{id, url, betreiber, schluessel}` |

Signiert vom Forge-Schlüssel; bei `refs` zusätzlich das Push-Zertifikat
(`git push --signed`), damit auch die Forge eine Ref-Änderung nicht fälschen kann.

## 6. Abläufe

**Push** — `receive-pack` über Smart HTTP. Pack direkt in den Bucket streamen,
indizieren (dünne Packs vervollständigen), Vorwärts-Prüfung bzw. Force-Push-Regel,
Refs per bedingtem Schreiben (CAS) umsetzen, Log-Einträge `pack` + `refs`
anhängen, `report-status`. Obergrenze pro Push (z. B. 50 MB, Rest gehört in LFS).

**Fetch** — öffentlich: dumb HTTP direkt aus dem Bucket/CDN. Privat:
`upload-pack` (Smart HTTP v2) oder dumb HTTP hinter einem prüfenden Worker.

**LFS** — Batch API; Antwort mit vorsignierten URLs, Client lädt direkt in den
Bucket. Nach Upload: Größe/Hash prüfen, Log-Eintrag `lfs`, Block-Hashes erzeugen.

**Force-Push** — erlaubt nur mit Recht `force` am Branch; alter Stand wird
archiviert. Kopien übernehmen den neuen Stand nur, wenn der Eintrag gültig
signiert ist, sonst einfrieren und melden.

**Sichten** — nach jedem Push deterministisch neu berechnen (gleicher Eingang →
gleiche Commit-Hashes), Commit-Nachrichten mitfiltern. Standard-Ebene ist
„vertraulich“.

**Einreichen per Formular** — Server erzeugt Blob, Tree, Commit auf einem
Vorschlags-Branch.

**Vorschlag übernehmen** — nur Fast-Forward oder konfliktfreies Rebase/Merge;
bei Konflikt ablehnen.

## 7. Identität und Rechte

**Eingebaut:** Nutzer, Organisationen, Teams, Mitgliedschaften, Rollen,
Tokens, Apps und Verlauf liegen in der eigenen Datenbank der Instanz. Eine neue
Instanz funktioniert ohne externen Identitätsanbieter.

**Anmeldeverfahren (austauschbar, mehrere gleichzeitig):**

| Verfahren | Wann |
|---|---|
| Passkeys (WebAuthn) | Standard, eingebaut, kostet nichts |
| E-Mail-Link | wenn ein Mail-Dienst angebunden ist |
| OIDC (ZITADEL, Keycloak, Authentik, Pocket ID, Google, …) | Anbindung an bestehende Identitäten, Gruppen → Teams optional |
| Cloudflare Access (JWT) | wenn die Instanz ohnehin hinter Access läuft |
| SAML, SCIM | später, für Organisationen, die es verlangen |

Git über HTTPS nutzt immer Tokens aus der eigenen Datenbank (persönliche Tokens,
App-Tokens); für die Kommandozeile zusätzlich ein Gerätefluss wie bei
`gh auth login`.

Für das Dorfarchiv:

- **Menschen:** OIDC mit ZITADEL (Dorf-ID). Rollen aus dem Projekt pro Repo,
  z. B. `lesen`, `schreiben`, `verwalten`, `force`, Ebene `mitglieder`.
- **Apps / Maschinen:** ZITADEL-Maschinen-Nutzer (JWT-Profil mit Schlüsselpaar),
  kurzlebige Tokens, Prüfung per JWKS. Kopien, Automationen, Importe.
- **Git über HTTPS:** Token als HTTP-Basic-Passwort (persönliche Tokens oder
  Maschinen-Token).
- **Notzugang:** Offline-Admin-Schlüssel (Ed25519), öffentlicher Teil in der
  Konfiguration, privater Teil nach Shamir aufgeteilt (z. B. 2 von 3).
  Funktioniert ohne ZITADEL.
- Kopien von öffentlichen und verschlüsselten Daten brauchen **keine**
  Zugangsdaten.

## 8. Kopien

Ablauf je Durchlauf (zustandslos, darf jederzeit abbrechen):

1. Log von einer bekannten Quelle lesen (Forge, andere Kopien), Kette und
   Signaturen prüfen.
2. Soll (Log) gegen Ist (eigener Bucket) vergleichen.
3. Fehlendes streamen — von irgendeiner Quelle — und mit Prüfsumme hochladen
   (`Content-MD5` / `x-amz-checksum-sha256`), so weit das Budget reicht.
4. Stichprobe prüfen; Log-Kopie und `status.json` schreiben.

Speicher-Adapter: S3-kompatibel (R2, B2, Hetzner, OVH, Bunny) oder Dateisystem.
Zeitsteuerung: Cron Trigger, `Deno.cron`, systemd-Timer, oder von außen per HTTP
angestoßen.

## 9. Prüfung und Kopien-Übersicht

- Öffentliche Daten: Prüfer liest direkt aus dem Bucket der Kopie (Range-Requests
  auf zufällige Blöcke) und vergleicht mit den Block-Hashes.
- Verschlüsselte Daten: dasselbe auf dem Chiffrat.
- Ergebnisse signiert veröffentlichen; Übersicht: Anzahl Kopien, bekannte
  Betreiber, Anbieter, letzte Prüfung.
- Grenzen: Weiterleitungs-Kopien und Sybil-Kopien lassen sich nicht ganz
  ausschließen → nur bestätigte Kopien bei verschiedenen Anbietern bzw. bekannter
  Hand voll zählen.

## 10. Speicher-Abstraktion

Benötigte Operationen: `get` (auch Range), `head`, `put` (Streaming, mit
Prüfsumme), `put` mit `If-None-Match` / `If-Match`, `list` mit Präfix.
Bedingtes Schreiben ist die einzige Koordination (Refs, Log-Kopf). Auf
Cloudflare optional zusätzlich ein Durable Object als Sperre.

## 10a. Anbieter-Adapter

Jeder Baustein ist ein Interface; Cloudflare ist die erste Umsetzung, weitere
Anbieter kommen als Beiträge dazu.

| Baustein | Cloudflare | Andere |
|---|---|---|
| Funktionen | Workers | Bunny Edge Scripting, Deno Deploy, Lambda, Node/Bun selbst gehostet |
| Objektspeicher | R2 | jedes S3: Hetzner, B2, OVH, IONOS, Garage/MinIO selbst gehostet |
| Datenbank | D1 / SQLite in Durable Objects | libSQL/Turso, SQLite-Datei (Pi), weitere SQLite-Dialekte |
| Konsistenz pro Repo | Durable Object | bedingtes Schreiben (S3 CAS), Deno KV atomic, Single-Writer-Prozess |
| Live-Updates | Durable Objects + WebSockets | Polling als Rückfall |
| Zeitsteuerung, Jobs | Cron Trigger, Queues | `Deno.cron`, systemd-Timer, Job-Tabelle |
| E-Mail | Mail-Dienst über API | SMTP |
| Compute für CI (später) | Containers | Fly Machines, Hetzner Cloud, … |

**SQLite als gemeinsame Sprache:** Die Datenbank-Schicht schreibt nur SQLite-SQL.
Das läuft auf D1, in Durable Objects, auf libSQL und als Datei auf dem Pi.

**Die schwierigste Stelle ist der Ersatz für Durable Objects** (starke
Konsistenz pro Repo). Der Kern verlässt sich deshalb nur auf „ein Schreiber pro
Repo“ über bedingtes Schreiben; Durable Objects sind eine Beschleunigung, keine
Voraussetzung.

## 11. Infrastruktur und Kosten (100 GB)

| Posten | ca. pro Monat |
|---|---|
| Forge: Cloudflare Workers (bezahlt) | 5 $ |
| Forge: R2, 90 GB über Freikontingent | 1,35 $ |
| Kopie: Backblaze B2 | 0,70 $ |
| Kopie: Hetzner Object Storage (Kulturkreis) | 4,99 € |
| CDN: Bunny | ~1 $ |
| Rechenleistung der Kopien (kostenlose Pläne) | 0 € |
| Pi mit 1-TB-SSD | einmalig ~150 € |
| **Summe** | **~13–15 €** |

## 12. Schritte

1. Git-Kern: `receive-pack`, `upload-pack`, dumb HTTP gegen R2; Tests mit echtem
   `git`.
2. LFS Batch API; Tests mit echtem `git-lfs`.
3. ZITADEL, Maschinen-Konten, Rechte, Notzugang.
4. Log, Bucket-Format, erste Kopie (B2), Prüfung.
5. Weboberfläche zum Ansehen, Kopien-Übersicht.
6. Einreichen per Formular.
7. Vorschläge mit konfliktfreiem Merge.
8. Sichten und Ebenen, verschlüsselte Vollkopie, Sperr-Einträge.

Nach Schritt 4 ist das System nutzbar (Push per Git, Kopien laufen).

## 13. Offene Fragen

- Bedingtes Schreiben bei B2, Hetzner, Bunny — unterstützt?
- Push-Zertifikate: Pflicht oder optional? (Erschwert Pushen für Gelegenheitsnutzer.)
- Kompaktierung für dumb HTTP: Häufigkeit, Frist für alte Packs.
- Sperr-Einträge: wer darf sie signieren, was gilt rechtlich nach Widerruf?
- Name und Lizenz (MIT oder AGPL).
- Wie viel aus git-on-cloudflare (MIT) und isomorphic-git (MIT) übernehmen?

## 14. Vorarbeiten

**Entscheidungen aus der Recherche (18.10.2026)**

- **Log-Format nach C2SP tlog-tiles:** nur statische Dateien (signierter
  Checkpoint, unveränderliche Tiles und Einträge), Merkle-Baum, optional
  Cosignaturen fremder Instanzen als „Zeugen“. Ersetzt die einfache Hash-Kette.
- **Ref-Prüfsumme nach GitHub Spokes:** XOR über `hash(refname, wert)` aller Refs
  in jedem Eintrag — billiger Vergleich, ob eine Kopie denselben Stand hat.
  Sicherungen sind nicht stimmberechtigt, es gibt genau einen Schreiber pro Repo.
- **Issues, PRs, Reviews als signierte Ereignisse in Git-Refs** (wie
  `refs/hub/**` in chr33s/git) prüfen — dann sichert das Git-Protokoll sie mit.
- **Divergierte Branches nie automatisch zusammenführen**, nur melden.
- **LFS:** Presigned URLs, aber mit Verify-Schritt (SHA-256 prüfen, bevor das
  Objekt als vorhanden gilt); Push ablehnen, wenn referenzierte LFS-Objekte
  fehlen. Testen, ob Presigned PUT an Länge/Prüfsumme gebunden werden kann.
- **Packs nie ganz im Speicher;** zlib-Inflate mit exakten Stream-Grenzen
  (`DecompressionStream` reicht dafür nicht).
- **Nicht:** Git-Objekte in DO-SQLite, ein Bundle pro Ref, Konsens/3PC,
  LFS-Bytes durch den Worker.

**Projekte und Quellen**

- git-on-cloudflare (TS, MIT) — Smart HTTP v2 auf Workers, gestreamter Push,
  eigener Pack-Indexer mit Thin-Pack-Auflösung, Fetch per R2-Range-Reads
  (https://github.com/zllovesuki/git-on-cloudflare)
- chr33s/git (TS auf Effect v4 rc, MIT, Pre-1.0) — Kern für DO/Node/Browser,
  Merge und Diff byte-identisch zu Git, PRs/Reviews als signierte Event-DAGs,
  Replikationsregeln (https://github.com/chr33s/git)
- Cloudflare Artifacts (Beta) — Git-Speicher für Agenten, keine Forge, kein LFS
- git-remote-s3 (awslabs) — CAS-Lock auf S3 mit `If-None-Match`
- git-lfs-s3-proxy (CC0) — Gerüst für Batch API mit Presigned URLs
- GitHub Spokes, GitLab Gitaly/Praefect/Workhorse — Konzepte, kein Code
- C2SP tlog-tiles (https://github.com/C2SP/C2SP/blob/main/tlog-tiles.md)
- isomorphic-git — Pack-Index, Merge in JavaScript
- go-git v6 — `receive_pack.go` als Referenz für Server-Abläufe und Hooks
- Git-Doku: pack-protocol, http-protocol, protocol-v2; Tests t5550/t5551/t5541
- git-lfs — Batch-API-Spezifikation und Integrationstests
- Radicle — signierte Refs pro Teilnehmer
- LOCKSS — Prinzip: viele Kopien, Prüfung, Reparatur
