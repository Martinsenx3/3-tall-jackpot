# 3-TALL Jackpot — RGS

Server-autoritativ flerspiller-lotterispill (Remote Game Server). Bygd for å
integreres mot en operatørs lommebok og kundedatabase (ekte penger, under konsesjon).

- **Serveren er fasit** for all pengelogikk: sesjoner, bonger, innsatser,
  trekning (kryptografisk RNG) og gevinstberegning. Klienten kun renderer.
- **Seamless wallet:** penger flyttes via operatørens lommebok gjennom
  `wallet-adapter.js`. Alle beløp er heltall i øre, alle transaksjoner idempotente.
- Felles trekning hvert 22. sekund, kringkastet til alle over SSE. Spilleren
  kjøper hver runde manuelt (ingen autoplay), innsats 2/4/8/16 kr, to delte
  progressive jackpotter.

## Kjør

```bash
npm start                      # demo: WALLET_MODE=mock → http://localhost:8123
WALLET_MODE=operator OPERATOR_BASE_URL=… OPERATOR_API_KEY=… OPERATOR_SECRET=… npm start
```

## Integrasjon

- **`INTEGRATION.md`** — hvordan operatøren kobler på lommebok + kundedatabase
- **`openapi.yaml`** — API-spesifikasjon
- **`wallet-adapter.js`** — pengegrensen (`MockWallet` for demo, `OperatorWallet` for produksjon)

## Deploy

`render.yaml` → Render **New → Blueprint**. Standard er demo-modus (`WALLET_MODE=mock`).
Produksjon krever i tillegg database + varig logglagring (se INTEGRATION.md).
