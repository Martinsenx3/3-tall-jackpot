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
| `POST /session/verify` `{token}` | Verifiser engangs launch-token → `{playerId, displayName, currency, jurisdiction, ageVerified, rg}` (se under). **MÅ avvise token for hardt selvutestengt eller under­aldrig spiller.** |
| `POST /wallet/balance` `{playerId}` | → `{balanceOre}` |
| `POST /wallet/debit` `{playerId, amountOre, txId, meta}` | Trekk innsats. **Idempotent per txId.** Feil: `INSUFFICIENT_FUNDS` |
| `POST /wallet/credit` `{playerId, amountOre, txId, meta}` | Utbetal gevinst. **Idempotent per txId.** |
| `POST /wallet/rollback` `{txId}` | Tilbakefør én tidligere debit (avbrutt kjøp / avbrutt runde). Idempotent. |

**Ansvarlig-spill-felter fra `/session/verify`** (operatøren er fasit):
```jsonc
{
  "playerId": "…", "displayName": "…", "currency": "NOK",
  "jurisdiction": "NO",        // sjekkes mot tillatt-liste (default ["NO"])
  "ageVerified": true,         // operatørens KYC/aldersresultat (18+)
  "rg": {
    "limits": { "dailyLossOre": 50000, "dailyDepositOre": null, "sessionTimeMs": null },
    "exclusion": { "status": "none|cooloff|excluded", "until": 1718540000000 },
    "realityCheckMs": 3600000,
    "lossSoFarOre": 0          // allerede forbrukt tap i dag (kryss-sesjon) → korrekt grensehåndhevelse
  }
}
```
I `operator`-modus **feiler spillet lukket**: mangler `ageVerified` eller `rg.exclusion.status`, blokkeres åpningen. Operatørens lommebok må **også** avvise en debit over grensen — RGS-sjekken er et raskt UX-lag, ikke den autoritative hovedboken.

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
| `GET /api/state?sessionId=` | Saldo, aktivt kjøp, siste resultat, jackpotter, rundetiming, `rg` (sesjonens spilletid/tap/grenser) |
| `GET /events` (SSE) | Felles trekning: `hello`, `round {n, numbers, jackpots, fair}` |
| `GET /api/verify?round=` | **Bevisbar rettferdig** — avslørt frø + tall for en allerede trukket runde (offentlig, read-only) |
| `GET /api/history?sessionId=&limit=` | Transaksjonshistorikk for sesjonen (read-only projeksjon, siste `KEEP_ROUNDS`) |
| `POST /api/bonus` | Daglig bonus — KUN demo-modus |
| `POST /api/rg/cooloff` `{sessionId, preset}` | Ta en pause / selvutesteng — KUN demo (`409 OPERATOR_MANAGED` i operator-modus) |
| `POST /api/rg/limits` `{sessionId, …}` | Sett tapsgrense/tidsgrense — KUN demo (`409 OPERATOR_MANAGED` i operator-modus) |
| `POST /api/topup` | KUN demo-modus (`WALLET_MODE=mock`) |

**Nye avvisningskoder** (returneres FØR enhver `wallet.debit` → ingen transaksjon opprettes, ingen avstemming):
- `/api/bet`: `LOSS_LIMIT_REACHED`, `TIME_LIMIT_REACHED`, `STAKE_LIMIT`, `COOLOFF_ACTIVE`, `SELF_EXCLUDED`
- `/api/session`: `SELF_EXCLUDED`, `COOLOFF_ACTIVE`, `AGE_NOT_VERIFIED`, `JURISDICTION_BLOCKED`

## Bevisbar rettferdig (commit–reveal)

Et **tillitslag oppå** CSPRNG-en — det erstatter **ikke** RNG-sertifisering fra akkreditert testhus (frøet er fortsatt `crypto.randomBytes(32)`; sertifikat er et konsesjonskrav).

- Hver runde får et `serverSeed` generert **én runde i forveien**. `sha256(serverSeed)` (en *forpliktelse*) publiseres i `hello`- og `round`-hendelsene + `/api/session` **før** innsatsvinduet stenger.
- Trekningen **utledes deterministisk** fra frøet: `HMAC-SHA256(serverSeed, "version:clientSeed:round")` → forventningsrett forkasting (rejection sampling) → delvis Fisher-Yates over 1–20.
- Etter runden **avsløres** `serverSeed` i neste `round`-hendelse og via `GET /api/verify?round=`. Klienten (eller hvem som helst) reberegner tallene og bekrefter at de stemmer med den forhåndspubliserte forpliktelsen.
- Hver runds `serverSeed` + `commit` skrives også til revisjonsloggen. `clientSeed` pinnes per deploy med env `FAIR_CLIENT_SEED` for stabil historisk verifisering. Klientverifisering (SubtleCrypto) krever sikker kontekst (HTTPS). `/api/verify` avslører kun frø for **allerede trukne** runder.

## Rundelivssyklus

1. Innsatsvindu åpent → spillere kjøper (`/api/bet`); hver innsats debiteres umiddelbart
2. Vinduet stenger 1,5 s før trekning (sene kjøp avvises med `WINDOW_CLOSED`;
   kappløp rundt stenging tilbakeføres automatisk)
3. Trekning: 4 av 20 tall, **utledet fra rundens forhåndsforpliktede `serverSeed`**
   (CSPRNG-frø, commit–reveal — se «Bevisbar rettferdig»)
4. Oppgjør per innsats, **hver bong betaler uavhengig**:
   - Jackpot (3 av 3 blant de 3 første trekkene): `50 × innsats` + andel av potten
   - 3 rette (på 4 trekk): `50 × innsats`
   - 2 rette: `5 × innsats`
   - **Premie-boosts** (se under) påvirker KUN den faste multiplikator-delen, aldri potten
5. Gevinster krediteres med `win-{betId}` (idempotent), resultat + saldo hentes av klienten
6. Jackpottene (to nivåer: 2–4 kr og 8–16 kr innsats) er **felles for alle spillere**,
   mates med 2 % av innsatsene i sitt nivå, og deles likt mellom vinnende bonger

## Premie-boosts (Gullbong + Bonusball)

To spennings-mekanikker som **øker RTP** og **utledes fra rundens provably-fair-frø**
(verifiserbare via `GET /api/verify`, ikke manipulerbare). Begge gjelder **kun den faste
multiplikator-delen** av en gevinst (`MULT × innsats`) — **aldri** den delte potten.

- **Gullbong (×2):** i ca. `GULLBONG_FREQ` (25 %) av rundene aktiveres én global bong-plass
  (`gullbongSlot`, lik for alle i den synkroniserte runden). En *vinnende* bong på den plassen
  betaler `×GULLBONG_MULT` (2) på multiplikator-delen. Telegrafert i `round`-hendelsen før trekning.
- **Bonusball (+50 %):** i ca. `BONUSBALL_FREQ` (20 %) av rundene — **ikke hver runde** — trekkes en
  femte gyllen ball (`bonusBall`, 1–20) til slutt. En *vinnende* bong hvis payline inneholder
  bonustallet får `+BONUS_PCT` (50 %) på multiplikator-delen. Ingen bonusball på de andre rundene.

**Utledning** (`deriveExtras`): egen HMAC-SHA256-strøm med `publicInput`-suffiks `:x` (så de 4
tallene fra `deriveDraw` er byte-for-byte uendret). Lesrekkefølge: `gullRoll=u32`,
`gullSlot=below(TICKETS)`, `bonusBall=below(TOTAL)+1`, `bonusRoll=u32`;
`gullActive = ENABLED && gullRoll/2³² < GULLBONG_FREQ`, `bonusActive = ENABLED && bonusRoll/2³² < BONUSBALL_FREQ`.
Alt er heltalls-øre (`Math.floor` på +50 %).

**Verifiserbarhet:** frekvensene ligger i `config.gullbong.freq` / `config.bonusBall.freq` og i
`round`-hendelsen, og `/api/verify` returnerer de rå frø-verdiene (`gullRoll`, `gullSlot`,
`gullbongFreq`, `bonusRoll`, `bonusBallRaw`, `bonusFreq`) — så enhver revisor kan reberegne både
`gullActive`/`gullbongSlot` og `bonusActive`/`bonusBall` fra det avslørte frøet alene. Klienten
reberegner OGSÅ boostsene i nettleseren (`Fair.deriveExtras`).

**RTP-virkning** (se `rtp-sim.js`, Monte-Carlo): fast-premie-RTP **59,7 % → 64,1 %** (+4,4 pp);
inkludert progressiv pott (~+2 pp) ≈ **~66 %**. `RTP_PCT` er satt til **66**. Bonusball gjelder nå kun
~20 % av rundene (ikke hver runde) for å holde RTP nede og gjøre den til et spesial-event. Fortsatt et
**mål** — **RTP-verifikasjon hos akkreditert testhus utestående**, og må kjøres på nytt etter enhver
endring av multiplikatorer/frekvenser. Skru av med `GULLBONG_ENABLED` / `BONUSBALL_ENABLED`.

## Konfigurasjon (env)

| Variabel | Verdi |
|---|---|
| `WALLET_MODE` | `mock` (demo, default) / `operator` (produksjon) |
| `OPERATOR_BASE_URL` | Operatørens wallet-API-base |
| `OPERATOR_API_KEY` / `OPERATOR_SECRET` | Utstedes av operatøren |
| `OPERATOR_LICENCE` | Konsesjonstekst som vises i klientens 18+/lisens-stripe (tom i demo) |
| `FAIR_CLIENT_SEED` | Offentlig roterende klientfrø for «bevisbar rettferdig»; pinnes per deploy for stabil historikk |
| `PORT` | Serveport (settes av vertsmiljøet) |

## Revisjonslogg

Append-only JSONL i `audit/audit-YYYY-MM-DD.jsonl`:
`session_open`, `bet_placed`, `bet_cancelled`, `round` (tall + `commit` + `serverSeed`),
`win_credit` (med breakdown per bong), `jackpot_hit`, `demo_topup`, `daily_bonus`,
`session_blocked` (RG-avvisning ved åpning), `limit_reject` (RG-avvisning ved kjøp),
`rg_cooloff_set`, `rg_limit_set`,
`CRITICAL_credit_failed`, `CRITICAL_rollback_failed`. Sistnevnte to MÅ overvåkes i drift.

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
  selvutestengelse og tvungen sesjonsavslutning må kobles på sesjonsflyten (se under)
- Driftsmiljø med overvåking av `CRITICAL_*`-hendelser, og infrastruktur som
  ikke sover (Render free-tier sover ved inaktivitet — kun for demo)

## Ansvarlig spill — ansvarsdeling (spill vs. operatør)

Spillet **viser og håndhever som raskt UX-lag**, men **operatøren eier sannheten**.

**Spillets ansvar (implementert):** vise grenser/spilletid/reality-check, blokkere
åpning og kjøp ved kjent selvutestengelse/cool-off/alder/jurisdiksjon (defence-in-depth,
feiler lukket i operator-modus), 18+/Hjelpelinjen-stripe alltid synlig, transaksjons­historikk,
og bevisbar-rettferdig-verifisering. Alle RG-avvisninger skjer **før** penger flyttes.

**Operatørens ansvar (IKKE spillets jobb — må på plass for ekte penger):**
- Spillerkonto, KYC og **aldersverifisering** (spillet får kun et `ageVerified`-flagg)
- Selve **innskudds-/tapsgrense-oppsettet** og det **nasjonale selvutestengingsregisteret**
- **Innskudd** flyter aldri gjennom RGS-en → innskuddsgrense håndheves operatørside;
  spillet viser den kun read-only
- **Autoritativ kryss-sesjon tapshovedbok**: single-prosess-RGS-en kan ikke være den varige
  hovedboken. Spillet fører et **estimat i økten** (tap/netto akkumuleres fra innsats − gevinst,
  startet fra operatørens `rg.lossSoFarOre`-baseline) for taps-baren, reality-check og den
  in-game tapsgrensen — dette er **defence-in-depth**. Operatørens lommebok er fasit og **må
  også** avvise debit over grensen. Estimatet nullstilles ved restart (in-memory) og er ikke
  varig logg.

`POST /api/rg/cooloff` og `POST /api/rg/limits` er **kun demo-endepunkter**. I operator-modus
returnerer de `409 OPERATOR_MANAGED` og klienten dyplenker til operatørens RG-sider.

**Demo er ikke etterlevelse:** `WALLET_MODE=mock` oppfyller **ingen** av kravene til reell
aldersverifisering, selvutestenging, grenser, KYC eller AML — det oppretter en fersk
1000-kr-demospiller uten identitet. Etterlevelsespåstander gjelder kun en korrekt koblet
operator-modus. `/api/history` er read-only, sesjons-scoped og begrenset til siste
`KEEP_ROUNDS` i minnet — operatørens kontoutskrift + revisjonslogg er fasit.
