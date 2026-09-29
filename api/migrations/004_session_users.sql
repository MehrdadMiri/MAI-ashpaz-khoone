-- One pantry, one week plan, and one shopping list per browser session.
-- local_user_id is already the primary key (migrations 001 and 003).
-- This file does not drop those tables and does not move a normal browser id.
-- A dump that used the sentinel id legacy-shared is copied once to
-- local-user-default when that default row is still missing, so a demo
-- volume is not wiped. Current installs have no sentinel row; the inserts
-- then change nothing. Do not store API keys in these rows.

INSERT INTO pantry_state (local_user_id, pantry, updated_at)
SELECT 'local-user-default', pantry, updated_at
FROM pantry_state
WHERE local_user_id = 'legacy-shared'
  AND NOT EXISTS (
    SELECT 1 FROM pantry_state WHERE local_user_id = 'local-user-default'
  )
ON CONFLICT (local_user_id) DO NOTHING;

INSERT INTO week_plan_state (local_user_id, plan, updated_at)
SELECT 'local-user-default', plan, updated_at
FROM week_plan_state
WHERE local_user_id = 'legacy-shared'
  AND NOT EXISTS (
    SELECT 1 FROM week_plan_state WHERE local_user_id = 'local-user-default'
  )
ON CONFLICT (local_user_id) DO NOTHING;

INSERT INTO shopping_state (local_user_id, shopping, updated_at)
SELECT 'local-user-default', shopping, updated_at
FROM shopping_state
WHERE local_user_id = 'legacy-shared'
  AND NOT EXISTS (
    SELECT 1 FROM shopping_state WHERE local_user_id = 'local-user-default'
  )
ON CONFLICT (local_user_id) DO NOTHING;
