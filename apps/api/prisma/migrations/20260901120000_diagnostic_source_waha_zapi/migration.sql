-- Additive: allow the WAHA and Z-API providers to record webhook logs,
-- diagnostic events, integration logs, and audit logs under their own
-- DiagnosticSource, mirroring the existing Uazapi entry. No existing enum
-- value is renamed or removed, so this migration is backward compatible
-- with rows already written under the current values.
ALTER TYPE "DiagnosticSource" ADD VALUE IF NOT EXISTS 'waha';
ALTER TYPE "DiagnosticSource" ADD VALUE IF NOT EXISTS 'zapi';
