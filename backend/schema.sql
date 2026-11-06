-- JobPilot — Supabase schema
-- Run this in your Supabase project: SQL Editor → New query → paste → Run.

create table if not exists public.profiles (
  user_sub      text primary key,          -- Google account subject id
  email         text,
  structured    jsonb not null default '{}'::jsonb,  -- Quick Details fields
  profile_text  text  not null default '',  -- extra typed notes
  resume_text   text  not null default '',  -- extracted resume text
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

-- The backend uses the service-role key and enforces per-user access in code
-- (by the verified Google token), so Row Level Security is not strictly
-- required. We still enable it and deny anon access as defense-in-depth.
alter table public.profiles enable row level security;

-- No policies for anon/authenticated roles → only the service-role key (used
-- by the backend) can read/write. This keeps data private.

-- Per-user monthly usage counters (protects shared AI quota from any single
-- heavy user starving everyone else).
create table if not exists public.usage_counters (
  user_sub   text not null,
  month      text not null,           -- "YYYY-MM", server-computed (UTC)
  count      integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_sub, month)
);

alter table public.usage_counters enable row level security;
-- No policies for anon/authenticated → service-role key only.

-- Atomically increments (and creates if missing) the counter for a user for
-- the given month, and returns the new count. Doing the increment inside a
-- single SQL statement avoids race conditions from concurrent requests.
create or replace function public.increment_usage(p_user_sub text, p_month text)
returns integer
language sql
as $$
  insert into public.usage_counters (user_sub, month, count, updated_at)
  values (p_user_sub, p_month, 1, now())
  on conflict (user_sub, month)
  do update set count = public.usage_counters.count + 1, updated_at = now()
  returning count;
$$;

