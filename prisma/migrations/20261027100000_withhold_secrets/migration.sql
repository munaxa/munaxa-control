-- Credential issuance answers once with its secret, and the idempotency record of such a request
-- used to keep a copy of that answer. It now keeps only that the request succeeded and the
-- credential's id (ADR-0004). Records written before that change are retry state, not customer
-- data: rewrite them to the same shape, so no secret survives the upgrade and a retry under an old
-- key is answered as a new one would be.
UPDATE idempotency_record
   SET response = jsonb_build_object('secretWithheld', true, 'id', response -> 'id')
 WHERE path LIKE '%/credentials'
   AND method = 'POST'
   AND NOT (response ? 'secretWithheld');
