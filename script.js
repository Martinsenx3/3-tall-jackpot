/* ============================================================
   3-TALL — MULTIPLAYER client
   The server (server.js) is the source of truth for the draw:
   one round every 10s, same numbers broadcast to everyone over SSE.
   This client just listens, animates the shared draw, and scores
   its own local bongs / balance / jackpots.
   ============================================================ */
"use strict";

const TOTAL_NUMBERS = 20;
const TICKETS_COUNT = 4;
const TICKET_SIZE = 3;        // the payline (middle row)
const DRAWS_PER_ROUND = 4;
const STAKE_OPTIONS = [2, 4, 8, 16];
const MULT_2 = 5;
const MULT_3 = 50;
const MULT_JP = 50;
let stakePerTicket = 8;
const HISTORY_LIMIT = 10;

const JACKPOT_TIERS = {
  low:  { seed: 250,  max: 1000, label: "2–4 KR" },
  high: { seed: 1500, max: 5000, label: "8–16 KR" },
};
const JACKPOT_INCREMENT_RATE = 0.02;

// per-ball animation timings — ~4s per ball, draw ~16s, fits the 22s round
const REVEAL_MS = 2600;  // ball slowly fills the sphere + holds
const DROP_MS = 650;     // then drops down into the tray
const BETWEEN_MS = 750;
const SUSPENSE_MS = 1100;
const END_MS = 650;

const BALL_TONES = ["w", "r", "g", "p", "y", "b"];
const MACHINE_BALL_POS = [
  [6, 6, 0], [30, 30, 0.6], [52, 8, 1.1], [70, 34, 1.7], [18, 54, 2.2], [58, 56, 2.8],
];

/* ---------- state ---------- */
let jackpots = { low: JACKPOT_TIERS.low.seed, high: JACKPOT_TIERS.high.seed };
let tickets = [];
let activeTickets = Array.from({ length: TICKETS_COUNT }, () => true);
let isDrawing = false;
let participating = false;    // am I bought into the round being drawn right now?
let readyForNext = false;     // must press SPILL each round — no autoplay
let online = false;
let playerBalance = 1000;
const TOPUP_AMOUNT = 1000;
const MIN_STAKE = STAKE_OPTIONS[0];
let recentRounds = [];
let drawTimer = null;
let winTimer = null;
let countdownTimer = null;
let nextRoundAt = 0;          // timestamp the next server round fires
let source = null;           // EventSource

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

/* ---------- helpers ---------- */
function formatKr(value) {
  return `${new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 0 }).format(value)} KR`;
}
function sampleUniqueNumbers(count, max) {
  const numbers = Array.from({ length: max }, (_, i) => i + 1);
  for (let i = numbers.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
  }
  return numbers.slice(0, count).sort((a, b) => a - b);
}
function ballTone(n) { return BALL_TONES[(n - 1) % BALL_TONES.length]; }
function getActiveTicketCount() { return activeTickets.filter(Boolean).length; }
function getRoundStake() { return getActiveTicketCount() * stakePerTicket; }
function hasEnoughBalance() { return playerBalance >= getRoundStake(); }
function getHitCount(mid, drawn) { return mid.filter((n) => drawn.includes(n)).length; }
function jackpotTier() { return stakePerTicket <= 4 ? "low" : "high"; }

/* ---------- info ---------- */
function updatePlayerInfo() {
  totalStakeEl.textContent = formatKr(getRoundStake());
  playerBalanceEl.textContent = formatKr(playerBalance);
  // Out of money (can't afford even 1 bong at min stake)? Offer demo top-up.
  topupButton.hidden = playerBalance >= MIN_STAKE;
}
function updateTierDisplays() {
  tier2El.textContent = formatKr(MULT_2 * stakePerTicket);
  tier3El.textContent = formatKr(MULT_3 * stakePerTicket);
  tierJpEl.textContent = `${formatKr(MULT_JP * stakePerTicket)} +`;
}
function updateJackpotBoard() {
  const tier = jackpotTier();
  jackpotAmountEl.textContent = new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 0 }).format(jackpots[tier]);
  if (jackpotTierEl) jackpotTierEl.textContent = JACKPOT_TIERS[tier].label;
}
function setStake(value) {
  // Allowed mid-draw too: the running round's prizes use the snapshot taken at its start,
  // so changing stake here only affects the NEXT round you buy.
  if (!STAKE_OPTIONS.includes(value)) return;
  stakePerTicket = value;
  stakeOptsEl.querySelectorAll(".stake-opt").forEach((b) => b.classList.toggle("is-active", Number(b.dataset.stake) === value));
  updateTierDisplays();
  updateJackpotBoard();
  updatePlayerInfo();
  updateControls();
}
function showWinFlash(amount, label) {
  winAmountEl.textContent = formatKr(amount);
  winTypeEl.textContent = label;
  winFlashEl.classList.add("show");
  if (winTimer) clearTimeout(winTimer);
  winTimer = setTimeout(() => winFlashEl.classList.remove("show"), 2600);
}

function updateControls() {
  // The SPILL button always buys the NEXT round — usable while spectating AND mid-draw.
  const canPlay = getActiveTicketCount() > 0 && hasEnoughBalance();
  joinButton.classList.toggle("joined", readyForNext);
  joinButton.classList.remove("locked");
  if (readyForNext) joinButton.textContent = isDrawing ? "KJØPT NESTE ✓" : "KJØPT ✓";
  else if (getActiveTicketCount() === 0) joinButton.textContent = "VELG BONG";
  else if (!hasEnoughBalance()) joinButton.textContent = "FOR LAV SALDO";
  else joinButton.textContent = isDrawing ? "KJØP NESTE" : "SPILL";
  joinButton.disabled = !readyForNext && !canPlay;
  // Bongs are locked only while YOUR round is being drawn (hit marks live on the cells).
  // Spectators may regenerate/toggle freely; stake may change at any time (snapshotted per round).
  newTicketsButton.disabled = isDrawing && participating;
}

/* ---------- hot / cold ---------- */
function updateHotColdBoard() {
  const counts = Array.from({ length: TOTAL_NUMBERS }, (_, i) => ({ number: i + 1, count: 0 }));
  recentRounds.forEach((round) => round.forEach((n) => { counts[n - 1].count += 1; }));
  const hot = [...counts].sort((a, b) => b.count - a.count || a.number - b.number).slice(0, 3);
  const cold = [...counts].sort((a, b) => a.count - b.count || a.number - b.number).slice(0, 3);
  hotNumbersEl.innerHTML = hot.map((e) => `<span class="minib h">${e.number}</span>`).join("");
  coldNumbersEl.innerHTML = cold.map((e) => `<span class="minib c">${e.number}</span>`).join("");
}

/* ---------- tickets (3x3 with payline = middle row) ---------- */
function makeTicket() {
  return {
    top: sampleUniqueNumbers(3, TOTAL_NUMBERS),
    mid: sampleUniqueNumbers(TICKET_SIZE, TOTAL_NUMBERS),
    bottom: sampleUniqueNumbers(3, TOTAL_NUMBERS),
  };
}
function renderTickets() {
  tickets.forEach((ticket, index) => {
    const cells = document.getElementById(`cells-${index}`);
    let html = '<div class="payline"></div>';
    ticket.top.forEach((n) => { html += `<div class="cell dim">${n}</div>`; });
    ticket.mid.forEach((n) => { html += `<div class="cell mid" data-n="${n}">${n}</div>`; });
    ticket.bottom.forEach((n) => { html += `<div class="cell dim">${n}</div>`; });
    cells.innerHTML = html;
    const bong = document.querySelector(`.bong[data-bong="${index}"]`);
    bong.classList.toggle("inactive", !activeTickets[index]);
    const toggle = bong.querySelector(".x");
    toggle.textContent = activeTickets[index] ? "✕" : "+";
    toggle.setAttribute("aria-label", activeTickets[index] ? `Fjern bong ${index + 1}` : `Aktiver bong ${index + 1}`);
  });
}
function clearTicketStates() {
  document.querySelectorAll(".bong").forEach((b) => b.classList.remove("near-win"));
  document.querySelectorAll(".cell").forEach((c) => c.classList.remove("hit", "fresh", "miss"));
}
function renderMachineBalls() {
  const tones = sampleUniqueNumbers(6, TOTAL_NUMBERS);
  machineBallsEl.innerHTML = MACHINE_BALL_POS.map((p, i) => {
    return `<div class="ball ${ballTone(tones[i])}" style="left:${p[0]}%;bottom:${p[1]}%;animation-delay:${p[2]}s"></div>`;
  }).join("");
}
function markHits(drawnNumber) {
  document.querySelectorAll(".bong").forEach((bong) => {
    const id = Number(bong.dataset.bong);
    if (!activeTickets[id]) return;
    bong.querySelectorAll(`.cell.mid[data-n="${drawnNumber}"]`).forEach((cell) => cell.classList.add("hit", "fresh"));
  });
}
function updateNearWin(drawn) {
  tickets.forEach((ticket, index) => {
    const bong = document.querySelector(`.bong[data-bong="${index}"]`);
    bong.classList.remove("near-win");
    bong.querySelectorAll(".cell.miss").forEach((c) => c.classList.remove("miss"));
    if (!activeTickets[index]) return;
    if (getHitCount(ticket.mid, drawn) !== 2) return;
    bong.classList.add("near-win");
    ticket.mid.forEach((n) => {
      if (!drawn.includes(n)) {
        const cell = bong.querySelector(`.cell.mid[data-n="${n}"]`);
        if (cell) cell.classList.add("miss");
      }
    });
  });
}
function hasNearWin(drawn) {
  return tickets.some((t, i) => activeTickets[i] && getHitCount(t.mid, drawn) === 2);
}
function addDrawnBall(number) {
  const ball = document.createElement("div");
  ball.className = `db pop ${ballTone(number)}`;
  ball.innerHTML = `<span class="face">${number}</span>`;
  drawnNumbersEl.appendChild(ball);
}

/* ---------- the shared draw (driven by the server) ---------- */
function runRound(numbers) {
  if (drawTimer) { clearTimeout(drawTimer); drawTimer = null; }
  const playing = readyForNext && getActiveTicketCount() > 0 && hasEnoughBalance();
  readyForNext = false;   // consumed — you must press SPILL again for the next round
  // Snapshot the purchase terms NOW: prizes for this round must use the stake it was
  // bought at, even if the player changes stake/tier while the draw is running.
  const playedStake = stakePerTicket;
  const playedTier = jackpotTier();
  const playedRoundStake = getRoundStake();
  participating = playing;
  isDrawing = true;
  machineEl.classList.add("is-drawing");
  clearTicketStates();
  drawnNumbersEl.innerHTML = "";
  revealEl.className = "reveal";
  revealEl.innerHTML = "";
  if (playing) {
    playerBalance -= playedRoundStake;
    updatePlayerInfo();
  }
  updateControls();

  const drawn = [];
  let i = 0;
  function step() {
    const n = numbers[i];
    revealEl.className = `reveal ${ballTone(n)}`;
    revealEl.innerHTML = `<span class="face">${n}</span>`;
    void revealEl.offsetWidth;
    revealEl.classList.add("fill");                 // fills the glass sphere
    drawTimer = setTimeout(() => {
      revealEl.classList.remove("fill");
      revealEl.classList.add("drop");               // then drops under, into the tray
      drawTimer = setTimeout(() => {
        revealEl.className = "reveal";
        revealEl.innerHTML = "";
        drawn.push(n);
        addDrawnBall(n);
        if (playing) { markHits(n); updateNearWin(drawn); }
        i += 1;
        if (i < DRAWS_PER_ROUND) {
          drawTimer = setTimeout(step, (playing && hasNearWin(drawn)) ? SUSPENSE_MS : BETWEEN_MS);
        } else {
          drawTimer = setTimeout(() => finishRound(drawn, playing, playedStake, playedRoundStake, playedTier), END_MS);
        }
      }, DROP_MS);
    }, REVEAL_MS);
  }
  step();
}

function finishRound(drawn, playing, playedStake, playedRoundStake, playedTier) {
  isDrawing = false;
  participating = false;
  drawTimer = null;
  machineEl.classList.remove("is-drawing");
  recentRounds.unshift([...drawn]);
  recentRounds = recentRounds.slice(0, HISTORY_LIMIT);
  updateHotColdBoard();
  if (playing) evaluateRound(drawn, playedStake, playedRoundStake, playedTier);
  updateControls();
}

function evaluateRound(drawn, playedStake, playedRoundStake, playedTier) {
  const firstThree = drawn.slice(0, 3);
  const jackpotWinner = tickets.some((t, i) => activeTickets[i] && t.mid.every((n) => firstThree.includes(n)));
  if (jackpotWinner) {
    const prize = MULT_JP * playedStake + jackpots[playedTier];
    playerBalance += prize;
    updatePlayerInfo();
    showWinFlash(prize, "JACKPOT!");
    jackpots[playedTier] = JACKPOT_TIERS[playedTier].seed;
    updateJackpotBoard();
    return;
  }
  const three = tickets.filter((t, i) => activeTickets[i] && getHitCount(t.mid, drawn) === 3).length;
  const two = tickets.filter((t, i) => activeTickets[i] && getHitCount(t.mid, drawn) === 2).length;
  if (three > 0) {
    const prize = three * MULT_3 * playedStake;
    playerBalance += prize;
    updatePlayerInfo();
    showWinFlash(prize, "3 RETTE");
  } else if (two > 0) {
    const prize = two * MULT_2 * playedStake;
    playerBalance += prize;
    updatePlayerInfo();
    showWinFlash(prize, "2 RETTE");
  }
  jackpots[playedTier] = Math.min(JACKPOT_TIERS[playedTier].max, jackpots[playedTier] + playedRoundStake * JACKPOT_INCREMENT_RATE);
  updateJackpotBoard();
}

/* ---------- controls ---------- */
function createNewTickets() {
  if (isDrawing && participating) return; // your bongs are in play right now
  tickets = Array.from({ length: TICKETS_COUNT }, makeTicket);
  activeTickets = Array.from({ length: TICKETS_COUNT }, () => true);
  renderTickets();
  renderMachineBalls();
  clearTicketStates();
  updatePlayerInfo();
  updateHotColdBoard();
  updateControls();
}
function toggleTicket(index) {
  if (isDrawing && participating) return;
  if (activeTickets[index] && getActiveTicketCount() === 1) return;
  activeTickets[index] = !activeTickets[index];
  renderTickets();
  clearTicketStates();
  updatePlayerInfo();
  updateControls();
}
function toggleReady() {
  // Allowed any time (mid-draw too) — it buys you into the NEXT round.
  if (!readyForNext && (getActiveTicketCount() === 0 || !hasEnoughBalance())) return;
  readyForNext = !readyForNext;
  updateControls();
}

joinButton.addEventListener("click", toggleReady);
newTicketsButton.addEventListener("click", createNewTickets);
topupButton.addEventListener("click", () => {
  playerBalance += TOPUP_AMOUNT;   // demo money
  updatePlayerInfo();
  updateControls();
});
document.querySelectorAll("[data-toggle]").forEach((btn) => {
  btn.addEventListener("click", () => toggleTicket(Number(btn.dataset.toggle)));
});
stakeOptsEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".stake-opt");
  if (btn && !btn.disabled) setStake(Number(btn.dataset.stake));
});

/* ---------- multiplayer connection + countdown ---------- */
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
  if (!online) {           // stale clock while reconnecting — don't show a frozen "0 s"
    countdownEl.textContent = "–";
    stat.classList.remove("soon");
    return;
  }
  const ms = Math.max(0, nextRoundAt - Date.now());
  const s = Math.ceil(ms / 1000);
  countdownEl.textContent = nextRoundAt ? `${s} s` : "–";
  stat.classList.toggle("soon", s <= 3 && ms > 0);
}
function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(updateCountdown, 200);
  updateCountdown();
}
function connect() {
  setConn(false, "Kobler til…");
  source = new EventSource("/events");
  source.addEventListener("hello", (e) => {
    const d = JSON.parse(e.data);
    nextRoundAt = Date.now() + d.msToNext;
    setConn(true, "Tilkoblet");
  });
  source.addEventListener("round", (e) => {
    const d = JSON.parse(e.data);
    nextRoundAt = Date.now() + d.intervalMs;
    setConn(true, "Tilkoblet");
    runRound(d.numbers);
  });
  source.onopen = () => setConn(true, "Tilkoblet");
  source.onerror = () => setConn(false, "Kobler til på nytt…");
}

/* ============================================================
   VISUAL SCAFFOLDING (canvas scale, sparkles, coins, bulbs, theme)
   ============================================================ */
(function fitCanvas() {
  const canvas = document.getElementById("canvas");
  function fit() {
    const s = Math.min(window.innerWidth / 1600, window.innerHeight / 1000);
    canvas.style.transform = `scale(${s})`;
  }
  window.addEventListener("resize", fit);
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

/* ---------- boot ---------- */
updateJackpotBoard();
updateTierDisplays();
createNewTickets();
updateControls();
startCountdown();
connect();
