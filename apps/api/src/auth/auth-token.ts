import { UnauthorizedException } from "@nestjs/common";

const sessionCookieName = "wpptrack_session";

export type AuthHeaderValue = string | string[] | undefined;

export type AuthTokenRequest = {
  headers: Record<string, AuthHeaderValue>;
};

export function extractAuthToken(request: AuthTokenRequest): string {
  const authorization = firstHeader(request.headers.authorization);

  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();

    if (token) {
      return token;
    }
  }

  const cookie = firstHeader(request.headers.cookie);
  const cookieToken = cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${sessionCookieName}=`))
    ?.slice(sessionCookieName.length + 1);

  if (cookieToken) {
    return decodeURIComponent(cookieToken);
  }

  throw new UnauthorizedException("Sessão não encontrada");
}

export function firstHeader(value: AuthHeaderValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
