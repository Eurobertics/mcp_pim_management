[![M8ven Score](https://m8ven.ai/badge/mcp/eurobertics-mcp-pim-management-1gfg7v)](https://m8ven.ai/mcp/eurobertics-mcp-pim-management-1gfg7v)
[![M8ven Score](https://m8ven.ai/badge/mcp/eurobertics-mcp-rpg-worldstate-13auk3)](https://m8ven.ai/mcp/eurobertics-mcp-rpg-worldstate-13auk3)

# PIM Management MCP

Lokaler TypeScript-MCP-Server für mehrere IMAP-Postfächer und ausgewählte CalDAV-Kalender. Transport: stdio. Mailabrufe erhalten den Gelesen-Status; Aussortieren und Wiederherstellen werden dauerhaft in SQLite protokolliert. Kalenderzugriff ausschließlich lesend. Keine SMTP-Funktion, endgültige Löschung, Ordnerleerung, Scheduler oder Benutzeroberfläche.

## Installation

Voraussetzung: Node.js **24 oder neuer**, npm und ein Dateisystem mit Unterstützung für Unix-Dateirechte. Die folgenden Befehle eignen sich für Linux, macOS und WSL. Im Projektverzeichnis:

```bash
npm ci
npm run build
npm test
```

`npm start` startet den Server. Ohne MCP-Client wartet er auf JSON-RPC über stdin; stdout ist ausschließlich für MCP reserviert. Diagnosen werden ohne Zugangsdaten an stderr ausgegeben.

## Konfiguration

Konfiguration mit Geheimnissen **außerhalb dieses Repositorys** ablegen, beispielsweise:

```bash
mkdir -p ~/.config/pim-management ~/.local/state/pim-management
chmod 700 ~/.config/pim-management ~/.local/state/pim-management
install -m 600 config.example.json ~/.config/pim-management/config.json
```

Die kopierte Datei bearbeiten und alle Platzhalter ersetzen. `PIM_CONFIG` ist ein absoluter Dateipfad; `~` wird innerhalb von JSON nicht expandiert. `statePath` ebenfalls absolut angeben. Die Datei darf keine Gruppen-/Fremdrechte haben (`chmod 600`). Unter WSL muss sie auf dem Linux-Dateisystem liegen, damit Unix-Dateirechte greifen.

```bash
export PIM_CONFIG="$HOME/.config/pim-management/config.json"
npm start
```

- `mail`: pro Postfach eine eindeutige `id`, IMAP-Host, Port (Standard 993), Benutzername, Passwort und optionaler `quarantineFolder` (Standard `PIM – Aussortiert`). Ausschließlich implizites TLS mit Zertifikatsprüfung.
- `calendars`: pro ausgewähltem Kalender eine eindeutige `id`, **direkte CalDAV-Kalender-URL** sowie Benutzername und Passwort beziehungsweise App-Passwort. Mehrere Einträge können dieselben Zugangsdaten verwenden. Keine öffentliche ICS-Freigabe-URL und keine allgemeine DAV-Root-URL. Nicht eingetragene Kalender werden nicht abgefragt. Es gibt keine automatische Kalendererkennung.
- `displayTimezone`: Standard `Europe/Berlin`. Zeitpunkte werden zusätzlich in dieser Zone dargestellt. Floating-Kalenderzeiten ohne TZID werden in dieser Zone interpretiert.
- `statePath`: dauerhaftes SQLite-Aktionsjournal. Es enthält Referenzen und Begründungen, keine Mailtexte oder Passwörter. Nicht löschen, solange Wiederherstellung oder Schutz vor Wiederholungen benötigt wird. Nur im gestoppten Zustand zusammen mit der Konfiguration sichern; bei Wiederherstellung älterer Backups können neuere Aktionen fehlen.
- Leere `mail`-/`calendars`-Listen sind für einen Offline-Start möglich. Status meldet nur die Konfiguration, keine erfolgreiche Quellenprüfung.

TLS wird für IMAP und HTTPS geprüft; HTTP und Redirects sind für CalDAV gesperrt. Bei eigener CA den üblichen Node-Vertrauensspeicher über `NODE_EXTRA_CA_CERTS` ergänzen. Keine Zertifikatsprüfung abschalten. Serverfehler werden bewusst ohne rohe Servermeldungen ausgegeben.

## MCP und Skill einbinden

In einem MCP-Host mit **lokalem stdio-Support** entspricht die Serverdefinition diesem Muster (Format hostabhängig):

```json
{
  "mcpServers": {
    "pim-management": {
      "command": "/ABSOLUTER/PFAD/ZU/node",
      "args": ["/home/DEIN_BENUTZER/projects/mcp_pim_management/dist/index.js"],
      "env": {
        "PIM_CONFIG": "/home/DEIN_BENUTZER/.config/pim-management/config.json"
      }
    }
  }
}
```

Für einen Windows-Host mit stdio-Prozessunterstützung kann der Start über WSL erfolgen:

```json
{
  "command": "wsl.exe",
  "args": [
    "--distribution", "DEINE_DISTRIBUTION",
    "--exec", "env",
    "PIM_CONFIG=/home/DEIN_BENUTZER/.config/pim-management/config.json",
    "/ABSOLUTER/WSL/PFAD/ZU/node",
    "/home/DEIN_BENUTZER/projects/mcp_pim_management/dist/index.js"
  ]
}
```

`command -v node` liefert den Node-Pfad. Ein Versionsmanager wird bei einem solchen Start nicht automatisch initialisiert. Diese Beispiele beschreiben den stdio-Prozessstart, keine verifizierte Einrichtung einer bestimmten Desktop-App. Ob der gewünschte Host lokalen stdio-Zugriff und Skills unterstützt, bleibt ein Integrationspunkt.

Den vollständigen Ordner [`skills/pim-management`](skills/pim-management/SKILL.md) in das Skill-Verzeichnis des Zielhosts kopieren oder dessen Skill-Import nutzen. Unterstützt der Host keine Skills, können die Anweisungen samt Referenzdateien als ausdrücklich hinterlegte Projektanweisungen eingebunden werden; automatische Skill-Erkennung ist dann nicht gegeben. Die Datei [`personal-rules.md`](skills/pim-management/references/personal-rules.md) in der installierten Kopie unabhängig editieren. Beispiele enthalten keine persönlichen Absenderregeln. Toolnamen können vom Host mit einem Serverpräfix versehen werden.

Intervallausführung und Desktop-Benachrichtigungen sind bewusst nicht implementiert und müssen bei Bedarf separat eingerichtet werden.

## Werkzeuge und Ergebnisvertrag

| Werkzeug | Wesentliche Parameter | Zweck |
| --- | --- | --- |
| `pim_status` | keine | Konfigurierte Quellen, Zeitzone, Grenzen; kein Verbindungstest |
| `mail_folders` | `account`, `limit?`, `cursor?` | Ordner auflisten |
| `mail_search` | `account`, `folder`, `from?`, `to?`, `readStatus?`, `limit?`, `cursor?` | Suche nach optionaler Empfangszeit/INTERNALDATE und Gelesen-Status, absteigende UID, Textauszüge |
| `mail_read` | `ref`, `offset?`, `maxChars?` | MIME-Text portionsweise, Anhangmetadaten |
| `mail_quarantine` | `ref`, `actionId`, `reason` | Eine Nachricht aussortieren |
| `pim_actions` | `actionId?` oder `offset?`, `limit?` | Einzelaktion oder Journal, neueste zuerst |
| `mail_restore` | `originalActionId`, `actionId`, `reason` | Erfolgreiche Aussortierung rückgängig machen |
| `calendar_events` | `calendar`, `from`, `to`, `limit?`, `cursor?` | Serientermine, Ausnahmen, Absagen und überlappende Termine |

`ref` enthält `account`, `folder`, `uidValidity` als Dezimalstring und `uid` als positive Zahl. Referenzen unverändert aus Such-/Aktionsergebnissen übernehmen. Bei geänderter UIDVALIDITY erneut suchen. `actionId` ist eine vom Aufrufer erzeugte UUID, `reason` ein sachlicher Text mit maximal 1000 Zeichen.

Ergebnisse stehen sowohl als MCP-`structuredContent` als auch als JSON-Text zur Verfügung. Erfolgreicher Werkzeugaufruf: `{ "ok": true, "data": ... }`. Abruffehler: MCP `isError: true` sowie `{ "ok": false, "complete": false, "error": { "code": ..., "message": ... } }`. Schemafehler liefert das MCP-SDK als Werkzeugfehler. Eine erfolgreich zurückgegebene Aktion kann `failed`, `pending` oder `uncertain` sein; `ok` allein beweist keine ausgeführte Verschiebung.

- Listen standardmäßig 25, maximal 100 Einträge. `nextCursor` bzw. `nextOffset` bis `null` verfolgen. `complete` bezeichnet die Fehlerfreiheit der Seite, nicht das Ende der Pagination. `errors` und `complete: false` melden Teilergebnisse.
- Mail-Zeiträume sind `[from,to)`, ISO-8601 mit Offset, maximal 93 Tage. `from` und `to` müssen gemeinsam gesetzt werden. Beide dürfen nur bei `readStatus: "unread"` entfallen; dann werden alle aktuell ungelesenen Nachrichten des Ordners paginiert durchsucht. Kalenderabfragen benötigen weiterhin einen Zeitraum.
- `mail_search.readStatus` akzeptiert `all` (Standard), `unread` oder `read`. `unread` sucht serverseitig nach Nachrichten ohne IMAP-Flag `\\Seen`; der Abruf selbst setzt dieses Flag nicht. Ohne Zeitangabe ist `unread` Pflicht.
- Mailseiten verwenden absteigende UIDs; neue Nachrichten während der Pagination erscheinen beim nächsten neuen Abruf. Gleichzeitige Löschungen/Verschiebungen sind kein transaktionaler Postfach-Snapshot. Empfangszeit und Absenderdatum werden getrennt geliefert.
- MIME-Limit 10 MiB pro Nachricht; größere Nachrichten bleiben als Treffer sichtbar, Textauszug fehlt und Prüfung gilt als unvollständig. `mail_read` liefert maximal 30000 Textzeichen pro Aufruf, Standard 12000. Inhalte werden nicht gerendert, externe Bilder/Links nicht geladen, Anhänge nicht ausgeführt oder als Bytes ausgegeben.
- Kalender: HTTPS-Antwort maximal 8 MiB, höchstens 500 Ressourcen. Serienauswertung je Ressource mit fünf Sekunden und 96 MiB Worker-Limit; zusätzlich ein Gesamtbudget von rund 30 Sekunden und 10000 Instanzen, bei Überschreitung explizite Teilergebnisse. Kalender-Cursor erkennen Änderungen am Abfrageergebnis und verlangen dann einen Neustart. Beschreibungen werden nach 12000 Zeichen mit Kennzeichnung gekürzt. `cancelled: true` bedeutet Absage; ganztägige Start-/Endwerte sind Datumsstrings, Ende exklusiv.
- Seltene `RECURRENCE-ID;RANGE=THISANDFUTURE`-Varianten, `RDATE;VALUE=PERIOD` und nicht von Intl erkannte TZIDs (etwa eigene VTIMEZONE-Namen) werden derzeit als unvollständig/Parserfehler gemeldet. Solche Daten werden nicht stillschweigend falsch dargestellt. Nicht erreichbare oder fehlerhafte Quellen müssen einzeln als fehlgeschlagen berichtet werden.

## Verschiebungen und Wiederherstellung

Der Server verlangt **MOVE und UIDPLUS**. Ein fehlender Aussortierordner wird bei Bedarf erstellt; bei Wiederherstellung muss der ursprüngliche Ordner existieren. Es gibt keinen COPY/DELETE/EXPUNGE-Fallback und kein pauschales EXPUNGE. Der Server setzt keine Seen-Flags; gelesen wird mit `EXAMINE`/Read-only-Lock und `BODY.PEEK`.

Vor dem MOVE wird die Aktion synchron und dauerhaft als `pending` gespeichert. Gleiche ID plus gleiche Parameter liefert das vorhandene Ergebnis. Eine zweite ID für dieselbe bereits bearbeitete Nachrichtenreferenz wird blockiert. Nach eindeutiger COPYUID-Zuordnung speichert das Journal `completed` und die neue Referenz. Auch Wiederherstellungen sind eigene protokollierte Aktionen.

Bei Verbindungsabbruch nach Beginn des MOVE oder fehlender UID-Zuordnung wird die Aktion `uncertain`. Nach abruptem Prozessende kann sie `pending` bleiben. **Beide Zustände werden nicht automatisch erneut ausgeführt.** Der tatsächliche Stand muss dann anhand von Postfach und Journal manuell geprüft werden. Diese erste Version bietet keine automatische Rekonstruktion oder Freigabe unklarer Aktionen; Message-ID allein wäre dafür kein eindeutiger Nachweis. `failed` bedeutet, dass der Server noch keinen MOVE aufgerufen hat; eine Ordneranlage kann bereits erfolgt sein.

Nach einer externen Verschiebung, Ordnerlöschung oder UIDVALIDITY-Änderung kann automatische Wiederherstellung scheitern. Das Journal ersetzt kein Mailbackup. Ein erneuter Aussortier-/Wiederherstellungszyklus ist mit den neu erhaltenen UIDs möglich.

## Entwicklung und Abnahme

```bash
npm run check
npm test
```

Die Tests verwenden MIME-/ICS-Fixtures, simuliertes IMAP/CalDAV und einen echten MCP-stdio-Client mit lokalem Serverprozess. Sie verwenden keine echten Zugangsdaten und verschieben keine echten Mails. Bekannte funktionale Grenzen und offene Integrationspunkte sind in den jeweiligen Abschnitten dieser README dokumentiert.

Bibliotheken: [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/), [ImapFlow](https://imapflow.com/docs/api/imapflow-client/), [MailParser](https://nodemailer.com/extras/mailparser), [node-ical](https://github.com/jens-maus/node-ical), fast-xml-parser und html-to-text. Exakte Versionen stehen in `package-lock.json`.
