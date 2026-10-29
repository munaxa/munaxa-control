-- Revocation lists (platform ADR-0022): a revoked licence now reaches offline installations through
-- a signed list, which states why in a fixed vocabulary. The operator's free-text reason stays here.
-- Additive. A licence revoked before this change states CONTRACT_ENDED in the list.
ALTER TABLE licence
  ADD COLUMN revoked_category TEXT,
  ADD CONSTRAINT licence_revoked_category_check CHECK (
    revoked_category IS NULL
    OR revoked_category IN ('ISSUED_IN_ERROR', 'SUPERSEDED', 'CONTRACT_ENDED', 'KEY_COMPROMISE')
  ),
  -- A revocation is final: the category is set with it, and neither is ever cleared.
  ADD CONSTRAINT licence_revoked_category_with_revocation CHECK (
    revoked_category IS NULL OR revoked_at IS NOT NULL
  );
