import { cookies } from "next/headers";
import { apiBaseUrl } from "../../../../../../lib/api";
import { isAllowedCreativeAdId } from "../../../../../../lib/creative-thumbnail";

const allowedContentTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

/**
 * Same-origin proxy for the persisted creative thumbnail. Forwards the
 * session cookie to the API (which scopes the lookup to the current
 * workspace) and never reaches Meta.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ adId: string }> },
) {
  const { adId } = await context.params;

  if (!isAllowedCreativeAdId(adId)) {
    return new Response(null, { status: 400 });
  }

  let response: Response;

  try {
    response = await fetch(
      `${apiBaseUrl}/reports/creative-thumbnails/ads/${encodeURIComponent(adId)}`,
      {
        credentials: "include",
        headers: {
          ...(await cookieHeader()),
        },
        cache: "no-store",
      },
    );
  } catch {
    return new Response(null, { status: 502 });
  }

  const contentType = (response.headers.get("Content-Type") ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase();

  if (!response.ok || !contentType || !allowedContentTypes.has(contentType)) {
    return new Response(null, {
      status: response.ok ? 502 : response.status,
      headers: { "Cache-Control": "no-store" },
    });
  }

  return new Response(await response.arrayBuffer(), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control":
        response.headers.get("Cache-Control") ??
        "private, max-age=604800, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function cookieHeader(): Promise<Record<string, string>> {
  try {
    const value = (await cookies()).toString();

    return value ? { Cookie: value } : {};
  } catch {
    return {};
  }
}
