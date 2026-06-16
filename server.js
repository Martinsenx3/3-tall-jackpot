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
const JACKPOT_TIERS = {
  low:  { seedOre: 25_000,  maxOre: 100_000, stakes: [200, 400] },
  high: { seedOre: 150_000, maxOre: 500_000, stakes: [800, 1600] },
};
const JACKPOT_INCREMENT_RATE = 0.02; // 2 % of stakes feed the pot
const DAILY_BONUS_ORE = 10_000;      // demo-only daily bonus → 100 kr lekepenger
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
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
function bettingRound() { return roundNumber + 1; }
function bettingOpen() { return Date.now() < nextRoundAt - BET_CUTOFF_MS; }
function publicJackpots() { return { low: jackpotsOre.low, high: jackpotsOre.high }; }
function touch(session) { session.lastSeen = Date.now(); }

/* ---------- round engine ---------- */
async function runRound() {
  roundNumber += 1;
  const thisRound = roundNumber;
  const numbers = drawNumbers();
  nextRoundAt = Date.now() + ROUND_INTERVAL;
  setTimeout(runRound, ROUND_INTERVAL);
  roundLog.set(thisRound, { numbers, at: Date.now() });

  const bets = pendingBets.get(thisRound) || new Map();
  pendingBets.delete(thisRound);
  reservations.delete(thisRound);
  audit("round", { round: thisRound, numbers, bets: bets.size });

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
      if (isJp) {
        const amount = MULT_JP * bet.stakeOre + jpShare[tier];
        winOre += amount;
        breakdown.push({ bong: idx, type: "jackpot", amountOre: amount });
      } else if (hits === 3) {
        winOre += MULT_3 * bet.stakeOre;
        breakdown.push({ bong: idx, type: "3-rette", amountOre: MULT_3 * bet.stakeOre });
      } else if (hits === 2) {
        winOre += MULT_2 * bet.stakeOre;
        breakdown.push({ bong: idx, type: "2-rette", amountOre: MULT_2 * bet.stakeOre });
      }
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
    settledThis.set(bet.sid, { bet, winOre, breakdown, balanceAfter });
  }
  settled.set(thisRound, settledThis);

  /* prune memory (include bet/reservation maps in case any slot ever leaked) */
  for (const m of [settled, roundLog, pendingBets, reservations]) {
    for (const key of m.keys()) if (key < thisRound - KEEP_ROUNDS) m.delete(key);
  }

  broadcast("round", { n: thisRound, numbers, intervalMs: ROUND_INTERVAL, jackpots: publicJackpots(), players: clients.size });

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
  const sid = crypto.randomUUID();
  const session = {
    sid,
    playerId: auth.playerId,
    displayName: auth.displayName,
    currency: auth.currency,
    tickets: makeTickets(),
    lastSeen: Date.now(),
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

  const betId = crypto.randomUUID();
  const amountOre = stakeOre * active.length;

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
  json(res, 200, {
    balanceOre,
    bet: activeBet ? { betId: activeBet.betId, roundId: activeBet.roundId, stakeOre: activeBet.stakeOre, active: activeBet.activeIdx } : null,
    lastResult,
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
      }
      if (req.method === "GET" && p === "/api/state") return await apiState(req, res, url.searchParams);
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
