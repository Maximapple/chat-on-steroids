# QA — alles an einem Ort

## Anleitung

**[ANLEITUNG.md](ANLEITUNG.md)** — sieben Schritte, von oben nach unten. Hier anfangen.

## Die beiden QA-Dokumente

| Datei | wofür | wohin damit |
|---|---|---|
| [chatgpt-desktop-qa-prompt.md](chatgpt-desktop-qa-prompt.md) | 32 Prüfungen für Desktop-Steuerung und Chrome-Erweiterung | in ChatGPT einfügen, mit verbundenen Desktop- und Core-Apps |
| [claude-on-mac-start-here.md](claude-on-mac-start-here.md) | die automatischen Prüfungen | in `claude` auf dem Mac einfügen |

Berichte danach nach **[reports/](reports/)** — dort steht, was mit ihnen passiert.

## Das DMG

Nicht in diesem Ordner: die Datei ist 141 MB, und GitHub weist jeden Push über 100 MB ab.
Sie liegt unter **[Releases](../../releases)**, zusammen mit der Prüfsumme.

Falls dort nichts zu sehen ist, ist das Release noch ein **Entwurf** — Entwürfe sieht nur, wer
Schreibrechte am Repository hat. Auf der Releases-Seite steht dann `Draft` daneben, und ein Klick
auf **Publish release** macht es öffentlich.

Der zweite Weg, immer verfügbar: der Actions-Tab. Jeder grüne **Release candidate**-Lauf hängt
`package-macos-arm64` als Artefakt an, gültig 30 Tage. Oder im Terminal:

```sh
gh run download --repo Maximapple/chat-on-steroids -n package-macos-arm64
```

## Kontext, falls jemand fragt warum

- [../macos-qa-runbook.md](../macos-qa-runbook.md) — was nur ein Mac beantworten kann, und die
  Tabelle, die jeden `pointer=`-Wert in ein Urteil übersetzt
- [../extension-parity.md](../extension-parity.md) — wie unsere Browsersteuerung gegen ChatGPTs
  eigene Erweiterung abschneidet
