-- Central de Inteligência do Shopee Fila
-- Migração aditiva: preserva produtos, fila e memória existentes.

create table if not exists public.shopee_product_snapshots (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.produtos(id) on delete set null,
  item_id text,
  product_name text not null,
  sales integer not null default 0,
  price numeric,
  discount numeric,
  rating numeric,
  commission numeric,
  captured_at timestamptz not null default now()
);
create index if not exists shopee_product_snapshots_product_date_idx
  on public.shopee_product_snapshots (product_id, captured_at desc);
create index if not exists shopee_product_snapshots_item_date_idx
  on public.shopee_product_snapshots (item_id, captured_at desc);

create table if not exists public.shopee_metrics_snapshots (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.produtos(id) on delete set null,
  item_id text,
  product_name text not null,
  clicks integer not null default 0,
  orders integer not null default 0,
  items_sold integer not null default 0,
  order_value numeric not null default 0,
  estimated_commission numeric not null default 0,
  validated_commission numeric not null default 0,
  conversion numeric not null default 0,
  captured_at timestamptz not null default now()
);
create index if not exists shopee_metrics_snapshots_product_date_idx
  on public.shopee_metrics_snapshots (product_id, captured_at desc);

create table if not exists public.shopee_keyword_history (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.produtos(id) on delete set null,
  term text not null,
  category text,
  keywords jsonb not null default '[]'::jsonb,
  source text,
  created_at timestamptz not null default now()
);
create index if not exists shopee_keyword_history_created_idx
  on public.shopee_keyword_history (created_at desc);
create index if not exists shopee_keyword_history_term_idx
  on public.shopee_keyword_history (term);

create table if not exists public.shopee_competitor_research (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.produtos(id) on delete set null,
  product_name text not null,
  search_query text not null,
  results jsonb not null default '[]'::jsonb,
  offers jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists shopee_competitor_research_created_idx
  on public.shopee_competitor_research (created_at desc);

create table if not exists public.shopee_hook_tests (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.produtos(id) on delete set null,
  memory_id bigint references public.diretor_ia_memoria(id) on delete set null,
  hook_type text not null,
  hook_text text not null,
  visual_open text,
  status text not null default 'planejado'
    check (status in ('planejado','publicado','descartado')),
  impressions integer not null default 0,
  views integer not null default 0,
  clicks integer not null default 0,
  orders integer not null default 0,
  revenue numeric not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists shopee_hook_tests_product_date_idx
  on public.shopee_hook_tests (product_id, created_at desc);
create index if not exists shopee_hook_tests_status_idx
  on public.shopee_hook_tests (status, created_at desc);

alter table public.shopee_product_snapshots enable row level security;
alter table public.shopee_metrics_snapshots enable row level security;
alter table public.shopee_keyword_history enable row level security;
alter table public.shopee_competitor_research enable row level security;
alter table public.shopee_hook_tests enable row level security;

grant all on public.shopee_product_snapshots to service_role;
grant all on public.shopee_metrics_snapshots to service_role;
grant all on public.shopee_keyword_history to service_role;
grant all on public.shopee_competitor_research to service_role;
grant all on public.shopee_hook_tests to service_role;

create or replace function public.shopee_fila_capture_product_snapshot()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT'
     or old.vendas is distinct from new.vendas
     or old.preco is distinct from new.preco
     or old.desconto is distinct from new.desconto
     or old.avaliacao is distinct from new.avaliacao
     or old.comissao is distinct from new.comissao then
    insert into public.shopee_product_snapshots
      (product_id,item_id,product_name,sales,price,discount,rating,commission,captured_at)
    values
      (new.id,new.item_id,new.nome,coalesce(new.vendas,0),new.preco,new.desconto,new.avaliacao,new.comissao,now());
  end if;
  return new;
end;
$$;

drop trigger if exists shopee_fila_product_snapshot on public.produtos;
create trigger shopee_fila_product_snapshot
after insert or update of vendas,preco,desconto,avaliacao,comissao
on public.produtos
for each row execute function public.shopee_fila_capture_product_snapshot();

create or replace function public.shopee_fila_capture_metrics_snapshot()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT'
     or old.cliques_convertidos is distinct from new.cliques_convertidos
     or old.pedidos is distinct from new.pedidos
     or old.itens_vendidos is distinct from new.itens_vendidos
     or old.valor_pedidos is distinct from new.valor_pedidos
     or old.comissao_estimada is distinct from new.comissao_estimada
     or old.comissao_validada is distinct from new.comissao_validada
     or old.conversao is distinct from new.conversao then
    insert into public.shopee_metrics_snapshots
      (product_id,item_id,product_name,clicks,orders,items_sold,order_value,estimated_commission,validated_commission,conversion,captured_at)
    values
      (new.id,new.item_id,new.nome,coalesce(new.cliques_convertidos,0),coalesce(new.pedidos,0),
       coalesce(new.itens_vendidos,0),coalesce(new.valor_pedidos,0),coalesce(new.comissao_estimada,0),
       coalesce(new.comissao_validada,0),coalesce(new.conversao,0),now());
  end if;
  return new;
end;
$$;

drop trigger if exists shopee_fila_metrics_snapshot on public.produtos;
create trigger shopee_fila_metrics_snapshot
after insert or update of cliques_convertidos,pedidos,itens_vendidos,valor_pedidos,comissao_estimada,comissao_validada,conversao
on public.produtos
for each row execute function public.shopee_fila_capture_metrics_snapshot();

-- Cria uma linha de base para os produtos e métricas que já existem.
insert into public.shopee_product_snapshots
  (product_id,item_id,product_name,sales,price,discount,rating,commission,captured_at)
select id,item_id,nome,coalesce(vendas,0),preco,desconto,avaliacao,comissao,now()
from public.produtos p
where not exists (
  select 1 from public.shopee_product_snapshots s where s.product_id=p.id
);

insert into public.shopee_metrics_snapshots
  (product_id,item_id,product_name,clicks,orders,items_sold,order_value,estimated_commission,validated_commission,conversion,captured_at)
select id,item_id,nome,coalesce(cliques_convertidos,0),coalesce(pedidos,0),
       coalesce(itens_vendidos,0),coalesce(valor_pedidos,0),coalesce(comissao_estimada,0),
       coalesce(comissao_validada,0),coalesce(conversao,0),now()
from public.produtos p
where not exists (
  select 1 from public.shopee_metrics_snapshots s where s.product_id=p.id
);
