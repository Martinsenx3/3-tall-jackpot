/* ============================================================
   wallet-adapter.js — the money boundary between the game (RGS)
   and the operator's wallet / customer database.

   ALL amounts are INTEGER ØRE (NOK minor units).
   Every mutating call is idempotent by txId: replaying the same
   txId returns the original result and moves no money twice.

   Two implementations:
     MockWallet     — in-memory demo wallet (WALLET_MODE=mock, default)
     OperatorWallet — HTTP skeleton to be mapped onto the operator's
                      actual API spec (WALLET_MODE=operator)
   ============================================================ */
"use strict";

const crypto = require("crypto");

class WalletError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code; // INSUFFICIENT_FUNDS | INVALID_AMOUNT | UNKNOWN_TX | UNKNOWN_PLAYER | AUTH_FAILED | NOT_CONFIGURED | UPSTREAM_ERROR
  }
}

function assertAmount(amountOre) {
  if (!Number.isInteger(amountOre) || amountOre <= 0) throw new WalletError("INVALID_AMOUNT");
}

/* ------------------------------------------------------------
   MockWallet — demo money. Mirrors the semantics the operator
   wallet must provide, so the game code is identical in both modes.
   ------------------------------------------------------------ */
class MockWallet {
  constructor() {
    this.mode = "mock";
    this.balances = new Map(); // playerId → øre
    this.tx = new Map();       // txId → receipt (idempotency)
  }

  async authenticateSession() {
    // Demo mode: every session is a fresh demo player with 1 000 kr.
    const playerId = `demo-${crypto.randomBytes(6).toString("hex")}`;
    this.balances.set(playerId, 100_000);
    return { playerId, displayName: "Demo-spiller", currency: "NOK" };
  }

  #requirePlayer(playerId) {
    if (!this.balances.has(playerId)) throw new WalletError("UNKNOWN_PLAYER");
  }

  async getBalance(playerId) {
    this.#requirePlayer(playerId);
    return this.balances.get(playerId);
  }

  async debit({ playerId, amountOre, txId, meta }) {
    this.#requirePlayer(playerId);
    if (this.tx.has(txId)) return this.tx.get(txId); // idempotent replay
    assertAmount(amountOre);
    const bal = this.balances.get(playerId);
    if (bal < amountOre) throw new WalletError("INSUFFICIENT_FUNDS");
    this.balances.set(playerId, bal - amountOre);
    const receipt = { txId, type: "debit", playerId, amountOre, balanceAfter: bal - amountOre, meta, at: Date.now() };
    this.tx.set(txId, receipt);
    return receipt;
  }

  async credit({ playerId, amountOre, txId, meta }) {
    this.#requirePlayer(playerId);
    if (this.tx.has(txId)) return this.tx.get(txId); // idempotent replay
    assertAmount(amountOre);
    const bal = this.balances.get(playerId) + amountOre;
    this.balances.set(playerId, bal);
    const receipt = { txId, type: "credit", playerId, amountOre, balanceAfter: bal, meta, at: Date.now() };
    this.tx.set(txId, receipt);
    return receipt;
  }

  /* Refund of one earlier debit (cancelled bet / failed round). */
  async rollback({ txId }) {
    const original = this.tx.get(txId);
    if (!original || original.type !== "debit") throw new WalletError("UNKNOWN_TX");
    const rbId = `rb-${txId}`;
    if (this.tx.has(rbId)) return this.tx.get(rbId); // idempotent replay
    const bal = this.balances.get(original.playerId) + original.amountOre;
    this.balances.set(original.playerId, bal);
    const receipt = { txId: rbId, type: "rollback", playerId: original.playerId, amountOre: original.amountOre, balanceAfter: bal, rolledBack: txId, at: Date.now() };
    this.tx.set(rbId, receipt);
    return receipt;
  }
}

/* ------------------------------------------------------------
   OperatorWallet — skeleton for the real integration.
   Map each method onto the operator's wallet API when their spec
   arrives. Until configured it refuses to start the game in
   operator mode rather than failing silently mid-round.

   Expected env:
     OPERATOR_BASE_URL   e.g. https://wallet.operator.example/api/v1
     OPERATOR_API_KEY    issued by the operator
     OPERATOR_SECRET     shared secret for request signing (HMAC-SHA256)
   ------------------------------------------------------------ */
class OperatorWallet {
  constructor() {
    this.mode = "operator";
    this.baseUrl = process.env.OPERATOR_BASE_URL;
    this.apiKey = process.env.OPERATOR_API_KEY;
    this.secret = process.env.OPERATOR_SECRET;
    if (!this.baseUrl || !this.apiKey || !this.secret) {
      throw new WalletError("NOT_CONFIGURED", "OPERATOR_BASE_URL / OPERATOR_API_KEY / OPERATOR_SECRET må settes i operator-modus");
    }
  }

  /* Signed POST — typical operator pattern; adjust to their spec. */
  async #post(pathname, payload) {
    const body = JSON.stringify(payload);
    const ts = String(Date.now());
    const signature = crypto.createHmac("sha256", this.secret).update(ts + body).digest("hex");
    let res;
    try {
      res = await fetch(this.baseUrl + pathname, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": this.apiKey,
          "X-Timestamp": ts,
          "X-Signature": signature,
        },
        body,
        signal: AbortSignal.timeout(8000),
      });
    } catch (e) {
      throw new WalletError("UPSTREAM_ERROR", `Nettverksfeil mot operatør-wallet: ${e.message}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new WalletError(data.code || "UPSTREAM_ERROR", data.message || `HTTP ${res.status}`);
    return data;
  }

  /* TODO map → operator's "verify game-launch token" endpoint.
     The operator's platform launches the game with a one-time token
     identifying the logged-in customer in THEIR database. */
  async authenticateSession(launchToken) {
    if (!launchToken) throw new WalletError("AUTH_FAILED", "Mangler launch-token fra operatørens plattform");
    const d = await this.#post("/session/verify", { token: launchToken });
    return { playerId: d.playerId, displayName: d.displayName, currency: d.currency || "NOK" };
  }

  /* TODO map → operator's balance endpoint. Returns integer øre. */
  async getBalance(playerId) {
    const d = await this.#post("/wallet/balance", { playerId });
    return d.balanceOre;
  }

  /* TODO map → operator's debit/bet endpoint. MUST be idempotent by txId. */
  async debit({ playerId, amountOre, txId, meta }) {
    assertAmount(amountOre);
    return this.#post("/wallet/debit", { playerId, amountOre, txId, meta });
  }

  /* TODO map → operator's credit/win endpoint. MUST be idempotent by txId. */
  async credit({ playerId, amountOre, txId, meta }) {
    assertAmount(amountOre);
    return this.#post("/wallet/credit", { playerId, amountOre, txId, meta });
  }

  /* TODO map → operator's cancel/rollback endpoint (refund one debit). */
  async rollback({ txId }) {
    return this.#post("/wallet/rollback", { txId });
  }
}

function createWallet() {
  return process.env.WALLET_MODE === "operator" ? new OperatorWallet() : new MockWallet();
}

module.exports = { createWallet, MockWallet, OperatorWallet, WalletError };
