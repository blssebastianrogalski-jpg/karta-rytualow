// Ustawienia aplikacji.
// Gdy SUPABASE_URL i SUPABASE_ANON_KEY są puste, aplikacja działa w TRYBIE DEMO:
// dane zapisują się tylko w tej przeglądarce (do testów).
window.APP_CONFIG = {
  SUPABASE_URL: 'https://pqvndgttgzaosjqjtxbg.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_Fs1pn9qjzVEHJjr9Qt8dEw_WicjPg3C',

  STUDIO_NAME: 'Twoje Ciało Twój Dobrostan',
  BOOKSY_URL: 'https://twojecialotwojdobrostan69.booksy.com/k',
  PHONE: '500 694 094',
  ADDRESS: 'ul. Zawierciańska 4/12, 32-310 Klucze',
  INSTAGRAM_URL: 'https://www.instagram.com/jrtwojecialo',
  FACEBOOK_URL: 'https://www.facebook.com/jrtwojecialo',
  WEBSITE_URL: 'https://twojecialotwojdobrostan.pl',
  VOUCHER_URL: 'https://twojecialotwojdobrostan.pl/voucher-na-masaz-klucze/',
  GOOGLE_REVIEW_URL: 'https://g.page/r/CQM4lNka6sVNEBM/review',
  // Klucz publiczny VAPID do powiadomień push. Puste = przycisk ukryty.
  PUSH_PUBLIC_KEY: 'BMmiIwyPch5Ffp9O9CYb81HmMhVIsFrMJ4HesZMXJ1btYHOWiaXBz70A_Ijez4BR457jvdwwgWUPTA68MbrX2TM',
  APP_URL: 'https://karta.twojecialotwojdobrostan.pl/',
  // Przycisk „Dodaj do Portfela Google” na Androidzie (funkcja portfel-google).
  // 'test' = tylko dla kart z listy niżej (zanim Google zatwierdzi kartę), true = dla wszystkich, false = ukryty.
  GOOGLE_WALLET: 'test',
  GOOGLE_WALLET_TEST_CARDS: [],

  // Rytuały do wyboru przy dodawaniu pieczątki
  SERVICES: [
    'Kobido UP®',
    'Master Kobido UP®',
    'Head SPA Premium',
    'Access Bars®',
    'Refleksologia Stóp Premium',
    'Masaż relaksacyjny 60 min',
    'Masaż relaksacyjny 90 min',
    'Masaż aromaterapeutyczny 60 min',
    'Masaż aromaterapeutyczny 90 min',
    'Masaż gorącą świecą',
    'Masaż głowy, karku i obręczy barkowej',
    'Ukojenie Dla Żuchwy i Twarzy'
  ]
};
