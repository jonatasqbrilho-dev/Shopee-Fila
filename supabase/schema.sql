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
  -- pendente | aprovado | publicado | rejeitado | sem_video | descartado
  status text not null default 'pendente',
  plataformas text[] not null default '{}',
  video_url text,
  telegram_ok boolean not null default false,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index if not exists produtos_status_nota on produtos (status, nota desc);
alter table produtos enable row level security; -- acesso só pelas funções (service key)

insert into storage.buckets (id, name, public) values ('videos', 'videos', true)
on conflict (id) do nothing;
