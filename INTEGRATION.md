# 3-TALL — Operatørintegrasjon (RGS ↔ wallet/kundedatabase)

Dette dokumentet beskriver hvordan 3-TALL-spillserveren (RGS) integreres med
operatørens plattform: kundedatabase (innlogging/KYC) og lommebok (ekte penger).

**Alle beløp er heltall i øre (NOK minor units). Alle pengetransaksjoner er
idempotente per `txId`.**

---

## Arkitektur

```
[Operatørens plattform]                      [3-TALL RGS (denne serveren)]
  kundedatabase / KYC / RG-verktøy             runde-motor (felles trekning hvert 22. s)
  lommebok (ekte penger)                       bonger, innsatser, gevinstberegning
        │                                      revisjonslogg (JSONL)
        │  1. spiller trykker på spillet              │
        │  2. plattformen åpner spill-URL             │
        │     med engangs launch-token   ───────────► │ 3. POST /api/session {token}
        │ ◄────────────────────────────────────────── │    RGS verifiserer token hos operatør
        │  4. wallet-kall (signert HTTP)               │    og får playerId/valuta
        │     debit / credit / rollback  ◄───────────► │ 5. spilleren kjøper runder; RGS
        │                                              │    debiterer/krediterer lommeboken
```

Spillmodellen er **seamless wallet**: spilleren har ÉN saldo — hos operatøren.
RGS-en holder aldri penger selv; den flytter dem via operatørens API.

## Hva operatøren må levere (RGS kaller disse)

Implementert i `wallet-adapter.js` (`OperatorWallet`) — endepunktsnavn/feltnavn
mappes om til operatørens faktiske spesifikasjon når den foreligger:

| Operasjon | Forventet semantikk |
|---|---|
| `POST /session/verify` `{token}` | Verifiser engangs launch-token → `{playerId, displayName, currency}` |
| `POST /wallet/balance` `{playerId}` | → `{balanceOre}` |
| `POST /wallet/debit` `{playerId, amountOre, txId, meta}` | Trekk innsats. **Idempotent per txId.** Feil: `INSUFFICIENT_FUNDS` |
| `POST /wallet/credit` `{playerId, amountOre, txId, meta}` | Utbetal gevinst. **Idempotent per txId.** |
| `POST /wallet/rollback` `{txId}` | Tilbakefør én tidligere debit (avbrutt kjøp / avbrutt runde). Idempotent. |

**Sikkerhet:** alle kall sendes med `X-Api-Key`, `X-Timestamp` og
`X-Signature` = HMAC-SHA256(secret, timestamp + body). Justeres til operatørens
opplegg (mTLS, JWT e.l.) ved behov.

**Transaksjons-ID-er fra RGS:** `bet-{betId}` (innsats), `win-{betId}` (gevinst),
`rb-bet-{betId}` (tilbakeføring). `betId` er UUID. Gjenta gjerne kall — samme
txId skal aldri flytte penger to ganger.

**Feilhåndtering:** Feilet `credit` (gevinst) logges som
`CRITICAL_credit_failed` i revisjonsloggen med komplett payload og kan replays
trygt (idempotent). Feilet `rollback` etter kappløp logges som
`CRITICAL_rollback_failed`. Disse MÅ overvåkes i drift.

## RGS-ens egne endepunkter (klienten bruker disse)

Se `openapi.yaml` for full spesifikasjon.

| Endepunkt | Hva |
|---|---|
| `POST /api/session` `{token?}` | Opprett spillsesjon (verifiserer launch-token i operator-modus) |
| `POST /api/tickets` `{sessionId}` | Nye bonger (avvises hvis aktivt kjøp) |
| `POST /api/bet` `{sessionId, stakeOre, active[]}` | Kjøp NESTE runde. Stenger `betCutoffMs` (1,5 s) før trekning |
| `POST /api/bet/cancel` `{sessionId, betId}` | Avbryt kjøp før vinduet stenger (full refusjon) |
| `GET /api/state?sessionId=` | Saldo, aktivt kjøp, siste resultat, jackpotter, rundetiming |
| `GET /events` (SSE) | Felles trekning: `hello`, `round {n, numbers, jackpots}` |
| `POST /api/topup` | KUN demo-modus (`WALLET_MODE=mock`) |

## Rundelivssyklus

1. Innsatsvindu åpent → spillere kjøper (`/api/bet`); hver innsats debiteres umiddelbart
2. Vinduet stenger 1,5 s før trekning (sene kjøp avvises med `WINDOW_CLOSED`;
   kappløp rundt stenging tilbakeføres automatisk)
3. Trekning: 4 av 20 tall, kryptografisk RNG (`crypto.randomInt`, Fisher-Yates)
4. Oppgjør per innsats, **hver bong betaler uavhengig**:
   - Jackpot (3 av 3 blant de 3 første trekkene): `50 × innsats` + andel av potten
   - 3 rette (på 4 trekk): `50 × innsats`
   - 2 rette: `5 × innsats`
5. Gevinster krediteres med `win-{betId}` (idempotent), resultat + saldo hentes av klienten
6. Jackpottene (to nivåer: 2–4 kr og 8–16 kr innsats) er **felles for alle spillere**,
   mates med 2 % av innsatsene i sitt nivå, og deles likt mellom vinnende bonger

## Konfigurasjon (env)

| Variabel | Verdi |
|---|---|
| `WALLET_MODE` | `mock` (demo, default) / `operator` (produksjon) |
| `OPERATOR_BASE_URL` | Operatørens wallet-API-base |
| `OPERATOR_API_KEY` / `OPERATOR_SECRET` | Utstedes av operatøren |
| `PORT` | Serveport (settes av vertsmiljøet) |

## Revisjonslogg

Append-only JSONL i `audit/audit-YYYY-MM-DD.jsonl`:
`session_open`, `bet_placed`, `bet_cancelled`, `round` (tall + antall innsatser),
`win_credit` (med breakdown per bong), `jackpot_hit`, `demo_topup`,
`CRITICAL_credit_failed`, `CRITICAL_rollback_failed`.

## Status og gjenstående for produksjonssetting

✅ Klart: server-autoritativ spillogikk, seamless wallet-adapter (mock + skall),
idempotente transaksjoner, kappløpsvern rundt innsatsvinduet, revisjonslogg,
CSPRNG, to delte progressive jackpotter, rate-limiting, input-validering.

⚠️ Må på plass før ekte penger (typisk i samarbeid med operatør/testhus):
- **Mapping av `OperatorWallet`** til operatørens faktiske API-spesifikasjon
- **Persistens / krasj-durabilitet**: rundestate, innsatser og den idempotente
  retry-køen lever i prosessminnet, revisjonsloggen på lokal disk. Retry-køen
  redder *forbigående* wallet-feil (nettverk/timeout) — men en full prosess­krasj
  mellom debit og oppgjør etterlater en foreldreløs debit. Produksjon MÅ ha
  database (in-flight innsatser + transaksjoner) og varig/ekstern logglagring;
  dette er et konsesjonskrav, ikke valgfritt. (Single-prosess i minnet er kun for demo.)
- **RNG-sertifisering** hos akkreditert testhus (RNG-en er CSPRNG, men
  sertifikat utstedes av testhuset), samt RTP-verifikasjon (~70 % med dagens
  premietabell — kan justeres)
- **Ansvarlig spill-kroker**: operatørens grensesnitt for innsatsgrenser,
  selvutestengelse og tvungen sesjonsavslutning må kobles på sesjonsflyten
- Driftsmiljø med overvåking av `CRITICAL_*`-hendelser, og infrastruktur som
  ikke sover (Render free-tier sover ved inaktivitet — kun for demo)
