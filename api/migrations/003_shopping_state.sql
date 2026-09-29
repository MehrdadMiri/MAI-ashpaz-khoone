-- Manual shopping-list rows and edits for one browser-local id.
-- Plan-derived lines are not stored here; the page rebuilds them.
-- A quantity saved here is the user's own and is not scaled by headcount.
-- local_user_id is not an account. Do not store API keys in these rows.
-- The api runs this file on startup (CREATE TABLE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS shopping_state (
    local_user_id text PRIMARY KEY,
    shopping jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT shopping_state_local_user_id_check
        CHECK (local_user_id ~ '^[A-Za-z0-9_-]{8,64}$')
);
