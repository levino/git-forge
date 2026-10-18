# git-forge

Serverlose Git-Forge mit eingebautem Git LFS und föderierten Sicherungskopien.

- Läuft ohne eigenen Server: Funktionen (zuerst Cloudflare Workers),
  S3-kompatibler Objektspeicher und eine SQLite-Datenbank.
- Bedienung nach dem Vorbild von GitHub: Repos, Issues, Pull Requests,
  Discussions, Organisationen und Teams, Apps als Maschinen-Konten.
- Jede Instanz kann von anderen gesichert werden: dieselbe Software in der
  Betriebsart „Sicherung“, mit eigenem Speicher und eigenen Nutzern. Jede Kopie
  bleibt auch ohne diese Software mit einem normalen `git clone` lesbar.

Stand: Konzeptphase. Siehe [KONZEPT.md](KONZEPT.md).
