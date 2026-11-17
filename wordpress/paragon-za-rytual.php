<?php
/**
 * Paragon za rytuał z panelu studia (Code Snippets, „Uruchamiaj wszędzie”).
 *
 * Panel studia (karta.twojecialotwojdobrostan.pl/panel.html) wysyła tu rytuał, kwotę,
 * płatność i dane klientki. Fragment tworzy opłacone zamówienie WooCommerce z ukrytym
 * produktem „rytuał”, a wtyczka eparagony.pl drukuje paragon na Elzab i wysyła
 * e-paragon na e-mail klientki (tak samo jak przy voucherach).
 * E-mail jest nieobowiązkowy: bez niego paragon i tak się drukuje, a e-paragon (kopia)
 * idzie na adres sklepu (WooCommerce → Ustawienia → E-maile → adres nadawcy).
 *
 * Dostęp: tylko zalogowana osoba z panelu. Fragment sprawdza jej token w Supabase
 * (funkcja is_staff), więc nie ma tu żadnego tajnego klucza.
 *
 * Adresy (prefiks /wp-json/tctd/v1/paragon):
 *   GET  /rytualy        lista rytuałów z cenami (produkty z kategorii „Rytuały – paragon”)
 *                        i na końcu pozycja „Zadatek na poczet rezerwacji terminu” (deposit: true, kwota dowolna)
 *   POST /               { client_ref, product_id, amount, payment, name, email?, phone? }
 *   GET  /{order_id}     status paragonu
 *   GET  /historia       ostatnie paragony za rytuały
 *
 * Ceny zmieniasz w WooCommerce → Produkty (kategoria „Rytuały – paragon”, produkty prywatne,
 * niewidoczne w sklepie). Przy pierwszym użyciu fragment sam zakłada je z listy niżej.
 */

if ( ! defined( 'ABSPATH' ) ) {
	return;
}

defined( 'TCTD_PARAGON_SUPABASE_URL' ) || define( 'TCTD_PARAGON_SUPABASE_URL', 'https://pqvndgttgzaosjqjtxbg.supabase.co' );
defined( 'TCTD_PARAGON_SUPABASE_KEY' ) || define( 'TCTD_PARAGON_SUPABASE_KEY', 'sb_publishable_Fs1pn9qjzVEHJjr9Qt8dEw_WicjPg3C' ); // klucz publiczny, ten sam co w aplikacji
defined( 'TCTD_PARAGON_CAT' ) || define( 'TCTD_PARAGON_CAT', 'rytualy-paragon' );
defined( 'TCTD_PARAGON_META' ) || define( 'TCTD_PARAGON_META', '_tctd_paragon_rytual' );
defined( 'TCTD_PARAGON_DEPOSIT_SKU' ) || define( 'TCTD_PARAGON_DEPOSIT_SKU', 'zadatek-rezerwacja' );
defined( 'TCTD_PARAGON_DEPOSIT_MAX' ) || define( 'TCTD_PARAGON_DEPOSIT_MAX', 2000 ); // najwyższy zadatek w zł

// Lista startowa (cennik z Booksy, listopad 2026). Używana tylko, gdy kategoria jest pusta.
function tctd_paragon_defaults() {
	return array(
		array( 'Kobido UP®', 200 ),
		array( 'Master Kobido UP®', 280 ),
		array( 'Head SPA Premium', 350 ),
		array( 'Access Bars®', 150 ),
		array( 'Refleksologia Stóp Premium', 150 ),
		array( 'Masaż relaksacyjny 60 min', 150 ),
		array( 'Masaż relaksacyjny 90 min', 190 ),
		array( 'Masaż aromaterapeutyczny 60 min', 180 ),
		array( 'Masaż aromaterapeutyczny 90 min', 230 ),
		array( 'Masaż gorącą świecą', 190 ),
		array( 'Masaż głowy, karku i obręczy barkowej', 130 ),
		array( 'Ukojenie dla Żuchwy i Twarzy', 190 ),
	);
}

// Panel wysyła token logowania w nagłówku X-TCTD-Staff (przeglądarka musi go mieć na liście CORS).
add_filter( 'rest_allowed_cors_headers', function ( $headers ) {
	$headers[] = 'X-TCTD-Staff';
	return $headers;
} );

add_action( 'rest_api_init', function () {
	$ns   = 'tctd/v1';
	$auth = 'tctd_paragon_is_staff';
	register_rest_route( $ns, '/paragon/rytualy', array( 'methods' => 'GET', 'callback' => 'tctd_paragon_list', 'permission_callback' => $auth ) );
	register_rest_route( $ns, '/paragon/historia', array( 'methods' => 'GET', 'callback' => 'tctd_paragon_history', 'permission_callback' => $auth ) );
	register_rest_route( $ns, '/paragon/(?P<id>\d+)', array( 'methods' => 'GET', 'callback' => 'tctd_paragon_status', 'permission_callback' => $auth ) );
	register_rest_route( $ns, '/paragon', array( 'methods' => 'POST', 'callback' => 'tctd_paragon_issue', 'permission_callback' => $auth ) );
} );

// Czy token należy do osoby z panelu studia. Wynik pamiętany 10 minut.
function tctd_paragon_is_staff( WP_REST_Request $req ) {
	$token = trim( (string) $req->get_header( 'x_tctd_staff' ) );
	if ( strlen( $token ) < 20 ) {
		return new WP_Error( 'tctd_auth', 'Zaloguj się ponownie w panelu studia.', array( 'status' => 401 ) );
	}
	$cache = 'tctd_staff_' . md5( $token );
	if ( get_transient( $cache ) === 'yes' ) {
		return true;
	}
	$res = wp_remote_post( TCTD_PARAGON_SUPABASE_URL . '/rest/v1/rpc/is_staff', array(
		'timeout' => 10,
		'headers' => array(
			'apikey'        => TCTD_PARAGON_SUPABASE_KEY,
			'Authorization' => 'Bearer ' . $token,
			'Content-Type'  => 'application/json',
		),
		'body'    => '{}',
	) );
	if ( is_wp_error( $res ) ) {
		return new WP_Error( 'tctd_auth', 'Nie mogę sprawdzić logowania. Spróbuj za chwilę.', array( 'status' => 503 ) );
	}
	if ( trim( wp_remote_retrieve_body( $res ) ) !== 'true' ) {
		return new WP_Error( 'tctd_auth', 'Brak dostępu. Zaloguj się ponownie w panelu studia.', array( 'status' => 403 ) );
	}
	set_transient( $cache, 'yes', 10 * MINUTE_IN_SECONDS );
	return true;
}

function tctd_paragon_category_id() {
	$term = get_term_by( 'slug', TCTD_PARAGON_CAT, 'product_cat' );
	if ( $term ) {
		return (int) $term->term_id;
	}
	$new = wp_insert_term( 'Rytuały – paragon', 'product_cat', array(
		'slug'        => TCTD_PARAGON_CAT,
		'description' => 'Rytuały do paragonu z panelu studia. Produkty prywatne, niewidoczne w sklepie.',
	) );
	return is_wp_error( $new ) ? 0 : (int) $new['term_id'];
}

function tctd_paragon_products() {
	$cat = tctd_paragon_category_id();
	if ( ! $cat ) {
		return array();
	}
	$query = array(
		'status'   => array( 'private', 'publish' ),
		'limit'    => 100,
		'orderby'  => 'menu_order',
		'order'    => 'ASC',
		'category' => array( TCTD_PARAGON_CAT ),
	);
	$list = wc_get_products( $query );
	if ( ! $list && ! get_option( 'tctd_paragon_seeded' ) ) {
		update_option( 'tctd_paragon_seeded', 1, false );
		$order = 0;
		foreach ( tctd_paragon_defaults() as $row ) {
			$p = new WC_Product_Simple();
			$p->set_name( $row[0] );
			$p->set_regular_price( (string) $row[1] );
			$p->set_virtual( true );
			$p->set_status( 'private' );
			$p->set_catalog_visibility( 'hidden' );
			$p->set_menu_order( ++$order );
			$p->set_category_ids( array( $cat ) );
			$p->set_sku( 'rytual-' . sanitize_title( $row[0] ) );
			$p->save();
		}
		$list = wc_get_products( $query );
	}
	return $list;
}

// Zadatek na poczet rezerwacji terminu: osobny ukryty produkt bez stałej ceny (kwotę wpisuje się w panelu).
// Zakładany sam przy pierwszym użyciu. Nazwę na paragonie zmieniasz w WooCommerce → Produkty.
function tctd_paragon_deposit_product() {
	$id = wc_get_product_id_by_sku( TCTD_PARAGON_DEPOSIT_SKU );
	if ( $id && ( $p = wc_get_product( $id ) ) ) {
		return $p;
	}
	$cat = tctd_paragon_category_id();
	if ( ! $cat ) {
		return null;
	}
	$p = new WC_Product_Simple();
	$p->set_name( 'Zadatek na poczet rezerwacji terminu' );
	$p->set_regular_price( '0' );
	$p->set_virtual( true );
	$p->set_status( 'private' );
	$p->set_catalog_visibility( 'hidden' );
	$p->set_menu_order( 999 );
	$p->set_category_ids( array( $cat ) );
	$p->set_sku( TCTD_PARAGON_DEPOSIT_SKU );
	$p->save();
	return $p;
}

function tctd_paragon_is_deposit( $product ) {
	return $product && $product->get_sku() === TCTD_PARAGON_DEPOSIT_SKU;
}

function tctd_paragon_list() {
	$out = array();
	foreach ( tctd_paragon_products() as $p ) {
		if ( tctd_paragon_is_deposit( $p ) ) {
			continue; // zadatek zawsze na końcu listy
		}
		$out[] = array( 'id' => $p->get_id(), 'name' => $p->get_name(), 'price' => (float) $p->get_regular_price() );
	}
	$dep = tctd_paragon_deposit_product();
	if ( $dep ) {
		$out[] = array( 'id' => $dep->get_id(), 'name' => $dep->get_name(), 'price' => 0, 'deposit' => true, 'max' => TCTD_PARAGON_DEPOSIT_MAX );
	}
	return $out;
}

// Stan paragonu z wtyczki eparagony.pl (pole _eparagony_state zamówienia).
function tctd_paragon_receipt( WC_Order $order ) {
	$state = (string) $order->get_meta( '_eparagony_state' );
	$data  = json_decode( (string) $order->get_meta( '_eparagony_document_data' ), true );
	$map   = array( 'confirmed' => 'confirmed', 'sent' => 'sent', 'sending' => 'sent', 'error' => 'error', 'queued' => 'queued', 'blank' => 'queued' );
	$out   = array( 'receipt' => $map[ $state ] ?? 'queued' );
	// Pole error bywa null także przy dobrym paragonie, więc błąd tylko przy stanie error.
	if ( $out['receipt'] === 'error' && is_array( $data ) && ! empty( $data['error'] ) ) {
		$out['error'] = (string) $data['error'];
	}
	return $out;
}

function tctd_paragon_row( WC_Order $order ) {
	$items = $order->get_items();
	$item  = $items ? reset( $items ) : null;
	return array_merge( array(
		'order_id'     => $order->get_id(),
		'order_number' => (string) $order->get_order_number(),
		'created_at'   => $order->get_date_created() ? $order->get_date_created()->format( DATE_ATOM ) : null,
		'service'      => $item ? $item->get_name() : '',
		'total'        => (float) $order->get_total(),
		'payment'      => (string) $order->get_meta( '_tctd_paragon_payment' ),
		'deposit'      => (bool) $order->get_meta( '_tctd_paragon_zadatek' ),
		'name'         => trim( $order->get_billing_first_name() . ' ' . $order->get_billing_last_name() ),
		'email'        => $order->get_meta( '_tctd_paragon_bez_maila' ) ? '' : $order->get_billing_email(),
	), tctd_paragon_receipt( $order ) );
}

function tctd_paragon_status( WP_REST_Request $req ) {
	$order = wc_get_order( (int) $req['id'] );
	if ( ! $order || ! $order->get_meta( TCTD_PARAGON_META ) ) {
		return new WP_Error( 'tctd_404', 'Nie ma takiego paragonu.', array( 'status' => 404 ) );
	}
	return tctd_paragon_row( $order );
}

function tctd_paragon_history() {
	$orders = wc_get_orders( array(
		'limit'      => 20,
		'orderby'    => 'date',
		'order'      => 'DESC',
		'meta_query' => array( array( 'key' => TCTD_PARAGON_META, 'value' => '1' ) ),
	) );
	return array_map( 'tctd_paragon_row', $orders );
}

function tctd_paragon_issue( WP_REST_Request $req ) {
	$b        = (array) $req->get_json_params();
	$ref      = strtolower( (string) ( $b['client_ref'] ?? '' ) );
	$pid      = (int) ( $b['product_id'] ?? 0 );
	$amount   = round( (float) ( $b['amount'] ?? 0 ), 2 );
	$payment  = (string) ( $b['payment'] ?? '' );
	$name     = trim( sanitize_text_field( (string) ( $b['name'] ?? '' ) ) );
	$email    = sanitize_email( (string) ( $b['email'] ?? '' ) );
	$phone    = trim( sanitize_text_field( (string) ( $b['phone'] ?? '' ) ) );
	$payments = array(
		'gotowka'      => array( 'tctd_gotowka', 'Gotówka' ),
		'blik_telefon' => array( 'tctd_blik_telefon', 'BLIK na telefon' ),
		'karta'        => array( 'tctd_karta', 'Karta płatnicza' ),
	);

	if ( ! preg_match( '/^[0-9a-f-]{36}$/', $ref ) ) {
		return new WP_Error( 'tctd_400', 'Brak identyfikatora paragonu.', array( 'status' => 400 ) );
	}
	$product = wc_get_product( $pid );
	if ( ! $product || ! has_term( TCTD_PARAGON_CAT, 'product_cat', $pid ) ) {
		return new WP_Error( 'tctd_400', 'Wybierz rytuał z listy.', array( 'status' => 400 ) );
	}
	$deposit = tctd_paragon_is_deposit( $product );
	$price   = $deposit ? (float) TCTD_PARAGON_DEPOSIT_MAX : (float) $product->get_regular_price();
	if ( $amount < 1 || $amount > $price ) {
		return new WP_Error( 'tctd_400', $deposit
			? 'Zadatek musi być od 1 zł do ' . wc_format_decimal( $price, 0 ) . ' zł.'
			: 'Kwota musi być od 1 zł do ceny rytuału (' . wc_format_decimal( $price, 2 ) . ' zł).', array( 'status' => 400 ) );
	}
	if ( ! isset( $payments[ $payment ] ) ) {
		return new WP_Error( 'tctd_400', 'Wybierz sposób płatności.', array( 'status' => 400 ) );
	}
	if ( mb_strlen( $name ) < 2 ) {
		return new WP_Error( 'tctd_400', 'Wpisz imię i nazwisko.', array( 'status' => 400 ) );
	}
	if ( $email !== '' && ! is_email( $email ) ) {
		return new WP_Error( 'tctd_400', 'Sprawdź adres e-mail.', array( 'status' => 400 ) );
	}
	// Klientka bez e-maila: zamówienie dostaje adres sklepu, żeby wtyczka eparagony.pl
	// miała komplet danych i wydrukowała paragon. Kopia e-paragonu trafia wtedy do studia.
	$no_mail = $email === '';
	if ( $no_mail ) {
		$email = sanitize_email( (string) get_option( 'woocommerce_email_from_address' ) );
		if ( ! is_email( $email ) ) {
			$email = sanitize_email( (string) get_option( 'admin_email' ) );
		}
	}

	// To samo kliknięcie wysłane drugi raz: oddaję istniejący paragon, nie drukuję drugiego.
	$prev = wc_get_orders( array( 'limit' => 1, 'meta_query' => array( array( 'key' => '_tctd_paragon_ref', 'value' => $ref ) ) ) );
	if ( $prev ) {
		return array_merge( tctd_paragon_row( $prev[0] ), array( 'duplicate' => true ) );
	}

	$parts = preg_split( '/\s+/', $name, 2 );
	$order = wc_create_order( array( 'created_via' => 'tctd-panel' ) );
	if ( is_wp_error( $order ) ) {
		return new WP_Error( 'tctd_500', 'Nie udało się utworzyć zamówienia.', array( 'status' => 500 ) );
	}
	// Cena regularna rytuału zostaje na pozycji, a niższa kwota pokaże się na paragonie jako rabat.
	$order->add_product( $product, 1, array( 'subtotal' => $amount, 'total' => $amount ) );
	$order->set_billing_first_name( $parts[0] );
	$order->set_billing_last_name( $parts[1] ?? '' );
	$order->set_billing_email( $email );
	if ( $phone !== '' ) {
		$order->set_billing_phone( $phone );
	}
	$order->set_payment_method( $payments[ $payment ][0] );
	$order->set_payment_method_title( $payments[ $payment ][1] );
	$order->update_meta_data( TCTD_PARAGON_META, '1' );
	$order->update_meta_data( '_tctd_paragon_ref', $ref );
	$order->update_meta_data( '_tctd_paragon_payment', $payment );
	if ( $no_mail ) {
		$order->update_meta_data( '_tctd_paragon_bez_maila', '1' );
	}
	if ( $deposit ) {
		$order->update_meta_data( '_tctd_paragon_zadatek', '1' );
	}
	$order->calculate_totals( false );
	$order->add_order_note( ( $deposit ? 'Paragon za zadatek na poczet rezerwacji terminu wystawiony z panelu studia.' : 'Paragon za rytuał wystawiony z panelu studia.' )
		. ( $no_mail ? ' Klientka bez e-maila: e-paragon (kopia) na adres sklepu.' : '' ) );
	$order->save();

	// Opłacone na miejscu: wtyczka eparagony.pl wysyła paragon do drukarki i e-paragon na e-mail.
	$order->payment_complete();

	return tctd_paragon_row( wc_get_order( $order->get_id() ) );
}

// Przy paragonie za rytuał klientka dostaje tylko e-paragon, bez maili „Twoje zamówienie”.
foreach ( array( 'customer_processing_order', 'customer_completed_order', 'customer_on_hold_order', 'new_order' ) as $tctd_mail ) {
	add_filter( 'woocommerce_email_enabled_' . $tctd_mail, function ( $enabled, $order ) {
		return ( $order instanceof WC_Order && $order->get_meta( TCTD_PARAGON_META ) ) ? false : $enabled;
	}, 20, 2 );
}
