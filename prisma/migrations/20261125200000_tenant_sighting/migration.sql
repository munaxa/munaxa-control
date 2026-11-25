-- Tenant sightings: product tenants a deployment has asked about that no operator has linked yet.
--
-- A SaaS product asks for a tenant's entitlements with its deployment's service credential. When
-- the tenant is not linked to any customer, the answer stays the same 404, and the question is
-- recorded here so the operator can pick the tenant from a list instead of copying its identifier
-- from the product by hand. A sighting grants nothing: linking is still an operator action, audited
-- like any other, and the deployment can only ever be told about tenants linked to itself.
--
-- Additive. Rows are kept (nothing is deleted); a linked sighting simply stops being listed.
CREATE TABLE "tenant_sighting" (
    "id" UUID NOT NULL,
    "product" TEXT NOT NULL,
    "deployment_id" UUID NOT NULL,
    "tenant_ref" TEXT NOT NULL,
    -- What the product says the tenant is called (its organisation's slug or name). Informational
    -- only, never trusted for anything: the operator still chooses the customer and display name.
    "label" TEXT,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_sighting_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tenant_sighting_tenant_ref_length" CHECK (char_length("tenant_ref") BETWEEN 1 AND 128),
    CONSTRAINT "tenant_sighting_label_length" CHECK ("label" IS NULL OR char_length("label") BETWEEN 1 AND 100)
);

CREATE UNIQUE INDEX "uq_sighting_deployment_ref" ON "tenant_sighting"("deployment_id", "tenant_ref");
CREATE INDEX "ix_sighting_product_ref" ON "tenant_sighting"("product", "tenant_ref");

ALTER TABLE "tenant_sighting" ADD CONSTRAINT "tenant_sighting_deployment_id_fkey"
  FOREIGN KEY ("deployment_id") REFERENCES "product_deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
