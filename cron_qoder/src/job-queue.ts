import type { Logger } from "./logger.js";
import { QoderRunner, type JobRun } from "./qoder-runner.js";

export class JobQueue {
  readonly #logger: Logger;
  readonly #pending: JobRun[] = [];
  readonly #runner: QoderRunner;
  #accepting = true;
  #drainPromise: Promise<void> | undefined;
  #nextJobId = 1;

  constructor(runner: QoderRunner, logger: Logger) {
    this.#runner = runner;
    this.#logger = logger;
  }

  enqueue(trigger: JobRun["trigger"]): boolean {
    if (!this.#accepting) {
      this.#logger.warn(`trigger=${trigger} ignored because shutdown is in progress`);
      return false;
    }

    const job: JobRun = {
      id: this.#nextJobId,
      triggeredAt: new Date(),
      trigger,
    };
    this.#nextJobId += 1;
    this.#pending.push(job);

    this.#logger.info(
      `job=${job.id} queued trigger=${trigger} queue_depth=${this.#pending.length}`,
    );
    this.#ensureDrain();
    return true;
  }

  async shutdown(): Promise<number> {
    this.#accepting = false;
    const discarded = this.#pending.length;
    this.#pending.splice(0, this.#pending.length);

    await this.#runner.shutdown();
    await this.#drainPromise;
    return discarded;
  }

  #ensureDrain(): void {
    if (this.#drainPromise) {
      return;
    }

    this.#drainPromise = this.#drain().finally(() => {
      this.#drainPromise = undefined;
      if (this.#accepting && this.#pending.length > 0) {
        this.#ensureDrain();
      }
    });
  }

  async #drain(): Promise<void> {
    while (this.#accepting) {
      const job = this.#pending.shift();
      if (!job) {
        return;
      }

      await this.#runner.run(job);
    }
  }
}
