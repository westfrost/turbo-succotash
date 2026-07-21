# 🚆 DK Togstatus

Selvopdaterende database og website med overblik over, om togene i Danmark kører
**til tiden**, **før tid** eller er **forsinkede**.

## Sådan virker det

1. **Datakilde:** [Rejseplanens](https://www.rejseplanen.dk) HAFAS-API (via
   [`hafas-client`](https://github.com/public-transport/hafas-client)).
   `scripts/fetch.js` henter afgangstavler for ~47 stationer, der tilsammen
   dækker alle jernbanestrækninger i landet, og dedupliker togene på tur-id.
2. **Database:** JSON-filer i git:
   - `data/days/ÅÅÅÅ-MM-DD.json` – alle unikke tog pr. dag med seneste/største
     forsinkelse, linje, togtype, operatør m.m.
   - `docs/data/latest.json` – øjebliksbillede til live-tabellen
   - `docs/data/stats.json` – aggregeret statistik (pr. dag, time, linje,
     togtype, operatør) + automatisk genererede tips
3. **Automatik:** GitHub Actions (`.github/workflows/update-data.yml`) kører
   **hver time** kl. xx:07 (UTC 03–23), henter friske data og committer dem.
4. **Website:** `docs/` er en statisk side (GitHub Pages) med søgbar
   afgangstabel, KPI'er, grafer og tips. Deployes automatisk af
   `.github/workflows/pages.yml`, når data eller siden ændres på `main`.

## Kom i gang

1. **Merge til `main`** – planlagte (cron) workflows kører kun på
   default-branchen.
2. **Slå GitHub Pages til:** Settings → Pages → Source: **GitHub Actions**.
3. Kør evt. workflowet **"Opdater togdata"** manuelt (Actions → Run workflow)
   for at få det første datasæt med det samme.

Websitet ligger derefter på `https://<ejer>.github.io/turbo-succotash/`.

### Lokal kørsel

```bash
npm ci
node scripts/fetch.js        # henter data (kræver internetadgang)
python3 -m http.server -d docs 8000   # åbn http://localhost:8000
```

## Definitioner

- **Til tiden:** under 3 minutters forsinkelse (samme princip som DSB's
  officielle punktlighedsmål)
- **Før tid:** afgang meldt mere end 1 minut før planlagt tid
- **Forsinket:** 3 minutter eller mere
- **Ingen realtid:** toget havde ingen realtidsmelding

Uofficielt hobbyprojekt – ikke tilknyttet Rejseplanen eller DSB. Tjek altid
Rejseplanen før afgang.
