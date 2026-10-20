# PolyScope X Palettierassistent

Ein unabhängiger Palettierassistent für PolyScope X. Mit dieser URCap lassen sich Palettier- und Depalettieraufgaben direkt am Roboter konfigurieren.

**Entwicklungsstand: `0.1.0-dev.9`.** Geprüft im UR8L-Simulator mit **PolyScope X `10.15.0-preview-1`**. Die finale Version 10.15.0 und der Einsatz an echter Roboterhardware sind noch nicht getestet.

## Funktionen

- Palettieren und Depalettieren mit Linien, Rastern und frei eingelernten Mustern.
- Mehrere Lagen, unterschiedliche Muster und Zwischenlagen.
- Geführte Einrichtung mit Palettenvorschau und Lagenübersicht.
- Verschiebbarer Palettenbezug sowie konfigurierbare Anfahrt, Werkzeugaktion und Abfahrt.
- Eigene Programmbaumaktionen für Greifer und Prozessschritte.
- Teilezähler und Wiederaufnahme unterbrochener Abläufe.

## Bauen

Benötigt werden **Node.js 24.11.1 bis 24.x** und **npm 10.9.1**.

```sh
npm ci
npm run build
```

Alternativ mit Docker und Bash:

```sh
bash scripts/build-container.sh
```

Das fertige `.urcapx`-Paket liegt anschließend im Verzeichnis `target/`.

## Installieren

Das `.urcapx`-Paket über die URCaps-Verwaltung von PolyScope X installieren. Vor dem Einsatz an einem echten Roboter müssen Einrichtung, Bewegungen, Greifer und Prozess für die jeweilige Anlage geprüft werden. Die Simulatorprüfung ersetzt diese Prüfung nicht.

## Lizenz

Copyright © 2026 Harry Korell. Für den eigenen Projektcode gilt **All rights reserved**; es wird keine Open-Source-Lizenz erteilt. Siehe [LICENSE](./LICENSE).

Abhängigkeiten und SDK-Bestandteile unterliegen ihren jeweiligen Lizenzbedingungen. Hinweise und die geltenden UR-SDK-Bedingungen stehen in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md); die zugehörigen Lizenztexte werden beim Paketbau mitgeliefert.

Dieses Projekt ist eine eigenständige Implementierung und kein offizielles Produkt von Universal Robots.
