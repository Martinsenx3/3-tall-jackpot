/* ============================================================
   3-TALL — multiplayer game server
   Serves the static client AND is the single source of truth for
   the draw: one global round every 10s, server-side RNG, broadcast
   to every connected client over Server-Sent Events (/events).
   Run with:  node server.js
   ============================================================ */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = process.env.PORT || 8123;
const ROUND_INTERVAL = 22000;   // a new draw every 22s (~16s draw + ~6s betting window)
const TOTAL_NUMBERS = 20;
const DRAWS_PER_ROUND = 4;

// Whitelist: ONLY the files the game needs are served.
// (The project folder also holds backups, design references etc. — never expose those.)
const FILES = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  "/script.js": { file: "script.js", type: "text/javascript; charset=utf-8" },
};

function sampleUnique(count, max) {
  const a = Array.from({ length: max }, (_, i) => i + 1);
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, count);
}

/* ---------- live clients + round loop ---------- */
const clients = new Set();
let roundNumber = 0;
let nextRoundAt = Date.now() + ROUND_INTERVAL;

function send(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (e) { /* client gone */ }
}
function broadcast(event, data) {
  for (const res of clients) send(res, event, data);
}

function runRound() {
  roundNumber += 1;
  const numbers = sampleUnique(DRAWS_PER_ROUND, TOTAL_NUMBERS);
  nextRoundAt = Date.now() + ROUND_INTERVAL;
  broadcast("round", { n: roundNumber, numbers, intervalMs: ROUND_INTERVAL });
  console.log(`[runde ${roundNumber}] trakk ${numbers.join(", ")}  ·  ${clients.size} spiller(e) tilkoblet`);
  setTimeout(runRound, ROUND_INTERVAL);
}

// keepalive so proxies don't drop idle SSE connections
setInterval(() => {
  for (const res of clients) { try { res.write(":ping\n\n"); } catch (e) { /* */ } }
}, 20000);

/* ---------- http: static files + SSE ---------- */
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);

  if (urlPath === "/events") {
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
    });
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  const entry = FILES[urlPath];
  if (!entry) { res.writeHead(404); res.end("Not found"); return; }
  fs.readFile(path.join(ROOT, entry.file), (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": entry.type, "Cache-Control": "no-cache" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`3-TALL multiplayer-server kjører på http://localhost:${PORT}`);
  console.log(`Ny trekning hvert ${ROUND_INTERVAL / 1000}. sekund. Åpne URL-en i flere faner for å se samme trekning.`);
  setTimeout(runRound, ROUND_INTERVAL);
});
