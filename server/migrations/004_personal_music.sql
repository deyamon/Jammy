-- Additive per-user music data. user_id is a verified Neon Auth subject; no
-- assumption is made about the managed neon_auth schema's foreign-key layout.
CREATE TABLE IF NOT EXISTS jammy_listening_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  event_id VARCHAR(120) NOT NULL,
  video_id VARCHAR(11) NOT NULL,
  title VARCHAR(500) NOT NULL,
  channel_name VARCHAR(200) NOT NULL DEFAULT '',
  source VARCHAR(16) NOT NULL CHECK (source IN ('standalone', 'room')),
  played_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT jammy_history_user_event_unique UNIQUE (user_id, event_id)
);
CREATE INDEX IF NOT EXISTS jammy_history_user_played_idx ON jammy_listening_history (user_id, played_at DESC);

CREATE TABLE IF NOT EXISTS spotify_connections (
  user_id TEXT PRIMARY KEY,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL,
  access_token_expires_at TIMESTAMPTZ NOT NULL,
  granted_scopes TEXT[] NOT NULL DEFAULT '{}',
  needs_reauth BOOLEAN NOT NULL DEFAULT FALSE,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS spotify_oauth_states (
  state_hash CHAR(64) PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS spotify_oauth_states_expiry_idx ON spotify_oauth_states (expires_at);

CREATE TABLE IF NOT EXISTS spotify_imported_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  kind VARCHAR(32) NOT NULL,
  provider_item_id VARCHAR(180) NOT NULL,
  observed_at TIMESTAMPTZ,
  data JSONB NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS spotify_imported_current_unique_idx
  ON spotify_imported_items (user_id, kind, provider_item_id) WHERE observed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS spotify_imported_observed_unique_idx
  ON spotify_imported_items (user_id, kind, provider_item_id, observed_at) WHERE observed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS spotify_imported_user_kind_idx ON spotify_imported_items (user_id, kind, imported_at DESC);

CREATE TABLE IF NOT EXISTS music_taste_profiles (
  user_id TEXT PRIMARY KEY,
  profile_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
