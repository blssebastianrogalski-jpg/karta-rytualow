-- Sprzedaż voucherów z panelu studia (paragon przez WooCommerce + eparagony.pl).
-- Historia sprzedaży. Zapisuje ją tylko funkcja sprzedaz-vouchera (service role),
-- panel studia może ją tylko czytać.
create table if not exists public.voucher_sales (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id) on delete set null,
  client_ref    uuid not null unique,                 -- chroni przed podwójną sprzedażą przy ponowieniu
  card_id       uuid references public.cards(id) on delete set null,
  product_id    int not null,
  product_name  text not null,
  qty           smallint not null check (qty between 1 and 10),
  unit_price    numeric(10,2),
  total         numeric(10,2),
  payment       text not null check (payment in ('gotowka', 'karta', 'blik')),
  buyer_name    text,
  buyer_email   text,
  buyer_phone   text,
  order_id      bigint,
  order_number  text,
  receipt       text not null default 'pending' check (receipt in ('pending', 'queued', 'sent', 'confirmed', 'error', 'failed')),
  stamps_added  smallint not null default 0,
  error         text
);
create index if not exists voucher_sales_created_idx on public.voucher_sales(created_at desc);

alter table public.voucher_sales enable row level security;
drop policy if exists "staff reads voucher sales" on public.voucher_sales;
create policy "staff reads voucher sales" on public.voucher_sales for select using (public.is_staff());

revoke all on public.voucher_sales from anon, authenticated;
grant select on public.voucher_sales to authenticated;
grant select, insert, update, delete on public.voucher_sales to service_role;
grant usage, select on sequence public.voucher_sales_id_seq to service_role;
