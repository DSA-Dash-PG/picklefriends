// netlify/functions/api.mjs
//
// Storage model
// ─────────────────────────────────────────────────────────────────────
// Two kinds of blobs in the `pickle-bash` store:
//
//   ladders-index          → { activeId, ladders: [{id,name,status,createdAt,completedAt}], lastUpdated }
//   ladder-<id>            → full ladder state (players, rounds, scores, ...)
//
// Migration:
//   On first read of `ladders-index`, if it doesn't exist but the legacy
//   `tournament-live` blob does, the live blob is migrated to `ladder-2`
//   with status=completed (the user's first ladder was never persisted).
//
// Endpoints
// ─────────────────────────────────────────────────────────────────────
//   GET  ?action=index                        → ladders index (auto-migrates)
//   GET  ?action=state&ladder=<id>            → that ladder's state (or active)
//   POST ?action=createLadder        body { name }
//   POST ?action=setActive           body { id }       (demotes prior active→completed)
//   POST ?action=startLadder         body { id }       (status upcoming→active)
//   POST ?action=completeLadder      body { id }
//   POST ?action=deleteLadder        body { id }       (only if upcoming)
//   POST ?action=save&ladder=<id>    body { ...ladder } (overwrite)
//   POST ?action=score&ladder=<id>   body { roundIndex, courtIndex, t1, t2 }
//   POST ?action=advance&ladder=<id>
//   POST ?action=reseed&ladder=<id>
//   POST ?action=reset&ladder=<id>            (clear that ladder)
//
// All POSTs require the x-admin-pin header.

import { getStore } from "@netlify/blobs";

const ADMIN_PIN = process.env.ADMIN_PIN || "2626";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-pin",
};

const INDEX_KEY = "ladders-index";
const LEGACY_LIVE_KEY = "tournament-live";

function respond(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function defaultLadder(id, name) {
  const now = Date.now();
  return {
    id,
    name,
    status: "upcoming", // upcoming | active | completed
    players: [],
    rounds: [],
    currentRound: 0,
    tourneyStarted: false,
    createdAt: now,
    completedAt: null,
    lastUpdated: now,
  };
}

function defaultIndex() {
  return { activeId: null, ladders: [], lastUpdated: Date.now() };
}

const ladderKey = (id) => `ladder-${id}`;

function nextLadderId(idx) {
  const nums = idx.ladders
    .map((l) => parseInt(String(l.id || "").replace(/^ladder-/, ""), 10))
    .filter((n) => !isNaN(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `ladder-${next}`;
}

function syncIndexEntry(idx, ladder) {
  const entry = {
    id: ladder.id,
    name: ladder.name,
    status: ladder.status,
    createdAt: ladder.createdAt,
    completedAt: ladder.completedAt || null,
  };
  const i = idx.ladders.findIndex((l) => l.id === ladder.id);
  if (i >= 0) idx.ladders[i] = entry;
  else idx.ladders.push(entry);
}

async function loadIndex(store) {
  let idx = await store.get(INDEX_KEY, { type: "json" });
  if (idx && Array.isArray(idx.ladders)) return idx;

  // No index yet — migrate legacy live blob if present, else start empty.
  const fresh = defaultIndex();
  let legacy = null;
  try {
    legacy = await store.get(LEGACY_LIVE_KEY, { type: "json" });
  } catch (e) {
    legacy = null;
  }

  const hasLegacy =
    legacy && (legacy.players?.length || legacy.rounds?.length);

  if (hasLegacy) {
    // The user's ladder #1 was never saved, so the live blob becomes ladder-2.
    const id = "ladder-2";
    const name = "Ladder 2";
    const migrated = {
      id,
      name,
      status: "completed",
      players: legacy.players || [],
      rounds: legacy.rounds || [],
      currentRound: legacy.currentRound || 0,
      tourneyStarted: !!legacy.tourneyStarted,
      createdAt: legacy.lastUpdated || Date.now(),
      completedAt: Date.now(),
      lastUpdated: legacy.lastUpdated || Date.now(),
    };
    await store.set(ladderKey(id), JSON.stringify(migrated));
    syncIndexEntry(fresh, migrated);
  }

  await store.set(INDEX_KEY, JSON.stringify(fresh));
  return fresh;
}

async function saveIndex(store, idx) {
  idx.lastUpdated = Date.now();
  await store.set(INDEX_KEY, JSON.stringify(idx));
  return idx;
}

async function loadLadder(store, id) {
  const blob = await store.get(ladderKey(id), { type: "json" });
  return blob || null;
}

async function saveLadder(store, ladder) {
  ladder.lastUpdated = Date.now();
  await store.set(ladderKey(ladder.id), JSON.stringify(ladder));
}

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "state";
  const qLadderId = url.searchParams.get("ladder") || "";

  let store;
  try {
    store = getStore("pickle-bash");
  } catch (e) {
    return respond({ error: "Store unavailable: " + e.message }, 500);
  }

  // ─────── GET (public) ───────
  if (req.method === "GET") {
    try {
      if (action === "index") {
        const idx = await loadIndex(store);
        return respond(idx);
      }
      // action === "state" (default): return the requested ladder, or active.
      const idx = await loadIndex(store);
      const id = qLadderId || idx.activeId;
      if (!id) {
        return respond({
          ...defaultLadder("none", ""),
          id: null,
          status: "none",
        });
      }
      const ladder = await loadLadder(store, id);
      if (!ladder) {
        return respond({ ...defaultLadder(id, "Unknown"), status: "missing" });
      }
      return respond(ladder);
    } catch (e) {
      return respond({ error: "Read failed: " + e.message }, 500);
    }
  }

  // ─────── POST (admin only) ───────
  if (req.method === "POST") {
    let body = {};
    try {
      const text = await req.text();
      if (text) body = JSON.parse(text);
    } catch (e) {
      return respond({ error: "Invalid JSON" }, 400);
    }

    const pin = req.headers.get("x-admin-pin") || "";
    if (pin !== ADMIN_PIN) return respond({ error: "Unauthorized" }, 401);

    try {
      const idx = await loadIndex(store);

      // ── createLadder ──
      if (action === "createLadder") {
        const name = (body.name || "").trim() || `Ladder ${idx.ladders.length + 1}`;
        const id = nextLadderId(idx);
        const ladder = defaultLadder(id, name);
        await saveLadder(store, ladder);
        syncIndexEntry(idx, ladder);
        await saveIndex(store, idx);
        return respond({ ok: true, ladder, index: idx });
      }

      // ── setActive ──
      if (action === "setActive") {
        const id = body.id || qLadderId;
        if (!idx.ladders.find((l) => l.id === id))
          return respond({ error: "Ladder not found" }, 404);

        // Demote any existing active ladder to completed.
        if (idx.activeId && idx.activeId !== id) {
          const prev = await loadLadder(store, idx.activeId);
          if (prev && prev.status === "active") {
            prev.status = "completed";
            prev.completedAt = Date.now();
            await saveLadder(store, prev);
            syncIndexEntry(idx, prev);
          }
        }

        const ladder = await loadLadder(store, id);
        if (!ladder) return respond({ error: "Ladder blob missing" }, 404);
        ladder.status = "active";
        ladder.tourneyStarted = !!ladder.rounds[0];
        await saveLadder(store, ladder);
        syncIndexEntry(idx, ladder);
        idx.activeId = id;
        await saveIndex(store, idx);
        return respond({ ok: true, ladder, index: idx });
      }

      // ── startLadder (status upcoming → active, requires rounds[0]) ──
      if (action === "startLadder") {
        const id = body.id || qLadderId;
        const ladder = await loadLadder(store, id);
        if (!ladder) return respond({ error: "Ladder not found" }, 404);
        if (!ladder.rounds[0])
          return respond({ error: "Assign courts before starting" }, 400);

        // Demote any other active ladder.
        if (idx.activeId && idx.activeId !== id) {
          const prev = await loadLadder(store, idx.activeId);
          if (prev && prev.status === "active") {
            prev.status = "completed";
            prev.completedAt = Date.now();
            await saveLadder(store, prev);
            syncIndexEntry(idx, prev);
          }
        }

        ladder.status = "active";
        ladder.tourneyStarted = true;
        ladder.currentRound = 0;
        await saveLadder(store, ladder);
        syncIndexEntry(idx, ladder);
        idx.activeId = id;
        await saveIndex(store, idx);
        return respond({ ok: true, ladder, index: idx });
      }

      // ── completeLadder ──
      if (action === "completeLadder") {
        const id = body.id || qLadderId;
        const ladder = await loadLadder(store, id);
        if (!ladder) return respond({ error: "Ladder not found" }, 404);
        ladder.status = "completed";
        ladder.completedAt = Date.now();
        await saveLadder(store, ladder);
        syncIndexEntry(idx, ladder);
        if (idx.activeId === id) idx.activeId = null;
        await saveIndex(store, idx);
        return respond({ ok: true, ladder, index: idx });
      }

      // ── deleteLadder (only upcoming) ──
      if (action === "deleteLadder") {
        const id = body.id || qLadderId;
        const entry = idx.ladders.find((l) => l.id === id);
        if (!entry) return respond({ error: "Ladder not found" }, 404);
        if (entry.status !== "upcoming")
          return respond(
            { error: "Only upcoming ladders can be deleted" },
            400
          );
        idx.ladders = idx.ladders.filter((l) => l.id !== id);
        if (idx.activeId === id) idx.activeId = null;
        await saveIndex(store, idx);
        try {
          await store.delete(ladderKey(id));
        } catch (e) {
          /* best effort */
        }
        return respond({ ok: true, index: idx });
      }

      // The remaining actions all need a target ladder id.
      const id = qLadderId || body.id || idx.activeId;
      if (!id) return respond({ error: "No ladder selected" }, 400);

      // ── save (overwrite ladder state — used when admin edits roster, courts) ──
      if (action === "save") {
        const ladder = body || {};
        // Force-bind id; preserve created/status if not sent.
        const existing = (await loadLadder(store, id)) || defaultLadder(id, ladder.name || `Ladder`);
        const merged = {
          ...existing,
          ...ladder,
          id,
          // Saving the roster/courts NEVER promotes status by itself.
          status: existing.status,
          createdAt: existing.createdAt,
          completedAt: existing.completedAt,
        };
        await saveLadder(store, merged);
        syncIndexEntry(idx, merged);
        await saveIndex(store, idx);
        return respond({
          ok: true,
          lastUpdated: merged.lastUpdated,
          index: idx,
          state: merged,
        });
      }

      const ladder = await loadLadder(store, id);
      if (!ladder) return respond({ error: "Ladder blob missing" }, 404);

      // ── score ──
      if (action === "score") {
        const { roundIndex, courtIndex, t1, t2 } = body;
        if (!ladder.rounds[roundIndex])
          return respond({ error: "Round not found" }, 400);
        if (!ladder.rounds[roundIndex].scores)
          ladder.rounds[roundIndex].scores = {};
        ladder.rounds[roundIndex].scores[courtIndex] = {
          t1: Number(t1),
          t2: Number(t2),
          ts: Date.now(),
        };
        await saveLadder(store, ladder);
        return respond({ ok: true, state: ladder });
      }

      // ── advance ──
      if (action === "advance") {
        const nextCourts = advancePlayers(ladder.rounds[ladder.currentRound]);
        ladder.currentRound++;
        ladder.rounds[ladder.currentRound] = { courts: nextCourts, scores: {} };
        await saveLadder(store, ladder);
        return respond({ ok: true, state: ladder });
      }

      // ── reseed ──
      if (action === "reseed") {
        const nextCourts = reseedByCumulativePoints(ladder);
        ladder.currentRound++;
        ladder.rounds[ladder.currentRound] = { courts: nextCourts, scores: {} };
        await saveLadder(store, ladder);
        return respond({ ok: true, state: ladder });
      }

      // ── reset (clears roster + rounds for THIS ladder; preserves id/name/createdAt) ──
      if (action === "reset") {
        const fresh = {
          ...defaultLadder(id, ladder.name),
          status: "upcoming",
          createdAt: ladder.createdAt,
        };
        await saveLadder(store, fresh);
        syncIndexEntry(idx, fresh);
        if (idx.activeId === id) idx.activeId = null;
        await saveIndex(store, idx);
        return respond({ ok: true, state: fresh, index: idx });
      }

      return respond({ error: "Unknown action: " + action }, 400);
    } catch (e) {
      return respond({ error: "Action failed: " + e.message }, 500);
    }
  }

  return respond({ error: "Method not allowed" }, 405);
}

export const config = { path: "/api" };

// ─────────────────────────────────────────────────────────────────────
// helpers — unchanged from previous implementation
// ─────────────────────────────────────────────────────────────────────
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
    const winTeam = !isTie ? (t1Score > t2Score ? c.team1 : c.team2) : c.team1;
    const loseTeam = !isTie ? (t1Score > t2Score ? c.team2 : c.team1) : c.team2;
    const winNext = isTie ? c.court : Math.min(numCourts, c.court + 1);
    const loseNext = isTie ? c.court : Math.max(1, c.court - 1);
    if (!courtAssignments[winNext]) courtAssignments[winNext] = [];
    if (!courtAssignments[loseNext]) courtAssignments[loseNext] = [];
    courtAssignments[winNext].push(...winTeam);
    courtAssignments[loseNext].push(...loseTeam);
  });
  const nextCourts = [];
  for (let cn = 1; cn <= numCourts; cn++) {
    const assigned = courtAssignments[cn] || [];
    const f = shuffle(assigned.filter((p) => p?.gender === "F"));
    const m = shuffle(assigned.filter((p) => p?.gender === "M"));
    let paired =
      f.length >= 2 && m.length >= 2
        ? [f[0], m[0], f[1], m[1]]
        : shuffle(assigned);
    while (paired.length < 4) paired.push(null);
    nextCourts.push({
      court: cn,
      team1: [paired[0], paired[1]],
      team2: [paired[2], paired[3]],
    });
  }
  return nextCourts;
}

function reseedByCumulativePoints(state) {
  const pts = {};
  state.players.forEach((p) => {
    pts[p.id] = 0;
  });
  state.rounds.forEach((round) => {
    round.courts?.forEach((c, ci) => {
      const sc = round.scores?.[ci];
      if (!sc || sc.t1 === undefined || sc.t2 === undefined) return;
      c.team1.forEach((p) => {
        if (p) pts[p.id] = (pts[p.id] || 0) + sc.t1;
      });
      c.team2.forEach((p) => {
        if (p) pts[p.id] = (pts[p.id] || 0) + sc.t2;
      });
    });
  });
  const sorted = [...state.players].sort(
    (a, b) => (pts[b.id] || 0) - (pts[a.id] || 0)
  );
  const females = sorted.filter((p) => p.gender === "F");
  const males = sorted.filter((p) => p.gender === "M");
  const ordered = [];
  const maxLen = Math.max(females.length, males.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < females.length) ordered.push(females[i]);
    if (i < males.length) ordered.push(males[i]);
  }
  sorted.forEach((p) => {
    if (!ordered.find((o) => o.id === p.id)) ordered.push(p);
  });
  const numCourts = state.rounds[0]?.courts.length || 8;
  const courts = [];
  for (let c = 0; c < numCourts; c++) {
    const courtNum = numCourts - c;
    courts.push({
      court: courtNum,
      team1: [ordered[c * 4] || null, ordered[c * 4 + 1] || null],
      team2: [ordered[c * 4 + 2] || null, ordered[c * 4 + 3] || null],
    });
  }
  return courts.sort((a, b) => a.court - b.court);
}
