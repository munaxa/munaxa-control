-- Munaxa Control: the initial schema. Generated from prisma/schema.prisma, then the rules Prisma
-- cannot express are added at the end. Additive only; nothing here deletes a row.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "customer" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "legal_name" TEXT,
    "country" CHAR(2),
    "contact_email" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_deployment" (
    "id" UUID NOT NULL,
    "product" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,

    CONSTRAINT "product_deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_credential" (
    "id" UUID NOT NULL,
    "deployment_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "secret_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,
    "last_used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" TEXT,

    CONSTRAINT "service_credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_link" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "product" TEXT NOT NULL,
    "tenant_ref" TEXT NOT NULL,
    "deployment_type" TEXT NOT NULL,
    "deployment_id" UUID,
    "display_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,

    CONSTRAINT "tenant_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan" (
    "id" UUID NOT NULL,
    "product" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,

    CONSTRAINT "plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_version" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    "features" TEXT[],
    "limits" JSONB NOT NULL DEFAULT '{}',
    "price_minor" BIGINT,
    "currency" CHAR(3),
    "billing_period" TEXT,
    "trial_days" INTEGER NOT NULL DEFAULT 0,
    "grace_days" INTEGER NOT NULL DEFAULT 14,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "retired_at" TIMESTAMPTZ(6),

    CONSTRAINT "plan_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription" (
    "id" UUID NOT NULL,
    "tenant_link_id" UUID NOT NULL,
    "plan_version_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "suspended_from" TEXT,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "trial_ends_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "grace_until" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "feature_overrides" JSONB NOT NULL DEFAULT '{"add":[],"remove":[]}',
    "limit_overrides" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_event" (
    "id" BIGSERIAL NOT NULL,
    "subscription_id" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "from_plan_version_id" UUID,
    "to_plan_version_id" UUID NOT NULL,
    "reason" TEXT,
    "actor" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "installation" (
    "id" UUID NOT NULL,
    "tenant_link_id" UUID NOT NULL,
    "installation_ref" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "replaced_by_id" UUID,
    "registered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "registered_by" TEXT NOT NULL,
    "replaced_at" TIMESTAMPTZ(6),

    CONSTRAINT "installation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "licence" (
    "id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "installation_id" UUID,
    "kid" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "supersedes_id" UUID,
    "issued_by" TEXT NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" TEXT,

    CONSTRAINT "licence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_report" (
    "id" BIGSERIAL NOT NULL,
    "tenant_link_id" UUID NOT NULL,
    "metric" TEXT NOT NULL,
    "value" BIGINT NOT NULL,
    "measured_at" TIMESTAMPTZ(6) NOT NULL,
    "installation_ref" TEXT,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_kind" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "customer_id" UUID,
    "tenant_link_id" UUID,
    "product" TEXT,
    "subscription_id" UUID,
    "licence_id" UUID,
    "installation_id" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "request_id" TEXT,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_record" (
    "actor" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "status" INTEGER NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_record_pkey" PRIMARY KEY ("actor","key")
);

-- CreateIndex
CREATE INDEX "ix_customer_name" ON "customer"("name");

-- CreateIndex
CREATE UNIQUE INDEX "uq_deployment_product_name" ON "product_deployment"("product", "name");

-- CreateIndex
CREATE INDEX "ix_credential_deployment" ON "service_credential"("deployment_id");

-- CreateIndex
CREATE INDEX "ix_tenant_customer" ON "tenant_link"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_tenant_product_ref" ON "tenant_link"("product", "tenant_ref");

-- CreateIndex
CREATE UNIQUE INDEX "uq_plan_product_code" ON "plan"("product", "code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_plan_version" ON "plan_version"("plan_id", "version");

-- CreateIndex
CREATE INDEX "ix_subscription_status_expiry" ON "subscription"("status", "expires_at");

-- CreateIndex
CREATE INDEX "ix_subscription_tenant" ON "subscription"("tenant_link_id");

-- CreateIndex
CREATE INDEX "ix_subscription_event_subscription" ON "subscription_event"("subscription_id", "id");

-- CreateIndex
CREATE INDEX "ix_installation_tenant" ON "installation"("tenant_link_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_installation_ref" ON "installation"("installation_ref");

-- CreateIndex
CREATE INDEX "ix_licence_subscription" ON "licence"("subscription_id");

-- CreateIndex
CREATE INDEX "ix_usage_latest" ON "usage_report"("tenant_link_id", "metric", "measured_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_usage_point" ON "usage_report"("tenant_link_id", "metric", "measured_at");

-- CreateIndex
CREATE INDEX "ix_audit_at" ON "audit_event"("at" DESC);

-- CreateIndex
CREATE INDEX "ix_audit_customer" ON "audit_event"("customer_id", "at" DESC);

-- CreateIndex
CREATE INDEX "ix_audit_subscription" ON "audit_event"("subscription_id", "at" DESC);

-- CreateIndex
CREATE INDEX "ix_idempotency_created" ON "idempotency_record"("created_at");

-- AddForeignKey
ALTER TABLE "service_credential" ADD CONSTRAINT "service_credential_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "product_deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_link" ADD CONSTRAINT "tenant_link_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_link" ADD CONSTRAINT "tenant_link_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "product_deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_version" ADD CONSTRAINT "plan_version_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_tenant_link_id_fkey" FOREIGN KEY ("tenant_link_id") REFERENCES "tenant_link"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_plan_version_id_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "plan_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_event" ADD CONSTRAINT "subscription_event_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installation" ADD CONSTRAINT "installation_tenant_link_id_fkey" FOREIGN KEY ("tenant_link_id") REFERENCES "tenant_link"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "licence" ADD CONSTRAINT "licence_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "licence" ADD CONSTRAINT "licence_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "installation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_report" ADD CONSTRAINT "usage_report_tenant_link_id_fkey" FOREIGN KEY ("tenant_link_id") REFERENCES "tenant_link"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------
-- Rules Prisma cannot express.
-- ---------------------------------------------------------------------------------------------

-- The products this control plane sells. A new product is a migration, on purpose.
ALTER TABLE "product_deployment" ADD CONSTRAINT "ck_deployment_product" CHECK ("product" IN ('school', 'work', 'docs'));
ALTER TABLE "tenant_link" ADD CONSTRAINT "ck_tenant_product" CHECK ("product" IN ('school', 'work', 'docs'));
ALTER TABLE "plan" ADD CONSTRAINT "ck_plan_product" CHECK ("product" IN ('school', 'work', 'docs'));

ALTER TABLE "customer" ADD CONSTRAINT "ck_customer_status" CHECK ("status" IN ('ACTIVE', 'CLOSED'));

-- A SaaS tenant is served by exactly one deployment; an on-premises tenant by none.
ALTER TABLE "tenant_link" ADD CONSTRAINT "ck_tenant_deployment" CHECK (
  ("deployment_type" = 'SAAS' AND "deployment_id" IS NOT NULL)
  OR ("deployment_type" = 'ON_PREMISES' AND "deployment_id" IS NULL)
);

ALTER TABLE "plan_version" ADD CONSTRAINT "ck_plan_version_state" CHECK ("state" IN ('DRAFT', 'PUBLISHED', 'RETIRED'));
ALTER TABLE "plan_version" ADD CONSTRAINT "ck_plan_version_terms" CHECK (
  "version" >= 1 AND "trial_days" >= 0 AND "grace_days" >= 0
  AND ("price_minor" IS NULL OR "price_minor" >= 0)
  AND ("billing_period" IS NULL OR "billing_period" IN ('MONTHLY', 'YEARLY'))
);

ALTER TABLE "subscription" ADD CONSTRAINT "ck_subscription_status" CHECK (
  "status" IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD', 'EXPIRED', 'SUSPENDED', 'CANCELLED')
);
ALTER TABLE "subscription" ADD CONSTRAINT "ck_subscription_suspension" CHECK (
  ("status" = 'SUSPENDED') = ("suspended_from" IS NOT NULL)
);

-- One live subscription per tenant. Cancelled ones stay, as the record of what was sold.
CREATE UNIQUE INDEX "uq_subscription_live_tenant" ON "subscription" ("tenant_link_id") WHERE "status" <> 'CANCELLED';

ALTER TABLE "installation" ADD CONSTRAINT "ck_installation_status" CHECK ("status" IN ('ACTIVE', 'REPLACED'));
ALTER TABLE "audit_event" ADD CONSTRAINT "ck_audit_actor_kind" CHECK ("actor_kind" IN ('OPERATOR', 'SERVICE', 'SYSTEM'));
ALTER TABLE "usage_report" ADD CONSTRAINT "ck_usage_value" CHECK ("value" >= 0);

-- A published plan version's terms never change; only its retirement may be recorded. A version
-- may never return to DRAFT. This is what lets a subscription point at a version for years.
CREATE FUNCTION "plan_version_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."state" <> 'DRAFT' THEN
    IF NEW."features" IS DISTINCT FROM OLD."features"
       OR NEW."limits" IS DISTINCT FROM OLD."limits"
       OR NEW."price_minor" IS DISTINCT FROM OLD."price_minor"
       OR NEW."currency" IS DISTINCT FROM OLD."currency"
       OR NEW."billing_period" IS DISTINCT FROM OLD."billing_period"
       OR NEW."trial_days" IS DISTINCT FROM OLD."trial_days"
       OR NEW."grace_days" IS DISTINCT FROM OLD."grace_days"
       OR NEW."version" IS DISTINCT FROM OLD."version"
       OR NEW."plan_id" IS DISTINCT FROM OLD."plan_id"
       OR NEW."published_at" IS DISTINCT FROM OLD."published_at" THEN
      RAISE EXCEPTION 'plan version % is %, and its terms are immutable', OLD."id", OLD."state"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."state" = 'DRAFT' OR (OLD."state" = 'RETIRED' AND NEW."state" <> 'RETIRED') THEN
      RAISE EXCEPTION 'plan version % cannot move from % to %', OLD."id", OLD."state", NEW."state"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "plan_version_immutable" BEFORE UPDATE ON "plan_version"
  FOR EACH ROW EXECUTE FUNCTION "plan_version_guard"();
