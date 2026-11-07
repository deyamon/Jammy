CREATE TABLE auth_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(24) NOT NULL,
  email VARCHAR(254) NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT auth_users_username_format CHECK (username ~ '^[a-z0-9_]{3,24}$'),
  CONSTRAINT auth_users_email_normalized CHECK (email = lower(btrim(email))),
  CONSTRAINT auth_users_email_unique UNIQUE (email)
);

CREATE UNIQUE INDEX auth_users_username_ci_unique_idx ON auth_users (lower(username));
CREATE UNIQUE INDEX auth_users_email_ci_unique_idx ON auth_users (lower(email));

CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY,
  token_hash CHAR(64) NOT NULL UNIQUE,
  csrf_token_hash CHAR(64) NOT NULL,
  user_id UUID NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT auth_sessions_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX auth_sessions_user_id_idx ON auth_sessions(user_id);
CREATE INDEX auth_sessions_active_expiry_idx ON auth_sessions(expires_at) WHERE revoked_at IS NULL;
