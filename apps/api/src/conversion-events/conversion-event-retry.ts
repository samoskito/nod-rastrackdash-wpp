import type { Prisma } from "@prisma/client";

type ConversionEventRetryState = {
  status: string;
  errorCode: string | null;
};

export const BLOCKED_CONVERSION_RETRY_LIMIT = 500;

const configurationErrorCodes = [
  "MissingAccessToken",
  "MissingMetaDestination",
];

export const configurationBlockedConversionEventWhere = {
  status: "not_configured",
  OR: [{ errorCode: { in: configurationErrorCodes } }, { errorCode: null }],
} satisfies Prisma.ConversionEventLogWhereInput;

export function isConfigurationBlockedConversionEvent(
  event: ConversionEventRetryState,
): boolean {
  return (
    event.status === "not_configured" &&
    (event.errorCode === null ||
      configurationErrorCodes.includes(event.errorCode))
  );
}

export function canRetryConversionEvent(
  event: ConversionEventRetryState,
): boolean {
  return (
    (event.status === "error" && event.errorCode === "MetaCapiNetworkError") ||
    isConfigurationBlockedConversionEvent(event)
  );
}
