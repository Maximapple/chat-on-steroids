# QA am Mac — Anleitung

Von oben nach unten. Nichts überspringen.

## 1. Installieren

DMG öffnen, App nach `/Programme` ziehen, starten.

## 2. Berechtigungen erteilen (nur du kannst das)

Systemeinstellungen → Datenschutz & Sicherheit:

- **Bildschirmaufnahme** → Chat On Steroids einschalten
- **Bedienungshilfen** → Chat On Steroids einschalten

Die App hat für jede einen Knopf, der die richtige Seite öffnet.

**Danach App komplett beenden (Cmd+Q) und neu starten.** Ohne das sieht die App die Freigabe
nicht — macOS merkt sich die Antwort pro Prozess.

## 3. Chrome-Erweiterung laden

1. In der App: **Open extension folder** klicken
2. Chrome: `chrome://extensions`
3. **Entwicklermodus** oben rechts einschalten
4. **Entpackte Erweiterung laden** → den geöffneten Ordner wählen
5. Auf das Erweiterungs-Symbol klicken → **Browsersteuerung** einschalten → beide Chrome-Fragen
   mit Ja beantworten

## 3b. Kurz prüfen, dass die richtige App läuft

**Der schnellste Test ist der Fenstertitel.** Er muss lauten:

```
Chat On Steroids 2.0.2+b556b8b
```

Steht dort nur `2.0.2` ohne Commit, läuft eine ältere App — dann gar nicht erst weitertesten.

Ausführlicher in der App: **Home** → Karte **Health** → **Run checks**.

Zwei Zeilen zählen:

```
Build          Chat On Steroids 2.0.2, built from <commit> …
Local server   … offers 3 tools: browser, computer, observe
```

Steht bei **Build** nicht der Commit des DMG, das du gerade installiert hast — oder fehlt die
Zeile ganz — läuft noch die alte App, und Testen ist sinnlos. Fehlt `browser` bei **Local
server**, siehe Schritt 3 (Erweiterung) und öffne einen neuen ChatGPT-Chat.

## 4. Automatische Prüfungen (Claude auf dem Mac)

Terminal:

```sh
git clone https://github.com/Maximapple/chat-on-steroids.git
cd chat-on-steroids
git checkout integrate/browser-and-desktop-064733
claude
```

Dann den Inhalt von `docs/qa/claude-on-mac-start-here.md` einfügen und abschicken.

Läuft von allein. Ausgabe am Ende **komplett kopieren.**

## 5. Der eigentliche QA-Lauf (ChatGPT)

1. ChatGPT öffnen, Unterhaltung mit verbundenen **Desktop-** und **Core-Apps**
2. Inhalt von `docs/qa/chatgpt-desktop-qa-prompt.md` einfügen und abschicken
3. Durchlaufen lassen, am Ende den Bericht **komplett kopieren**

## 6. Berichte ablegen

Beide Texte als Datei in `docs/qa/reports/` speichern:

```
docs/qa/reports/2026-08-31-chatgpt-desktop.md
docs/qa/reports/2026-08-31-claude-mac-automated.md
```

Nichts kürzen, nichts aufräumen, Fehlermeldungen wortgetreu lassen.

```sh
git add docs/qa/reports && git commit -m "QA reports" && git push
```

## 7. Reparieren lassen

Im `claude` auf dem Mac:

> Lies die Berichte in `docs/qa/reports/` und arbeite die Fehlschläge ab.

Fertig.

---

## Zwei Fallen

**Wenn im ChatGPT-Bericht steht, dass Prüfung 24 fehlgeschlagen ist** — das Steuern der eigenen
Registerkarte, `chrome://settings` oder `file://` wurde abgelehnt — dann ist das **richtig so.**
Diese Prüfung ist nur bestanden, wenn sie abgelehnt wird. Nicht reparieren lassen.

**Wenn alle Mauszeiger-Prüfungen bestanden sind, einmal selbst nachsehen.** Genau das wurde schon
einmal behauptet und war falsch. Mach ein Fenster-Bildschirmfoto mit der Maus mitten im Fenster
und schau, ob der Pfeil im Bild ist. Ja oder nein — mehr braucht es nicht.
