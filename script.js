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
let roundExtras = null;             // {gullbongSlot, gullMult, bonusBall, bonusPct} for the animating round
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
function formatKrSigned(ore) { return `${ore < 0 ? "−" : "+"}${formatKr(Math.abs(ore))}`; }
function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
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
  if (!res.ok) { const err = new Error(data.message || data.error || res.status); err.code = data.error; err.data = data; err.status = res.status; throw err; }
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
let jpShown = null;          // kr currently displayed
let jpShownTier = null;      // which tier is on screen
let jpTween = null;
const krFmt = (kr) => new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 0 }).format(kr);
function updateJackpotBoard() {
  const tier = tierOf(stakeOre);
  const targetKr = Math.floor(jackpots[tier] / 100);
  if (jackpotTierEl) jackpotTierEl.textContent = tier === "low" ? "2–4 KR" : "8–16 KR";
  // fill meter toward the tier cap (a "living" pot that visibly climbs toward must-grow ceiling)
  const max = config.jackpotMaxOre && config.jackpotMaxOre[tier];
  const seed = (config.jackpotSeedOre && config.jackpotSeedOre[tier]) || 0;
  const fill = document.getElementById("jpMeterFill");
  if (fill && max && max > seed) {
    const pct = Math.max(0, Math.min(100, ((jackpots[tier] - seed) / (max - seed)) * 100));
    fill.style.width = `${pct}%`;
    fill.classList.toggle("hot", pct >= 80);
  }
  if (tier !== jpShownTier || jpShown === null) {   // tier switch → snap, no count-up
    jpShownTier = tier; jpShown = targetKr;
    if (jpTween) { cancelAnimationFrame(jpTween); jpTween = null; }
    jackpotAmountEl.textContent = krFmt(targetKr);
    return;
  }
  if (targetKr === jpShown) return;
  tweenJackpot(jpShown, targetKr, targetKr > jpShown);
  jpShown = targetKr;
}
function tweenJackpot(from, to, grew) {
  if (jpTween) cancelAnimationFrame(jpTween);
  const dur = 900, t0 = performance.now();
  const disp = jackpotAmountEl.closest(".display") || jackpotAmountEl;
  if (grew) { disp.classList.remove("bump"); void disp.offsetWidth; disp.classList.add("bump"); }
  const tickAt = [];
  const frame = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    const eased = 1 - Math.pow(1 - k, 3);
    const v = Math.round(from + (to - from) * eased);
    jackpotAmountEl.textContent = krFmt(v);
    if (grew && Sound && k < 1) { const slot = Math.floor(k * 6); if (!tickAt[slot]) { tickAt[slot] = 1; Sound.tick(); } }
    if (k < 1) jpTween = requestAnimationFrame(frame); else jpTween = null;
  };
  jpTween = requestAnimationFrame(frame);
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
  document.querySelectorAll(".bong").forEach((b) => { b.classList.remove("near-win", "payfire", "gullbong"); b.removeAttribute("data-hits"); });
  document.querySelectorAll(".cell").forEach((c) => c.classList.remove("hit", "fresh", "miss", "bonushit"));
  document.querySelectorAll(".payline").forEach((p) => p.classList.remove("sweep"));
  hideNearBanner();
}
/* payline laser: light the mid-row progressively as a bong's hits accumulate */
function paintPaylines(idxs, drawn) {
  idxs.forEach((id) => {
    const bong = document.querySelector(`.bong[data-bong="${id}"]`);
    if (!bong) return;
    const hits = getHitCount(myTickets[id].mid, drawn);
    bong.dataset.hits = String(hits);
    if (hits >= 2) bong.classList.add("payfire");
    const pl = bong.querySelector(".payline");
    if (pl) { pl.classList.remove("sweep"); void pl.offsetWidth; pl.classList.add("sweep"); } // retrigger the sweep each hit
  });
}
function showNearBanner(text) {
  let b = document.getElementById("nearBanner");
  if (!b) { b = document.createElement("div"); b.id = "nearBanner"; b.className = "near-banner"; document.getElementById("canvas").appendChild(b); }
  b.textContent = text;
  b.classList.add("show");
}
function hideNearBanner() { const b = document.getElementById("nearBanner"); if (b) b.classList.remove("show"); }

/* win recap card (item 8) */
let lastWinShare = 0;
function bongLabel(t) { return t === "jackpot" ? "JACKPOT" : t === "3-rette" ? "3 rette" : "2 rette"; }
function showWinRecap(result) {
  if (!result || !(result.winOre > 0) || !Array.isArray(result.breakdown)) return;
  lastWinShare = result.winOre;
  const isJp = result.breakdown.some((b) => b.type === "jackpot");
  const is3 = result.breakdown.some((b) => b.type === "3-rette");
  document.getElementById("recapHead").textContent = isJp ? "JACKPOT!" : is3 ? "3 RETTE!" : "Gevinst!";
  document.getElementById("recapBurst").textContent = isJp ? "👑" : "🎉";
  document.getElementById("recapTotal").textContent = formatKr(result.winOre);
  document.getElementById("recapRows").innerHTML = result.breakdown
    .slice().sort((a, b) => b.amountOre - a.amountOre)
    .map((b) => `<div class="recap-row"><span>Bong ${Number(b.bong) + 1} · ${bongLabel(b.type)}</span><b class="gold">${formatKrSigned(b.amountOre)}</b></div>`)
    .join("");
  const card = document.getElementById("winRecap");
  openModal(card);
  clearTimeout(showWinRecap._t);
  showWinRecap._t = setTimeout(() => closeModal(card), 2000);   // auto-close after 2s
}
(function wireRecapShare() {
  const btn = document.getElementById("recapShare");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    Sound.click();
    const txt = `Jeg vant ${formatKr(lastWinShare)} på 3-TALL Jackpot! 🎉`;
    try {
      if (navigator.share) await navigator.share({ text: txt });
      else if (navigator.clipboard) { await navigator.clipboard.writeText(txt); flashToast("Kopiert ✓"); }
    } catch (e) { /* user dismissed share sheet */ }
  });
})();

/* subtle pointer parallax on the centrepieces (desktop, respects reduced-motion) */
(function parallax() {
  if (window.matchMedia && (window.matchMedia("(max-width: 820px)").matches || window.matchMedia("(prefers-reduced-motion: reduce)").matches)) return;
  const layers = [[document.querySelector(".jackpot"), 10], [document.querySelector(".machine"), 16]];
  let raf = null, mx = 0, my = 0;
  window.addEventListener("mousemove", (e) => {
    mx = (e.clientX / window.innerWidth - 0.5); my = (e.clientY / window.innerHeight - 0.5);
    if (!raf) raf = requestAnimationFrame(() => {
      raf = null;
      layers.forEach(([el, d]) => { if (el) el.style.transform = `translate(${(-mx * d).toFixed(1)}px, ${(-my * d).toFixed(1)}px)`; });
    });
  }, { passive: true });
})();
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

  // telegraph the gullbong (×2) — only on a bong the player actually activated, since that is the
  // ONLY bong where settlement can pay the ×2 (server: idx === gullbongSlot AND idx ∈ activeIdx)
  if (participating && roundExtras && roundExtras.gullbongSlot >= 0 && idxs.includes(roundExtras.gullbongSlot)) {
    const gb = document.querySelector(`.bong[data-bong="${roundExtras.gullbongSlot}"]`);
    if (gb) gb.classList.add("gullbong");
    showNearBanner(`⭐ GULLBONG — Bong ${roundExtras.gullbongSlot + 1} gir ×${roundExtras.gullMult || 2}!`);
    setTimeout(hideNearBanner, 2400);   // dismissed by its own timer; step() won't wipe it on the first ball (i===0)
  }

  const drawn = [];
  let i = 0;
  let tenseNext = false;
  function step() {
    if (i > 0) hideNearBanner();   // keep the gullbong telegraph visible through the first ball (its own timer dismisses it)
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
        if (participating) { markHits(n, idxs); updateNearWin(drawn, idxs); paintPaylines(idxs, drawn); }
        i += 1;
        const near = participating && i < numbers.length && idxs.some((id) => getHitCount(myTickets[id].mid, drawn) === 2);
        tenseNext = near;
        machineEl.classList.toggle("tense", near);
        if (near) { Sound.heartbeat(); showNearBanner(i === 2 ? "1 tall unna JACKPOT! 👑" : "1 tall unna 3 RETTE!"); }
        else hideNearBanner();
        if (i < numbers.length) {
          drawTimer = setTimeout(step, near ? SUSPENSE_MS : BETWEEN_MS);
        } else {
          machineEl.classList.remove("tense");
          hideNearBanner();
          const finish = () => { drawTimer = setTimeout(() => finishRound(roundId), END_MS); };
          if (roundExtras && roundExtras.bonusBall != null) drawTimer = setTimeout(() => bonusStep(finish), BETWEEN_MS);
          else finish();
        }
      }, DROP_MS);
    }, REVEAL_MS);
  }
  /* the gold bonus ball — drawn after the four numbers; boosts a winning bong it appears on */
  function bonusStep(done) {
    const n = roundExtras.bonusBall;
    revealEl.className = "reveal bonus";
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
        const ball = document.createElement("div");
        ball.className = "db bonus pop";
        ball.innerHTML = `<span class="face">${n}</span><span class="btag">BONUS</span>`;
        drawnNumbersEl.appendChild(ball);
        Sound.land();
        if (participating) {
          idxs.forEach((id) => {
            const bong = document.querySelector(`.bong[data-bong="${id}"]`);
            if (bong) bong.querySelectorAll(`.cell.mid[data-n="${n}"]`).forEach((c) => c.classList.add("bonushit"));
          });
        }
        done();
      }, DROP_MS);
    }, Math.round(REVEAL_MS * 0.75));
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
    if (s.rg) { rgState = s.rg; renderRg(); }
    if (s.bet) activeBet = { betId: s.bet.betId, roundId: s.bet.roundId, stakeOre: s.bet.stakeOre, active: s.bet.active };
    updatePlayerInfo();
    updateJackpotBoard();
    updateControls();
    /* provably-fair: now that the draw has fully animated, recompute it in-browser and flip the badge */
    if (fair.lastReveal && fair.lastReveal.round === roundId) verifyRound(fair.lastReveal, recentRounds[0]);
    const iWonJackpot = wasParticipating && s.lastResult && s.lastResult.roundId === roundId
      && s.lastResult.breakdown.some((b) => b.type === "jackpot");
    if (wasParticipating && s.lastResult && s.lastResult.roundId === roundId && s.lastResult.winOre > 0) {
      const types = s.lastResult.breakdown.map((b) => b.type);
      const label = types.includes("jackpot") ? "JACKPOT!" : types.includes("3-rette") ? "3 RETTE" : "2 RETTE";
      showWinFlash(s.lastResult.winOre, label);
      const result = s.lastResult;
      setTimeout(() => showWinRecap(result), 1600);   // recap card after the flash settles
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
    /* RG rejects moved NO money — just surface them. */
    if (e.code === "SELF_EXCLUDED" || e.code === "COOLOFF_ACTIVE") {
      showLock({ status: e.code === "SELF_EXCLUDED" ? "excluded" : "cooloff", until: e.data && e.data.until }, e.data && e.data.helpLine);
    } else if (e.code === "LOSS_LIMIT_REACHED") { flashToast("Du har nådd tapsgrensen din for i dag.");
    } else if (e.code === "TIME_LIMIT_REACHED") { flashToast("Du har nådd spilletidsgrensen.");
    } else if (e.code === "STAKE_LIMIT") { flashToast("Innsatsen overstiger grensen din.");
    }
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

/* ============================================================
   WAVE 4 — trust · provably-fair verification · responsible gaming
   ============================================================ */
let fair = { version: 1, clientSeed: null, currentCommit: null, currentCommitRound: null, lastReveal: null, lastVerify: null };
let sessionStartMs = Date.now();
let rgState = null;                 // {limits, exclusion, lossSoFarOre, realityCheckMs, sessionStartedAt}
let realityAckUntil = 0;           // elapsed-ms boundary already acknowledged by the player
let locked = false;

/* ---- provably-fair: byte-identical recompute of the server draw with SubtleCrypto ---- */
const Fair = (() => {
  const subtle = (typeof crypto !== "undefined" && crypto.subtle) ? crypto.subtle : null;
  function hexToBytes(hex) { const a = new Uint8Array(hex.length / 2); for (let i = 0; i < a.length; i += 1) a[i] = parseInt(hex.substr(i * 2, 2), 16); return a; }
  function toHex(buf) { return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
  async function sha256hex(bytes) { return toHex(await subtle.digest("SHA-256", bytes)); }
  async function hmac(keyBytes, msgStr) {
    const key = await subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await subtle.sign("HMAC", key, new TextEncoder().encode(msgStr)));
  }
  // a reader over the concatenation of HMAC-SHA256(seed, `${pi}:${block}`) — mirrors server fairReader
  function makeReader(serverSeedHex, pi) {
    const seed = hexToBytes(serverSeedHex);
    let block = 0, buf = new Uint8Array(0), pos = 0;
    async function u32() {
      while (buf.length - pos < 4) {
        const h = await hmac(seed, `${pi}:${block}`); block += 1;
        const merged = new Uint8Array((buf.length - pos) + h.length);
        merged.set(buf.subarray(pos)); merged.set(h, buf.length - pos);
        buf = merged; pos = 0;
      }
      const w = (buf[pos] * 0x1000000) + (buf[pos + 1] * 0x10000) + (buf[pos + 2] * 0x100) + buf[pos + 3]; pos += 4; return w >>> 0;
    }
    async function below(n) { const lim = Math.floor(0x100000000 / n) * n; let w; do { w = await u32(); } while (w >= lim); return w % n; }
    return { u32, below };
  }
  async function deriveDraw(serverSeedHex, round, clientSeed, version) {
    const total = config.numbersTotal || 20, draws = config.drawsPerRound || 4;
    const r = makeReader(serverSeedHex, `${version}:${clientSeed}:${round}`);
    const a = Array.from({ length: total }, (_, i) => i + 1); const picks = [];
    for (let i = a.length - 1; i > 0 && picks.length < draws; i -= 1) { const j = await r.below(i + 1); [a[i], a[j]] = [a[j], a[i]]; picks.push(a[i]); }
    return picks;
  }
  // recompute the economy extras from the SAME revealed seed (publicInput + ":x") so the boosts that
  // change real-money payouts are inside the verified surface, not trusted blindly
  async function deriveExtras(serverSeedHex, round, clientSeed, version) {
    const total = config.numbersTotal || 20, tickets = config.ticketsPerSession || 4;
    const r = makeReader(serverSeedHex, `${version}:${clientSeed}:${round}:x`);
    const gullRoll = await r.u32();
    const gullSlot = await r.below(tickets);
    const bonusBall = (await r.below(total)) + 1;
    const bonusRoll = await r.u32();
    const gEnabled = !!(config.gullbong && config.gullbong.enabled);
    const gFreq = (config.gullbong && config.gullbong.freq) || 0;
    const gullActive = gEnabled && (gullRoll / 0x100000000 < gFreq);
    const bEnabled = !!(config.bonusBall && config.bonusBall.enabled);
    const bFreq = (config.bonusBall && config.bonusBall.freq) || 0;
    const bonusActive = bEnabled && (bonusRoll / 0x100000000 < bFreq);
    return { gullbongSlot: gullActive ? gullSlot : -1, bonus: bonusActive ? bonusBall : null };
  }
  return { available: !!subtle, sha256hex, hexToBytes, deriveDraw, deriveExtras };
})();

function storeFair(f) {
  if (!f) return;
  fair.version = f.version ?? fair.version;
  if (f.clientSeed) fair.clientSeed = f.clientSeed;
  if (f.commit) { fair.currentCommit = f.commit.commit; fair.currentCommitRound = f.commit.round; }
  if (f.reveal) fair.lastReveal = f.reveal;
}
async function verifyRound(reveal, drawnNumbers) {
  if (!Fair.available || !reveal) { fair.lastVerify = { ok: null, reason: "unavailable" }; renderFairBadge(); return; }
  try {
    const commitOk = (await Fair.sha256hex(Fair.hexToBytes(reveal.serverSeed))) === reveal.commit;
    const recomputed = await Fair.deriveDraw(reveal.serverSeed, reveal.round, fair.clientSeed, fair.version);
    const numbersOk = Array.isArray(drawnNumbers) && JSON.stringify(recomputed) === JSON.stringify(drawnNumbers);
    // also verify the RTP-affecting boosts (gullbong slot + bonus ball) against the reported values
    let extrasOk = true;
    if (roundExtras) {
      const ex = await Fair.deriveExtras(reveal.serverSeed, reveal.round, fair.clientSeed, fair.version);
      extrasOk = ex.gullbongSlot === roundExtras.gullbongSlot && ex.bonus === (roundExtras.bonusBall ?? null);
    }
    fair.lastVerify = { ok: commitOk && numbersOk && extrasOk, round: reveal.round, commit: reveal.commit, serverSeed: reveal.serverSeed, recomputed, drawn: drawnNumbers, commitOk, numbersOk, extrasOk };
  } catch (e) { fair.lastVerify = { ok: null, reason: "error" }; }
  renderFairBadge();
  renderFairPanel();
}
function renderFairBadge() {
  const badge = document.getElementById("fairBadge");
  if (!badge) return;
  const v = fair.lastVerify;
  badge.classList.remove("ok", "bad", "neutral");
  if (!Fair.available) { badge.classList.add("neutral"); badge.querySelector(".fb-mark").textContent = "🔒"; badge.querySelector(".fb-txt").textContent = "Rettferdig"; return; }
  if (v && v.ok === true) { badge.classList.add("ok"); badge.querySelector(".fb-mark").textContent = "✓"; badge.querySelector(".fb-txt").textContent = "Bevisbar rettferdig"; }
  else if (v && v.ok === false) { badge.classList.add("bad"); badge.querySelector(".fb-mark").textContent = "✕"; badge.querySelector(".fb-txt").textContent = "Avvik!"; }
  else { badge.classList.add("neutral"); badge.querySelector(".fb-mark").textContent = "🛡"; badge.querySelector(".fb-txt").textContent = "Rettferdig"; }
}
function renderFairPanel() {
  const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  set("fairClientSeed", fair.clientSeed || "—");
  set("fairCommitRound", fair.currentCommitRound != null ? `#${fair.currentCommitRound}` : "—");
  set("fairCommitHash", fair.currentCommit ? fair.currentCommit : "—");
  const v = fair.lastVerify;
  const resEl = document.getElementById("fairResult");
  if (!resEl) return;
  if (!Fair.available) { resEl.className = "fair-result neutral"; resEl.textContent = "Verifisering krever en sikker (HTTPS) tilkobling."; return; }
  if (!v) { resEl.className = "fair-result neutral"; resEl.textContent = "Venter på første trekning…"; return; }
  if (v.ok === true) { resEl.className = "fair-result ok"; resEl.innerHTML = `✓ Runde #${v.round} verifisert — tall <b>${(v.drawn || []).join(", ")}</b>${v.extrasOk ? " + premie-boosts" : ""} stemmer med den forhåndspubliserte forpliktelsen.`; }
  else if (v.ok === false) { resEl.className = "fair-result bad"; resEl.innerHTML = `✕ Avvik i runde #${v.round}! Reberegnet ${(v.recomputed || []).join(", ")} vs trukket ${(v.drawn || []).join(", ")} (commit ${v.commitOk ? "ok" : "feil"}).`; }
  else { resEl.className = "fair-result neutral"; resEl.textContent = "Kunne ikke verifisere."; }
}

/* ---- trust chrome: mode badge, RTP, session timer ---- */
function applyTrustConfig() {
  const modeBadge = document.getElementById("modeBadge");
  if (modeBadge) {
    const demo = mode === "mock";
    modeBadge.textContent = demo ? "DEMO · LEKEPENGER" : "EKTE PENGER";
    modeBadge.classList.toggle("demo", demo);
    modeBadge.classList.toggle("real", !demo);
  }
  const rtp = config.rtpPct || 66;
  const setTxt = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
  setTxt("rtpVal", `~${rtp}%`);       // (RTP UI removed from the strip; kept null-safe for any future use)
  setTxt("rtpInfoVal", `~${rtp}%`);
  setTxt("rtpOdds", `${config.drawsPerRound || 4} av ${config.numbersTotal || 20} tall trekkes`);
  // help line + licence in the always-on strip
  const help = config.helpLine || { name: "Hjelpelinjen", phone: "800 800 40", url: "https://hjelpelinjen.no" };
  [["helpLink", `${help.name}: ${help.phone}`], ["rgHubHelp", `${help.name} ${help.phone}`]].forEach(([id, txt]) => {
    const a = document.getElementById(id); if (a) { a.textContent = txt; a.href = help.url; }
  });
  document.querySelectorAll(".age-limit").forEach((el) => { el.textContent = `${config.ageLimit || 18}+`; });
  const lic = document.getElementById("licenceText");
  if (lic) lic.textContent = config.licence || (mode === "mock" ? "Demo — ingen ekte innsats" : "");
}
let sessTimer = null;
function startSessionTimer() {
  if (sessTimer) clearInterval(sessTimer);
  const tick = () => {
    const txt = fmtDuration(Date.now() - sessionStartMs);
    const a = document.getElementById("sessTimer"); if (a) a.textContent = txt;
    const b = document.getElementById("rgSessTime"); if (b) b.textContent = txt;
  };
  tick(); sessTimer = setInterval(tick, 1000);
}

/* ---- responsible-gaming hub + reality check ---- */
function renderRg() {
  if (!rgState) return;
  const set = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
  const loss = rgState.lossSoFarOre || 0;
  const limit = rgState.limits ? rgState.limits.dailyLossOre : null;
  set("rgLossText", limit != null ? `${formatKr(loss)} / ${formatKr(limit)}` : `${formatKr(loss)} (ingen grense)`);
  const bar = document.getElementById("rgLossBar");
  if (bar) { const pct = limit ? Math.min(100, Math.round((loss / limit) * 100)) : 0; bar.style.width = `${pct}%`; bar.classList.toggle("warn", limit && loss / limit >= 0.8); }
  const li = document.getElementById("limitLossInput");
  if (li && document.activeElement !== li) li.value = (rgState.limits && rgState.limits.dailyLossOre != null) ? Math.floor(rgState.limits.dailyLossOre / 100) : "";
  const ti = document.getElementById("limitTimeInput");
  if (ti && document.activeElement !== ti) ti.value = (rgState.limits && rgState.limits.sessionTimeMs != null) ? Math.floor(rgState.limits.sessionTimeMs / 60000) : "";
}
function maybeReality() {
  if (!rgState || !rgState.realityCheckMs || locked) return;
  if (isDrawing) return;
  if (document.getElementById("reality") && !document.getElementById("reality").hidden) return;
  // don't stack on top of another open modal
  if ([...document.querySelectorAll(".modal")].some((m) => !m.hidden)) return;
  const elapsed = Date.now() - sessionStartMs;
  const dueBoundary = Math.floor(elapsed / rgState.realityCheckMs) * rgState.realityCheckMs;
  if (dueBoundary <= 0 || dueBoundary <= realityAckUntil) return;
  realityAckUntil = dueBoundary;
  const set = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
  set("realityTime", fmtDuration(elapsed));
  const net = rgState.netOre || 0;   // true signed session net (server-accumulated, both modes)
  const netEl = document.getElementById("realityNet");
  if (netEl) { netEl.textContent = net === 0 ? "0 KR" : formatKrSigned(net); netEl.className = `reality-net ${net < 0 ? "loss" : net > 0 ? "win" : "even"}`; }
  openModal(document.getElementById("reality"));
}
let realityTimer = null;
function startRealityCheck() {
  if (realityTimer) clearInterval(realityTimer);
  realityTimer = setInterval(maybeReality, 5000);
}

async function loadHistory() {
  const listEl = document.getElementById("histList");
  if (listEl) listEl.innerHTML = '<div class="hist-empty">Laster…</div>';
  try {
    const d = await api(`/api/history?sessionId=${encodeURIComponent(sessionId)}&limit=20`);
    renderHistory(d.items || []);
  } catch (e) { if (listEl) listEl.innerHTML = '<div class="hist-empty">Kunne ikke hente historikk.</div>'; }
}
function renderHistory(items) {
  const listEl = document.getElementById("histList");
  if (!listEl) return;
  if (!items.length) { listEl.innerHTML = '<div class="hist-empty">Ingen spill ennå denne økten.</div>'; return; }
  let staked = 0, won = 0;
  listEl.innerHTML = items.map((it) => {
    staked += it.betAmountOre; won += it.winOre;
    const balls = (it.drawn || []).map((n) => `<span class="hist-ball">${n}</span>`).join("");
    const winCls = it.netOre > 0 ? "win" : it.netOre < 0 ? "loss" : "";
    return `<div class="hist-row"><div class="hist-meta"><b>Runde #${it.roundId}</b><span>${it.bongs} bong · ${formatKr(it.stakeOre)}/bong</span></div>
      <div class="hist-balls">${balls}</div>
      <div class="hist-net ${winCls}">${formatKrSigned(it.netOre)}</div></div>`;
  }).join("");
  const set = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
  set("rgStaked", formatKr(staked)); set("rgWon", formatKr(won));
}

/* ---- RG actions ---- */
async function saveLimits() {
  const lossKr = document.getElementById("limitLossInput").value;
  const timeMin = document.getElementById("limitTimeInput").value;
  const body = { sessionId };
  body.dailyLossOre = lossKr === "" ? null : Math.max(0, Math.round(Number(lossKr))) * 100;
  body.sessionTimeMs = timeMin === "" ? null : Math.max(0, Math.round(Number(timeMin))) * 60000;
  const btn = document.getElementById("saveLimitsBtn"); if (btn) btn.disabled = true;
  try {
    const d = await post("/api/rg/limits", body);
    if (rgState) rgState.limits = d.limits;
    renderRg();
    flashToast("Grenser lagret ✓");
  } catch (e) { flashToast(e.code === "OPERATOR_MANAGED" ? "Grenser settes hos spilltilbyderen." : "Kunne ikke lagre."); }
  if (btn) btn.disabled = false;
}
async function setCooloff(preset) {
  try {
    const d = await post("/api/rg/cooloff", { sessionId, preset });
    rgState = rgState || {};
    rgState.exclusion = d.exclusion;
    try { localStorage.setItem("cooloffUntil", String(d.exclusion.until || (d.exclusion.status === "excluded" ? -1 : 0))); } catch (e) {}
    showLock(d.exclusion, d.helpLine);
  } catch (e) { flashToast(e.code === "OPERATOR_MANAGED" ? "Pause settes hos spilltilbyderen." : "Kunne ikke sette pause."); }
}
function showLock(exclusion, helpLine) {
  locked = true;
  const lock = document.getElementById("rgLock");
  if (!lock) return;
  document.querySelectorAll(".modal").forEach((m) => { if (m !== lock) m.hidden = true; });
  const set = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
  if (exclusion && exclusion.status === "cooloff" && exclusion.until) {
    set("rgLockTitle", "Du tar en pause");
    set("rgLockText", "Du har valgt en pause fra spillet.");
    let lockTimer = null;
    const upd = () => {
      const left = exclusion.until - Date.now();
      if (left <= 0) { if (lockTimer) clearInterval(lockTimer); locked = false; lock.hidden = true; location.reload(); return; }
      set("rgLockUntil", `Pausen er over om ${fmtDuration(left)}`);
    };
    lockTimer = setInterval(upd, 1000); upd();   // assign before the synchronous upd() to avoid a TDZ ReferenceError on immediate expiry
  } else {
    set("rgLockTitle", exclusion && exclusion.status === "excluded" ? "Selvekskludert" : "Spillet er låst");
    set("rgLockText", "Du har valgt å stenge tilgangen til spillet.");
    set("rgLockUntil", "");
  }
  const help = helpLine || config.helpLine;
  if (help) { const a = document.getElementById("rgLockHelp"); if (a) { a.textContent = `${help.name}: ${help.phone}`; a.href = help.url; } }
  lock.hidden = false;
  joinButton.disabled = true;
}
function flashToast(msg) {
  let t = document.getElementById("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; document.getElementById("canvas").appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(flashToast._t); flashToast._t = setTimeout(() => t.classList.remove("show"), 2600);
}

/* ---- wire modals + buttons ---- */
function wireWave4() {
  const open = (id) => openModal(document.getElementById(id));
  const onClick = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener("click", fn); };
  onClick("rtpBadge", () => { Sound.click(); open("rtpInfo"); });
  onClick("rgBtn", () => { Sound.click(); renderRg(); open("rgHub"); });
  onClick("fairBadge", () => { Sound.click(); renderFairPanel(); open("fairPanel"); });
  onClick("histOpenBtn", () => { Sound.click(); open("history"); loadHistory(); });
  onClick("rtpFairBtn", () => { Sound.click(); closeModal(document.getElementById("rtpInfo")); renderFairPanel(); open("fairPanel"); });
  onClick("rgFairBtn", () => { Sound.click(); closeModal(document.getElementById("rgHub")); renderFairPanel(); open("fairPanel"); });
  onClick("saveLimitsBtn", () => { Sound.click(); saveLimits(); });
  onClick("realityPause", () => { Sound.click(); closeModal(document.getElementById("reality")); renderRg(); open("rgHub"); });
  onClick("fairVerifyBtn", async () => {
    Sound.click();
    if (fair.lastReveal) await verifyRound(fair.lastReveal, recentRounds[0]);
  });
  document.querySelectorAll("[data-cooloff]").forEach((b) => b.addEventListener("click", () => { Sound.click(); setCooloff(b.dataset.cooloff); }));
  document.querySelectorAll(".modal [data-close]").forEach((b) => b.addEventListener("click", () => { Sound.click(); closeModal(b.closest(".modal")); }));
  renderFairBadge();
}
wireWave4();

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
    storeFair(d.fair);
    renderFairBadge();
    updateJackpotBoard();
    setPlayers(d.players);
    setConn(true, "Tilkoblet");
    refreshState();
  });
  source.addEventListener("round", (e) => {
    const d = JSON.parse(e.data);
    nextRoundAt = Date.now() + d.intervalMs;
    jackpots = d.jackpots;
    storeFair(d.fair);              // store reveal+next commit, but DON'T verify yet (would spoil the draw)
    updateJackpotBoard();
    setPlayers(d.players);
    setConn(true, "Tilkoblet");
    recentRounds.unshift([...d.numbers]);
    recentRounds = recentRounds.slice(0, 10);
    updateHotColdBoard();
    roundExtras = d.extras || null;
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
    if (d.rg) { rgState = d.rg; sessionStartMs = d.rg.sessionStartedAt || Date.now(); }
    storeFair(d.fair);
    if (mode === "mock") {
      const saldoLabel = playerBalanceEl.closest(".stat").querySelector(".k");
      if (saldoLabel) saldoLabel.textContent = "SALDO · DEMO";
    }
    soundBtn.textContent = Sound.muted ? "🔇" : "🔊";
    soundBtn.classList.toggle("muted", Sound.muted);
    renderTickets();
    renderMachineBalls();
    applyTrustConfig();
    renderRg();
    renderFairBadge();
    updatePlayerInfo();
    updateTierDisplays();
    updateJackpotBoard();
    updateControls();
    startCountdown();
    startSessionTimer();
    startRealityCheck();
    connect();
    // No auto popups before the game starts — the guide is available via the “?” button.
  } catch (e) {
    /* A responsible-gaming launch block is NOT a connection error — show the lock, don't retry into play. */
    if (e.code === "SELF_EXCLUDED" || e.code === "COOLOFF_ACTIVE") {
      showLock({ status: e.code === "SELF_EXCLUDED" ? "excluded" : "cooloff", until: e.data && e.data.until }, e.data && e.data.helpLine);
      return;
    }
    if (e.code === "AGE_NOT_VERIFIED" || e.code === "JURISDICTION_BLOCKED") {
      showLock({ status: "excluded" }, e.data && e.data.helpLine);
      const t = document.getElementById("rgLockText"); if (t) t.textContent = e.message || "Spillet er ikke tilgjengelig.";
      return;
    }
    setConn(false, "Får ikke kontakt med spillserveren");
    setTimeout(boot, 4000);
  }
}

/* ============================================================
   VISUAL SCAFFOLDING (canvas scale, sparkles, coins, bulbs, theme)
   ============================================================ */
(function fitCanvas() {
  const canvas = document.getElementById("canvas");
  const wrap = document.querySelector(".wrap");
  const mobile = window.matchMedia("(max-width: 820px)");
  function fit() {
    if (mobile.matches) { canvas.style.transform = "none"; canvas.style.height = ""; return; } // mobile reflows vertically
    // Size the canvas to its ACTUAL content height so nothing is ever clipped, then scale the whole
    // board to fit the viewport (width AND height) with a small margin.
    canvas.style.height = "1000px";                          // reset to read the natural content height
    const contentH = Math.max(1000, wrap ? wrap.scrollHeight : 1000);
    canvas.style.height = `${contentH}px`;
    const s = Math.min(window.innerWidth / 1600, window.innerHeight / contentH) * 0.97;
    canvas.style.transform = `scale(${s})`;
  }
  window.addEventListener("resize", fit);
  if (mobile.addEventListener) mobile.addEventListener("change", () => { fit(); placeBulbs(); });
  fit();
  window.addEventListener("load", fit);                      // re-fit once fonts/layout settle
  setTimeout(fit, 400);
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
