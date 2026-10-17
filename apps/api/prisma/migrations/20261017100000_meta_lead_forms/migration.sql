-- Meta Lead Ads (instant forms), Dashboard Leads parity: per-Page connection
-- with encrypted Graph/CAPI tokens, and one row per form submission (the CRM
-- event needs its Meta lead id). Nothing is subscribed or sent by this migration.
-- CreateTable
CREATE TABLE "MetaLeadFormConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "formIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "crmDatasetId" TEXT,
    "qualifiedEventName" TEXT NOT NULL DEFAULT 'LeadQualificado',
    "graphTokenEncrypted" TEXT NOT NULL,
    "graphTokenIv" TEXT NOT NULL,
    "graphTokenTag" TEXT NOT NULL,
    "graphTokenLast4" TEXT NOT NULL,
    "capiTokenEncrypted" TEXT,
    "capiTokenIv" TEXT,
    "capiTokenTag" TEXT,
    "capiTokenLast4" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "pageSubscribedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaLeadFormConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaLeadSubmission" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "leadId" TEXT,
    "metaLeadId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "formId" TEXT,
    "campaignId" TEXT,
    "adSetId" TEXT,
    "adId" TEXT,
    "fullName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "fieldData" JSONB,
    "metaCreatedAt" TIMESTAMP(3),
    "fetchStatus" TEXT NOT NULL,
    "fetchError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaLeadSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MetaLeadFormConnection_pageId_active_idx" ON "MetaLeadFormConnection"("pageId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "MetaLeadFormConnection_workspaceId_pageId_key" ON "MetaLeadFormConnection"("workspaceId", "pageId");

-- CreateIndex
CREATE UNIQUE INDEX "MetaLeadSubmission_metaLeadId_key" ON "MetaLeadSubmission"("metaLeadId");

-- CreateIndex
CREATE INDEX "MetaLeadSubmission_workspaceId_leadId_metaCreatedAt_idx" ON "MetaLeadSubmission"("workspaceId", "leadId", "metaCreatedAt");

-- CreateIndex
CREATE INDEX "MetaLeadSubmission_workspaceId_createdAt_idx" ON "MetaLeadSubmission"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "MetaLeadFormConnection" ADD CONSTRAINT "MetaLeadFormConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaLeadSubmission" ADD CONSTRAINT "MetaLeadSubmission_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaLeadSubmission" ADD CONSTRAINT "MetaLeadSubmission_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "MetaLeadFormConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaLeadSubmission" ADD CONSTRAINT "MetaLeadSubmission_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

