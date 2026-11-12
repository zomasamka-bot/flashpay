CREATE TABLE public.kernel_deployment_identity (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 application_id text NOT NULL CHECK (application_id ~ '^[a-z][a-z0-9-]{2,79}$'),
 profile_sha256 text NOT NULL CHECK (profile_sha256 ~ '^[a-f0-9]{64}$'),
 database_branch text NOT NULL, recovery_cutover timestamptz NOT NULL,
 historical_holds text[] NOT NULL, kernel_version text NOT NULL CHECK (kernel_version='0.1.0-kernel.1')
);
ALTER TABLE public.kernel_deployment_identity OWNER TO neondb_owner;
REVOKE ALL ON public.kernel_deployment_identity FROM PUBLIC;
GRANT SELECT ON public.kernel_deployment_identity TO r36_owner,r36_runtime,r36_evidence_reader;
