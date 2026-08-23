import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable, Logger, OnModuleInit, Optional } from "@nestjs/common";
import type { Queue } from "bullmq";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import {
  LICENSE_HEARTBEAT_INTERVAL_MS,
  LICENSE_HEARTBEAT_JOB_NAME,
  LICENSE_HEARTBEAT_QUEUE,
} from "./license-client.constants";
import { LicenseClientService } from "./license-client.service";

/**
 * Schedules the repeatable license heartbeat (every 6h). No-ops entirely
 * when LICENSE_KEY/LICENSE_ACCOUNT_IDENTITY aren't set, so a dev checkout of
 * this public template never depends on a license server to boot.
 */
@Injectable()
export class LicenseHeartbeatScheduler implements OnModuleInit {
  private readonly logger = new Logger(LicenseHeartbeatScheduler.name);

  constructor(
    @InjectQueue(LICENSE_HEARTBEAT_QUEUE) private readonly queue: Queue,
    @Inject(LicenseClientService) private readonly licenseClient: LicenseClientService,
    @Optional() @Inject(RUNTIME_ENV) private readonly env: RuntimeEnv = process.env,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.licenseClient.isConfigured()) {
      this.logger.log("license_heartbeat_scheduler_skipped_not_configured");
      return;
    }

    const configured = Number(this.env.LICENSE_HEARTBEAT_INTERVAL_MS ?? LICENSE_HEARTBEAT_INTERVAL_MS);
    const every = Number.isFinite(configured) && configured >= 60_000 ? configured : LICENSE_HEARTBEAT_INTERVAL_MS;
    await this.queue.add(
      LICENSE_HEARTBEAT_JOB_NAME,
      {},
      {
        jobId: "license-heartbeat-repeatable",
        repeat: { every },
        removeOnComplete: 20,
        removeOnFail: 20,
      },
    );
  }
}
