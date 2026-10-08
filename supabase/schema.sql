create table if not exists produtos (
  id uuid primary key default gen_random_uuid(),
  item_id text unique not null,
  nome text not null,
  imagem text,
  preco numeric,
  desconto int,
  vendas int,
  avaliacao numeric,
  comissao numeric,
  link_afiliado text,
  link_produto text,
  nota int,
  motivo text,
  legenda text,
  video_prompt text,
  video_roteiro text,
  video_narracao text,
  video_textos text,
  video_cta text,
  hashtags text[] not null default '{}',
  pacote_gerado_em timestamptz,
  sub_ids text[] not null default '{}',
  links_plataforma jsonb not null default '{}'::jsonb,
  cliques_convertidos int not null default 0,
  pedidos int not null default 0,
  itens_vendidos int not null default 0,
  valor_pedidos numeric not null default 0,
  comissao_estimada numeric not null default 0,
  comissao_validada numeric not null default 0,
  conversao numeric not null default 0,
  ultima_sincronizacao timestamptz,
  metricas_status text,
  status text not null default 'pendente',
  plataformas text[] not null default '{}',
  video_url text,
  telegram_ok boolean not null default false,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

alter table produtos add column if not exists video_prompt text;
alter table produtos add column if not exists video_roteiro text;
alter table produtos add column if not exists video_narracao text;
alter table produtos add column if not exists video_textos text;
alter table produtos add column if not exists video_cta text;
alter table produtos add column if not exists hashtags text[] not null default '{}';
alter table produtos add column if not exists pacote_gerado_em timestamptz;
alter table produtos add column if not exists sub_ids text[] not null default '{}';
alter table produtos add column if not exists links_plataforma jsonb not null default '{}'::jsonb;
alter table produtos add column if not exists cliques_convertidos int not null default 0;
alter table produtos add column if not exists pedidos int not null default 0;
alter table produtos add column if not exists itens_vendidos int not null default 0;
alter table produtos add column if not exists valor_pedidos numeric not null default 0;
alter table produtos add column if not exists comissao_estimada numeric not null default 0;
alter table produtos add column if not exists comissao_validada numeric not null default 0;
alter table produtos add column if not exists conversao numeric not null default 0;
alter table produtos add column if not exists ultima_sincronizacao timestamptz;
alter table produtos add column if not exists metricas_status text;

create index if not exists produtos_status_nota on produtos (status, nota desc);
create index if not exists produtos_atualizado on produtos (atualizado_em desc);
alter table produtos enable row level security;

insert into storage.buckets (id, name, public) values ('videos', 'videos', true)
on conflict (id) do nothing;
