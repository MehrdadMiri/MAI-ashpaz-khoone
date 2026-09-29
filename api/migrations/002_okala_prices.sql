-- Okala unit prices for pantry and shopping names.
-- Rows are a shared catalog, not a user account and not a secret.
-- price values are toman. The fetcher converts Okala's rial field before insert.
-- The api runs this file on startup (CREATE TABLE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS okala_price (
    name_key text PRIMARY KEY,
    display_name text NOT NULL,
    matched boolean NOT NULL,
    product_id text,
    product_title text,
    product_url text,
    pack_price_toman bigint,
    pack_quantity double precision,
    unit text,
    unit_price_toman bigint,
    in_stock boolean,
    origin text NOT NULL,
    fetched_at timestamptz,
    CONSTRAINT okala_price_name_key_check CHECK (char_length(name_key) BETWEEN 1 AND 80),
    CONSTRAINT okala_price_origin_check CHECK (origin IN ('live', 'fixture', 'cache'))
);
