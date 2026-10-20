-- Execute este arquivo no SQL Editor do Supabase para habilitar a fila persistente de Shopee Video.
create table if not exists public.shopee_video_queue (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.produtos(id) on delete set null,
  product_name text not null,
  product_url text,
  video_url text,
  caption text not null default '',
  scheduled_date date not null default current_date,
  position integer not null default 1,
  status text not null default 'pendente' check (status in ('pendente','publicado','ignorado')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists shopee_video_queue_date_position
  on public.shopee_video_queue (scheduled_date, position);
alter table public.shopee_video_queue enable row level security;
