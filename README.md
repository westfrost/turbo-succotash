# 🚆 DK Togstatus

![Punktlighed i dag](https://westfrost.github.io/turbo-succotash/badge.svg)

Selvopdaterende database og website med overblik over, om togene i Danmark kører
**til tiden**, **før tid** eller er **forsinkede**.

## Sådan virker det

1. **Datakilde:** [Rejseplanens](https://www.rejseplanen.dk) HAFAS-API (via
   [`hafas-client`](https://github.com/public-transport/hafas-client)).
   `scripts/fetch.js` henter afgangstavler for **alle togstationer i landet**
   og dedupliker togene på tur-id. Stationskataloget bygges automatisk ved at
   scanne Danmark i et gitter af nearby-opslag; scanningen gentages den 1. i
   måneden (og kan køres manuelt med workflow-inputtet "discover"), så nye
   stationer kommer med af sig selv. Vejrdata hentes fra
   [Open-Meteo](https://open-meteo.com).
2. **Database:** JSON-filer i git:
   - `data/days/ÅÅÅÅ-MM-DD.json` – alle unikke tog pr. dag med seneste/største
     forsinkelse, linje, togtype, operatør m.m.
   - `docs/data/latest.json` – øjebliksbillede til live-tabellen
   - `docs/data/stats.json` – aggregeret statistik (pr. dag, time, linje,
     togtype, operatør) + automatisk genererede tips
   - `docs/data/days/` + `docs/data/index.json` – kompakte dagsfiler til
     historik-sektionen, hvor man kan bladre i datoer eller vælge en
     fra/til-periode med egne tabeller, grafer og nøgletal
3. **Automatik:** GitHub Actions (`.github/workflows/update-data.yml`) kører
   **hver time døgnet rundt** (kl. xx:07 UTC), henter friske data og committer dem.
4. **Website:** `docs/` er en statisk side med søgbar afgangstabel, KPI'er,
   grafer og tips. `.github/workflows/pages.yml` spejler `docs/` til
   `gh-pages`-branchen, som GitHub Pages serverer, hver gang data eller siden
   ændres på `main`.

**Websitet er live på: https://westfrost.github.io/turbo-succotash/**

### Lokal kørsel

```bash
npm ci
node scripts/fetch.js            # henter data (kræver internetadgang)
node scripts/fetch.js --offline  # genberegner kun docs/data/* fra data/days/
python3 -m http.server -d docs 8000   # åbn http://localhost:8000
```

## Selvkørende vedligehold

Projektet passer sig selv, også uden menneskelig indblanding:

- **Overvågning** (`.github/workflows/healthcheck.yml`): tjekker hver 6. time,
  om dataene stadig opdateres. Går databasen i stå i 4+ timer, oprettes
  automatisk en issue med fejlsøgningstjekliste (og GitHub sender notifikation).
- **Stationsscanning:** den 1. i måneden genscannes hele landet, så nye eller
  omdøbte stationer automatisk kommer med.
- **Dependabot** (`.github/dependabot.yml`): åbner ugentlige pull requests, når
  `hafas-client` eller GitHub Actions har opdateringer – de skal blot merges.

## Definitioner

- **Til tiden:** under 3 minutters forsinkelse (samme princip som DSB's
  officielle punktlighedsmål)
- **Før tid:** afgang meldt mere end 1 minut før planlagt tid
- **Forsinket:** 3 minutter eller mere
- **Ingen realtid:** toget havde ingen realtidsmelding

Uofficielt hobbyprojekt – ikke tilknyttet Rejseplanen eller DSB. Tjek altid
Rejseplanen før afgang.
