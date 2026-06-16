/* ============================================================
   3-TALL — client (render only)
   The RGS server owns all money: sessions, tickets, bets, wins.
   This client renders the shared draw and talks to the server's
   API for every krone. Amounts from the API are integer øre.
   ============================================================ */
"use strict";

/* ---------- visual timings (~4s per ball, draw ~16s of the 22s round) ---------- */
const REVEAL_MS = 2600;
const DROP_MS = 650;
const BETWEEN_MS = 750;
const SUSPENSE_MS = 1100;
const END_MS = 650;

const BALL_TONES = ["w", "r", "g", "p", "y", "b"];
const MACHINE_BALL_POS = [
  [6, 6, 0], [30, 30, 0.6], [52, 8, 1.1], [70, 34, 1.7], [18, 54, 2.2], [58, 56, 2.8],
];

/* ---------- state (server-fed) ---------- */
let sessionId = null;
let mode = "mock";
let config = { stakeOptionsOre: [200, 400, 800, 1600], multipliers: { two: 5, three: 50, jackpot: 50 }, intervalMs: 22000, betCutoffMs: 1500 };
let myTickets = [];                 // [{top, mid, bottom} × 4] from the server
let activeTickets = [true, true, true, true];
let luckyBongs = [false, false, false, false]; // which bongs the player hand-picked (🍀)
let stakeOre = 800;
let balanceOre = 0;
let jackpots = { low: 0, high: 0 };
let activeBet = null;               // {betId, roundId, stakeOre, active} for the UPCOMING round
let participating = false;          // my bet is in the round being animated
let isDrawing = false;
let busy = false;                   // an API call is in flight
let online = false;
let lastWindowOpen = true;
let drawTimer = null;
let winTimer = null;
let countdownTimer = null;
let nextRoundAt = 0;

/* ---------- elements ---------- */
const jackpotAmountEl = document.getElementById("jackpotAmount");
const jackpotTierEl = document.getElementById("jackpotTier");
const joinButton = document.getElementById("joinButton");
const newTicketsButton = document.getElementById("newTicketsButton");
const drawnNumbersEl = document.getElementById("drawnNumbers");
const revealEl = document.getElementById("revealBall");
const machineEl = document.querySelector(".machine");
const machineBallsEl = document.getElementById("machineBalls");
const hotNumbersEl = document.getElementById("hotNumbers");
const coldNumbersEl = document.getElementById("coldNumbers");
const totalStakeEl = document.getElementById("totalStake");
const playerBalanceEl = document.getElementById("playerBalance");
const countdownEl = document.getElementById("countdown");
const connEl = document.getElementById("conn");
const connTextEl = document.getElementById("connText");
const stakeOptsEl = document.getElementById("stakeOpts");
const tier2El = document.getElementById("tier2");
const tier3El = document.getElementById("tier3");
const tierJpEl = document.getElementById("tierJp");
const winFlashEl = document.getElementById("winFlash");
const winAmountEl = document.getElementById("winAmount");
const winTypeEl = document.getElementById("winType");
const topupButton = document.getElementById("topupButton");
const soundBtn = document.getElementById("soundBtn");
const playersEl = document.getElementById("players");
const playerCountEl = document.getElementById("playerCount");
const tickerTrackEl = document.getElementById("tickerTrack");
const confettiEl = document.getElementById("confetti");
const jpTakeoverEl = document.getElementById("jpTakeover");
const jpTakeoverAmountEl = document.getElementById("jpTakeoverAmount");
let pendingResults = null;
let lastCdSecond = null;

/* ---------- helpers ---------- */
function formatKr(ore) {
  return `${new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 0 }).format(Math.floor(ore / 100))} KR`;
}
function ballTone(n) { return BALL_TONES[(n - 1) % BALL_TONES.length]; }
function activeIdx() { return activeTickets.map((on, i) => (on ? i : -1)).filter((i) => i >= 0); }
function roundStakeOre() { return activeIdx().length * stakeOre; }
function tierOf(s) { return s <= 400 ? "low" : "high"; }
function bettingOpen() { return online && nextRoundAt - Date.now() > config.betCutoffMs; }
function getHitCount(mid, drawn) { return mid.filter((n) => drawn.includes(n)).length; }

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.message || data.error || res.status); err.code = data.error; throw err; }
  return data;
}
const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/* ---------- sound (synthesized Web Audio — no asset files) ---------- */
const Sound = (() => {
  let ctx = null;
  let muted = localStorage.getItem("muted") === "1";
  function ensure() {
    if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) ctx = new AC(); }
    if (ctx && ctx.state === "suspended") ctx.resume();
    return ctx;
  }
  function tone(freq, dur, o = {}) {
    if (muted) return; const c = ensure(); if (!c) return;
    const t = c.currentTime + (o.delay || 0);
    const osc = c.createOscillator(); const g = c.createGain();
    osc.type = o.type || "sine"; osc.frequency.setValueAtTime(freq, t);
    if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(o.slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.gain || 0.18, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(c.destination); osc.start(t); osc.stop(t + dur + 0.03);
  }
  const arp = (freqs, step, o) => freqs.forEach((f, i) => tone(f, (o && o.dur) || 0.3, Object.assign({}, o, { delay: i * step })));
  return {
    resume: ensure,
    get muted() { return muted; },
    toggle() { muted = !muted; localStorage.setItem("muted", muted ? "1" : "0"); if (!muted) ensure(); return muted; },
    click() { tone(420, 0.05, { type: "square", gain: 0.07 }); },
    reveal() { tone(280, 0.95, { type: "sine", gain: 0.1, slideTo: 720 }); },
    land() { tone(170, 0.18, { type: "sine", gain: 0.22, slideTo: 90 }); tone(120, 0.12, { type: "triangle", gain: 0.1 }); },
    heartbeat() { tone(66, 0.16, { type: "sine", gain: 0.3, slideTo: 48 }); tone(66, 0.16, { type: "sine", gain: 0.3, slideTo: 48, delay: 0.26 }); },
    tick() { tone(680, 0.05, { type: "square", gain: 0.09 }); },
    win2() { arp([523, 659], 0.08, { type: "triangle", gain: 0.16, dur: 0.26 }); },
    win3() { arp([523, 659, 784, 1046], 0.085, { type: "triangle", gain: 0.18, dur: 0.32 }); },
    jackpot() { arp([523, 659, 784, 1046, 1318, 1568], 0.11, { type: "sawtooth", gain: 0.15, dur: 0.5 }); arp([262, 330, 392], 0.11, { type: "sine", gain: 0.1, dur: 0.6 }); },
  };
})();

/* ---------- celebration FX + social ---------- */
function spawnConfetti(count, withCoins) {
  const colors = ["#ffd76a", "#ff6b6b", "#5fa8ff", "#7ee29c", "#c595f5", "#fff3c4"];
  for (let k = 0; k < count; k += 1) {
    const el = document.createElement("span");
    const coin = withCoins && Math.random() > 0.55;
    el.className = `cfetti${coin ? " coin" : ""}`;
    if (!coin) el.style.background = colors[Math.floor(Math.random() * colors.length)];
    el.style.left = `${Math.random() * 100}%`;
    el.style.animationDuration = `${1.6 + Math.random() * 1.6}s`;
    el.style.animationDelay = `${Math.random() * 0.4}s`;
    confettiEl.appendChild(el);
    setTimeout(() => el.remove(), 3600);
  }
}
function screenShake() {
  const c = document.getElementById("canvas");
  c.classList.remove("shake"); void c.offsetWidth; c.classList.add("shake");
}
function jackpotTakeover(amountOre, sub) {
  jpTakeoverAmountEl.textContent = formatKr(amountOre);
  document.getElementById("jpTakeoverSub").textContent = sub || "vunnet nå";
  jpTakeoverEl.classList.add("show");
  Sound.jackpot(); spawnConfetti(120, true); screenShake();
  setTimeout(() => jpTakeoverEl.classList.remove("show"), 4200);
}
function pushTicker(feed) {
  if (!feed || !feed.length) return;
  const items = feed.map((w) => {
    const cls = w.type === "jackpot" ? "tick-item jp" : "tick-item";
    const label = w.type === "jackpot" ? "🎰 JACKPOT" : w.type === "3-rette" ? "🎉 3 rette" : "✨ 2 rette";
    return `<span class="${cls}">${label} · <span class="amt">${formatKr(w.amountOre)}</span></span>`;
  }).join("");
  tickerTrackEl.innerHTML = items + items; // duplicate for seamless scroll
}
function setPlayers(n) {
  if (typeof n !== "number") return;
  playerCountEl.textContent = String(n);
  playersEl.hidden = false;
}

/* ---------- info displays ---------- */
function updatePlayerInfo() {
  totalStakeEl.textContent = formatKr(roundStakeOre());
  playerBalanceEl.textContent = formatKr(balanceOre);
  topupButton.hidden = !(mode === "mock" && balanceOre < config.stakeOptionsOre[0]);
}
function updateTierDisplays() {
  tier2El.textContent = formatKr(config.multipliers.two * stakeOre);
  tier3El.textContent = formatKr(config.multipliers.three * stakeOre);
  tierJpEl.textContent = `${formatKr(config.multipliers.jackpot * stakeOre)} +`;
}
function updateJackpotBoard() {
  const tier = tierOf(stakeOre);
  jackpotAmountEl.textContent = new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 0 }).format(Math.floor(jackpots[tier] / 100));
  if (jackpotTierEl) jackpotTierEl.textContent = tier === "low" ? "2–4 KR" : "8–16 KR";
}
function showWinFlash(amountOre, label) {
  if (label === "JACKPOT!") { jackpotTakeover(amountOre, "din gevinst!"); return; }
  winAmountEl.textContent = formatKr(amountOre);
  winTypeEl.textContent = label;
  const big = label === "3 RETTE";
  winFlashEl.classList.toggle("big", big);
  winFlashEl.classList.add("show");
  if (big) { Sound.win3(); spawnConfetti(80, true); screenShake(); }
  else { Sound.win2(); spawnConfetti(28, false); }
  if (winTimer) clearTimeout(winTimer);
  winTimer = setTimeout(() => winFlashEl.classList.remove("show"), 2600);
}

function updateControls() {
  const canPlay = activeIdx().length > 0 && balanceOre >= roundStakeOre();
  const windowOpen = bettingOpen();
  joinButton.classList.toggle("joined", !!activeBet);
  if (busy) joinButton.textContent = "…";
  else if (activeBet) joinButton.textContent = isDrawing ? "KJØPT NESTE ✓" : "KJØPT ✓";
  else if (!windowOpen && online) joinButton.textContent = "STENGT";
  else if (activeIdx().length === 0) joinButton.textContent = "VELG BONG";
  else if (balanceOre < roundStakeOre()) joinButton.textContent = "FOR LAV SALDO";
  else joinButton.textContent = isDrawing ? "KJØP NESTE" : "SPILL";
  joinButton.disabled = busy || !online || (!activeBet && (!canPlay || !windowOpen));
  /* bongs are locked while you have money on the table (bet placed or round running with your bet) */
  const locked = !!activeBet || participating || busy;
  newTicketsButton.disabled = locked;
  stakeOptsEl.querySelectorAll(".stake-opt").forEach((b) => { b.disabled = busy; });
  document.querySelectorAll(".bong .head .pick").forEach((b) => { b.disabled = locked; });
}

/* ---------- hot / cold (visual, from broadcast numbers) ---------- */
let recentRounds = [];
function updateHotColdBoard() {
  const counts = Array.from({ length: 20 }, (_, i) => ({ number: i + 1, count: 0 }));
  recentRounds.forEach((round) => round.forEach((n) => { counts[n - 1].count += 1; }));
  const hot = [...counts].sort((a, b) => b.count - a.count || a.number - b.number).slice(0, 3);
  const cold = [...counts].sort((a, b) => a.count - b.count || a.number - b.number).slice(0, 3);
  hotNumbersEl.innerHTML = hot.map((e) => `<span class="minib h">${e.number}</span>`).join("");
  coldNumbersEl.innerHTML = cold.map((e) => `<span class="minib c">${e.number}</span>`).join("");
}

/* ---------- tickets ---------- */
function renderTickets() {
  myTickets.forEach((ticket, index) => {
    const cells = document.getElementById(`cells-${index}`);
    let html = '<div class="payline"></div>';
    ticket.top.forEach((n) => { html += `<div class="cell dim">${n}</div>`; });
    ticket.mid.forEach((n) => { html += `<div class="cell mid${luckyBongs[index] ? " luck" : ""}" data-n="${n}">${n}</div>`; });
    ticket.bottom.forEach((n) => { html += `<div class="cell dim">${n}</div>`; });
    cells.innerHTML = html;
    const bong = document.querySelector(`.bong[data-bong="${index}"]`);
    bong.classList.toggle("inactive", !activeTickets[index]);
    bong.classList.toggle("has-luck", luckyBongs[index]);
    const toggle = bong.querySelector(".x");
    toggle.textContent = activeTickets[index] ? "✕" : "+";
  });
}
function clearTicketStates() {
  document.querySelectorAll(".bong").forEach((b) => b.classList.remove("near-win"));
  document.querySelectorAll(".cell").forEach((c) => c.classList.remove("hit", "fresh", "miss"));
}
function renderMachineBalls() {
  machineBallsEl.innerHTML = MACHINE_BALL_POS.map((p, i) => {
    return `<div class="ball ${BALL_TONES[i % BALL_TONES.length]}" style="left:${p[0]}%;bottom:${p[1]}%;animation-delay:${p[2]}s"></div>`;
  }).join("");
}
function markHits(drawnNumber, idxs) {
  idxs.forEach((id) => {
    const bong = document.querySelector(`.bong[data-bong="${id}"]`);
    bong.querySelectorAll(`.cell.mid[data-n="${drawnNumber}"]`).forEach((cell) => cell.classList.add("hit", "fresh"));
  });
}
function updateNearWin(drawn, idxs) {
  idxs.forEach((id) => {
    const bong = document.querySelector(`.bong[data-bong="${id}"]`);
    bong.classList.remove("near-win");
    bong.querySelectorAll(".cell.miss").forEach((c) => c.classList.remove("miss"));
    const mid = myTickets[id].mid;
    if (getHitCount(mid, drawn) !== 2) return;
    bong.classList.add("near-win");
    mid.forEach((n) => {
      if (!drawn.includes(n)) {
        const cell = bong.querySelector(`.cell.mid[data-n="${n}"]`);
        if (cell) cell.classList.add("miss");
      }
    });
  });
}
function addDrawnBall(number) {
  const ball = document.createElement("div");
  ball.className = `db pop ${ballTone(number)}`;
  ball.innerHTML = `<span class="face">${number}</span>`;
  drawnNumbersEl.appendChild(ball);
}

/* ---------- the shared draw (server-driven) ---------- */
function runRound(roundId, numbers) {
  if (drawTimer) { clearTimeout(drawTimer); drawTimer = null; }
  const myBet = activeBet && activeBet.roundId === roundId ? activeBet : null;
  if (activeBet && activeBet.roundId < roundId) activeBet = null; // missed round (slept tab) — state refetch below
  if (myBet) activeBet = null;       // consumed by this round
  participating = !!myBet;
  const idxs = myBet ? myBet.active : [];
  isDrawing = true;
  machineEl.classList.add("is-drawing");
  clearTicketStates();
  drawnNumbersEl.innerHTML = "";
  revealEl.className = "reveal";
  revealEl.innerHTML = "";
  updateControls();

  const drawn = [];
  let i = 0;
  let tenseNext = false;
  function step() {
    const n = numbers[i];
    revealEl.className = `reveal ${ballTone(n)}${tenseNext ? " tense" : ""}`;
    revealEl.innerHTML = `<span class="face">${n}</span>`;
    void revealEl.offsetWidth;
    revealEl.classList.add("fill");
    Sound.reveal();
    drawTimer = setTimeout(() => {
      revealEl.classList.remove("fill");
      revealEl.classList.add("drop");
      drawTimer = setTimeout(() => {
        revealEl.className = "reveal";
        revealEl.innerHTML = "";
        drawn.push(n);
        addDrawnBall(n);
        Sound.land();
        if (participating) { markHits(n, idxs); updateNearWin(drawn, idxs); }
        i += 1;
        const near = participating && i < numbers.length && idxs.some((id) => getHitCount(myTickets[id].mid, drawn) === 2);
        tenseNext = near;
        machineEl.classList.toggle("tense", near);
        if (near) Sound.heartbeat();
        if (i < numbers.length) {
          drawTimer = setTimeout(step, near ? SUSPENSE_MS : BETWEEN_MS);
        } else {
          machineEl.classList.remove("tense");
          drawTimer = setTimeout(() => finishRound(roundId), END_MS);
        }
      }, DROP_MS);
    }, REVEAL_MS);
  }
  step();
}

async function finishRound(roundId) {
  isDrawing = false;
  drawTimer = null;
  machineEl.classList.remove("is-drawing");
  const wasParticipating = participating;
  participating = false;
  updateControls();
  try {
    const s = await api(`/api/state?sessionId=${encodeURIComponent(sessionId)}`);
    balanceOre = s.balanceOre ?? balanceOre;
    jackpots = s.jackpots;
    if (s.bet) activeBet = { betId: s.bet.betId, roundId: s.bet.roundId, stakeOre: s.bet.stakeOre, active: s.bet.active };
    updatePlayerInfo();
    updateJackpotBoard();
    updateControls();
    const iWonJackpot = wasParticipating && s.lastResult && s.lastResult.roundId === roundId
      && s.lastResult.breakdown.some((b) => b.type === "jackpot");
    if (wasParticipating && s.lastResult && s.lastResult.roundId === roundId && s.lastResult.winOre > 0) {
      const types = s.lastResult.breakdown.map((b) => b.type);
      const label = types.includes("jackpot") ? "JACKPOT!" : types.includes("3-rette") ? "3 RETTE" : "2 RETTE";
      showWinFlash(s.lastResult.winOre, label);
    }
    /* social results for THIS round, applied now (in sync with the draw, not at round start) */
    if (pendingResults && pendingResults.round === roundId) {
      setPlayers(pendingResults.players);
      pushTicker(pendingResults.feed);
      if (pendingResults.jackpot && !iWonJackpot) jackpotTakeover(pendingResults.jackpot.shareOre, "vunnet i runden!");
      pendingResults = null;
    }
  } catch (e) { /* next state fetch heals */ }
}

/* ---------- actions ---------- */
async function toggleBuy() {
  if (busy || !online) return;
  busy = true; updateControls();
  try {
    if (activeBet) {
      const d = await post("/api/bet/cancel", { sessionId, betId: activeBet.betId });
      activeBet = null;
      if (d.balanceOre !== null) balanceOre = d.balanceOre;
    } else {
      const d = await post("/api/bet", { sessionId, stakeOre, active: activeIdx() });
      activeBet = { betId: d.betId, roundId: d.roundId, stakeOre, active: activeIdx() };
      if (d.balanceOre !== null) balanceOre = d.balanceOre;
    }
  } catch (e) {
    await refreshState();
  }
  busy = false;
  updatePlayerInfo();
  updateControls();
}

async function setStake(value) {
  if (busy || !config.stakeOptionsOre.includes(value)) return;
  const hadBet = !!activeBet;
  busy = true; updateControls();
  try {
    if (hadBet) {
      const d = await post("/api/bet/cancel", { sessionId, betId: activeBet.betId });
      activeBet = null;
      if (d.balanceOre !== null) balanceOre = d.balanceOre;
    }
    stakeOre = value;
    if (hadBet) {
      const d = await post("/api/bet", { sessionId, stakeOre, active: activeIdx() });
      activeBet = { betId: d.betId, roundId: d.roundId, stakeOre, active: activeIdx() };
      if (d.balanceOre !== null) balanceOre = d.balanceOre;
    }
  } catch (e) {
    await refreshState();
  }
  busy = false;
  stakeOptsEl.querySelectorAll(".stake-opt").forEach((b) => b.classList.toggle("is-active", Number(b.dataset.stake) * 100 === stakeOre));
  updateTierDisplays();
  updateJackpotBoard();
  updatePlayerInfo();
  updateControls();
}

async function newTickets() {
  if (busy || activeBet || participating) return;
  busy = true; updateControls();
  try {
    const d = await post("/api/tickets", { sessionId });
    myTickets = d.tickets;
    activeTickets = [true, true, true, true];
    luckyBongs = [false, false, false, false];
    renderTickets();
    clearTicketStates();
  } catch (e) { /* keep current */ }
  busy = false;
  updatePlayerInfo();
  updateControls();
}

function toggleTicket(index) {
  if (busy || activeBet || participating) return;
  if (activeTickets[index] && activeIdx().length === 1) return;
  activeTickets[index] = !activeTickets[index];
  renderTickets();
  clearTicketStates();
  updatePlayerInfo();
  updateControls();
}

async function topup() {
  if (busy) return;
  busy = true; updateControls();
  try {
    const d = await post("/api/topup", { sessionId });
    balanceOre = d.balanceOre;
  } catch (e) { /* */ }
  busy = false;
  updatePlayerInfo();
  updateControls();
}

async function refreshState() {
  try {
    const s = await api(`/api/state?sessionId=${encodeURIComponent(sessionId)}`);
    balanceOre = s.balanceOre ?? balanceOre;
    jackpots = s.jackpots;
    activeBet = s.bet ? { betId: s.bet.betId, roundId: s.bet.roundId, stakeOre: s.bet.stakeOre, active: s.bet.active } : null;
    updatePlayerInfo();
    updateJackpotBoard();
  } catch (e) { /* */ }
}

joinButton.addEventListener("click", () => { Sound.click(); toggleBuy(); });
newTicketsButton.addEventListener("click", () => { Sound.click(); newTickets(); });
topupButton.addEventListener("click", () => { Sound.click(); topup(); });
document.querySelectorAll("[data-toggle]").forEach((btn) => {
  btn.addEventListener("click", () => { Sound.click(); toggleTicket(Number(btn.dataset.toggle)); });
});
stakeOptsEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".stake-opt");
  if (btn && !btn.disabled) { Sound.click(); setStake(Number(btn.dataset.stake) * 100); }
});
soundBtn.addEventListener("click", () => {
  const m = Sound.toggle();
  soundBtn.textContent = m ? "🔇" : "🔊";
  soundBtn.classList.toggle("muted", m);
  if (!m) Sound.click();
});

/* ============================================================
   WAVE 3 — Lykketall picker · onboarding · daily bonus
   ============================================================ */
function openModal(el) { el.hidden = false; }
function closeModal(el) { el.hidden = true; }
function bongLocked() { return !!activeBet || participating || busy; }

/* ---- Lykketall: pick your own 3 payline numbers per bong ---- */
const pickerEl = document.getElementById("picker");
const pickGridEl = document.getElementById("pickGrid");
const pickCountEl = document.getElementById("pickCount");
const pickConfirmEl = document.getElementById("pickConfirm");
const pickTitleEl = document.getElementById("pickTitle");
let pickBong = -1;
let pickSel = [];

document.querySelectorAll(".bong").forEach((bong) => {
  const id = Number(bong.dataset.bong);
  const head = bong.querySelector(".head");
  const btn = document.createElement("button");
  btn.className = "pick"; btn.type = "button"; btn.textContent = "✎";
  btn.title = "Velg lykketall";
  btn.setAttribute("aria-label", `Velg lykketall for bong ${id + 1}`);
  head.insertBefore(btn, head.querySelector(".x"));
  btn.addEventListener("click", () => { Sound.click(); openPicker(id); });
});

function openPicker(bong) {
  if (bongLocked()) return;
  pickBong = bong;
  pickSel = [...((myTickets[bong] && myTickets[bong].mid) || [])];
  pickTitleEl.textContent = `Bong ${bong + 1} — velg 3 lykketall`;
  renderPickGrid();
  openModal(pickerEl);
}
function renderPickGrid() {
  let html = "";
  for (let n = 1; n <= 20; n += 1) {
    const sel = pickSel.includes(n);
    const dis = !sel && pickSel.length >= 3;
    html += `<button class="pick-num${sel ? " sel" : ""}" type="button" data-n="${n}"${dis ? " disabled" : ""}>${n}</button>`;
  }
  pickGridEl.innerHTML = html;
  pickCountEl.textContent = String(pickSel.length);
  pickConfirmEl.disabled = pickSel.length !== 3;
}
pickGridEl.addEventListener("click", (e) => {
  const b = e.target.closest(".pick-num");
  if (!b || b.disabled) return;
  const n = Number(b.dataset.n);
  if (pickSel.includes(n)) pickSel = pickSel.filter((x) => x !== n);
  else if (pickSel.length < 3) pickSel.push(n);
  Sound.click(); renderPickGrid();
});
document.getElementById("pickRandom").addEventListener("click", () => {
  const pool = Array.from({ length: 20 }, (_, i) => i + 1);
  pickSel = [];
  while (pickSel.length < 3) pickSel.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  Sound.click(); renderPickGrid();
});
pickConfirmEl.addEventListener("click", async () => {
  if (pickSel.length !== 3 || pickBong < 0 || bongLocked()) return;
  const bong = pickBong;
  pickConfirmEl.disabled = true;
  try {
    const d = await post("/api/tickets/pick", { sessionId, bong, numbers: pickSel });
    myTickets = d.tickets;
    luckyBongs[bong] = true;
    renderTickets(); clearTicketStates(); updatePlayerInfo();
    Sound.land();
    closeModal(pickerEl);
  } catch (e) { pickConfirmEl.disabled = false; }
});
document.getElementById("pickClose").addEventListener("click", () => { Sound.click(); closeModal(pickerEl); });

/* ---- onboarding: "Slik spiller du" ---- */
const introEl = document.getElementById("intro");
function closeIntro() { closeModal(introEl); try { localStorage.setItem("seenIntro", "1"); } catch (e) {} }
document.getElementById("helpBtn").addEventListener("click", () => { Sound.click(); openModal(introEl); });
document.getElementById("introClose").addEventListener("click", () => { Sound.click(); closeIntro(); });
document.getElementById("introCta").addEventListener("click", () => { Sound.click(); closeIntro(); });
function maybeShowIntro() {
  let seen = false;
  try { seen = localStorage.getItem("seenIntro") === "1"; } catch (e) {}
  if (!seen) openModal(introEl);
}

/* ---- daily bonus (demo only) ---- */
const bonusEl = document.getElementById("bonus");
function dayKey() { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
function yesterdayKey() { const d = new Date(Date.now() - 864e5); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
function renderStreak(streak) {
  const box = document.getElementById("streak");
  let html = "";
  for (let i = 0; i < 7; i += 1) {
    const on = i < streak ? "on" : "";
    const today = i === streak ? "today" : "";
    html += `<div class="day ${on} ${today}">${i + 1}</div>`;
  }
  box.innerHTML = html;
}
function maybeShowBonus() {
  if (mode !== "mock" || !config.dailyBonusOre) return;
  let last = null, streak = 0;
  try { last = localStorage.getItem("bonusDay"); streak = Number(localStorage.getItem("bonusStreak") || "0"); } catch (e) {}
  if (last === dayKey()) return;                 // already claimed today
  if (last !== yesterdayKey()) streak = 0;        // streak broken
  document.getElementById("bonusAmount").textContent = formatKr(config.dailyBonusOre);
  renderStreak(streak);
  openModal(bonusEl);
}
document.getElementById("bonusClaim").addEventListener("click", async () => {
  const btn = document.getElementById("bonusClaim");
  btn.disabled = true;
  try {
    const d = await post("/api/bonus", { sessionId });
    balanceOre = d.balanceOre;
    let streak = 0;
    try { streak = Number(localStorage.getItem("bonusStreak") || "0"); } catch (e) {}
    if (localStorageGet("bonusDay") !== yesterdayKey()) streak = 0;
    streak = Math.min(7, streak + 1);
    try { localStorage.setItem("bonusDay", dayKey()); localStorage.setItem("bonusStreak", String(streak)); } catch (e) {}
    updatePlayerInfo();
    Sound.win2(); spawnConfetti(40, true);
  } catch (e) { /* if already claimed, just close */ }
  btn.disabled = false;
  closeModal(bonusEl);
});
function localStorageGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

/* ---------- connection + countdown ---------- */
function setConn(isOnline, text) {
  online = isOnline;
  connEl.classList.toggle("online", isOnline);
  connEl.classList.toggle("offline", !isOnline);
  connTextEl.textContent = text;
}
function updateCountdown() {
  const stat = countdownEl.closest(".stat");
  if (isDrawing) {
    countdownEl.textContent = "trekker";
    stat.classList.add("drawing");
    stat.classList.remove("soon");
    return;
  }
  stat.classList.remove("drawing");
  if (!online) {
    countdownEl.textContent = "–";
    stat.classList.remove("soon");
    return;
  }
  const ms = Math.max(0, nextRoundAt - Date.now());
  const s = Math.ceil(ms / 1000);
  countdownEl.textContent = nextRoundAt ? `${s} s` : "–";
  stat.classList.toggle("soon", s <= 3 && ms > 0);
  if (s !== lastCdSecond) { lastCdSecond = s; if (s >= 1 && s <= 3 && ms > 0) Sound.tick(); }
  const open = bettingOpen();
  if (open !== lastWindowOpen) { lastWindowOpen = open; updateControls(); }
}
function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(updateCountdown, 200);
  updateCountdown();
}

function connect() {
  setConn(false, "Kobler til…");
  const source = new EventSource("/events");
  source.addEventListener("hello", (e) => {
    const d = JSON.parse(e.data);
    nextRoundAt = Date.now() + d.msToNext;
    jackpots = d.jackpots;
    updateJackpotBoard();
    setPlayers(d.players);
    setConn(true, "Tilkoblet");
    refreshState();
  });
  source.addEventListener("round", (e) => {
    const d = JSON.parse(e.data);
    nextRoundAt = Date.now() + d.intervalMs;
    jackpots = d.jackpots;
    updateJackpotBoard();
    setPlayers(d.players);
    setConn(true, "Tilkoblet");
    recentRounds.unshift([...d.numbers]);
    recentRounds = recentRounds.slice(0, 10);
    updateHotColdBoard();
    runRound(d.n, d.numbers);
  });
  source.addEventListener("players", (e) => { setPlayers(JSON.parse(e.data).players); });
  source.addEventListener("results", (e) => {
    // hold until the local draw finishes (finishRound) so we don't spoil the reveal
    pendingResults = JSON.parse(e.data);
    setPlayers(pendingResults.players);
  });
  source.onopen = () => setConn(true, "Tilkoblet");
  source.onerror = () => setConn(false, "Kobler til på nytt…");
}

/* ---------- boot ---------- */
async function boot() {
  try {
    const d = await post("/api/session", {});
    sessionId = d.sessionId;
    mode = d.mode;
    config = d.config;
    balanceOre = d.balanceOre;
    myTickets = d.tickets;
    jackpots = d.jackpots;
    nextRoundAt = Date.now() + d.round.msToNext;
    if (mode === "mock") {
      const saldoLabel = playerBalanceEl.closest(".stat").querySelector(".k");
      if (saldoLabel) saldoLabel.textContent = "SALDO · DEMO";
    }
    soundBtn.textContent = Sound.muted ? "🔇" : "🔊";
    soundBtn.classList.toggle("muted", Sound.muted);
    renderTickets();
    renderMachineBalls();
    updatePlayerInfo();
    updateTierDisplays();
    updateJackpotBoard();
    updateControls();
    startCountdown();
    connect();
    maybeShowIntro();
    if (introEl.hidden) maybeShowBonus();   // first-time players see the guide; returning players get the bonus
  } catch (e) {
    setConn(false, "Får ikke kontakt med spillserveren");
    setTimeout(boot, 4000);
  }
}

/* ============================================================
   VISUAL SCAFFOLDING (canvas scale, sparkles, coins, bulbs, theme)
   ============================================================ */
(function fitCanvas() {
  const canvas = document.getElementById("canvas");
  const mobile = window.matchMedia("(max-width: 820px)");
  function fit() {
    if (mobile.matches) { canvas.style.transform = "none"; return; } // mobile uses the reflowed vertical layout
    const s = Math.min(window.innerWidth / 1600, window.innerHeight / 1000);
    canvas.style.transform = `scale(${s})`;
  }
  window.addEventListener("resize", fit);
  if (mobile.addEventListener) mobile.addEventListener("change", () => { fit(); placeBulbs(); });
  fit();
})();

(function sparkles() {
  const box = document.getElementById("sparkles");
  for (let i = 0; i < 58; i += 1) {
    const s = document.createElement("span");
    s.className = "spark";
    const sz = Math.random() * 2.6 + 1;
    s.style.width = `${sz}px`; s.style.height = `${sz}px`;
    s.style.left = `${Math.random() * 100}%`; s.style.top = `${Math.random() * 92}%`;
    const gold = Math.random() > 0.4;
    s.style.background = gold ? "#ffe19a" : "var(--neon)";
    s.style.boxShadow = `0 0 6px 1px ${gold ? "rgba(255,221,138,.8)" : "var(--neon)"}`;
    s.style.animationDelay = `${Math.random() * 3.6}s`;
    s.style.animationDuration = `${2.4 + Math.random() * 2.6}s`;
    box.appendChild(s);
  }
})();

(function coins() {
  const box = document.getElementById("coins");
  const spots = [[3, 12, 0.85, 1], [93, 8, 0.7, 1.08], [1.5, 40, 0.6, 0.78], [95.5, 46, 0.62, 0.92], [88, 86, 0.55, 0.7], [7, 86, 0.5, 0.66]];
  spots.forEach((p, i) => {
    const c = document.createElement("div");
    c.className = "coin";
    c.style.left = `calc(${p[0]}% - 39px)`; c.style.top = `calc(${p[1]}% - 39px)`;
    c.style.transform = `scale(${p[3]})`; c.style.opacity = p[2];
    c.style.filter = `blur(${p[2] < 0.6 ? 1.2 : 0}px)`;
    c.style.animationDelay = `${i * 0.8}s`; c.style.animationDuration = `${6 + i}s`;
    box.appendChild(c);
  });
})();

function placeBulbs() {
  const jp = document.querySelector(".jackpot");
  const holder = document.getElementById("bulbs");
  if (!jp || !holder) return;
  holder.innerHTML = "";
  const w = jp.offsetWidth, h = jp.offsetHeight;
  if (!w || !h) return;
  const gap = 33, pts = [];
  for (let x = 18; x <= w - 18; x += gap) { pts.push([x, 3]); pts.push([x, h - 3]); }
  for (let y = 24; y <= h - 24; y += gap) { pts.push([3, y]); pts.push([w - 3, y]); }
  pts.forEach((p) => {
    const b = document.createElement("span");
    b.className = "bulb";
    b.style.left = `${p[0]}px`; b.style.top = `${p[1]}px`;
    b.style.animationDelay = `${(((p[0] + p[1]) / 90) % 1.4).toFixed(2)}s`;
    holder.appendChild(b);
  });
}
window.addEventListener("resize", placeBulbs);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(placeBulbs);
setTimeout(placeBulbs, 120); setTimeout(placeBulbs, 600);

(function themeSwitcher() {
  const sw = document.getElementById("themeSwitcher");
  sw.addEventListener("click", (e) => {
    const btn = e.target.closest(".theme-dot");
    if (!btn) return;
    document.documentElement.dataset.theme = btn.dataset.theme;
    sw.querySelectorAll(".theme-dot").forEach((d) => d.classList.toggle("is-active", d === btn));
  });
})();

boot();
