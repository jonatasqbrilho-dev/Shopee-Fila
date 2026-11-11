-- Garante medições periódicas mesmo quando as vendas não mudam.
-- O gatilho já dispara quando o sincronizador atualiza os campos monitorados;
-- limitamos a uma captura por produto a cada 6 horas para evitar excesso de linhas.

create or replace function public.shopee_fila_capture_product_snapshot()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  last_capture timestamptz;
begin
  select max(captured_at)
    into last_capture
    from public.shopee_product_snapshots
   where product_id = new.id;

  if last_capture is null or last_capture <= now() - interval '6 hours' then
    insert into public.shopee_product_snapshots
      (product_id,item_id,product_name,sales,price,discount,rating,commission,captured_at)
    values
      (new.id,new.item_id,new.nome,coalesce(new.vendas,0),new.preco,new.desconto,
       new.avaliacao,new.comissao,now());
  end if;

  return new;
end;
$$;
