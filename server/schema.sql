CREATE TABLE IF NOT EXISTS rooms (
  id UUID PRIMARY KEY,
  code VARCHAR(6) NOT NULL UNIQUE,
  name VARCHAR(60) NOT NULL,
  creator_guest_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  capacity SMALLINT NOT NULL DEFAULT 8 CHECK (capacity BETWEEN 2 AND 20),
  settings JSONB NOT NULL DEFAULT '{"queueMode":"collaborative"}'::jsonb
);

CREATE TABLE IF NOT EXISTS room_members (
  id UUID PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  display_name VARCHAR(24) NOT NULL,
  role VARCHAR(10) NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  online BOOLEAN NOT NULL DEFAULT FALSE,
  member_token_hash CHAR(64) NOT NULL,
  CHECK (length(trim(display_name)) BETWEEN 1 AND 24)
);

CREATE INDEX IF NOT EXISTS room_members_room_id_idx ON room_members(room_id);
CREATE UNIQUE INDEX IF NOT EXISTS room_members_one_owner_idx ON room_members(room_id) WHERE role = 'owner';

CREATE TABLE IF NOT EXISTS room_queue (
  id UUID PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  track_id VARCHAR(80) NOT NULL,
  track_data JSONB,
  track_data_expires_at TIMESTAMPTZ,
  position INTEGER NOT NULL CHECK (position >= 0),
  is_autoplay BOOLEAN NOT NULL DEFAULT FALSE,
  added_by VARCHAR(24) NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE room_queue ADD COLUMN IF NOT EXISTS track_data JSONB;
ALTER TABLE room_queue ADD COLUMN IF NOT EXISTS track_data_expires_at TIMESTAMPTZ;
ALTER TABLE room_queue ADD COLUMN IF NOT EXISTS is_autoplay BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS room_queue_room_position_idx ON room_queue(room_id, position, added_at);

CREATE TABLE IF NOT EXISTS room_playback (
  room_id UUID PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  current_track_id VARCHAR(80),
  current_track_data JSONB,
  current_track_data_expires_at TIMESTAMPTZ,
  is_playing BOOLEAN NOT NULL DEFAULT FALSE,
  position_ms INTEGER NOT NULL DEFAULT 0 CHECK (position_ms BETWEEN 0 AND 86400000),
  repeat_mode VARCHAR(8) NOT NULL DEFAULT 'off' CHECK (repeat_mode IN ('off', 'all', 'one')),
  autoplay_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  recent_track_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  current_track_is_autoplay BOOLEAN NOT NULL DEFAULT FALSE,
  playback_token UUID NOT NULL DEFAULT gen_random_uuid(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE room_playback ADD COLUMN IF NOT EXISTS current_track_data JSONB;
ALTER TABLE room_playback ADD COLUMN IF NOT EXISTS current_track_data_expires_at TIMESTAMPTZ;
ALTER TABLE room_playback ADD COLUMN IF NOT EXISTS repeat_mode VARCHAR(8) NOT NULL DEFAULT 'off';
ALTER TABLE room_playback ADD COLUMN IF NOT EXISTS autoplay_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE room_playback ADD COLUMN IF NOT EXISTS recent_track_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE room_playback ADD COLUMN IF NOT EXISTS current_track_is_autoplay BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE room_playback ADD COLUMN IF NOT EXISTS playback_token UUID;
UPDATE room_playback SET playback_token = gen_random_uuid() WHERE playback_token IS NULL;
ALTER TABLE room_playback ALTER COLUMN playback_token SET DEFAULT gen_random_uuid();
ALTER TABLE room_playback ALTER COLUMN playback_token SET NOT NULL;
