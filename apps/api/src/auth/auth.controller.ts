import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Optional,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import {
  accountActivationConfirmInputSchema,
  emailVerificationConfirmInputSchema,
  googleOAuthCallbackQuerySchema,
  googleOAuthStartSchema,
  loginSchema,
  passwordResetConfirmInputSchema,
  passwordResetRequestInputSchema,
  registerSchema,
} from "@wpptrack/shared";
import { extractAuthToken, firstHeader } from "./auth-token";
import { AuthService, type AuthSessionResult } from "./auth.service";
import {
  clearSessionCookies,
  setSessionCookie,
  type SessionCookieResponse,
} from "./session-cookie";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import { parseWebOrigin } from "../config/deployment-config";

type HeaderValue = string | string[] | undefined;

type AuthRequest = {
  headers: Record<string, HeaderValue>;
  ip?: string;
};

type OAuthCallbackResponse = SessionCookieResponse & {
  redirect: (status: number, url: string) => void;
};

@Controller("auth")
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Optional()
    @Inject(RUNTIME_ENV)
    private readonly env: RuntimeEnv = process.env,
  ) {}

  @Post("register")
  async register(
    @Body() body: unknown,
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: SessionCookieResponse,
  ): Promise<AuthSessionResult> {
    if (!this.isPublicRegistrationEnabled()) {
      throw new ForbiddenException("Cadastro publico desabilitado");
    }

    const input = this.parseBody(registerSchema.safeParse(body));
    const session = await this.authService.register(input, {
      userAgent: firstHeader(request.headers["user-agent"]) ?? null,
      ipAddress: request.ip ?? null,
    });

    setSessionCookie(response, session, this.env);

    return session;
  }

  @Post("login")
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: SessionCookieResponse,
  ): Promise<AuthSessionResult> {
    const input = this.parseBody(loginSchema.safeParse(body));
    const session = await this.authService.login(input, {
      userAgent: firstHeader(request.headers["user-agent"]) ?? null,
      ipAddress: request.ip ?? null,
    });

    setSessionCookie(response, session, this.env);

    return session;
  }

  @Get("me")
  async me(@Req() request: AuthRequest) {
    return this.authService.getSession(extractAuthToken(request));
  }

  @Post("logout")
  @HttpCode(200)
  async logout(
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: SessionCookieResponse,
  ) {
    await this.authService.logout(extractAuthToken(request));
    clearSessionCookies(response, this.env);

    return { ok: true };
  }

  @Post("google/start")
  startGoogleOAuth(@Body() body: unknown) {
    this.assertGoogleAuthEnabled();
    const input = this.parseBody(googleOAuthStartSchema.safeParse(body));

    return this.authService.getGoogleOAuthStart(input);
  }

  @Get("google/callback")
  async handleGoogleOAuthCallback(
    @Query() query: Record<string, unknown>,
    @Req() request: AuthRequest,
    @Res() response: OAuthCallbackResponse,
  ) {
    this.assertGoogleAuthEnabled();
    const input = this.parseBody(
      googleOAuthCallbackQuerySchema.safeParse(query),
    );
    const result = await this.authService.handleGoogleOAuthCallback(input, {
      userAgent: firstHeader(request.headers["user-agent"]) ?? null,
      ipAddress: request.ip ?? null,
    });

    if (result.action === "authenticated" && "session" in result) {
      setSessionCookie(response, result.session, this.env);
    }

    response.redirect(302, this.googleCallbackRedirectUrl(result));
  }

  @Post("password/forgot")
  async requestPasswordReset(
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    const input = this.parseBody(
      passwordResetRequestInputSchema.safeParse(body),
    );

    return this.authService.requestPasswordReset(input, {
      userAgent: firstHeader(request.headers["user-agent"]) ?? null,
      ipAddress: request.ip ?? null,
    });
  }

  @Post("password/reset")
  async resetPassword(@Body() body: unknown) {
    const input = this.parseBody(
      passwordResetConfirmInputSchema.safeParse(body),
    );

    return this.authService.resetPassword(input);
  }

  @Post("account/activate")
  async activateProvisionedAccount(
    @Body() body: unknown,
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: SessionCookieResponse,
  ) {
    const input = this.parseBody(
      accountActivationConfirmInputSchema.safeParse(body),
    );
    const result = await this.authService.activateProvisionedAccount(input, {
      userAgent: firstHeader(request.headers["user-agent"]) ?? null,
      ipAddress: request.ip ?? null,
    });

    setSessionCookie(response, result.session, this.env);

    return { ok: true };
  }

  @Post("email/verification/start")
  async requestEmailVerification(@Req() request: AuthRequest) {
    return this.authService.requestEmailVerification(
      extractAuthToken(request),
      {
        userAgent: firstHeader(request.headers["user-agent"]) ?? null,
        ipAddress: request.ip ?? null,
      },
    );
  }

  @Post("email/verification/confirm")
  async confirmEmailVerification(@Body() body: unknown) {
    const input = this.parseBody(
      emailVerificationConfirmInputSchema.safeParse(body),
    );

    return this.authService.confirmEmailVerification(input);
  }

  private parseBody<T>(
    result: { success: true; data: T } | { success: false },
  ): T {
    if (!result.success) {
      throw new BadRequestException("Payload invalido");
    }

    return result.data;
  }

  private isPublicRegistrationEnabled(): boolean {
    const explicit =
      this.env.AUTH_PUBLIC_REGISTRATION_ENABLED?.trim().toLowerCase();

    if (explicit) {
      return explicit === "true";
    }

    return this.env.NODE_ENV !== "production";
  }

  private assertGoogleAuthEnabled(): void {
    if (this.env.AUTH_GOOGLE_ENABLED?.trim().toLowerCase() !== "true") {
      throw new ForbiddenException("Login com Google desabilitado");
    }
  }

  private googleCallbackRedirectUrl(result: {
    action: string;
    redirectTo: string;
  }): string {
    const webOrigin = parseWebOrigin(this.env);

    if (result.action === "authenticated") {
      return new URL(this.safeAppPath(result.redirectTo), webOrigin).toString();
    }

    const error =
      result.action === "configure_env"
        ? "google_env"
        : result.action === "exchange_failed"
          ? "google_exchange"
          : "google_pending";

    return new URL(`/login?error=${error}`, webOrigin).toString();
  }

  private safeAppPath(path: string): string {
    if (!path.startsWith("/") || path.startsWith("//")) {
      return "/overview";
    }

    return path;
  }
}
