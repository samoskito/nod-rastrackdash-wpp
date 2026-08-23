-- CreateTable
CREATE TABLE "LicenseState" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "fingerprint" TEXT NOT NULL,
    "accountIdentity" TEXT NOT NULL,
    "licenseKeyPrefix" TEXT NOT NULL,
    "signedCache" TEXT,
    "cacheValidUntil" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unlicensed',
    "expiresAt" TIMESTAMP(3),
    "bound" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LicenseState_pkey" PRIMARY KEY ("id")
);
