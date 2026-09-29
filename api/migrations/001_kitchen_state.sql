-- Pantry chips, week budget, household size, and the 7-day meal plan.
-- household (تعداد نفرات, default 4) lives inside the pantry jsonb object.
-- local_user_id is a browser-local token, not an account and not a password.
-- Do not store API keys or other secrets in these rows.
-- Postgres runs this file when the data volume is first created.
-- The api runs it again (CREATE TABLE IF NOT EXISTS) so an existing volume
-- gains the tables without a volume reset.

CREATE TABLE IF NOT EXISTS pantry_state (
    local_user_id text PRIMARY KEY,
    pantry jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pantry_state_local_user_id_check
        CHECK (local_user_id ~ '^[A-Za-z0-9_-]{8,64}$')
);

CREATE TABLE IF NOT EXISTS week_plan_state (
    local_user_id text PRIMARY KEY,
    plan jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT week_plan_state_local_user_id_check
        CHECK (local_user_id ~ '^[A-Za-z0-9_-]{8,64}$')
);
