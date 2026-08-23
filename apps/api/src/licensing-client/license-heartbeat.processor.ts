import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { LicenseClientService } from "./license-client.service";
import { LICENSE_HEARTBEAT_QUEUE } from "./license-client.constants";

@Processor(LICENSE_HEARTBEAT_QUEUE)
export class LicenseHeartbeatProcessor extends WorkerHost {
  private readonly logger = new Logger(LicenseHeartbeatProcessor.name);

  constructor(@Inject(LicenseClientService) private readonly licenseClient: LicenseClientService) {
    super();
  }

  async process(_job: Job): Promise<void> {
    try {
      // heartbeat() already fails open (grace) on network errors and never
      // throws for that case; this guard only covers truly unexpected
      // failures so a license outage can never turn into a worker crash loop.
      await this.licenseClient.heartbeat();
    } catch (error) {
      this.logger.error("license_heartbeat_job_failed", error instanceof Error ? error.stack : undefined);
    }
  }
}
