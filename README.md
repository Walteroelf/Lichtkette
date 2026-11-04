# Lichtkette

Ein gemeinsames Spiel für alle Geräte einer Gruppe, gedacht für die Digital-AG: iPads, Taster und Augensteuerung (z. B. GridPad) spielen zusammen.

**App öffnen:** https://walteroelf.github.io/Lichtkette/

## Die Idee

Auf der Tafel (Beamer, Smartboard) wandert ein Licht durch ein Netz aus Geräten. Es ist immer bei **genau einem** Gerät. Wer es hat, gibt es mit **einer einzigen Aktion** weiter: tippen, Taster drücken oder auf einen großen Kreis schauen. Dann springt es zufällig zu einem anderen Gerät, mit Ton und leuchtender Spur auf der Tafel.

Ist die Runde voll (im ruhigen Modus mindestens 8 Weitergaben, bei vielen Geräten 3 pro Gerät), gibt es ein ruhiges Finale mit allen Farben und Tönen. Danach beginnt eine neue Runde. Es gibt kein Verlieren und keinen Zeitdruck.

**Zufällig, aber fair:** Jedes Gerät kommt einmal dran, bevor die Reihe von vorn beginnt.

## So wird gespielt

1. **Tafel:** `https://walteroelf.github.io/Lichtkette/?tafel=1` am Beamer-Rechner öffnen und auf „Tafel starten“ tippen. Es erscheint ein QR-Code.
2. **iPads:** QR-Code mit der Kamera scannen.
3. **GridPad:** Den **Spieler-Link** per Mail schicken (auf der Tafel unter ⚙ → „Spieler-Link kopieren“). Der Link bleibt gleich, solange der Raumcode gleich bleibt. Einmal als Lesezeichen anlegen, dann reicht ein Klick.
4. **Auf jedem Gerät zuerst die Eingabeart wählen:**
   - 👆 **Tippen**: iPad oder Touchscreen. Ein Tipp irgendwo auf dem Bildschirm gibt das Licht weiter.
   - 🔘 **Taster**: Taster, Schalter oder Leertaste. Auch ein Klick oder Tipp geht.
   - 👁 **Blick / Maus**: Augensteuerung. Es gibt einen großen Kreis in der Mitte. Der Rest des Bildschirms reagiert nicht, damit ein Blick daneben nichts auslöst.
5. Unter der Auswahl lässt sich pro Gerät einstellen:
   - **Licht wandert weiter nach** nie, 10 s oder 30 s. Dann geht das Licht von allein weiter, falls jemand gerade nicht kann. Auf der Tafel zeigt ein Ring, wie viel Zeit noch bleibt.
   - **Ton auf diesem Gerät** an oder aus.

Jedes Gerät hat eine eigene **Farbe und Form** (Kreis, Dreieck, Quadrat …), damit man sich auch ohne Farbensehen zuordnen kann.

## Zeitspiel: die Bestzeit schlagen

Auf der Tafel unter ⚙ lässt sich von **Ruhig** auf **Zeitspiel** umschalten.

- **Weitergaben pro Runde:** 10, 15 oder 20 (oder „Auto“ im ruhigen Modus). Im Zeitspiel gilt ohne Auswahl 10.
- **Ablauf:** Die Tafel zeigt „Los ▶“ (auch mit Enter oder Leertaste). Nach 3, 2, 1 erscheint das erste Licht, und die Uhr läuft mit. Mit der letzten Weitergabe stoppt sie.
- **Endzeit und Bestzeit:** Die Tafel zeigt die Endzeit und „Neue Bestzeit!“, wenn die alte unterboten wurde. Die Bestzeit wird auf dem Tafel-Gerät gemerkt, getrennt für 10, 15 und 20 Weitergaben.
- **Teamzeit:** Es gibt nur die Zeit der Gruppe. Einzelzeiten werden nirgends angezeigt.
- **Kein Auto-Weiterwandern** im Zeitspiel, damit die Zeit nicht verfälscht wird.

### Fairer Ausgleich: „Zeit zählt nicht“
Auf dem Startbildschirm jedes Geräts gibt es **Zeitspiel: Zeit dieses Geräts → zählt nicht**. Solange ein solches Gerät das Licht hat, **steht die Uhr**. So können auch Schülerinnen und Schüler mit Blicksteuerung oder Taster mitspielen, ohne dass die Gruppe Zeit verliert. Auf dem Gerät steht dann „Die Uhr steht. Du hast Zeit.“ Auf der Tafel sieht man nicht, welches Gerät so eingestellt ist.

## Springender Punkt für fitte Spieler

Auf dem Startbildschirm gibt es **Tippfläche → springender Punkt** (für Tippen und Maus, nicht für den Taster). Statt des ganzen Bildschirms erscheint ein leuchtender Punkt, bei jedem Licht an einer **anderen Stelle**, nie in der Mitte und nie zweimal am selben Ort. Tipps daneben tun nichts. So kann man nicht einfach dauerhaft in die Mitte tippen.

## Für Augensteuerung und Taster

- Es zählt nur ein Klick. Es gibt kein Ziehen, Wischen, Scrollen oder Hover-Menü.
- Nach dem Erhalten des Lichts gibt es eine kurze **Sperrzeit** (0,7 s, bei Blick 1 s), damit ein nachlaufender Klick es nicht sofort weitergibt.
- Beim Blick-Modus gibt es keinen kleinen „Eingabeart ändern“-Knopf in der Ecke. Zum Wechseln die Seite neu laden.
- Das Finale blitzt nicht, es gibt nur weiche, langsame Ringe. Bei „Bewegung reduzieren“ im System entfallen auch diese.

## Technik

- Reine Web-App (HTML, CSS, JavaScript) ohne eigenen Server, gehostet über GitHub Pages.
- Verbindung wie beim MatheBingo über einen öffentlichen MQTT-Server (HiveMQ, als Ersatz EMQX) per `wss://`. Das ist normaler Webverkehr und läuft im Schulnetz.
- Die **Tafel ist die Spielleitung**: Sie entscheidet, wer das Licht bekommt. Eine zweite Tafel im selben Raum schaut nur mit („Mitschau“).
- Übertragen werden nur zufällige Gerätekennungen, Formen und Tipps. Keine Namen und keine Schülerdaten.
- Geht eine Nachricht verloren, holt sie das nächste Lebenszeichen nach. Wer das Licht hat und tippt, dessen Tipp wird bis zu viermal wiederholt.
- Bis zu 12 Geräte pro Raum.

Links und Parameter:

| Link | Bedeutung |
|---|---|
| `?tafel=1` | Tafel. Der Raumcode wird auf diesem Gerät gemerkt. |
| `?tafel=1&r=CODE` | Tafel mit eigenem Raumcode |
| `?r=CODE` | Spieler im Raum `CODE` |
| `&b=1` | zuerst den zweiten MQTT-Server versuchen |
| `&id=abc123` | feste Gerätekennung (zum Testen mit mehreren Tabs) |

## Dateien

- `index.html`, `style.css`: Oberfläche
- `main.js`: Einstieg (Tafel, Spieler oder Startseite)
- `board.js`: Tafel, Spielleitung und Lichtanimation
- `player.js`: Spieler-Ansicht mit den drei Eingabearten
- `net.js`: MQTT-Verbindung mit Ersatzserver
- `shared.js`: Farben, Formen, Töne
- `lib/`: MQTT.js 5.10.1 und qrcode-generator 1.4.4 (beide MIT, siehe `lib/README.md`)

## Ideen für später

- Weitere Spiele auf derselben Verbindung (Beat, Lichtkunst)
- Auswahl, wer das Licht bekommt, für Geräte mit mehreren Eingabeflächen
- Installierbar als App und offlinefähig (Service Worker)
