# 3-TALL Jackpot

Flerspiller-lotterispill (lekepenger). Serveren er fasit for trekningen: én felles runde
hvert 22. sekund, samme tall kringkastes til alle tilkoblede spillere over SSE.
Hver spiller kjøper seg inn runde for runde (ingen autoplay), med valgfri innsats
(2/4/8/16 kr) og to progressive jackpot-nivåer.

## Kjør lokalt

```bash
npm start          # node server.js → http://localhost:8123
```

Åpne URL-en i flere faner for å se den delte trekningen.

## Deploy

Repoet har en `render.yaml` — på [Render](https://render.com): **New → Blueprint**,
velg dette repoet, og tjenesten settes opp automatisk (gratis-tier).

Filene som trengs i drift: `server.js`, `index.html`, `styles.css`, `script.js`, `package.json`.
