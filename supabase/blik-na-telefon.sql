-- Płatności przy sprzedaży vouchera: BLIK (kod przez PayU), gotówka, BLIK na telefon.
-- „karta” zostaje w warunku tylko dla starych wpisów w historii.
alter table public.voucher_sales drop constraint if exists voucher_sales_payment_check;
alter table public.voucher_sales add constraint voucher_sales_payment_check
  check (payment in ('gotowka', 'karta', 'blik', 'blik_telefon'));
