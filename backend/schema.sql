-- JobPilot — Supabase schema
-- Run this in your Supabase project: SQL Editor → New query → paste → Run.

create table if not exists public.profiles (
  user_sub      text primary key,          -- Google account subject id
  email         text,
  structured    jsonb not null default '{}'::jsonb,  -- Quick Details fields
  profile_text  text  not null default '',  -- extra typed notes
  resume_text   text  not null default '',  -- extracted text of the default resume
  resumes       jsonb not null default '[]'::jsonb,  -- all resumes: [{id,name,text,fileName,fileType,updatedAt,isDefault}]
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

-- Migration for databases created before multiple resumes were supported.
alter table public.profiles add column if not exists resumes jsonb not null default '[]'::jsonb;

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


-- Feedback reports sent from the extension ("Report a problem").
-- Read and triaged on the admin page (/admin); only the backend can access it.
create table if not exists public.feedback (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz,
  user_sub    text not null,
  email       text,                              -- shown to admins only if contact_ok
  contact_ok  boolean not null default false,
  type        text not null default 'other',     -- bug | wrong-answer | site | idea | other
  status      text not null default 'new',       -- new | in-progress | fixed | wont-fix
  message     text not null,
  details     jsonb not null default '{}'::jsonb -- site, version, field counts, last error
);
create index if not exists feedback_created_idx on public.feedback (created_at desc);
create index if not exists feedback_user_idx on public.feedback (user_sub, created_at);
alter table public.feedback enable row level security;
-- No policies → service-role key (backend) only.
