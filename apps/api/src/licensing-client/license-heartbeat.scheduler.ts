import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable, Logger, OnModuleInit, Optional } from "@nestjs/common";
import type { Queue } from "bullmq";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import {
  LICENSE_HEARTBEAT_JOB_NAME,
  LICENSE_HEARTBEAT_QUEUE,
  LICENSE_HEARTBEAT_RETRY_INTERVAL_MS,
  resolveHeartbeatIntervalMs,
} from "./license-client.constants";
import { LicenseClientService } from "./license-client.service";

/**
 * Schedules the repeatable license heartbeat tick (hourly, or the configured
 * interval when it is shorter). Each tick calls heartbeatIfDue(): a healthy
 * install still talks to the server only every 6h, a failing one retries
 * every tick. No-ops entirely when LICENSE_KEY/LICENSE_ACCOUNT_IDENTITY aren't
 * set, so a dev checkout of this public template never depends on a license
 * server to boot.
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

    const every = Math.min(resolveHeartbeatIntervalMs(this.env), LICENSE_HEARTBEAT_RETRY_INTERVAL_MS);
    await this.removeStaleRepeatables(every);
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

  /** Older builds registered a 6h repeatable; drop any tick with a different period. */
  private async removeStaleRepeatables(every: number): Promise<void> {
    try {
      const repeatables = await this.queue.getRepeatableJobs();
      for (const job of repeatables) {
        if (job.name === LICENSE_HEARTBEAT_JOB_NAME && Number(job.every) !== every) {
          await this.queue.removeRepeatableByKey(job.key);
        }
      }
    } catch {
      // Best effort: a leftover tick only causes an extra (skipped) heartbeatIfDue().
      this.logger.warn("license_heartbeat_stale_repeatable_cleanup_failed");
    }
  }
}
