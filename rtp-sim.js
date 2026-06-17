/* ============================================================
   RTP simulator for 3-TALL — Monte-Carlo estimate of the FIXED-prize RTP
   (the progressive pot SHARE is excluded; it is funded by ~2 % of stakes and
   is roughly RTP-neutral over the long run, adding ~+2 pp on top of these
   numbers). Use this to re-tune the economy boosts before re-certification.

     node rtp-sim.js [trials]

   NOT the certified figure — RTP must be verified by an accredited test house.
   Keep the multipliers/frequencies below in sync with server.js.
   ============================================================ */
"use strict";

const TOTAL = 20, DRAWS = 4, BONGS = 4;
const MULT_2 = 5, MULT_3 = 50, MULT_JP = 50;
const GULLBONG_MULT = 2, GULLBONG_FREQ = 0.25, BONUS_PCT = 50, BONUSBALL_FREQ = 0.2;

function sample(k, pool) {
  const a = Array.from({ length: pool }, (_, i) => i + 1);
  for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, k);
}

function trial(useBoost) {
  const draw = sample(DRAWS, TOTAL), first3 = draw.slice(0, 3);
  const gullActive = useBoost && Math.random() < GULLBONG_FREQ;
  const gullSlot = Math.floor(Math.random() * BONGS);
  const bonusActive = useBoost && Math.random() < BONUSBALL_FREQ;
  const bonus = bonusActive ? (Math.floor(Math.random() * TOTAL) + 1) : null;
  const stake = 1; let payout = 0, totalStake = 0;
  for (let b = 0; b < BONGS; b += 1) {
    totalStake += stake;
    const mid = sample(3, TOTAL);
    const isJp = mid.every((n) => first3.includes(n));
    const hits = mid.filter((n) => draw.includes(n)).length;
    let mult = 0;
    if (isJp) mult = MULT_JP; else if (hits === 3) mult = MULT_3; else if (hits === 2) mult = MULT_2;
    if (mult === 0) continue;
    const multPart = mult * stake; let boost = 0;
    if (useBoost) {
      if (bonus != null && mid.includes(bonus)) boost += Math.floor(multPart * BONUS_PCT / 100);
      if (gullActive && b === gullSlot) boost += multPart * (GULLBONG_MULT - 1);
    }
    payout += multPart + boost; // pot share excluded
  }
  return [payout, totalStake];
}

function rtp(useBoost, N) { let p = 0, s = 0; for (let i = 0; i < N; i += 1) { const [a, b] = trial(useBoost); p += a; s += b; } return p / s; }

const N = Number(process.argv[2]) || 4_000_000;
const base = rtp(false, N), boosted = rtp(true, N);
console.log(`3-TALL fixed-prize RTP over ${N.toLocaleString("en")} trials (progressive pot share excluded, ~+2 pp on top):`);
console.log(`  BASE (no boosts):        ${(base * 100).toFixed(2)} %`);
console.log(`  WITH Gullbong + Bonus:   ${(boosted * 100).toFixed(2)} %  (+${((boosted - base) * 100).toFixed(2)} pp)`);
console.log(`  config: Gullbong ×${GULLBONG_MULT} @ ${GULLBONG_FREQ * 100}% of rounds · Bonus +${BONUS_PCT}% @ ${BONUSBALL_FREQ * 100}% of rounds`);
