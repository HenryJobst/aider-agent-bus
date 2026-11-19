# AiderDesk Agent Bus

[English](README.md) · [Deutsch](README.de.md)

Macht aus unabhängigen AiderDesk-Tasks ein abgestimmtes Multi-Agent-Team.

AiderDesk führt die Agenten aus und verwaltet Git-Worktrees. [agent-bus](https://github.com/MustaphaSteph/agent-bus)
besitzt Nachrichten, Threads und das Task-Board. Diese Extension ist die Schicht
dazwischen: sie legt die Tasks an, gibt jeder eine Bus-Identität und weckt
ruhende Worker, wenn Nachrichten eintreffen.

```
AiderDesk-Tasks ──▶ Extension ──▶ agent-bus (MCP-Tools für Agenten, CLI für die Extension)
      ▲                                        │
      └──────────── Aufwecken ◀────────────────┘
```

Keine neue Runtime, kein zweiter Message-Store: eine Integrationsschicht
zwischen zwei Systemen, die es schon gibt.

## Status

**v0.2 — nutzbar, nicht gehärtet.** Für die Abstimmung zwischen Sessions
funktional vollständig; mit rauen Kanten bei Merges und allem, was unten nicht
als verifiziert aufgeführt ist. Abgedeckt durch 105 Tests: Tasks mit Profil,
Identität und Worktree erzeugen, laufende Tasks adoptieren, Identitätszuordnung,
Inbox-Polling und Aufwecken, Team-Commands/-Tools, Dashboard, Config-/State-
Persistenz und ein Integrationstest gegen die echte CLI.

Live verifiziert: Extension-Laden, Command-Ausführung, Config-/State-Schreiben,
Registrierung der Agenten auf dem Bus, Panel-Refresh, Adoption inklusive
Worktree-Wechsel sowie ein Master, der Board-Tasks delegiert und Worker, die sie
claimen.

Panel-Aktionen – stop, stop all, stumm, remove, set-config und Klick-zum-Öffnen –
sind durch Host-Tests gegen den echten Extension-Code abgedeckt, wurden aber noch
nicht in der laufenden UI geklickt.

Noch ungeprüft: ein delegiertes Arbeitspaket, das mit Review und Merge
durchläuft.

## Installation

```bash
# 1. agent-bus CLI (es gibt keine Homebrew-Formula)
npm install -g @agent-bus-connect/cli@latest

# 2. Extension, global
git clone https://github.com/HenryJobst/aider-agent-bus.git
mkdir -p ~/.aider-desk/extensions/aiderdesk-agent-bus
rsync -a --exclude node_modules --exclude .git \
  aider-agent-bus/.aider-desk/extensions/aiderdesk-agent-bus/ \
  ~/.aider-desk/extensions/aiderdesk-agent-bus/
cd ~/.aider-desk/extensions/aiderdesk-agent-bus && npm install --omit=dev
```

`agent-bus` bringt `better-sqlite3` mit, für das es bei sehr neuen Node-Versionen
kein Prebuild gibt. Installiere es mit einem unterstützten Node (z. B.
`brew install node@22`) und richte sowohl die Extension (`agentBus.nodeBinary`)
als auch den MCP-Server (`command`) auf diesen Interpreter. Symptom bei
Abweichung: `NODE_MODULE_VERSION 127 ... requires 147`.

MCP-Server in `.aider-desk/mcp-servers.json`:

```json
{
  "mcpServers": {
    "agent-bus": {
      "command": "/opt/homebrew/opt/node@22/bin/node",
      "args": ["/opt/homebrew/lib/node_modules/@agent-bus-connect/cli/dist/mcp/server.js"],
      "scope": "task"
    }
  }
}
```

Kopiere die Config-Vorlagen und passe die Pfade an deine Maschine an – die echten
Dateien sind gitignored, weil sie lokale Node-Pfade enthalten:

```bash
cp .aider-desk/agent-bus.example.json .aider-desk/agent-bus.json
cp .aider-desk/mcp-servers.example.json .aider-desk/mcp-servers.json
```

Danach die Extensions in AiderDesk neu laden.

## Verwendung

```
/agent-bus-init                     # Config schreiben + diese Task als Master registrieren
/agent-bus-spawn <name> [role]      # neuer Worker; Rolle ist standardmäßig developer
/agent-bus-join                     # DIESE Task adoptieren (Name und Rolle abgeleitet)
/agent-bus-team                     # Roster, Status, ungelesene Nachrichten
/agent-bus-say backend <message>    # Nachricht als Mensch senden
/agent-bus-log 20                   # letzter Bus-Verkehr
/agent-bus-doctor                   # ist jede Identität wirklich auf dem Bus?
/agent-bus-config                   # Projekteinstellungen anzeigen/ändern
/agent-bus-pause backend            # Wake-ups stummschalten, zurück mit /agent-bus-resume
/agent-bus-stop                     # den einzigen laufenden Worker unterbrechen
/agent-bus-remove <name>            # einen Teilnehmer aus dem Team entfernen
/agent-bus-leave                    # diese Task verlässt das Team und läuft weiter
/agent-bus-reset confirm            # alle Identitäten entfernen, Join-Table leeren
```

Zwei Wege zu einem Teammitglied:

- **spawn** legt eine neue Task an, weist das Rollenprofil zu, setzt sie in einen
  eigenen Worktree und startet sie mit dem Arbeitspaket.
- **join** adoptiert eine bereits laufende Task. Sie behält Konversation und
  Arbeitsverzeichnis, bekommt eine Bus-Identität und die Anweisung, sich zu
  registrieren und dann *weiterzumachen* – nie neu zu starten. Die Task wird auf
  das Rollenprofil umgestellt, damit der agent-bus-MCP-Server für sie aktiv ist;
  Provider/Modell bleiben unverändert. Zweimaliges Joinen ist idempotent, der
  Master kann nicht als Worker joinen, `maxWorkers` gilt.
  `switchToWorktree: true` verschiebt die Task vorher in einen eigenen Worktree
  (nimmt uncommittete Änderungen mit, also nur für Tasks, die noch nicht
  editieren).

Beide Befehle geben eine `mcp:`-Zeile aus. Steht dort `missing`, ist für das
Projekt kein `agent-bus`-Server konfiguriert und die Agenten sehen
`register`/`send`/`inbox` nicht – dann zuerst `.aider-desk/mcp-servers.json`
einrichten.

Der Master bekommt `agent_bus_spawn_worker`, `agent_bus_spawn_team`,
`agent_bus_join_worker`, `agent_bus_get_team`, `agent_bus_stop_worker` und
`agent_bus_remove_worker`; jedes andere Profil sieht nur die Teamübersicht.
Unterhaltungen laufen weiter über die agent-bus-MCP-Tools (`register`, `send`,
`ask`, `reply`, `delegate`, `now`, `team_board`).

Das Panel am unteren Rand der Task-Sidebar spiegelt die drei Einstellungen, die
du pro Projekt umschaltest – Board-Tasks vs. nur Nachrichten, Peer-to-Peer an/aus
und Worktree vs. geteiltes Verzeichnis (letzteres nur, solange kein Worker
läuft). In der Kopfzeile sitzt `stop all`, das nach Rückfrage jeden laufenden
Agenten inklusive Master unterbricht. Ein Klick auf einen Namen aktiviert die
entsprechende Task in AiderDesk. Alles andere läuft über
`/agent-bus-config <key> <value>`: prüft Key und Wert, schreibt die Projektdatei
und wendet sie sofort an.

Die Config liegt im Projekt: `.aider-desk/agent-bus.json`. Identitätszuordnung
und Wake-Zähler liegen daneben in `.aider-desk/agent-bus-state.json` – eine reine
Zuordnungstabelle; sie zu löschen verliert keine Nachrichten.

## Wie das Team am Leben bleibt

agent-bus speichert Nachrichten, kann eine ruhende AiderDesk-Task aber nicht
wecken. Das macht die Extension:

1. alle `pollIntervalMs` liest sie die Zahl ungelesener Nachrichten über
   `agent-bus inbox-status --json`;
2. ruhende Worker außerhalb des Cooldowns bekommen `runPrompt()` mit einem
   Inbox-Prompt;
3. `onAgentFinished` führt dieselbe Prüfung sofort aus, damit Antworten nicht auf
   den nächsten Tick warten.

Kein Worker blockiert in `inbox(wait_s: 110)` – das würde seine Agent-Loop
belegen und ließe sich nicht unterbrechen. Bremsen: `wakeCooldownMs`,
`maxWakesPerTask`, und eine laufende Task wird nie geweckt.

## Anwendungsfälle

**Wie die Ausschnitte hier zu lesen sind.** Jeder JSON-Block ist ein *Teil* der
`.aider-desk/agent-bus.json`, keine vollständige Datei. Du musst sie nicht von
Hand bearbeiten – setze die Keys stattdessen aus der Master-Task:

```
/agent-bus-config                                  # alle effektiven Werte anzeigen
/agent-bus-config orchestration.trackTasks false   # einen Wert ändern
```

`/agent-bus-config` prüft Key und Wert, schreibt die Projektdatei und wendet die
Änderung sofort an. Manuelles Editieren funktioniert ebenfalls: weggelassene Keys
behalten ihren Default, Änderungen greifen bei der nächsten Aktion. Existiert die
Datei noch nicht, von `.aider-desk/agent-bus.example.json` starten.

### 1. Sessions sollen sich nur abstimmen

Kein Board, kein Task-Besitz – nur Nachrichten. Das ist das leichteste Setup.

In `.aider-desk/agent-bus.json`:

```json
{ "orchestration": { "trackTasks": false, "peerToPeerEnabled": true } }
```

1. In der Session, die führen soll: `/agent-bus-init` (Master-Identität,
   MCP-Prüfung).
2. In jeder anderen Session: `/agent-bus-join` (ohne Argumente).
3. Agenten nutzen `send` für Information, `ask`, wenn sie eine Antwort brauchen,
   und `reply` auf die Message-ID. Die Extension weckt eine ruhende Session, wenn
   ungelesene Nachrichten vorliegen.

Prüfen: `/agent-bus-doctor` zeigt alle Identitäten als `registered`; die Sidebar
zeigt `unread`-Zähler.

### 2. Ein Arbeitspaket braucht einen eigenen Worker

Wenn die Arbeit in einer isolierten Kopie des Repos passieren soll.

In `.aider-desk/agent-bus.json`:

```json
{ "isolation": { "mode": "worktree" } }
```

1. Git-Repository erforderlich – sonst auf `shared` wechseln.
2. `/agent-bus-spawn backend developer Implementiere die Users-API, Abnahme: npm test`
3. Der Worker bekommt seinen eigenen Worktree, das Developer-Profil und den
   Registrierungs-Prompt. Der Master bleibt im Hauptverzeichnis.

Prüfen: `git worktree list` zeigt den neuen Worktree, `/agent-bus-team` den
Worker mit unread-Zähler.

### 3. Laufende Sessions ins Team holen

Bestehende Tasks behalten ihre Konversation – nichts wird neu gestartet.

1. Die Task anhalten, die adoptiert werden soll (Joins unterbrechen absichtlich
   nicht).
2. `/agent-bus-join` für die Defaults oder `/agent-bus-join backend reviewer`.
3. Soll die Session isoliert werden: `agent_bus_join_worker` mit
   `switchToWorktree: true` **bevor** sie zu editieren beginnt.

Prüfen: Ausgabe von `agent_bus_join_worker` oder `/agent-bus-doctor`, danach
`whois` auf dem Bus.

### 4. Verfolgte Arbeit mit Review

Nur sinnvoll, wenn mehrere Arbeitspakete parallel laufen und du ein Board willst.

In `.aider-desk/agent-bus.json`:

```json
{ "orchestration": { "trackTasks": true, "requireReview": true } }
```

1. Der Master legt mit `delegate` eine Task an (Halter = Worker, Titel,
   Beschreibung, Abnahmekriterien).
2. Der Worker claimt sie, setzt `now --status working` und meldet sich mit `reply`.
3. Der Reviewer prüft und berichtet; der Master schließt mit `done`, nachdem du
   den Merge freigegeben hast.

Prüfen: `agent-bus tasks --project <p> --team <t>`, Board-Status im Panel.

### 5. Team verkleinern oder beenden

| Ziel | Aktion |
|---|---|
| Der aktuelle Lauf eines Agenten stoppt | `/agent-bus-stop <name>` |
| Ein Teilnehmer verlässt das Team, die Task läuft weiter | `/agent-bus-remove <name>` oder `×` im Panel |
| Das ganze Team ist fertig | `/agent-bus-reset confirm`, dann die Tasks in AiderDesk schließen |

### 6. Kein Git-Repository (Analyse, Doku, fremdes Projekt)

In `.aider-desk/agent-bus.json`:

```json
{ "isolation": { "mode": "shared" } }
```

Worktree-Spawns scheitern mit `not a git repository`. Im Modus `shared` teilen
sich alle Agenten das Verzeichnis – gib ihnen disjunkte Dateien oder starte sie
nacheinander.

### 7. Ein Agent sieht keine Bus-Tools

1. `/agent-bus-doctor` – die `mcp:`-Zeile muss `configured` sagen.
2. Steht dort `missing`: den `agent-bus`-Eintrag in `.aider-desk/mcp-servers.json`
   ergänzen.
3. Extensions neu laden, einen frischen Prompt starten und im Log nach
   `Initializing MCP connectors enabledServers=['agent-bus']` suchen.
4. Immer noch nichts? Dann hatte der Lauf die Tools und das Modell hat sie
   ignoriert – für diese Rolle ein stärkeres Modell verwenden.

## Konfiguration

`.aider-desk/agent-bus.json`, alle Keys optional:

| Key | Default | Bedeutung |
|---|---|---|
| `team` | `<projekt>-team` | Bus-Team-Scope, muss bei jedem Aufruf passen |
| `agentBus.project` / `.area` | Ordnername / keiner | Bus-Scope; Worktrees leiten einen anderen Namen ab, deshalb wird er immer explizit übergeben |
| `agentBus.binary` / `.nodeBinary` | `agent-bus` / keiner | CLI-Einstiegspunkt und, wenn gesetzt, der Interpreter dafür |
| `mcpServerName` | `agent-bus` | Name des MCP-Servers, der in den Agent-Profilen aktiviert wird; muss zu `mcp-servers.json` passen |
| `isolation.mode` | `worktree` | `worktree`, `shared` oder `hybrid` (Worker als Worktree) |
| `orchestration.maxWorkers` | `5` | Obergrenze für gespawnte **und** adoptierte Worker |
| `orchestration.peerToPeerEnabled` | `true` | direkte Worker-zu-Worker-Nachrichten erlauben |
| `orchestration.trackTasks` | `true` | `false` = nur über Nachrichten koordinieren, keine Board-Regeln |
| `orchestration.pollIntervalMs` / `wakeCooldownMs` / `maxWakesPerTask` | `20000` / `60000` / `3` | Takt und Budget der Wake-ups; ein Agent, der seine Inbox ignoriert, wird für denselben Rückstand nicht erneut geweckt |
| `profiles.provider` / `.model` | gelernt | nur Fallback; das echte Modell wird beim ersten Agentenlauf gelernt |

## Repository-Aufbau

Dieses Repository *ist* die Extension, projektlokal installiert, wie AiderDesk es
erwartet:

```
README.md                                  englische Fassung
README.de.md                               diese Datei
LICENSE                                    MIT
AGENTS.md                                  Anweisungen für Agenten (Repo + Teammitgliedschaft)
.aider-desk/agent-bus.example.json         Vorlage für die Projekt-Config
.aider-desk/mcp-servers.example.json       Vorlage für den MCP-Eintrag
.aider-desk/extensions/aiderdesk-agent-bus/
  index.ts                                 Extension: Tools, Commands, Events, UI
  src/{bus,core,orchestration}/            BusClient, Config, State, Spawn, Wake-up
  src/{profiles,tools,commands}.ts         Agent-Profile und Control Plane
  src/ui/Dashboard.jsx                     Dashboard in der Task-Sidebar
  tests/                                   node:test-Suite + Fakes + Real-CLI-Integration
  README.md                                Referenz der Extension
```

## Entwicklung

```bash
cd .aider-desk/extensions/aiderdesk-agent-bus
npm install
npm run check   # format:check + lint + typecheck + tests
```

105 Tests, ESLint + Prettier eingerichtet:

| Suite | Deckt ab |
|---|---|
| Unit | Config-Merge/-Clamping, State-Join-Table, Prompt-Inhalte, Inbox-Status-Normalisierung |
| Seam | Spawnen und Adoptieren gegen gefälschte `ProjectContext`/`TaskContext`, Worktree-Fallback, Master-only-Tools |
| Wake-up | laufende Task, Cooldown, Budget, Parken ohne Fortschritt, leere Inbox, kaputte CLI |
| Host | Tools, Panel-Daten und jede Panel-Action (refresh, stop, stop all, stumm, remove, set-config) gegen einen Fake-Host |
| Drift | Metadata-Version vs. `package.json`, vollständige Profilform, Command-Parität zwischen englischer und deutscher README |
| Wake integriert | echte CLI und Bus-DB: eine zugestellte Nachricht weckt genau einmal, ein stummer Worker nie |
| Integration | echte CLI in einem Wegwerf-`AGENT_BUS_DIR`: zwei Identitäten registrieren, Nachricht, Unread-Zähler, Scope-Isolation; wird ohne CLI übersprungen |

Design-Entscheidungen und Stolperfallen (expliziter Bus-Scope, keine
blockierenden Inbox-Waits, Worktree-Regeln) stehen in [`AGENTS.md`](AGENTS.md)
und in der [Extension-README](.aider-desk/extensions/aiderdesk-agent-bus/README.md).

## Fehlerbehebung

| Symptom | Ursache | Lösung |
|---|---|---|
| `NODE_MODULE_VERSION 127 … requires 147` | CLI mit Node 22 installiert, mit Node 26 ausgeführt | `agentBus.nodeBinary` und den MCP-`command` auf denselben Interpreter setzen |
| `not a git repository` beim Spawn | `isolation.mode: worktree` ohne Git-Repo | `git init` oder auf `shared` wechseln |
| `unread ?` in `/agent-bus-team` | CLI fehlt oder anderer Bus-Scope | `agentBus.binary`/`nodeBinary` prüfen, dann `project`/`team` |
| Worker erhalten keine Nachrichten | jeder Aufruf nutzte einen anderen Scope | `project`/`area`/`team` explizit übergeben, auch in Worktrees |
| Log sagt `Agent profile with id agent-bus-… not found` | die Extension hat keine Profile registriert (globaler Kontext) | Extensions neu laden; Profile müssen auch ohne offenes Projekt gelistet sein |
| Agent sagt, er habe keine agent-bus-Tools | kein MCP-Server konfiguriert oder der Connector der Task entstand vor Server/Profil | `agent-bus` in `.aider-desk/mcp-servers.json` ergänzen, init/join erneut ausführen, dann einen frischen Prompt starten oder die App neu starten – bestehende Connectoren werden nicht neu gebaut |
| `Exception in connector … scipy … _spropack` in AiderDesk | das Python-Venv der App bringt einen scipy-Build, den der Loader ablehnt (nicht diese Extension) | ein funktionierendes scipy in `~/Library/Application Support/aider-desk/python-venv` pinnen oder die Repo-Map abschalten |
| App wirkt hängend, viele Agentenläufe, `woke …` wiederholt sich im Log | Wake-Schleife: Agenten ignorieren ihre Inbox, jedes Wecken ist ein voller Lauf | Agent stummschalten (`/agent-bus-pause`), `wakeCooldownMs` erhöhen, `maxWakesPerTask` senken; 0.2 parkt solche Agenten nach dem Budget |
| Log zeigt `inbox poll … took N ms` | die Bus-CLI ist langsam, jeder Poll blockiert die Extension | `agentBus.nodeBinary`, Anzahl der Worker und eine mögliche DB-Sperre durch einen anderen Prozess prüfen |
| Panel erscheint nicht | das Projekt hat noch kein Team | `/agent-bus-init` ausführen; das Panel wird registriert, sobald Master oder Worker existieren |

## Lizenz

MIT – siehe [LICENSE](LICENSE). agent-bus selbst ist ebenfalls MIT.
