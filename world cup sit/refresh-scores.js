// api/refresh-scores.js
// Runs server-side on Vercel. Holds the football-data.org key as an env var
// (never exposed to the browser), computes group-stage tables, and writes
// the result into Supabase so every visitor sees the same data.
//
// Env vars required (set in Vercel → Project → Settings → Environment Variables):
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY   (the "service_role" key — NOT the anon key)
//   FOOTBALL_DATA_KEY      (from your football-data.org account)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY;

// football-data.org sometimes names teams differently than our roster list.
// Add to this if you spot a mismatch in the refresh response.
const ALIASES = {
  "Korea Republic": "South Korea",
  "Republic of Korea": "South Korea",
  "IR Iran": "Iran",
  "Côte d'Ivoire": "Ivory Coast",
  "United States": "USA",
  "Czech Republic": "Czechia",
  "Cabo Verde": "Cape Verde",
  "Bosnia and Herzegovina": "Bosnia",
  "Turkey": "Türkiye",
  "Congo DR": "DR Congo",
  "DR Congo": "DR Congo"
};
const norm = (name) => ALIASES[name] || name;

const GROUPS = {
  A: ["Mexico", "South Korea", "Czechia", "South Africa"],
  B: ["Canada", "Switzerland", "Bosnia", "Qatar"],
  C: ["Brazil", "Morocco", "Scotland", "Haiti"],
  D: ["USA", "Australia", "Paraguay", "Türkiye"],
  E: ["Germany", "Ivory Coast", "Ecuador", "Curaçao"],
  F: ["Netherlands", "Sweden", "Japan", "Tunisia"],
  G: ["Belgium", "Egypt", "Iran", "New Zealand"],
  H: ["Spain", "Cape Verde", "Uruguay", "Saudi Arabia"],
  I: ["France", "Norway", "Senegal", "Iraq"],
  J: ["Argentina", "Austria", "Algeria", "Jordan"],
  K: ["Colombia", "Portugal", "DR Congo", "Uzbekistan"],
  L: ["England", "Ghana", "Croatia", "Panama"]
};
const TEAM_GROUP = {};
Object.entries(GROUPS).forEach(([g, ts]) => ts.forEach((t) => (TEAM_GROUP[t] = g)));

module.exports = async (req, res) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(200).json({
      ok: false,
      error: "Server isn't configured yet — missing SUPABASE_URL or SUPABASE_SERVICE_KEY in Vercel env vars."
    });
  }
  if (!FOOTBALL_DATA_KEY) {
    return res.status(200).json({ ok: false, error: "Missing FOOTBALL_DATA_KEY in Vercel env vars." });
  }

  // ---- 1. Pull matches from football-data.org (server-side, no CORS issue) ----
  let matches;
  try {
    const r = await fetch("https://api.football-data.org/v4/competitions/WC/matches", {
      headers: { "X-Auth-Token": FOOTBALL_DATA_KEY }
    });
    if (!r.ok) {
      const body = await r.text();
      return res.status(200).json({
        ok: false,
        error: `football-data.org responded ${r.status}. Their free tier may not include the World Cup competition — you may need a paid tier for this endpoint. ${body.slice(0, 200)}`
      });
    }
    const data = await r.json();
    matches = data.matches || [];
  } catch (e) {
    return res.status(200).json({ ok: false, error: "Couldn't reach football-data.org: " + e.message });
  }

  // ---- 2. Aggregate finished matches into a per-team table ----
  const table = {};
  const ensure = (t) => table[t] || (table[t] = { pts: 0, gd: 0, pld: 0 });
  const finishedResults = [];

  for (const m of matches) {
    if (m.status !== "FINISHED") continue;
    const home = norm(m.homeTeam?.name || "");
    const away = norm(m.awayTeam?.name || "");
    const hs = m.score?.fullTime?.home;
    const as = m.score?.fullTime?.away;
    if (hs == null || as == null) continue;
    if (!TEAM_GROUP[home] && !TEAM_GROUP[away]) continue; // not one of our 48 teams

    if (TEAM_GROUP[home]) {
      const t = ensure(home);
      t.pld++; t.gd += hs - as; t.pts += hs > as ? 3 : hs === as ? 1 : 0;
    }
    if (TEAM_GROUP[away]) {
      const t = ensure(away);
      t.pld++; t.gd += as - hs; t.pts += as > hs ? 3 : hs === as ? 1 : 0;
    }
    finishedResults.push({
      home, home_score: hs, away, away_score: as,
      match_date: (m.utcDate || "").slice(0, 10),
      grp: TEAM_GROUP[home] || TEAM_GROUP[away] || null
    });
  }

  // ---- 3. Rank within each group. NOTE: this is a simplified status model —
  // it ranks strictly 1st/2nd = advance once all 3 group games are played.
  // It does NOT model the 8 best-third-place wildcard spots. A commissioner
  // can always hand-correct a team's status from the Matches tab. ----
  const teamRows = [];
  for (const teams of Object.values(GROUPS)) {
    const rows = teams.map((t) => ({ team: t, ...(table[t] || { pts: 0, gd: 0, pld: 0 }) }));
    const allDone = rows.every((r) => r.pld >= 3);
    const ranked = [...rows].sort((a, b) => b.pts - a.pts || b.gd - a.gd);
    ranked.forEach((r, i) => {
      const status = allDone ? (i < 2 ? "adv" : "elim") : i === 3 ? "brink" : "alive";
      teamRows.push({ team: r.team, pts: r.pts, gd: r.gd, pld: r.pld, status, updated_at: new Date().toISOString() });
    });
  }

  // ---- 4. Write to Supabase using the service key (server-side only) ----
  const headers = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "resolution=merge-duplicates"
  };

  try {
    const r1 = await fetch(`${SUPABASE_URL}/rest/v1/teams_state?on_conflict=team`, {
      method: "POST", headers, body: JSON.stringify(teamRows)
    });
    if (!r1.ok) throw new Error("teams_state upsert failed: " + (await r1.text()));

    if (finishedResults.length) {
      const r2 = await fetch(`${SUPABASE_URL}/rest/v1/results?on_conflict=home,away`, {
        method: "POST", headers, body: JSON.stringify(finishedResults)
      });
      if (!r2.ok) throw new Error("results upsert failed: " + (await r2.text()));
    }
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }

  return res.status(200).json({
    ok: true,
    teamsUpdated: teamRows.length,
    matchesSeen: matches.length,
    finishedSeen: finishedResults.length
  });
};
