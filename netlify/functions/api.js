// netlify/functions/api.js
// Handles all tournament state via Netlify Blobs
// Routes: GET /api/state | POST /api/state | POST /api/score | POST /api/reset

import { getStore } from "@netlify/blobs";

const ADMIN_PIN = process.env.ADMIN_PIN || "2626"; // set in Netlify env vars

function ok(body) {
  return { statusCode: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) };
}
function err(msg, code = 400) {
  return { statusCode: code, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ error: msg }) };
}

function requireAdmin(headers) {
  const pin = headers["x-admin-pin"] || headers["X-Admin-Pin"];
  return pin === ADMIN_PIN;
}

export default async function handler(req, context) {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,x-admin-pin" }, body: "" };
  }

  const store = getStore("pickle-bash");
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "state";

  // ── GET state (public) ──────────────────────────────────────────────
  if (req.method === "GET") {
    try {
      const raw = await store.get("tournament", { type: "json" });
      return ok(raw || getDefaultState());
    } catch {
      return ok(getDefaultState());
    }
  }

  // ── POST actions (admin-gated except score entry) ───────────────────
  if (req.method === "POST") {
    let body = {};
    try { body = await req.json(); } catch {}

    // Score entry — requires admin OR scorer PIN
    if (action === "score") {
      if (!requireAdmin(req.headers)) return err("Unauthorized", 401);
      try {
        const state = await store.get("tournament", { type: "json" }) || getDefaultState();
        const { roundIndex, courtIndex, t1, t2 } = body;
        if (!state.rounds[roundIndex]) return err("Round not found");
        if (!state.rounds[roundIndex].scores) state.rounds[roundIndex].scores = {};
        state.rounds[roundIndex].scores[courtIndex] = { t1: Number(t1), t2: Number(t2), ts: Date.now() };
        state.lastUpdated = Date.now();
        await store.set("tournament", JSON.stringify(state));
        return ok({ ok: true, state });
      } catch (e) {
        return err("Failed to save score: " + e.message);
      }
    }

    // Full state save — admin only
    if (action === "save") {
      if (!requireAdmin(req.headers)) return err("Unauthorized", 401);
      try {
        body.lastUpdated = Date.now();
        await store.set("tournament", JSON.stringify(body));
        return ok({ ok: true });
      } catch (e) {
        return err("Failed to save: " + e.message);
      }
    }

    // Advance round — admin only
    if (action === "advance") {
      if (!requireAdmin(req.headers)) return err("Unauthorized", 401);
      try {
        const state = await store.get("tournament", { type: "json" }) || getDefaultState();
        const nextCourts = advancePlayers(state.rounds[state.currentRound]);
        state.currentRound++;
        state.rounds[state.currentRound] = { courts: nextCourts, scores: {} };
        state.lastUpdated = Date.now();
        await store.set("tournament", JSON.stringify(state));
        return ok({ ok: true, state });
      } catch (e) {
        return err("Advance failed: " + e.message);
      }
    }

    // Reset — admin only
    if (action === "reset") {
      if (!requireAdmin(req.headers)) return err("Unauthorized", 401);
      try {
        await store.set("tournament", JSON.stringify(getDefaultState()));
        return ok({ ok: true });
      } catch (e) {
        return err("Reset failed: " + e.message);
      }
    }

    return err("Unknown action");
  }

  return err("Method not allowed", 405);
}

function getDefaultState() {
  return {
    players: DEFAULT_ROSTER,
    rounds: [],
    currentRound: 0,
    tourneyStarted: false,
    lastUpdated: Date.now()
  };
}

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
    const courtNum = c.court;
    const isTie = t1Score === t2Score;
    const winTeam = !isTie ? (t1Score > t2Score ? c.team1 : c.team2) : c.team1;
    const loseTeam = !isTie ? (t1Score > t2Score ? c.team2 : c.team1) : c.team2;
    const winNext = isTie ? courtNum : Math.min(numCourts, courtNum + 1);
    const loseNext = isTie ? courtNum : Math.max(1, courtNum - 1);
    if (!courtAssignments[winNext]) courtAssignments[winNext] = [];
    if (!courtAssignments[loseNext]) courtAssignments[loseNext] = [];
    courtAssignments[winNext].push(...winTeam);
    courtAssignments[loseNext].push(...loseTeam);
  });
  const nextCourts = [];
  for (let cn = 1; cn <= numCourts; cn++) {
    const assigned = courtAssignments[cn] || [];
    const f = shuffle(assigned.filter(p => p?.gender === 'F'));
    const m = shuffle(assigned.filter(p => p?.gender === 'M'));
    let paired = f.length >= 2 && m.length >= 2
      ? [f[0], m[0], f[1], m[1]]
      : [...shuffle(assigned)];
    while (paired.length < 4) paired.push(null);
    nextCourts.push({ court: cn, team1: [paired[0], paired[1]], team2: [paired[2], paired[3]] });
  }
  return nextCourts;
}

const DEFAULT_ROSTER = [
  { name: 'Angel Munar',       gender: 'F', id: 1  },
  { name: 'Bill Avant',        gender: 'M', id: 2  },
  { name: 'Candice Chan',      gender: 'F', id: 3  },
  { name: 'Desiree Myers',     gender: 'F', id: 4  },
  { name: 'Eli Henry',         gender: 'M', id: 5  },
  { name: 'Erick Li',          gender: 'M', id: 6  },
  { name: 'Gia Boysen',        gender: 'F', id: 7  },
  { name: 'Gina Henderson',    gender: 'F', id: 8  },
  { name: 'Guy Chirinian',     gender: 'M', id: 9  },
  { name: 'Ian Chan',          gender: 'M', id: 10 },
  { name: 'Deep Moore',        gender: 'M', id: 11 },
  { name: 'John Phandinh',     gender: 'M', id: 12 },
  { name: 'John Henderson',    gender: 'M', id: 13 },
  { name: 'Kai Pylkkanen',     gender: 'M', id: 14 },
  { name: 'Joanne Boyle',      gender: 'F', id: 15 },
  { name: 'Gopi Dhanasekaran', gender: 'M', id: 16 },
  { name: 'Lisa Greene',       gender: 'F', id: 17 },
  { name: 'Marie Sam',         gender: 'F', id: 18 },
  { name: 'Marko Vranich',     gender: 'M', id: 19 },
  { name: 'Nanneke Dinklo',    gender: 'F', id: 20 },
  { name: 'Phoebe Pylkkanen',  gender: 'F', id: 21 },
  { name: 'Richard Hak',       gender: 'M', id: 22 },
  { name: 'Rick Byrne',        gender: 'M', id: 23 },
  { name: 'Ron Levin',         gender: 'M', id: 24 },
  { name: 'Stuart Waldman',    gender: 'M', id: 25 },
  { name: 'Tanya Deemer',      gender: 'F', id: 26 },
  { name: 'Vicken Bedikian',   gender: 'M', id: 27 },
  { name: 'Selene Jovel',      gender: 'F', id: 28 },
  { name: "Tina O'Brian",      gender: 'F', id: 29 },
  { name: 'Lena Tjandra',      gender: 'F', id: 30 },
  { name: 'Katelyn Martin',    gender: 'F', id: 31 },
  { name: 'Lisa Mack',         gender: 'F', id: 32 },
];

export const config = { path: "/api" };
