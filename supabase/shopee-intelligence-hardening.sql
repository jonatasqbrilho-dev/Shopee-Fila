-- Hardening da Central de Inteligência
alter function public.shopee_fila_capture_product_snapshot() set search_path = public, pg_temp;
alter function public.shopee_fila_capture_metrics_snapshot() set search_path = public, pg_temp;

create index if not exists shopee_conversion_periods_product_id_idx
  on public.shopee_conversion_periods (product_id);
create index if not exists shopee_competitor_research_product_id_idx
  on public.shopee_competitor_research (product_id);
create index if not exists shopee_keyword_history_product_id_idx
  on public.shopee_keyword_history (product_id);
create index if not exists shopee_hook_tests_memory_id_idx
  on public.shopee_hook_tests (memory_id);
