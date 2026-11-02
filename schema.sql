CREATE TABLE IF NOT EXISTS captains (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL DEFAULT '123456',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS groups (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL UNIQUE,
  name TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS authorized_numbers (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  name TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_phone TEXT NOT NULL,
  sender_name TEXT,
  text_body TEXT,
  quoted_message_id TEXT,
  webhook_type TEXT,
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_quoted ON whatsapp_messages(group_id, quoted_message_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON whatsapp_messages(sender_phone);

CREATE TABLE IF NOT EXISTS claims (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  original_message_id TEXT NOT NULL,
  reply_message_id TEXT NOT NULL UNIQUE,
  producer_phone TEXT NOT NULL,
  consumer_phone TEXT NOT NULL,
  producer_name TEXT,
  consumer_name TEXT,
  status TEXT NOT NULL DEFAULT 'waiting',
  current_reaction TEXT,
  current_value NUMERIC(12,3) NOT NULL DEFAULT 0,
  approved_by TEXT,
  cancelled_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_claim_original ON claims(group_id, original_message_id);
CREATE INDEX IF NOT EXISTS idx_claim_status ON claims(status);

ALTER TABLE claims ADD COLUMN IF NOT EXISTS last_reaction_ts BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS movements (
  id BIGSERIAL PRIMARY KEY,
  claim_id BIGINT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('production','consumption')),
  captain_phone TEXT NOT NULL,
  amount NUMERIC(12,3) NOT NULL,
  reaction TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  version_no INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_movements_claim ON movements(claim_id);
CREATE INDEX IF NOT EXISTS idx_movements_captain ON movements(captain_phone, status);

CREATE TABLE IF NOT EXISTS captain_balances (
  captain_phone TEXT PRIMARY KEY,
  production NUMERIC(14,3) NOT NULL DEFAULT 0,
  consumption NUMERIC(14,3) NOT NULL DEFAULT 0,
  net NUMERIC(14,3) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS event_queue (
  id BIGSERIAL PRIMARY KEY,
  dedup_key TEXT NOT NULL UNIQUE,
  event_type TEXT,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_queue_pending ON event_queue(status, next_attempt_at, id);

CREATE TABLE IF NOT EXISTS reaction_log (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT REFERENCES event_queue(id),
  claim_id BIGINT REFERENCES claims(id),
  target_message_id TEXT,
  reactor_phone TEXT,
  reaction TEXT,
  decision TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sheet_sync_queue (
  id BIGSERIAL PRIMARY KEY,
  sync_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sheet_sync_pending ON sheet_sync_queue(status, next_attempt_at, id);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================
-- V3.1 Weekly closing, floor fees, settlements & captain status
-- ============================================================

ALTER TABLE captains ADD COLUMN IF NOT EXISTS status_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE captains ADD COLUMN IF NOT EXISTS status_checked_at TIMESTAMPTZ;
ALTER TABLE captains ADD COLUMN IF NOT EXISTS last_group_seen_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS accounting_weeks (
  id BIGSERIAL PRIMARY KEY,
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  floor_amount NUMERIC(12,3) NOT NULL DEFAULT 0.500,
  floor_applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_open_accounting_week
  ON accounting_weeks(status) WHERE status='open';

INSERT INTO accounting_weeks(starts_at,status)
SELECT now(),'open'
WHERE NOT EXISTS (SELECT 1 FROM accounting_weeks WHERE status='open');

ALTER TABLE claims ADD COLUMN IF NOT EXISTS week_id BIGINT REFERENCES accounting_weeks(id);
UPDATE claims
SET week_id=(SELECT id FROM accounting_weeks WHERE status='open' ORDER BY id DESC LIMIT 1)
WHERE week_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_claims_week ON claims(week_id);

CREATE TABLE IF NOT EXISTS weekly_charges (
  id BIGSERIAL PRIMARY KEY,
  week_id BIGINT NOT NULL REFERENCES accounting_weeks(id) ON DELETE CASCADE,
  captain_phone TEXT NOT NULL,
  charge_type TEXT NOT NULL DEFAULT 'floor',
  amount NUMERIC(12,3) NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(week_id,captain_phone,charge_type)
);

CREATE TABLE IF NOT EXISTS weekly_adjustments (
  id BIGSERIAL PRIMARY KEY,
  week_id BIGINT NOT NULL REFERENCES accounting_weeks(id) ON DELETE CASCADE,
  captain_phone TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('production','consumption')),
  amount NUMERIC(12,3) NOT NULL CHECK (amount > 0),
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS weekly_settlements (
  id BIGSERIAL PRIMARY KEY,
  week_id BIGINT NOT NULL REFERENCES accounting_weeks(id) ON DELETE CASCADE,
  captain_phone TEXT NOT NULL,
  captain_name TEXT NOT NULL DEFAULT '',
  production NUMERIC(14,3) NOT NULL DEFAULT 0,
  consumption NUMERIC(14,3) NOT NULL DEFAULT 0,
  floor_fee NUMERIC(14,3) NOT NULL DEFAULT 0,
  net NUMERIC(14,3) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  admin_confirmed_at TIMESTAMPTZ,
  captain_confirmed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(week_id,captain_phone)
);

-- V3.5.7 — carry unpaid captain debt into the next open week as "old balance"
ALTER TABLE weekly_settlements ADD COLUMN IF NOT EXISTS old_balance NUMERIC(14,3) NOT NULL DEFAULT 0;
ALTER TABLE weekly_charges ADD COLUMN IF NOT EXISTS source_settlement_id BIGINT;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='weekly_charges_source_settlement_fk'
  ) THEN
    ALTER TABLE weekly_charges
      ADD CONSTRAINT weekly_charges_source_settlement_fk
      FOREIGN KEY (source_settlement_id) REFERENCES weekly_settlements(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_weekly_old_balance_source
  ON weekly_charges(source_settlement_id)
  WHERE charge_type='old_balance' AND source_settlement_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS settlement_proofs (
  id BIGSERIAL PRIMARY KEY,
  settlement_id BIGINT NOT NULL REFERENCES weekly_settlements(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('captain_to_admin','admin_to_captain')),
  mime_type TEXT NOT NULL,
  file_name TEXT,
  file_data BYTEA NOT NULL,
  uploaded_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(settlement_id,direction)
);

CREATE TABLE IF NOT EXISTS captain_status_checks (
  id BIGSERIAL PRIMARY KEY,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  active_groups INTEGER NOT NULL DEFAULT 0,
  active_captains INTEGER NOT NULL DEFAULT 0,
  stopped_captains INTEGER NOT NULL DEFAULT 0,
  details JSONB
);

-- ============================================================
-- V3.2 Captain Portal: auth, onboarding, transfer data, alerts, disputes
-- ============================================================
ALTER TABLE captains ADD COLUMN IF NOT EXISTS password_cipher TEXT;
ALTER TABLE captains ADD COLUMN IF NOT EXISTS password_iv TEXT;
ALTER TABLE captains ADD COLUMN IF NOT EXISTS password_tag TEXT;
ALTER TABLE captains ADD COLUMN IF NOT EXISTS password_changed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE captains ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE captains ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT '';
ALTER TABLE captains ADD COLUMN IF NOT EXISTS payment_details JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE captains ADD COLUMN IF NOT EXISTS payment_updated_at TIMESTAMPTZ;
ALTER TABLE captains ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;


-- ============================================================
-- V3.5.5 Global transfer-to-system settings shown to all captains
-- ============================================================
CREATE TABLE IF NOT EXISTS system_transfer_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id=1),
  method_name TEXT NOT NULL DEFAULT '',
  account_name TEXT NOT NULL DEFAULT '',
  account_number TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO system_transfer_settings(id,method_name,account_name,account_number,note)
VALUES(1,'','','','')
ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS captain_notifications (
  id BIGSERIAL PRIMARY KEY,
  captain_phone TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_captain_notifications_phone ON captain_notifications(captain_phone,is_read,created_at DESC);

CREATE TABLE IF NOT EXISTS captain_objections (
  id BIGSERIAL PRIMARY KEY,
  captain_phone TEXT NOT NULL,
  claim_id BIGINT REFERENCES claims(id) ON DELETE SET NULL,
  movement_id BIGINT REFERENCES movements(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','resolved','rejected')),
  admin_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_captain_objections_phone ON captain_objections(captain_phone,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_captain_objections_status ON captain_objections(status,created_at DESC);

-- ============================================================
-- V3.2.3 Captain WhatsApp password recovery
-- ============================================================
CREATE TABLE IF NOT EXISTS captain_password_recovery (
  id BIGSERIAL PRIMARY KEY,
  captain_phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  verified_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_captain_password_recovery_phone ON captain_password_recovery(captain_phone,created_at DESC);

-- V3.2.4 Experience / support / security
ALTER TABLE captains ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS announcements (
 id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, important BOOLEAN NOT NULL DEFAULT FALSE,
 active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS support_tickets (
 id BIGSERIAL PRIMARY KEY, captain_phone TEXT NOT NULL, category TEXT NOT NULL, subject TEXT NOT NULL,
 body TEXT NOT NULL, movement_id BIGINT, settlement_id BIGINT, status TEXT NOT NULL DEFAULT 'open',
 admin_note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_captain ON support_tickets(captain_phone,created_at DESC);
CREATE TABLE IF NOT EXISTS captain_login_log (
 id BIGSERIAL PRIMARY KEY, captain_phone TEXT NOT NULL, ip TEXT, user_agent TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE captains ADD COLUMN IF NOT EXISTS sessions_invalidated_at TIMESTAMPTZ;


-- V3.3.1 accounting integrity / cleanup indexes
CREATE INDEX IF NOT EXISTS idx_claims_status_created ON claims(status,created_at);
CREATE INDEX IF NOT EXISTS idx_claims_parties ON claims(producer_phone,consumer_phone,status);


-- V3.3.4 — manual accounting movements + direct weekly balance corrections
CREATE TABLE IF NOT EXISTS manual_movements (
  id BIGSERIAL PRIMARY KEY,
  week_id BIGINT NOT NULL REFERENCES accounting_weeks(id) ON DELETE CASCADE,
  captain_phone TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('production','consumption')),
  product_name TEXT NOT NULL DEFAULT '',
  product_id TEXT NOT NULL DEFAULT '',
  amount NUMERIC(12,3) NOT NULL CHECK (amount > 0),
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_manual_movements_week_captain ON manual_movements(week_id,captain_phone,created_at DESC);
ALTER TABLE manual_movements ADD COLUMN IF NOT EXISTS order_count INTEGER;
UPDATE manual_movements SET order_count=GREATEST(1,ROUND(amount/0.25)::integer) WHERE order_count IS NULL;

CREATE TABLE IF NOT EXISTS weekly_balance_corrections (
  id BIGSERIAL PRIMARY KEY,
  week_id BIGINT NOT NULL REFERENCES accounting_weeks(id) ON DELETE CASCADE,
  captain_phone TEXT NOT NULL,
  previous_net NUMERIC(14,3) NOT NULL DEFAULT 0,
  target_net NUMERIC(14,3) NOT NULL DEFAULT 0,
  delta NUMERIC(14,3) NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_weekly_balance_corrections_week_captain ON weekly_balance_corrections(week_id,captain_phone,created_at DESC);

-- ============================================================
-- V3.4.7 Public captain registration + admin approval queue
-- ============================================================
CREATE TABLE IF NOT EXISTS captain_registration_requests (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  admin_note TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT NOT NULL DEFAULT '',
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_captain_registration_status
  ON captain_registration_requests(status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_captain_registration_name
  ON captain_registration_requests(lower(regexp_replace(btrim(name),'[[:space:]]+',' ','g')));


-- V3.4.8 Required onboarding documents for public captain registration
CREATE TABLE IF NOT EXISTS captain_registration_files (
  request_id BIGINT NOT NULL REFERENCES captain_registration_requests(id) ON DELETE CASCADE,
  file_kind TEXT NOT NULL CHECK (file_kind IN ('identity','vehicle_license','payment_proof')),
  mime_type TEXT NOT NULL,
  file_name TEXT NOT NULL DEFAULT '',
  file_data BYTEA NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(request_id,file_kind)
);
CREATE INDEX IF NOT EXISTS idx_captain_registration_files_request
  ON captain_registration_files(request_id);



-- AMMAN DELIVERY V6 runtime heartbeat/status
CREATE TABLE IF NOT EXISTS runtime_status (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================
-- V6.3 WAHA identity/LID mapping
-- ============================================================
CREATE TABLE IF NOT EXISTS whatsapp_identity_map (
  provider TEXT NOT NULL DEFAULT 'waha',
  session_name TEXT NOT NULL,
  lid TEXT NOT NULL,
  phone TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,session_name,lid)
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_identity_phone
  ON whatsapp_identity_map(provider,session_name,phone);

-- V6.3.1 WhatsApp names + message-id repair
ALTER TABLE captains ADD COLUMN IF NOT EXISTS whatsapp_name TEXT;
ALTER TABLE captains ADD COLUMN IF NOT EXISTS whatsapp_name_updated_at TIMESTAMPTZ;

UPDATE whatsapp_messages
SET text_body=COALESCE(
  NULLIF(text_body,''),
  NULLIF(raw #>> '{messageData,textMessageData,textMessage}',''),
  NULLIF(raw #>> '{messageData,extendedTextMessageData,text}',''),
  NULLIF(raw #>> '{messageData,fileMessageData,caption}',''),
  NULLIF(raw #>> '{messageData,imageMessageData,caption}',''),
  NULLIF(raw #>> '{messageData,videoMessageData,caption}',''),
  NULLIF(raw #>> '{body}',''),
  NULLIF(raw #>> '{caption}',''),
  NULLIF(raw #>> '{text}','')
)
WHERE COALESCE(text_body,'')='';

WITH matched AS (
  SELECT c.id,
    (
      SELECT wm.message_id
      FROM whatsapp_messages wm
      WHERE wm.group_id=c.group_id
        AND c.original_message_id<>''
        AND (
          wm.message_id=c.original_message_id
          OR right(wm.message_id,char_length(c.original_message_id))=c.original_message_id
          OR position(c.original_message_id in wm.message_id)>0
        )
      ORDER BY CASE
        WHEN wm.message_id=c.original_message_id THEN 0
        WHEN right(wm.message_id,char_length(c.original_message_id))=c.original_message_id THEN 1
        ELSE 2
      END, wm.created_at DESC
      LIMIT 1
    ) AS canonical_id
  FROM claims c
)
UPDATE claims c
SET original_message_id=m.canonical_id,
    updated_at=now()
FROM matched m
WHERE m.id=c.id
  AND m.canonical_id IS NOT NULL
  AND c.original_message_id<>m.canonical_id;

-- V6.3.2 group source control + persistent WhatsApp media
ALTER TABLE groups ADD COLUMN IF NOT EXISTS auto_register_members BOOLEAN NOT NULL DEFAULT FALSE;

-- Keep exactly one sensible source group on existing installations if none was chosen yet.
UPDATE groups
SET auto_register_members=TRUE
WHERE id=(
  SELECT id FROM groups
  WHERE active=TRUE
  ORDER BY id
  LIMIT 1
)
AND NOT EXISTS (SELECT 1 FROM groups WHERE auto_register_members=TRUE);

CREATE TABLE IF NOT EXISTS whatsapp_media (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  file_name TEXT NOT NULL DEFAULT '',
  file_data BYTEA NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id,message_id)
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_media_message
  ON whatsapp_media(group_id,message_id);



ALTER TABLE accounting_weeks ADD COLUMN IF NOT EXISTS trashed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_accounting_weeks_trashed ON accounting_weeks(trashed_at) WHERE trashed_at IS NOT NULL;
