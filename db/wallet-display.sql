-- Display-only preference; no foreign keys or writes to financial records.
CREATE TABLE public.wallet_display_preferences (
 application_id text NOT NULL CHECK (length(application_id) BETWEEN 3 AND 80),
 pi_uid text NOT NULL CHECK (length(pi_uid) BETWEEN 1 AND 256),
 network text NOT NULL CHECK (network IN ('Pi Testnet','Pi Network')),
 address text NOT NULL CHECK (address ~ '^G[A-Z2-7]{55}$'),
 saved_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (application_id,pi_uid,network)
);
REVOKE ALL ON public.wallet_display_preferences FROM PUBLIC;
COMMENT ON TABLE public.wallet_display_preferences IS 'Manually entered public address for balance display only, never financial authority. Application API inserts once, never updates or deletes.';
