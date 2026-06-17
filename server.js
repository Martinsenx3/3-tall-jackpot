/* ============================================================
   3-TALL — RGS (Remote Game Server)

   Server-authoritative real-money architecture:
   - The server owns rounds, tickets, bets, win evaluation and all
     money movement. The client only renders.
   - Money moves through wallet-adapter.js (mock in demo, the
     operator's wallet in production). ALL amounts are integer øre.
   - One shared round every 22s (crypto RNG), broadcast over SSE.
   - Bets are placed per round, close BET_CUTOFF_MS before the draw.
   - Append-only audit log (JSONL) of every round/bet/payout.

   Run:    node server.js              (demo: WALLET_MODE=mock)
   Prod:   WALLET_MODE=operator OPERATOR_BASE_URL=... node server.js
   ============================================================ */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createWallet, WalletError } = require("./wallet-adapter");

const ROOT = __dirname;
const PORT = process.env.PORT || 8123;

/* ---------- game configuration (amounts in øre) ---------- */
const ROUND_INTERVAL = 22000;
const BET_CUTOFF_MS = 1500;          // betting closes this long before the draw
const TOTAL_NUMBERS = 20;
const DRAWS_PER_ROUND = 4;
const TICKETS_PER_SESSION = 4;
const STAKE_OPTIONS_ORE = [200, 400, 800, 1600];
const MULT_2 = 5;                    // 2 rette  → 5 × innsats
const MULT_3 = 50;                   // 3 rette  → 50 × innsats
const MULT_JP = 50;                  // jackpot  → 50 × innsats + andel av potten

/* ---------- economy boosts (Gullbong + Bonusball) ----------
   BOTH are derived from the round's provably-fair seed (verifiable, not
   manipulable) and applied ONLY to the fixed multiplier part of a win — never
   to the shared progressive pot, so pot integrity is preserved. They RAISE RTP;
   the resulting RTP is computed (see rtp-sim) and surfaced honestly. Re-cert
   required before real money. Tune freq/mult here; all integer-øre math. */
const GULLBONG_ENABLED = true;
const GULLBONG_MULT = 2;             // a winning gullbong pays ×2 on its multiplier part
const GULLBONG_FREQ = 0.25;          // ~1 in 4 rounds is a (telegraphed) gullbong round
const BONUSBALL_ENABLED = true;
const BONUS_PCT = 50;                // +50 % to a winning bong whose payline contains the bonus number
const JACKPOT_TIERS = {
  low:  { seedOre: 25_000,  maxOre: 100_000, stakes: [200, 400] },
  high: { seedOre: 150_000, maxOre: 500_000, stakes: [800, 1600] },
};
const JACKPOT_INCREMENT_RATE = 0.02; // 2 % of stakes feed the pot
const DAILY_BONUS_ORE = 10_000;      // demo-only daily bonus → 100 kr lekepenger
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

/* ---------- responsible gaming (ansvarlig spill) ----------
   In production the OPERATOR owns the player account, limits and the
   self-exclusion register; authenticateSession returns the player's RG state
   and the operator must refuse a launch token for an excluded/under-age player.
   The game RESPECTS those limits + surfaces the UI. In mock mode a working demo
   is implemented (session-scoped). See INTEGRATION.md. */
const RTP_PCT = 69;                          // computed target RTP incl. economy boosts (~67% fixed + ~2pp pot, see rtp-sim.js) — RTP-verification + RNG cert by an accredited test house still PENDING (INTEGRATION.md). Do NOT edit without re-verification.
const AGE_LIMIT = 18;
const JURISDICTION_ALLOWLIST = ["NO"];
const REALITY_CHECK_MS_DEFAULT = 60 * 60 * 1000;   // remind the player every hour (operator-overridable)
const RG_LIMIT_DEFAULTS = { dailyLossOre: 50_000, dailyDepositOre: null, sessionTimeMs: null }; // demo defaults
const COOLOFF_PRESETS_MS = { "15m": 15 * 60 * 1000, "1t": 60 * 60 * 1000, "24t": 24 * 60 * 60 * 1000, "7d": 7 * 24 * 60 * 60 * 1000 };
const HELP_LINE = { name: "Hjelpelinjen for spilleavhengige", phone: "800 800 40", url: "https://hjelpelinjen.no" };
const KEEP_ROUNDS = 30;              // settled rounds kept in memory for /api/state

const wallet = createWallet();

/* ---------- audit log (append-only JSONL) ---------- */
const AUDIT_DIR = path.join(ROOT, "audit");
fs.mkdirSync(AUDIT_DIR, { recursive: true });
function audit(event, data) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...data });
  fs.appendFile(path.join(AUDIT_DIR, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`), line + "\n", (err) => {
    // A swallowed audit write is itself a compliance failure — surface it to the host log.
    if (err) console.error("AUDIT_WRITE_FAILED", event, (data && data.txId) || "", err.message);
  });
}

/* Idempotent wallet-retry queue: failed credit/rollback ops are retried with
   backoff (same txId → the wallet won't move money twice). Survives transient
   wallet outages WITHIN this process; a full crash still needs a DB (see INTEGRATION.md). */
const walletRetry = [];
function enqueueWalletRetry(op, args) {
  walletRetry.push({ op, args, attempts: 0, nextAt: Date.now() + 4000 });
  audit("wallet_retry_enqueued", { op, txId: args.txId });
}
async function processWalletRetry() {
  const now = Date.now();
  for (const item of [...walletRetry]) {
    if (item.nextAt > now) continue;
    try {
      await wallet[item.op](item.args);
      walletRetry.splice(walletRetry.indexOf(item), 1);
      audit("wallet_retry_ok", { op: item.op, txId: item.args.txId, attempts: item.attempts });
    } catch (e) {
      item.attempts += 1;
      item.nextAt = now + Math.min(120000, 4000 * 2 ** item.attempts);
      if (item.attempts >= 14) {
        walletRetry.splice(walletRetry.indexOf(item), 1);
        audit("CRITICAL_wallet_giveup", { op: item.op, txId: item.args.txId, error: e.code || e.message });
      }
    }
  }
}
setInterval(processWalletRetry, 4000);

/* ---------- crypto-strong RNG ---------- */
function shuffled() {
  const a = Array.from({ length: TOTAL_NUMBERS }, (_, i) => i + 1);
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function drawNumbers() { return shuffled().slice(0, DRAWS_PER_ROUND); }
function ticketRow() { return shuffled().slice(0, 3).sort((x, y) => x - y); }
function makeTickets() {
  return Array.from({ length: TICKETS_PER_SESSION }, () => ({ top: ticketRow(), mid: ticketRow(), bottom: ticketRow() }));
}

/* ---------- state ---------- */
const sessions = new Map();      // sid → {playerId, displayName, currency, tickets, lastSeen}
const pendingBets = new Map();   // roundId → Map(sid → bet)   [gradeable bets]
const reservations = new Map();  // roundId → Set(sid)         [non-gradeable double-bet guard]
const settled = new Map();       // roundId → Map(sid → {bet, winOre, breakdown, balanceAfter})
const roundLog = new Map();      // roundId → {numbers, at}
const jackpotsOre = { low: JACKPOT_TIERS.low.seedOre, high: JACKPOT_TIERS.high.seedOre };
let roundNumber = 0;
let nextRoundAt = Date.now() + ROUND_INTERVAL;

function tierOf(stakeOre) { return stakeOre <= 400 ? "low" : "high"; }
// UTC day bucket for the demo daily-loss limit. In production the operator's wallet is the
// loss authority and its timezone/day-boundary definition wins.
function dayKey(ts) { return new Date(ts).toISOString().slice(0, 10); }
function rollLossDay(session, now) {
  const k = dayKey(now);
  if (session.rg && session.rg.lossDayKey !== k) { session.rg.lossDayKey = k; session.rg.lossSoFarOre = 0; session.rg.depositSoFarOre = 0; }
}
// Pure responsible-gaming check for a bet attempt → a {status,error,message,…} to reject, or null to
// allow. NO side effects, so it is safe to call BEFORE the reservation/debit. Can only ever be MORE
// restrictive than the operator wallet, never permit an over-limit debit.
function rgBetReject(session, amountOre, now) {
  const rg = session.rg;
  if (!rg) return null;
  const ex = rg.exclusion || {};
  if (ex.status === "excluded") return { status: 403, error: "SELF_EXCLUDED", message: "Du har selvekskludert deg.", until: ex.until || null, helpLine: HELP_LINE };
  if (ex.status === "cooloff" && ex.until && ex.until > now) return { status: 403, error: "COOLOFF_ACTIVE", message: "Du har en aktiv pause.", until: ex.until, helpLine: HELP_LINE };
  if (rg.limits.sessionTimeMs != null && now - rg.startedAt >= rg.limits.sessionTimeMs) return { status: 403, error: "TIME_LIMIT_REACHED", message: "Du har nådd spilletidsgrensen for denne økten." };
  rollLossDay(session, now);
  if (rg.limits.dailyLossOre != null && rg.lossSoFarOre + amountOre > rg.limits.dailyLossOre) return { status: 403, error: "LOSS_LIMIT_REACHED", message: "Du har nådd tapsgrensen din for i dag." };
  return null;
}
function bettingRound() { return roundNumber + 1; }
function bettingOpen() { return Date.now() < nextRoundAt - BET_CUTOFF_MS; }
function publicJackpots() { return { low: jackpotsOre.low, high: jackpotsOre.high }; }
function touch(session) { session.lastSeen = Date.now(); }

/* ============================================================
   PROVABLY FAIR (commit–reveal) — a transparency layer ON TOP of the CSPRNG.
   Each round gets serverSeed = crypto.randomBytes(32) (still CSPRNG-strong),
   generated one round AHEAD so sha256(serverSeed) can be published BEFORE
   betting closes. The draw is DERIVED deterministically from the seed, so once
   the seed is revealed anyone can recompute it and confirm it matches the
   pre-published commitment. This does NOT replace accredited test-house RNG
   certification — it is an additional, verifiable trust layer.
   ============================================================ */
const FAIR_VERSION = 1;
// Public rotating client seed. Pin via env for stable historical verification across restarts.
const FAIR_CLIENT_SEED = process.env.FAIR_CLIENT_SEED || crypto.randomBytes(16).toString("hex");
const sha256hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
function fairPublicInput(round) { return `${FAIR_VERSION}:${FAIR_CLIENT_SEED}:${round}`; }

// Deterministic byte reader over the concatenation of HMAC-SHA256(serverSeed, `${publicInput}:${block}`)
// for block = 0,1,2,… — reproducible in-browser with SubtleCrypto.
function fairReader(serverSeedBuf, publicInput) {
  let block = 0, buf = Buffer.alloc(0), pos = 0;
  return {
    u32() {
      while (buf.length - pos < 4) {
        const h = crypto.createHmac("sha256", serverSeedBuf).update(`${publicInput}:${block}`).digest();
        block += 1;
        buf = Buffer.concat([buf.subarray(pos), h]); pos = 0;
      }
      const w = buf.readUInt32BE(pos); pos += 4; return w;
    },
  };
}
// Unbiased partial Fisher-Yates → DRAWS_PER_ROUND distinct numbers in 1..TOTAL_NUMBERS (order significant).
function deriveDraw(serverSeedHex, round) {
  const reader = fairReader(Buffer.from(serverSeedHex, "hex"), fairPublicInput(round));
  function below(n) { const limit = Math.floor(0x100000000 / n) * n; let w; do { w = reader.u32(); } while (w >= limit); return w % n; }
  const a = Array.from({ length: TOTAL_NUMBERS }, (_, i) => i + 1);
  const picks = [];
  for (let i = a.length - 1; i > 0 && picks.length < DRAWS_PER_ROUND; i -= 1) {
    const j = below(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
    picks.push(a[i]);
  }
  return picks;
}
// Economy extras (gullbong slot + bonus ball), derived from a SEPARATE keystream
// (publicInput suffix ":x") so the 4-number draw above is byte-for-byte unchanged.
// Raw rolls are seed-only (verifiable); the enabled/freq config is applied on top.
function deriveExtras(serverSeedHex, round) {
  const reader = fairReader(Buffer.from(serverSeedHex, "hex"), `${fairPublicInput(round)}:x`);
  function below(n) { const limit = Math.floor(0x100000000 / n) * n; let w; do { w = reader.u32(); } while (w >= limit); return w % n; }
  const gullRoll = reader.u32();                    // 0..2^32-1
  const gullSlot = below(TICKETS_PER_SESSION);      // 0..TICKETS-1
  const bonusBall = below(TOTAL_NUMBERS) + 1;       // 1..TOTAL_NUMBERS
  const gullActive = GULLBONG_ENABLED && (gullRoll / 0x100000000 < GULLBONG_FREQ);
  return {
    gullRoll, gullSlot, bonusBall,
    gullActive,
    gullbongSlot: gullActive ? gullSlot : -1,
    bonus: BONUSBALL_ENABLED ? bonusBall : null,
  };
}
const seeds = new Map(); // roundId → { serverSeedHex, commitHex }
function ensureSeed(roundId) {
  let s = seeds.get(roundId);
  if (!s) {
    const buf = crypto.randomBytes(32);
    s = { serverSeedHex: buf.toString("hex"), commitHex: sha256hex(buf) };
    seeds.set(roundId, s);
  }
  return s;
}
function commitFor(roundId) { return ensureSeed(roundId).commitHex; }
function fairReveal(roundId) {
  const log = roundLog.get(roundId);
  if (!log || !log.serverSeedHex) return null;
  return { round: roundId, serverSeed: log.serverSeedHex, commit: log.commitHex };
}
ensureSeed(roundNumber + 1); // commit the first betting round before the first hello frame goes out

/* ---------- round engine ---------- */
async function runRound() {
  roundNumber += 1;
  const thisRound = roundNumber;
  // Provably-fair: draw is DERIVED from this round's pre-committed seed (synchronous —
  // no await before settlement, so the 22s cadence and apiBet microtask-atomicity are intact).
  const { serverSeedHex, commitHex } = ensureSeed(thisRound);
  const numbers = deriveDraw(serverSeedHex, thisRound);
  const extras = deriveExtras(serverSeedHex, thisRound);   // gullbong slot + bonus ball (provably-fair)
  const nextCommit = commitFor(thisRound + 1); // commit the next betting round before this broadcast
  nextRoundAt = Date.now() + ROUND_INTERVAL;
  setTimeout(runRound, ROUND_INTERVAL);
  roundLog.set(thisRound, { numbers, at: Date.now(), serverSeedHex, commitHex, clientSeed: FAIR_CLIENT_SEED, version: FAIR_VERSION, extras });

  const bets = pendingBets.get(thisRound) || new Map();
  pendingBets.delete(thisRound);
  reservations.delete(thisRound);
  audit("round", { round: thisRound, numbers, bets: bets.size, commit: commitHex, serverSeed: serverSeedHex, gullbong: extras.gullbongSlot, bonus: extras.bonus });

  /* 1) pots grow from this round's stakes (per tier) */
  for (const bet of bets.values()) {
    const tier = tierOf(bet.stakeOre);
    const growth = Math.floor(bet.stakeOre * bet.activeIdx.length * JACKPOT_INCREMENT_RATE);
    jackpotsOre[tier] = Math.min(JACKPOT_TIERS[tier].maxOre, jackpotsOre[tier] + growth);
  }

  /* 2) find jackpot-winning bongs (3 of 3 within the first three draws) per tier */
  const firstThree = numbers.slice(0, 3);
  const jpWinners = { low: [], high: [] }; // entries: {bet, bongIdx}
  for (const bet of bets.values()) {
    for (const idx of bet.activeIdx) {
      const mid = bet.ticketsSnapshot[idx].mid;
      if (mid.every((n) => firstThree.includes(n))) jpWinners[tierOf(bet.stakeOre)].push({ bet, bongIdx: idx });
    }
  }
  const jpShare = { low: 0, high: 0 };
  for (const tier of ["low", "high"]) {
    const winners = jpWinners[tier];
    if (winners.length > 0) {
      jpShare[tier] = Math.floor(jackpotsOre[tier] / winners.length);
      const remainder = jackpotsOre[tier] - jpShare[tier] * winners.length;
      jackpotsOre[tier] = JACKPOT_TIERS[tier].seedOre + remainder; // re-seed; integer remainder stays in the pot
      audit("jackpot_hit", { round: thisRound, tier, winners: winners.length, shareOre: jpShare[tier] });
    }
  }

  /* 3) evaluate every bet — each bong pays independently */
  const settledThis = new Map();
  const roundWinners = []; // anonymized {amountOre, type} for the social feed
  for (const bet of bets.values()) {
    const tier = tierOf(bet.stakeOre);
    const breakdown = [];
    let winOre = 0;
    for (const idx of bet.activeIdx) {
      const mid = bet.ticketsSnapshot[idx].mid;
      const isJp = mid.every((n) => firstThree.includes(n));
      const hits = mid.filter((n) => numbers.includes(n)).length;
      let type = null, multPart = 0, potPart = 0;
      if (isJp) { type = "jackpot"; multPart = MULT_JP * bet.stakeOre; potPart = jpShare[tier]; }
      else if (hits === 3) { type = "3-rette"; multPart = MULT_3 * bet.stakeOre; }
      else if (hits === 2) { type = "2-rette"; multPart = MULT_2 * bet.stakeOre; }
      if (!type) continue;
      /* Economy boosts apply to the FIXED multiplier part only (never the shared pot), integer øre. */
      const bonusHit = extras.bonus != null && mid.includes(extras.bonus);
      const isGull = extras.gullActive && idx === extras.gullbongSlot;
      let boostOre = 0;
      if (bonusHit) boostOre += Math.floor(multPart * BONUS_PCT / 100);
      if (isGull) boostOre += multPart * (GULLBONG_MULT - 1);
      const amount = multPart + potPart + boostOre;
      winOre += amount;
      breakdown.push({ bong: idx, type, amountOre: amount, ...(isGull ? { gull: true } : {}), ...(bonusHit ? { bonus: true } : {}) });
    }

    let balanceAfter = null;
    if (winOre > 0) {
      const topType = breakdown.some((b) => b.type === "jackpot") ? "jackpot"
        : breakdown.some((b) => b.type === "3-rette") ? "3-rette" : "2-rette";
      roundWinners.push({ amountOre: winOre, type: topType });
      try {
        const receipt = await wallet.credit({
          playerId: bet.playerId,
          amountOre: winOre,
          txId: `win-${bet.betId}`,
          meta: { round: thisRound, betId: bet.betId },
        });
        balanceAfter = receipt.balanceAfter ?? null;
        audit("win_credit", { round: thisRound, betId: bet.betId, playerId: bet.playerId, winOre, breakdown });
      } catch (e) {
        /* A failed win-credit must NEVER be silently lost: log it AND queue an
           idempotent retry (txId win-${betId}) so the player is paid once the
           wallet recovers. */
        audit("CRITICAL_credit_failed", { round: thisRound, betId: bet.betId, playerId: bet.playerId, winOre, error: e.code || e.message });
        enqueueWalletRetry("credit", { playerId: bet.playerId, amountOre: winOre, txId: `win-${bet.betId}`, meta: { round: thisRound, betId: bet.betId } });
      }
    }
    /* Responsible-gaming accounting. Runs AFTER settlement and touches ONLY session.rg —
       never the wallet — so it cannot perturb the idempotent money flow (no new await before
       settlement). Accumulates in BOTH modes so the loss bar / reality-check / in-game loss cap
       track real in-session activity: in operator mode it starts from the operator-provided
       baseline (server-authoritative loss remains the operator wallet's, this is defence-in-depth).
       lossSoFarOre is the DAILY floored loss (for the cap); netOre is the SESSION signed net. */
    {
      const sess = sessions.get(bet.sid);
      if (sess && sess.rg) {
        rollLossDay(sess, Date.now());
        const stakeTotal = bet.stakeOre * bet.activeIdx.length;
        sess.rg.lossSoFarOre = Math.max(0, sess.rg.lossSoFarOre + (stakeTotal - winOre));
        sess.rg.netOre = (sess.rg.netOre || 0) + (winOre - stakeTotal);
      }
    }
    settledThis.set(bet.sid, { bet, winOre, breakdown, balanceAfter });
  }
  settled.set(thisRound, settledThis);

  /* prune memory (include bet/reservation/seed maps in case any slot ever leaked).
     seeds for thisRound+1 (the next betting round) survive — that key is far above the cutoff. */
  for (const m of [settled, roundLog, pendingBets, reservations, seeds]) {
    for (const key of m.keys()) if (key < thisRound - KEEP_ROUNDS) m.delete(key);
  }

  broadcast("round", {
    n: thisRound, numbers, intervalMs: ROUND_INTERVAL, jackpots: publicJackpots(), players: clients.size,
    extras: { gullbongSlot: extras.gullbongSlot, gullMult: GULLBONG_MULT, gullFreq: GULLBONG_FREQ, bonusBall: extras.bonus, bonusPct: BONUS_PCT },
    fair: {
      version: FAIR_VERSION, clientSeed: FAIR_CLIENT_SEED,
      reveal: { round: thisRound, serverSeed: serverSeedHex, commit: commitHex },
      commit: { round: thisRound + 1, commit: nextCommit },
    },
  });

  /* social: aggregate, anonymized results for the live ticker + shared jackpot FX */
  const totalWonOre = roundWinners.reduce((s, w) => s + w.amountOre, 0);
  const biggestOre = roundWinners.reduce((m, w) => Math.max(m, w.amountOre), 0);
  const jpShareMax = Math.max(jpShare.low, jpShare.high);
  broadcast("results", {
    round: thisRound,
    players: clients.size,
    bettors: bets.size,
    winners: roundWinners.length,
    totalWonOre,
    biggestOre,
    feed: roundWinners.sort((a, b) => b.amountOre - a.amountOre).slice(0, 6),
    jackpot: (jpWinners.low.length + jpWinners.high.length) > 0 ? { shareOre: jpShareMax } : null,
  });
  console.log(`[runde ${thisRound}] trakk ${numbers.join(", ")} · ${bets.size} bet(s) · ${roundWinners.length} vinner(e) · ${clients.size} tilkoblet`);
}

/* ---------- SSE ---------- */
const clients = new Set();
function send(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) { /* client gone */ }
}
function broadcast(event, data) { for (const res of clients) send(res, event, data); }
function broadcastPlayers() { broadcast("players", { players: clients.size }); }
setInterval(() => { for (const res of clients) { try { res.write(":ping\n\n"); } catch (e) { /* */ } } }, 20000);

/* ---------- helpers: http ---------- */
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}
function fail(res, status, code, message) { json(res, status, { error: code, message }); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 10_000) { reject(new Error("TOO_LARGE")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("BAD_JSON")); }
    });
    req.on("error", reject);
  });
}

/* very light per-IP rate limit for /api/ */
const rateBuckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + 10_000 }; rateBuckets.set(ip, b); }
  b.count += 1;
  return b.count > 40;
}
setInterval(() => { const now = Date.now(); for (const [ip, b] of rateBuckets) if (now > b.resetAt) rateBuckets.delete(ip); }, 60_000);

function getSession(sid) {
  if (typeof sid !== "string") return null;
  const s = sessions.get(sid);
  if (!s) return null;
  touch(s);
  return s;
}

/* ---------- API handlers ---------- */
async function apiSession(req, res, body) {
  let auth;
  try {
    auth = await wallet.authenticateSession(body.token);
  } catch (e) {
    return fail(res, 401, e.code || "AUTH_FAILED", e.message);
  }

  /* Responsible-gaming launch gates — operator mode only, defence-in-depth on top of the
     operator refusing the token. Fail CLOSED: if the operator omitted age/exclusion we block. */
  const now = Date.now();
  if (wallet.mode === "operator") {
    const ex = (auth.rg && auth.rg.exclusion) || {};
    if (!auth.rg || ex.status === undefined) {
      audit("session_blocked", { playerId: auth.playerId, reason: "rg_missing" });
      return fail(res, 403, "SELF_EXCLUDED", "Spillet kan ikke åpnes (manglende ansvarlig-spill-status).");
    }
    if (ex.status === "excluded" || (ex.status === "cooloff" && ex.until && ex.until > now)) {
      audit("session_blocked", { playerId: auth.playerId, reason: "self_excluded", until: ex.until || null });
      return json(res, 403, { error: "SELF_EXCLUDED", message: "Du har en aktiv pause/selvekskludering.", until: ex.until || null, helpLine: HELP_LINE });
    }
    if (auth.ageVerified !== true) {
      audit("session_blocked", { playerId: auth.playerId, reason: "age" });
      return json(res, 403, { error: "AGE_NOT_VERIFIED", message: `Spillet krever bekreftet alder (${AGE_LIMIT}+).`, helpLine: HELP_LINE });
    }
    // Fail CLOSED like the age/exclusion gates: an unknown jurisdiction is the most-uncertain
    // case and must be blocked, not let through. Operator MUST populate jurisdiction.
    if (!JURISDICTION_ALLOWLIST.includes(auth.jurisdiction)) {
      audit("session_blocked", { playerId: auth.playerId, reason: "jurisdiction", jurisdiction: auth.jurisdiction || null });
      return fail(res, 403, "JURISDICTION_BLOCKED", "Spillet er ikke tilgjengelig i din jurisdiksjon.");
    }
  }

  const authRg = auth.rg || {};
  const limits = {
    dailyLossOre: authRg.limits ? authRg.limits.dailyLossOre ?? null : RG_LIMIT_DEFAULTS.dailyLossOre,
    dailyDepositOre: authRg.limits ? authRg.limits.dailyDepositOre ?? null : RG_LIMIT_DEFAULTS.dailyDepositOre,
    sessionTimeMs: authRg.limits ? authRg.limits.sessionTimeMs ?? null : RG_LIMIT_DEFAULTS.sessionTimeMs,
  };
  const realityCheckMs = authRg.realityCheckMs ?? REALITY_CHECK_MS_DEFAULT;

  const sid = crypto.randomUUID();
  const session = {
    sid,
    playerId: auth.playerId,
    displayName: auth.displayName,
    currency: auth.currency,
    tickets: makeTickets(),
    lastSeen: now,
    rg: {
      limits,
      exclusion: { status: (authRg.exclusion && authRg.exclusion.status) || "none", until: (authRg.exclusion && authRg.exclusion.until) || null },
      realityCheckMs,
      startedAt: now,
      lossDayKey: dayKey(now),
      lossSoFarOre: authRg.lossSoFarOre || 0,      // operator-provided daily baseline in prod; 0 in mock
      depositSoFarOre: authRg.depositSoFarOre || 0,
      netOre: 0,                                   // signed session net (for the reality-check)
    },
  };
  sessions.set(sid, session);
  audit("session_open", { sid, playerId: auth.playerId, mode: wallet.mode });
  let balanceOre = 0;
  try { balanceOre = await wallet.getBalance(auth.playerId); } catch (e) { /* show 0, state refetches */ }
  json(res, 200, {
    sessionId: sid,
    mode: wallet.mode,
    player: { id: auth.playerId, name: auth.displayName },
    currency: auth.currency,
    balanceOre,
    tickets: session.tickets,
    config: {
      stakeOptionsOre: STAKE_OPTIONS_ORE,
      multipliers: { two: MULT_2, three: MULT_3, jackpot: MULT_JP },
      intervalMs: ROUND_INTERVAL,
      betCutoffMs: BET_CUTOFF_MS,
      dailyBonusOre: wallet.mode === "mock" ? DAILY_BONUS_ORE : 0,
      rtpPct: RTP_PCT,
      numbersTotal: TOTAL_NUMBERS,
      drawsPerRound: DRAWS_PER_ROUND,
      ticketsPerSession: TICKETS_PER_SESSION,
      realityCheckMs,
      limits,
      helpLine: HELP_LINE,
      ageLimit: AGE_LIMIT,
      cooloffPresets: Object.keys(COOLOFF_PRESETS_MS),
      rgEditable: wallet.mode === "mock",   // mock: player edits limits in-game; operator: read-only deep-link
      licence: process.env.OPERATOR_LICENCE || "",
      jackpotSeedOre: { low: JACKPOT_TIERS.low.seedOre, high: JACKPOT_TIERS.high.seedOre },
      jackpotMaxOre: { low: JACKPOT_TIERS.low.maxOre, high: JACKPOT_TIERS.high.maxOre },
      gullbong: { enabled: GULLBONG_ENABLED, mult: GULLBONG_MULT, freq: GULLBONG_FREQ },
      bonusBall: { enabled: BONUSBALL_ENABLED, pct: BONUS_PCT },
    },
    rg: { sessionStartedAt: session.rg.startedAt, lossSoFarOre: session.rg.lossSoFarOre, netOre: session.rg.netOre, limits, exclusion: session.rg.exclusion, realityCheckMs },
    fair: {
      version: FAIR_VERSION,
      clientSeed: FAIR_CLIENT_SEED,
      commit: { round: bettingRound(), commit: commitFor(bettingRound()) },
      reveal: fairReveal(roundNumber),
    },
    jackpots: publicJackpots(),
    round: { n: roundNumber, next: bettingRound(), msToNext: Math.max(0, nextRoundAt - Date.now()) },
  });
}

async function apiNewTickets(req, res, body) {
  const session = getSession(body.sessionId);
  if (!session) return fail(res, 401, "NO_SESSION", "Ukjent sesjon");
  const upcoming = pendingBets.get(bettingRound());
  if (upcoming && upcoming.has(session.sid)) return fail(res, 409, "BET_ACTIVE", "Du har et aktivt kjøp — avbryt det først");
  session.tickets = makeTickets();
  json(res, 200, { tickets: session.tickets });
}

// Lykketall: player picks the 3 payline (mid-row) numbers for one bong. Server validates.
async function apiPickNumbers(req, res, body) {
  const session = getSession(body.sessionId);
  if (!session) return fail(res, 401, "NO_SESSION", "Ukjent sesjon");
  const upcoming = pendingBets.get(bettingRound());
  if (upcoming && upcoming.has(session.sid)) return fail(res, 409, "BET_ACTIVE", "Du har et aktivt kjøp — avbryt det først");
  const bong = body.bong;
  if (!Number.isInteger(bong) || bong < 0 || bong >= TICKETS_PER_SESSION) return fail(res, 400, "INVALID_BONG", "Ugyldig bong");
  const nums = Array.isArray(body.numbers) ? body.numbers : [];
  const uniq = [...new Set(nums)];
  if (uniq.length !== 3 || uniq.some((n) => !Number.isInteger(n) || n < 1 || n > TOTAL_NUMBERS)) {
    return fail(res, 400, "INVALID_NUMBERS", "Velg nøyaktig 3 ulike tall (1–20)");
  }
  session.tickets[bong] = { top: ticketRow(), mid: uniq.sort((a, b) => a - b), bottom: ticketRow() };
  json(res, 200, { tickets: session.tickets });
}

async function apiBet(req, res, body) {
  const session = getSession(body.sessionId);
  if (!session) return fail(res, 401, "NO_SESSION", "Ukjent sesjon");

  const stakeOre = body.stakeOre;
  if (!STAKE_OPTIONS_ORE.includes(stakeOre)) return fail(res, 400, "INVALID_STAKE", "Ugyldig innsats");
  const active = Array.isArray(body.active) ? [...new Set(body.active)] : null;
  if (!active || active.length < 1 || active.length > TICKETS_PER_SESSION ||
      active.some((i) => !Number.isInteger(i) || i < 0 || i >= TICKETS_PER_SESSION)) {
    return fail(res, 400, "INVALID_TICKETS", "Ugyldig bong-utvalg");
  }

  if (!bettingOpen()) return fail(res, 409, "WINDOW_CLOSED", "Innsatsvinduet er stengt — prøv neste runde");
  const targetRound = bettingRound();

  if (!pendingBets.has(targetRound)) pendingBets.set(targetRound, new Map());
  if (!reservations.has(targetRound)) reservations.set(targetRound, new Set());
  const roundBets = pendingBets.get(targetRound);
  const roundReserving = reservations.get(targetRound);
  if (roundBets.has(session.sid) || roundReserving.has(session.sid)) {
    return fail(res, 409, "ALREADY_BET", "Du har allerede kjøpt denne runden");
  }

  /* Responsible-gaming gate — PURE, side-effect-free, runs BEFORE any reservation slot or
     wallet.debit. A reject therefore never creates a transaction (no orphaned debit; the
     bet enters neither pendingBets nor reservations → settled XOR refunded still holds). */
  const amountOre = stakeOre * active.length;
  const rgReject = rgBetReject(session, amountOre, Date.now());
  if (rgReject) {
    audit("limit_reject", { playerId: session.playerId, reason: rgReject.error, stakeOre, bongs: active.length });
    return json(res, rgReject.status, { error: rgReject.error, message: rgReject.message, until: rgReject.until || null, helpLine: rgReject.helpLine || null });
  }

  const betId = crypto.randomUUID();

  /* Reserve a NON-gradeable slot to block concurrent double-bets, but do NOT put
     the bet into pendingBets (the map runRound settles) until the debit succeeds
     AND we've confirmed the round hasn't fired. This makes "settled" and "rolled
     back" mutually exclusive: a bet is graded XOR refunded, never both. */
  roundReserving.add(session.sid);

  let receipt;
  try {
    receipt = await wallet.debit({
      playerId: session.playerId,
      amountOre,
      txId: `bet-${betId}`,
      meta: { round: targetRound, stakeOre, bongs: active.length },
    });
  } catch (e) {
    roundReserving.delete(session.sid);
    const status = e.code === "INSUFFICIENT_FUNDS" ? 402 : 502;
    return fail(res, status, e.code || "WALLET_ERROR", e.message);
  }

  /* Atomic re-check: microtask continuation runs to completion before any
     setTimeout(runRound), so the round cannot fire between this check and the
     roundBets.set below. If the round already fired during the debit, the bet
     was NEVER gradeable (never in pendingBets) → refund it. */
  if (roundNumber >= targetRound) {
    roundReserving.delete(session.sid);
    try { await wallet.rollback({ txId: `bet-${betId}` }); }
    catch (e) {
      audit("CRITICAL_rollback_failed", { betId, playerId: session.playerId, txId: `bet-${betId}`, error: e.code || e.message });
      enqueueWalletRetry("rollback", { txId: `bet-${betId}` });
    }
    return fail(res, 409, "WINDOW_CLOSED", "Runden rakk å starte — innsatsen er tilbakeført");
  }

  const bet = {
    betId,
    sid: session.sid,
    playerId: session.playerId,
    roundId: targetRound,
    stakeOre,
    activeIdx: active.slice().sort((a, b) => a - b),
    ticketsSnapshot: session.tickets.map((t) => ({ top: [...t.top], mid: [...t.mid], bottom: [...t.bottom] })),
    placedAt: Date.now(),
  };
  roundBets.set(session.sid, bet);   // now gradeable; runRound cannot have settled it yet
  roundReserving.delete(session.sid);

  audit("bet_placed", { betId, round: targetRound, playerId: session.playerId, stakeOre, bongs: active.length, amountOre });
  json(res, 200, { betId, roundId: targetRound, amountOre, balanceOre: receipt.balanceAfter ?? null });
}

async function apiCancelBet(req, res, body) {
  const session = getSession(body.sessionId);
  if (!session) return fail(res, 401, "NO_SESSION", "Ukjent sesjon");
  const roundBets = pendingBets.get(bettingRound());
  const bet = roundBets ? roundBets.get(session.sid) : null;
  if (!bet || bet.betId !== body.betId) return fail(res, 404, "NO_BET", "Ingen aktiv innsats å avbryte");
  if (!bettingOpen()) return fail(res, 409, "WINDOW_CLOSED", "Innsatsvinduet er stengt — innsatsen står");
  roundBets.delete(session.sid);   // synchronous + within window → bet is no longer gradeable
  let receipt = null;
  try {
    receipt = await wallet.rollback({ txId: `bet-${bet.betId}` });
  } catch (e) {
    /* The bet is already out of the gradeable map; queue the refund (idempotent
       by txId) instead of reinstating it into a possibly-detached round map. */
    audit("CRITICAL_rollback_failed", { betId: bet.betId, playerId: session.playerId, txId: `bet-${bet.betId}`, error: e.code || e.message });
    enqueueWalletRetry("rollback", { txId: `bet-${bet.betId}` });
  }
  audit("bet_cancelled", { betId: bet.betId, round: bet.roundId, playerId: session.playerId, refundQueued: !receipt });
  json(res, 200, { cancelled: bet.betId, balanceOre: receipt ? receipt.balanceAfter : null });
}

async function apiState(req, res, query) {
  const session = getSession(query.get("sessionId"));
  if (!session) return fail(res, 401, "NO_SESSION", "Ukjent sesjon");
  let balanceOre = null;
  try { balanceOre = await wallet.getBalance(session.playerId); } catch (e) { /* leave null */ }
  const roundBets = pendingBets.get(bettingRound());
  const activeBet = roundBets ? roundBets.get(session.sid) || null : null;
  /* most recent settled result for this session (scan back a few rounds) */
  let lastResult = null;
  for (let r = roundNumber; r > roundNumber - 5 && r > 0; r -= 1) {
    const m = settled.get(r);
    if (m && m.has(session.sid)) {
      const s = m.get(session.sid);
      lastResult = { roundId: r, winOre: s.winOre, breakdown: s.breakdown };
      break;
    }
  }
  const now = Date.now();
  if (session.rg) rollLossDay(session, now);
  const rg = session.rg
    ? { sessionStartedAt: session.rg.startedAt, sessionElapsedMs: now - session.rg.startedAt, lossSoFarOre: session.rg.lossSoFarOre, netOre: session.rg.netOre, limits: session.rg.limits, exclusion: session.rg.exclusion, realityCheckMs: session.rg.realityCheckMs }
    : null;
  json(res, 200, {
    balanceOre,
    bet: activeBet ? { betId: activeBet.betId, roundId: activeBet.roundId, stakeOre: activeBet.stakeOre, active: activeBet.activeIdx } : null,
    lastResult,
    rg,
    jackpots: publicJackpots(),
    round: { n: roundNumber, next: bettingRound(), msToNext: Math.max(0, nextRoundAt - Date.now()), bettingOpen: bettingOpen() },
  });
}

async function apiTopup(req, res, body) {
  if (wallet.mode !== "mock") return fail(res, 403, "NOT_AVAILABLE", "Påfyll finnes bare i demo-modus");
  const session = getSession(body.sessionId);
  if (!session) return fail(res, 401, "NO_SESSION", "Ukjent sesjon");
  const receipt = await wallet.credit({
    playerId: session.playerId,
    amountOre: 100_000,
    txId: `topup-${crypto.randomUUID()}`,
    meta: { reason: "demo-topup" },
  });
  audit("demo_topup", { playerId: session.playerId, amountOre: 100_000 });
  json(res, 200, { balanceOre: receipt.balanceAfter });
}

// Daily login bonus — demo only. Once-per-day is gated client-side (ephemeral demo
// players); the per-session guard here just stops a single session from farming it.
async function apiBonus(req, res, body) {
  if (wallet.mode !== "mock") return fail(res, 403, "NOT_AVAILABLE", "Bonus finnes bare i demo-modus");
  const session = getSession(body.sessionId);
  if (!session) return fail(res, 401, "NO_SESSION", "Ukjent sesjon");
  if (session.bonusClaimed) return fail(res, 409, "ALREADY_CLAIMED", "Bonus allerede hentet i denne sesjonen");
  session.bonusClaimed = true;
  const receipt = await wallet.credit({
    playerId: session.playerId,
    amountOre: DAILY_BONUS_ORE,
    txId: `bonus-${crypto.randomUUID()}`,
    meta: { reason: "daily-bonus" },
  });
  audit("daily_bonus", { playerId: session.playerId, amountOre: DAILY_BONUS_ORE });
  json(res, 200, { balanceOre: receipt.balanceAfter, amountOre: DAILY_BONUS_ORE });
}

// Provably-fair verification — public, read-only. Returns the revealed seed + draw for an
// ALREADY-DRAWN round (roundLog only holds settled rounds, so a pending seed is never exposed).
async function apiVerify(req, res, params) {
  const round = Number(params.get("round"));
  if (!Number.isInteger(round) || round < 1) return fail(res, 400, "INVALID_ROUND", "Ugyldig runde");
  const log = roundLog.get(round);
  if (!log || !log.serverSeedHex) return fail(res, 404, "NO_ROUND", "Runden finnes ikke (eller er for gammel)");
  json(res, 200, {
    round,
    version: log.version,
    clientSeed: log.clientSeed,
    publicInput: `${log.version}:${log.clientSeed}:${round}`,
    serverSeed: log.serverSeedHex,
    commit: log.commitHex,
    numbers: log.numbers,
    // raw seed-derived inputs so any auditor can reproduce gullActive = gullRoll/2^32 < gullbongFreq
    extras: log.extras ? {
      gullbongSlot: log.extras.gullbongSlot, gullRoll: log.extras.gullRoll, gullSlot: log.extras.gullSlot,
      gullbongFreq: GULLBONG_FREQ, bonusBall: log.extras.bonus,
    } : null,
    at: log.at,
  });
}

// Transaction history — read-only re-projection of this session's settled bets. SESSION-SCOPED,
// limited to the last KEEP_ROUNDS in memory; the operator account/statement is the system of record.
async function apiHistory(req, res, params) {
  const session = getSession(params.get("sessionId"));
  if (!session) return fail(res, 401, "NO_SESSION", "Ukjent sesjon");
  const limit = Math.max(1, Math.min(30, Number(params.get("limit")) || 20));
  const items = [];
  for (let r = roundNumber; r > roundNumber - KEEP_ROUNDS && r > 0 && items.length < limit; r -= 1) {
    const roundSettled = settled.get(r);
    const entry = roundSettled && roundSettled.get(session.sid);
    if (!entry) continue;
    const log = roundLog.get(r);
    const betAmountOre = entry.bet.stakeOre * entry.bet.activeIdx.length;
    items.push({
      roundId: r,
      at: log ? log.at : null,
      drawn: log ? log.numbers : null,
      stakeOre: entry.bet.stakeOre,
      bongs: entry.bet.activeIdx.length,
      betAmountOre,
      winOre: entry.winOre,
      netOre: entry.winOre - betAmountOre,
      breakdown: entry.breakdown,
    });
  }
  json(res, 200, { items, sessionId: session.sid, returnedThrough: roundNumber, keptRounds: KEEP_ROUNDS });
}

// Self-exclusion / cool-off ("ta en pause"). MOCK ONLY — in production the operator owns the
// self-exclusion register and this returns 409 OPERATOR_MANAGED. No wallet calls; only flips the
// session flag the apiBet/apiSession gates already read.
async function apiCooloff(req, res, body) {
  const session = getSession(body.sessionId);
  if (!session) return fail(res, 401, "NO_SESSION", "Ukjent sesjon");
  if (wallet.mode !== "mock") return fail(res, 409, "OPERATOR_MANAGED", "Pause/selvekskludering settes hos spilltilbyderen din.");
  const preset = body.preset;
  if (preset === "exclude") {
    session.rg.exclusion = { status: "excluded", until: null };
  } else if (COOLOFF_PRESETS_MS[preset]) {
    session.rg.exclusion = { status: "cooloff", until: Date.now() + COOLOFF_PRESETS_MS[preset] };
  } else {
    return fail(res, 400, "INVALID_PRESET", "Ugyldig varighet");
  }
  audit("rg_cooloff_set", { playerId: session.playerId, preset, until: session.rg.exclusion.until });
  json(res, 200, { exclusion: session.rg.exclusion, helpLine: HELP_LINE });
}

// Set responsible-gaming limits. MOCK ONLY — in production these are operator-owned.
async function apiSetLimits(req, res, body) {
  const session = getSession(body.sessionId);
  if (!session) return fail(res, 401, "NO_SESSION", "Ukjent sesjon");
  if (wallet.mode !== "mock") return fail(res, 409, "OPERATOR_MANAGED", "Grenser settes hos spilltilbyderen din.");
  const fields = ["dailyLossOre", "dailyDepositOre", "sessionTimeMs"];
  const next = { ...session.rg.limits };
  for (const f of fields) {
    if (!(f in body)) continue;
    const v = body[f];
    if (v === null) { next[f] = null; continue; }
    if (!Number.isInteger(v) || v < 0) return fail(res, 400, "INVALID_LIMIT", `Ugyldig verdi for ${f}`);
    next[f] = v;
  }
  session.rg.limits = next;
  audit("rg_limit_set", { playerId: session.playerId, limits: next });
  json(res, 200, { limits: next, lossSoFarOre: session.rg.lossSoFarOre });
}

/* session pruning */
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) if (now - s.lastSeen > SESSION_TTL_MS) sessions.delete(sid);
}, 10 * 60 * 1000);

/* ---------- static whitelist ---------- */
const FILES = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  "/script.js": { file: "script.js", type: "text/javascript; charset=utf-8" },
};

/* ---------- http server ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  if (p === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    send(res, "hello", {
      round: roundNumber,
      msToNext: Math.max(0, nextRoundAt - Date.now()),
      intervalMs: ROUND_INTERVAL,
      jackpots: publicJackpots(),
      players: clients.size + 1,
      fair: {
        version: FAIR_VERSION,
        clientSeed: FAIR_CLIENT_SEED,
        commit: { round: bettingRound(), commit: commitFor(bettingRound()) },
        reveal: fairReveal(roundNumber),
      },
    });
    clients.add(res);
    broadcastPlayers();
    req.on("close", () => { clients.delete(res); broadcastPlayers(); });
    return;
  }

  if (p.startsWith("/api/")) {
    // Behind Render's proxy the socket address is the proxy; use the client IP from X-Forwarded-For.
    const xff = req.headers["x-forwarded-for"];
    const ip = (xff ? String(xff).split(",")[0].trim() : req.socket.remoteAddress) || "?";
    if (rateLimited(ip)) return fail(res, 429, "RATE_LIMITED", "For mange forespørsler");
    try {
      if (req.method === "POST") {
        const body = await readBody(req);
        if (p === "/api/session") return await apiSession(req, res, body);
        if (p === "/api/tickets") return await apiNewTickets(req, res, body);
        if (p === "/api/tickets/pick") return await apiPickNumbers(req, res, body);
        if (p === "/api/bet") return await apiBet(req, res, body);
        if (p === "/api/bet/cancel") return await apiCancelBet(req, res, body);
        if (p === "/api/topup") return await apiTopup(req, res, body);
        if (p === "/api/bonus") return await apiBonus(req, res, body);
        if (p === "/api/rg/cooloff") return await apiCooloff(req, res, body);
        if (p === "/api/rg/limits") return await apiSetLimits(req, res, body);
      }
      if (req.method === "GET" && p === "/api/state") return await apiState(req, res, url.searchParams);
      if (req.method === "GET" && p === "/api/verify") return await apiVerify(req, res, url.searchParams);
      if (req.method === "GET" && p === "/api/history") return await apiHistory(req, res, url.searchParams);
      return fail(res, 404, "NOT_FOUND", "Ukjent endepunkt");
    } catch (e) {
      if (e.message === "TOO_LARGE") return fail(res, 413, "TOO_LARGE", "For stor forespørsel");
      if (e.message === "BAD_JSON") return fail(res, 400, "BAD_JSON", "Ugyldig JSON");
      console.error("API-feil:", e);
      return fail(res, 500, "INTERNAL", "Intern feil");
    }
  }

  const entry = FILES[p];
  if (!entry) { res.writeHead(404); res.end("Not found"); return; }
  fs.readFile(path.join(ROOT, entry.file), (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": entry.type, "Cache-Control": "no-cache" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`3-TALL RGS kjører på http://localhost:${PORT}  (wallet: ${wallet.mode})`);
  console.log(`Ny trekning hvert ${ROUND_INTERVAL / 1000}. sekund, innsats stenger ${BET_CUTOFF_MS / 1000}s før.`);
  setTimeout(runRound, ROUND_INTERVAL);
});
