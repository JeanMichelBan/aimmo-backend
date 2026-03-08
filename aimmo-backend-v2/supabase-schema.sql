-- ============================================================
-- AIMMO - Schéma Supabase complet
-- Coller dans : Supabase Dashboard > SQL Editor > New Query
-- ============================================================

-- 1. TABLE USERS
create table if not exists public.users (
  id uuid references auth.users(id) on delete cascade primary key,
  email text unique not null,
  plan text not null default 'free' check (plan in ('free', 'pro', 'expert')),
  nb_scans_mois integer default 0,
  nb_analyses_mois integer default 0,
  stripe_customer_id text,
  stripe_subscription_id text,
  plan_updated_at timestamptz,
  created_at timestamptz default now()
);

-- 2. TABLE ANNONCES
create table if not exists public.annonces (
  id uuid default gen_random_uuid() primary key,
  titre text not null,
  description text,
  url_source text unique,
  source text,
  badge text default 'badge-cl',
  surface integer,
  prix integer,
  cp text,
  ville text,
  type text,
  dpe text,
  chauffage text,
  pieces integer,
  annee integer,
  kws text[] default '{}',
  photos text[] default '{}',
  score_ia numeric(3,1) default 5.0,
  indicateurs jsonb default '{}',
  is_new boolean default true,
  date_annonce timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Index pour les recherches fréquentes
create index if not exists annonces_cp_idx on public.annonces(cp);
create index if not exists annonces_score_idx on public.annonces(score_ia desc);
create index if not exists annonces_source_idx on public.annonces(source);
create index if not exists annonces_created_idx on public.annonces(created_at desc);

-- 3. TABLE ANALYSES (off-market)
create table if not exists public.analyses (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.users(id) on delete cascade,
  bien_data jsonb not null,
  analyse_data jsonb,
  score numeric(3,1),
  ville text,
  cp text,
  created_at timestamptz default now()
);

create index if not exists analyses_user_idx on public.analyses(user_id);

-- 4. TABLE ALERTES
create table if not exists public.alertes (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.users(id) on delete cascade,
  nom text,
  criteres jsonb default '{}',
  active boolean default true,
  derniere_alerte timestamptz,
  created_at timestamptz default now()
);

-- 5. TABLE ANALYSES SAUVEGARDÉES
create table if not exists public.analyses_saved (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.users(id) on delete cascade,
  titre text,
  localisation text,
  score numeric(3,1),
  data jsonb,
  created_at timestamptz default now()
);

-- 6. FONCTION incrémenter analyses
create or replace function increment_analyses(user_id uuid)
returns void as $$
  update public.users
  set nb_analyses_mois = nb_analyses_mois + 1
  where id = user_id;
$$ language sql;

-- 7. FONCTION reset quotas mensuel (à appeler via cron Supabase)
create or replace function reset_quotas_mensuels()
returns void as $$
  update public.users
  set nb_scans_mois = 0, nb_analyses_mois = 0;
$$ language sql;

-- 8. RLS (Row Level Security) - chaque user voit ses données
alter table public.users enable row level security;
alter table public.analyses enable row level security;
alter table public.alertes enable row level security;
alter table public.analyses_saved enable row level security;

-- Policies users
create policy "Users can view own profile"
  on public.users for select using (auth.uid() = id);
create policy "Users can update own profile"
  on public.users for update using (auth.uid() = id);

-- Policies analyses
create policy "Users can view own analyses"
  on public.analyses for select using (auth.uid() = user_id);
create policy "Users can insert own analyses"
  on public.analyses for insert with check (auth.uid() = user_id);

-- Policies alertes
create policy "Users can manage own alertes"
  on public.alertes for all using (auth.uid() = user_id);

-- Policies analyses_saved
create policy "Users can manage own saved"
  on public.analyses_saved for all using (auth.uid() = user_id);

-- Annonces publiques (tout le monde peut lire)
alter table public.annonces enable row level security;
create policy "Annonces are public readable"
  on public.annonces for select using (true);

-- 9. Données de test (optionnel)
insert into public.annonces (titre, source, badge, surface, prix, cp, ville, type, kws, score_ia, is_new) values
('Ferme à rénover — vente urgente', 'PAP.fr', 'badge-cl', 185, 34000, '23000', 'Guéret', 'Maison', '{"urgent","travaux"}', 8.7, true),
('Manoir XIXe — succession', 'Bien sans maître', 'badge-hd', 480, 180000, '09100', 'Pamiers', 'Château', '{"succession","abandon"}', 9.1, true),
('Appartement haussmannien notaire', 'SeLoger', 'badge-cl', 88, 172000, '08000', 'Charleville', 'Appartement', '{"notaire"}', 6.8, true)
on conflict (url_source) do nothing;

-- ============================================================
-- Fin du schéma
-- Appuyer sur "Run" dans Supabase SQL Editor
-- ============================================================
