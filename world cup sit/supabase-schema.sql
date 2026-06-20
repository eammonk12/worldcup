-- ============================================================
-- The Group Chat Cup — Supabase schema
-- Run this once in Supabase: Project → SQL Editor → New query → paste → Run
-- ============================================================

create extension if not exists pgcrypto;

-- Live group-stage state per team. The /api/refresh-scores function
-- (and the commissioner's manual edit) both write here.
create table if not exists public.teams_state (
  team text primary key,
  pts int not null default 0,
  gd int not null default 0,
  pld int not null default 0,
  status text not null default 'alive', -- adv | alive | brink | elim | dnq
  updated_at timestamptz not null default now()
);

-- Finished match results, shown on the Matches tab.
create table if not exists public.results (
  id bigserial primary key,
  home text not null,
  home_score int not null,
  away text not null,
  away_score int not null,
  match_date text,
  grp text,
  played_at timestamptz not null default now(),
  unique (home, away)
);

-- Trade requests.
create table if not exists public.trades (
  id text primary key default encode(gen_random_bytes(8), 'hex'),
  created_at timestamptz not null default now(),
  from_player text not null,
  with_player text not null,
  team_out text not null,
  team_in text not null,
  note text,
  status text not null default 'pending' -- pending | approved | rejected
);

alter table public.teams_state enable row level security;
alter table public.results enable row level security;
alter table public.trades enable row level security;

-- Everyone in the group can read everything (it's a friend pool, not sensitive data).
create policy "read teams_state" on public.teams_state for select using (true);
create policy "read results"     on public.results     for select using (true);
create policy "read trades"      on public.trades       for select using (true);

-- Anyone can propose a trade — it lands as 'pending'.
create policy "insert trades" on public.trades for insert with check (status = 'pending');

-- IMPORTANT: there are no UPDATE policies for anon on trades or teams_state.
-- The only way to change a trade's status or edit a team's score is through
-- the PIN-checked functions below, which run as the table owner.

-- ---- Change this PIN before you share the site ----
-- It appears in TWO places below. Update both, then re-run this whole file
-- (CREATE OR REPLACE is safe to run again).
create or replace function public.approve_trade(p_id text, p_pin text, p_decision text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_pin <> '2026' then
    raise exception 'Incorrect PIN';
  end if;
  if p_decision not in ('approved', 'rejected') then
    raise exception 'Invalid decision';
  end if;
  update public.trades set status = p_decision where id = p_id;
end;
$$;

create or replace function public.update_team_state(
  p_team text, p_pts int, p_gd int, p_pld int, p_status text, p_pin text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_pin <> '2026' then
    raise exception 'Incorrect PIN';
  end if;
  insert into public.teams_state (team, pts, gd, pld, status, updated_at)
  values (p_team, p_pts, p_gd, p_pld, p_status, now())
  on conflict (team) do update
    set pts = excluded.pts, gd = excluded.gd, pld = excluded.pld,
        status = excluded.status, updated_at = now();
end;
$$;

grant execute on function public.approve_trade(text, text, text) to anon;
grant execute on function public.update_team_state(text, int, int, int, text, text) to anon;
