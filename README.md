# The Group Chat Cup — World Cup Pool Tracker

Shared standings, bracket, odds, and trades for your 6-person pool — synced across everyone's phone through Supabase, with live scores pulled server-side from football-data.org.

## What's in this folder
```
index.html              the whole app (UI + logic)
api/refresh-scores.js   Vercel serverless function — fetches scores, writes to Supabase
supabase-schema.sql     run once in Supabase to create tables + the PIN-checked approval functions
package.json            lets Vercel recognize this as a project
.env.example             which environment variables you'll set in Vercel (not committed)
```

You'll do three things: **(1) set up Supabase, (2) deploy to Vercel with env vars, (3) paste two public values into `index.html`.** ~15 minutes total.

---

## 1. Set up Supabase (free)

1. Go to supabase.com → New project. Pick any name/region, set a database password (you won't need it again — save it somewhere anyway).
2. Once it's created: **Project → SQL Editor → New query.**
3. Open `supabase-schema.sql` from this folder, paste the whole thing in, click **Run**.
   - This creates the `teams_state`, `results`, and `trades` tables, and two PIN-protected functions (`approve_trade`, `update_team_state`) that are the only way to change data.
   - **Change the PIN first if you want:** in the SQL before running it, find the two lines `if p_pin <> '2026' then` and replace `'2026'` with your own PIN. (You can also re-run the file later with `CREATE OR REPLACE` to change it — no need to drop anything.)
4. Go to **Project Settings → API**. You'll need three values from this page:
   - `Project URL` → this is your `SUPABASE_URL`
   - `anon` `public` key → this is your `SUPABASE_ANON_KEY` (safe to expose in the browser — that's what it's for)
   - `service_role` key → this is your `SUPABASE_SERVICE_KEY` (⚠️ secret — only goes into Vercel env vars, never into `index.html`)

## 2. Get a football-data.org key

You mentioned you already have one. If you need to regenerate it: footballdata.org → My Account → it's listed as "X-Auth-Token". Keep it private — it goes into a Vercel env var, never into a file.

> Heads-up: football-data.org's **free tier doesn't always include the World Cup competition** — it's mainly top domestic leagues, with major tournaments sometimes gated to paid tiers. The refresh button is built to fail gracefully and tell you exactly that if it happens, rather than break the site. If it turns out you need their paid tier, the rest of the app (manual scoring, trades, bracket, odds) works the same either way.

## 3. Deploy to Vercel

**Easiest path (no terminal):**
1. Put this whole folder in a GitHub repo (or just drag the folder into Vercel's "Add New → Project" import screen).
2. In Vercel's import screen, before deploying, open **Environment Variables** and add:
   - `SUPABASE_URL` → your Project URL
   - `SUPABASE_SERVICE_KEY` → your service_role key
   - `FOOTBALL_DATA_KEY` → your football-data.org token
3. Deploy. You'll get a URL like `the-group-chat-cup.vercel.app`.

**With the CLI:**
```bash
npm i -g vercel
cd <this-folder>
vercel
# When prompted, or afterwards in the dashboard, add the same 3 env vars above
vercel --prod
```

## 4. Turn on shared mode in `index.html`

Open `index.html`, find this near the top of the `<script>` block:
```js
const SUPABASE_URL = "";       // e.g. "https://abcd1234.supabase.co"
const SUPABASE_ANON_KEY = "";  // the "anon public" key
```
Paste in your Project URL and **anon** key (not the service key — that one stays out of this file). Redeploy (`vercel --prod`, or push to GitHub if it's connected). Once both are filled in, the local-mode banner disappears and everyone visiting the site sees the same trades, scores, and standings.

---

## How it all fits together
- **Reading data:** every visitor's browser talks directly to Supabase using the public anon key, governed by row-level security policies that allow reads for everyone.
- **Proposing a trade:** also a direct, public insert — anyone can propose, it lands as `pending`.
- **Approving/rejecting a trade, or editing a score:** the browser calls a Postgres function (`approve_trade` / `update_team_state`) and passes whatever PIN you typed. The function checks the PIN *inside the database* before changing anything — there's no client-side bypass, since anon users have no direct UPDATE permission on those tables at all.
- **Live scores:** the "Try live refresh" button calls your own `/api/refresh-scores` endpoint (same origin, no CORS issues). That serverless function holds the football-data.org key server-side, fetches finished matches, computes each team's points/goal-difference/status, and writes it into Supabase with the service key. Every browser then just re-reads the updated `teams_state` table.

## Known simplifications (so you're not surprised)
- The auto-computed **status** (advanced/alive/brink/eliminated) ranks strictly 1st/2nd in-group once all 3 group matches are played. It does **not** model the 8 best-third-place wildcard spots — that logic is genuinely fiddly across 12 groups. A commissioner can always hand-correct any team's status via "Commissioner: edit a score," PIN included.
- Team names from football-data.org occasionally differ from your roster list (e.g. "Korea Republic" vs "South Korea"). `api/refresh-scores.js` has an `ALIASES` map at the top — if a refresh comes back looking off for a specific team, add the mapping there and redeploy.
- The bracket past the Round of 32 is a *projected path* (who plays who if seeds hold), not pulled live — there's no official Round of 16+ schedule to fetch until the group stage finishes.

## Running with no backend at all
If you skip Supabase entirely (leave those two consts blank), the site still works — it just falls back to **local mode**: everything saves to that one browser only, same as the original version. Good for testing before you wire up the shared backend.
