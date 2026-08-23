import type { PrismaService } from "../../src/common/prisma/prisma.service";

export interface FakeLicenseStateRow {
  id: string;
  fingerprint: string;
  accountIdentity: string;
  licenseKeyPrefix: string;
  signedCache: string | null;
  cacheValidUntil: Date | null;
  lastCheckedAt: Date | null;
  lastError: string | null;
  status: string;
  expiresAt: Date | null;
  bound: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function defaultRow(): FakeLicenseStateRow {
  return {
    id: "singleton",
    fingerprint: "",
    accountIdentity: "",
    licenseKeyPrefix: "",
    signedCache: null,
    cacheValidUntil: null,
    lastCheckedAt: null,
    lastError: null,
    status: "unlicensed",
    expiresAt: null,
    bound: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * Minimal in-memory stand-in for `prisma.licenseState`, scoped to the single
 * row this table ever holds. Keeps license-client tests hermetic (no DB
 * connection required) while exercising real upsert/update semantics.
 */
export function createFakePrisma(initialRow?: Partial<FakeLicenseStateRow>) {
  let row: FakeLicenseStateRow | null = initialRow ? { ...defaultRow(), ...initialRow } : null;

  const licenseState = {
    findUnique: async () => row,
    upsert: async ({ create, update }: { create: Partial<FakeLicenseStateRow>; update: Partial<FakeLicenseStateRow> }) => {
      row = row ? { ...row, ...update, updatedAt: new Date() } : { ...defaultRow(), ...create };
      return row;
    },
    update: async ({ data }: { data: Partial<FakeLicenseStateRow> }) => {
      if (!row) throw new Error("fake_prisma_no_row_to_update");
      row = { ...row, ...data, updatedAt: new Date() };
      return row;
    },
  };

  return {
    prisma: { licenseState } as unknown as PrismaService,
    getRow: () => row,
  };
}
