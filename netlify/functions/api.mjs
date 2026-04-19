// netlify/functions/api.mjs
import { getStore } from "@netlify/blobs";

const ADMIN_PIN = process.env.ADMIN_PIN || "2626";
const VALID_TOURNEYS = ["live", "test", "practice"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-pin",
};

function respond(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// Empty state — no hardcoded roster. Players come from the app UI.
function getDefaultState() {
  return {
    players: [],
    rounds: [],
    currentRound: 0,
    tourneyStarted: false,
    lastUpdated: Date.now(),
  };
}

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "state";
  const tourney = url.searchParams.get("tourney") || "live";
  const storeKey = VALID_TOURNEYS.includes(tourney) ? `tournament-${tourney}` : "tournament-live";

  let store;
  try {
    store = getStore("pickle-bash");
  } catch (e) {
    return respond({ error: "Store unavailable: " + e.message }, 500);
  }

  // GET — public
  if (req.method === "GET") {
    try {
      const raw = await store.get(storeKey, { type: "json" });
      return respond(raw || getDefaultState());
    } catch (e) {
      return respond(getDefaultState());
    }
  }

  // POST
  if (req.method === "POST") {
    let body = {};
    try {
      const text = await req.text();
      if (text) body = JSON.parse(text);
    } catch (e) {
      return respond({ error: "Invalid JSON" }, 400);
    }

    const pin = req.headers.get("x-admin-pin") || "";
    if (pin !== ADMIN_PIN) {
      return respond({ error: "Unauthorized" }, 401);
    }

    if (action === "save") {
      try {
        body.lastUpdated = Date.now();
        await store.set(storeKey, JSON.stringify(body));
        return respond({ ok: true, lastUpdated: body.lastUpdated });
      } catch (e) {
        return respond({ error: "Save failed: " + e.message }, 500);
      }
    }

    if (action === "score") {
      try {
        let current = await store.get(storeKey, { type: "json" }) || getDefaultState();
        const { roundIndex, courtIndex, t1, t2 } = body;
        if (!current.rounds[roundIndex]) return respond({ error: "Round not found" }, 400);
        if (!current.rounds[roundIndex].scores) current.rounds[roundIndex].scores = {};
        current.rounds[roundIndex].scores[courtIndex] = { t1: Number(t1), t2: Number(t2), ts: Date.now() };
        current.lastUpdated = Date.now();
        await store.set(storeKey, JSON.stringify(current));
        return respond({ ok: true, state: current });
      } catch (e) {
        return respond({ error: "Score failed: " + e.message }, 500);
      }
    }

    if (action === "advance") {
      try {
        let current = await store.get(storeKey, { type: "json" }) || getDefaultState();
        const nextCourts = advancePlayers(current.rounds[current.currentRound]);
        current.currentRound++;
        current.rounds[current.currentRound] = { courts: nextCourts, scores: {} };
        current.lastUpdated = Date.now();
        await store.set(storeKey, JSON.stringify(current));
        return respond({ ok: true, state: current });
      } catch (e) {
        return respond({ error: "Advance failed: " + e.message }, 500);
      }
    }

    if (action === "reseed") {
      try {
        let current = await store.get(storeKey, { type: "json" }) || getDefaultState();
        const nextCourts = reseedByCumulativePoints(current);
        current.currentRound++;
        current.rounds[current.currentRound] = { courts: nextCourts, scores: {} };
        current.lastUpdated = Date.now();
        await store.set(storeKey, JSON.stringify(current));
        return respond({ ok: true, state: current });
      } catch (e) {
        return respond({ error: "Reseed failed: " + e.message }, 500);
      }
    }

    if (action === "reset") {
      try {
        const fresh = getDefaultState();
        await store.set(storeKey, JSON.stringify(fresh));
        return respond({ ok: true, state: fresh });
      } catch (e) {
        return respond({ error: "Reset failed: " + e.message }, 500);
      }
    }

    return respond({ error: "Unknown action: " + action }, 400);
  }

  return respond({ error: "Method not allowed" }, 405);
}

export const config = { path: "/api" };

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function advancePlayers(round) {
  const numCourts = round.courts.length;
  const courtAssignments = {};
  round.courts.forEach((c, ci) => {
    const sc = round.scores?.[ci] || {};
    const t1Score = sc.t1 ?? 0;
    const t2Score = sc.t2 ?? 0;
    const isTie = t1Score === t2Score;
    const winTeam  = !isTie ? (t1Score > t2Score ? c.team1 : c.team2) : c.team1;
    const loseTeam = !isTie ? (t1Score > t2Score ? c.team2 : c.team1) : c.team2;
    const winNext  = isTie ? c.court : Math.min(numCourts, c.court + 1);
    const loseNext = isTie ? c.court : Math.max(1, c.court - 1);
    if (!courtAssignments[winNext])  courtAssignments[winNext]  = [];
    if (!courtAssignments[loseNext]) courtAssignments[loseNext] = [];
    courtAssignments[winNext].push(...winTeam);
    courtAssignments[loseNext].push(...loseTeam);
  });
  const nextCourts = [];
  for (let cn = 1; cn <= numCourts; cn++) {
    const assigned = courtAssignments[cn] || [];
    const f = shuffle(assigned.filter(p => p?.gender === "F"));
    const m = shuffle(assigned.filter(p => p?.gender === "M"));
    let paired = f.length >= 2 && m.length >= 2 ? [f[0], m[0], f[1], m[1]] : shuffle(assigned);
    while (paired.length < 4) paired.push(null);
    nextCourts.push({ court: cn, team1: [paired[0], paired[1]], team2: [paired[2], paired[3]] });
  }
  return nextCourts;
}

function reseedByCumulativePoints(state) {
  const pts = {};
  state.players.forEach(p => { pts[p.id] = 0; });
  state.rounds.forEach(round => {
    round.courts?.forEach((c, ci) => {
      const sc = round.scores?.[ci];
      if (!sc || sc.t1 === undefined || sc.t2 === undefined) return;
      c.team1.forEach(p => { if (p) pts[p.id] = (pts[p.id] || 0) + sc.t1; });
      c.team2.forEach(p => { if (p) pts[p.id] = (pts[p.id] || 0) + sc.t2; });
    });
  });
  const sorted = [...state.players].sort((a, b) => (pts[b.id] || 0) - (pts[a.id] || 0));
  const females = sorted.filter(p => p.gender === 'F');
  const males   = sorted.filter(p => p.gender === 'M');
  const ordered = [];
  const maxLen = Math.max(females.length, males.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < females.length) ordered.push(females[i]);
    if (i < males.length)   ordered.push(males[i]);
  }
  sorted.forEach(p => { if (!ordered.find(o => o.id === p.id)) ordered.push(p); });
  const numCourts = state.rounds[0]?.courts.length || 8;
  const courts = [];
  for (let c = 0; c < numCourts; c++) {
    const courtNum = numCourts - c;
    courts.push({
      court: courtNum,
      team1: [ordered[c*4] || null, ordered[c*4+1] || null],
      team2: [ordered[c*4+2] || null, ordered[c*4+3] || null],
    });
  }
  return courts.sort((a, b) => a.court - b.court);
}
