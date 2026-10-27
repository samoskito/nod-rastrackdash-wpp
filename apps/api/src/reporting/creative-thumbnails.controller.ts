import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Res,
  StreamableFile,
} from "@nestjs/common";
import { AuthToken } from "../auth/auth-user.decorator";
import { AuthService } from "../auth/auth.service";
import { MetaCreativeThumbnailService } from "../integrations/meta/meta-creative-thumbnail.service";
import { WorkspacesService } from "../workspaces/workspaces.service";

type HeaderResponse = {
  setHeader(name: string, value: string): void;
};

/**
 * Serves persisted Meta creative thumbnails from our database, scoped to the
 * caller's current workspace. Never calls Meta. The web proxies this route
 * with the session cookie and adds `?v=<version>` so the response can be
 * cached privately as immutable.
 */
@Controller("reports/creative-thumbnails")
export class CreativeThumbnailsController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(WorkspacesService)
    private readonly workspacesService: WorkspacesService,
    @Inject(MetaCreativeThumbnailService)
    private readonly thumbnails: MetaCreativeThumbnailService,
  ) {}

  @Get("ads/:adId")
  async adThumbnail(
    @AuthToken() refreshToken: string,
    @Param("adId") adId: string,
    @Res({ passthrough: true }) response: HeaderResponse,
  ): Promise<StreamableFile> {
    if (!/^[0-9A-Za-z_-]{1,64}$/u.test(adId)) {
      throw new BadRequestException("Anúncio inválido");
    }

    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);
    const stored = await this.thumbnails.findStoredThumbnailForAd(
      workspace.id,
      adId,
    );

    if (!stored) {
      throw new NotFoundException("Miniatura indisponível");
    }

    response.setHeader("Content-Type", stored.contentType);
    response.setHeader("Content-Length", String(stored.bytes.length));
    // Private: the image belongs to one workspace; the URL is versioned.
    response.setHeader(
      "Cache-Control",
      "private, max-age=604800, immutable",
    );
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'none'");

    if (stored.version) {
      response.setHeader("ETag", `"${stored.version}"`);
    }

    return new StreamableFile(stored.bytes);
  }
}
