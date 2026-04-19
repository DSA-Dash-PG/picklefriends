// netlify/functions/api.mjs
import { getStore } from "@netlify/blobs";

const ADMIN_PIN = process.env.ADMIN_PIN || "2626";

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

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "state";

  let store;
  try {
    store = getStore("pickle-bash");
  } catch (e) {
    return respond({ error: "Store unavailable: " + e.message }, 500);
  }

  // GET — public
  if (req.method === "GET") {
    try {
      const raw = await store.get("tournament", { type: "json" });
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
        await store.set("tournament", JSON.stringify(body));
        return respond({ ok: true, lastUpdated: body.lastUpdated });
      } catch (e) {
        return respond({ error: "Save failed: " + e.message }, 500);
      }
    }

    if (action === "score") {
      try {
        let current = await store.get("tournament", { type: "json" }) || getDefaultState();
        const { roundIndex, courtIndex, t1, t2 } = body;
        if (!current.rounds[roundIndex]) return respond({ error: "Round not found" }, 400);
        if (!current.rounds[roundIndex].scores) current.rounds[roundIndex].scores = {};
        current.rounds[roundIndex].scores[courtIndex] = { t1: Number(t1), t2: Number(t2), ts: Date.now() };
        current.lastUpdated = Date.now();
        await store.set("tournament", JSON.stringify(current));
        return respond({ ok: true, state: current });
      } catch (e) {
        return respond({ error: "Score failed: " + e.message }, 500);
      }
    }

    if (action === "advance") {
      try {
        let current = await store.get("tournament", { type: "json" }) || getDefaultState();
        const nextCourts = advancePlayers(current.rounds[current.currentRound]);
        current.currentRound++;
        current.rounds[current.currentRound] = { courts: nextCourts, scores: {} };
        current.lastUpdated = Date.now();
        await store.set("tournament", JSON.stringify(current));
        return respond({ ok: true, state: current });
      } catch (e) {
        return respond({ error: "Advance failed: " + e.message }, 500);
      }
    }

    if (action === "reset") {
      try {
        const fresh = getDefaultState();
        await store.set("tournament", JSON.stringify(fresh));
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

function getDefaultState() {
  return {
    players: DEFAULT_ROSTER,
    rounds: [],
    currentRound: 0,
    tourneyStarted: false,
    lastUpdated: Date.now(),
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

const DEFAULT_ROSTER = [
  { name: "Angel Munar",       gender: "F", id: 1  },
  { name: "Bill Avant",        gender: "M", id: 2  },
  { name: "Candice Chan",      gender: "F", id: 3  },
  { name: "Desiree Myers",     gender: "F", id: 4  },
  { name: "Eli Henry",         gender: "M", id: 5  },
  { name: "Erick Li",          gender: "M", id: 6  },
  { name: "Gia Boysen",        gender: "F", id: 7  },
  { name: "Gina Henderson",    gender: "F", id: 8  },
  { name: "Guy Chirinian",     gender: "M", id: 9  },
  { name: "Ian Chan",          gender: "M", id: 10 },
  { name: "Deep Moore",        gender: "M", id: 11 },
  { name: "John Phandinh",     gender: "M", id: 12 },
  { name: "John Henderson",    gender: "M", id: 13 },
  { name: "Kai Pylkkanen",     gender: "M", id: 14 },
  { name: "Joanne Boyle",      gender: "F", id: 15 },
  { name: "Gopi Dhanasekaran", gender: "M", id: 16 },
  { name: "Lisa Greene",       gender: "F", id: 17 },
  { name: "Marie Sam",         gender: "F", id: 18 },
  { name: "Marko Vranich",     gender: "M", id: 19 },
  { name: "Nanneke Dinklo",    gender: "F", id: 20 },
  { name: "Phoebe Pylkkanen",  gender: "F", id: 21 },
  { name: "Richard Hak",       gender: "M", id: 22 },
  { name: "Rick Byrne",        gender: "M", id: 23 },
  { name: "Ron Levin",         gender: "M", id: 24 },
  { name: "Stuart Waldman",    gender: "M", id: 25 },
  { name: "Tanya Deemer",      gender: "F", id: 26 },
  { name: "Vicken Bedikian",   gender: "M", id: 27 },
  { name: "Selene Jovel",      gender: "F", id: 28 },
  { name: "Tina O'Brian",      gender: "F", id: 29 },
  { name: "Lena Tjandra",      gender: "F", id: 30 },
  { name: "Katelyn Martin",    gender: "F", id: 31 },
  { name: "Lisa Mack",         gender: "F", id: 32 },
];
