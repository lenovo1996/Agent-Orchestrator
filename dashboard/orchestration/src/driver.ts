import type { Inngest } from 'inngest';
import type { OrchestrationService } from './service.js';

export interface OrchestrationDriver {
  send(input: {
    eventId: string;
    eventType: string;
    data: { commandId: string; flowId: string };
  }): Promise<void>;
}

export class InngestDriver implements OrchestrationDriver {
  constructor(private readonly client: Inngest.Any) {}

  async send(input: {
    eventId: string;
    eventType: string;
    data: { commandId: string; flowId: string };
  }): Promise<void> {
    await this.client.send({ id: input.eventId, name: input.eventType, data: input.data });
  }
}

export class OutboxDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private dispatching = false;

  constructor(
    private readonly service: OrchestrationService,
    private readonly driver: OrchestrationDriver,
  ) {}

  async dispatchOnce(): Promise<number> {
    if (this.dispatching) return 0;
    this.dispatching = true;
    let delivered = 0;
    try {
      for (const event of this.service.claimOutbox()) {
        try {
          await this.driver.send({
            eventId: event.eventId,
            eventType: event.eventType,
            data: event.payload,
          });
          this.service.markOutboxSent(event.id, event.commandId);
          delivered += 1;
        } catch (error) {
          this.service.markOutboxFailed(event.id, error);
        }
      }
      return delivered;
    } finally {
      this.dispatching = false;
    }
  }

  start(intervalMs = 1_000): void {
    if (this.timer) return;
    void this.dispatchOnce();
    this.timer = setInterval(() => { void this.dispatchOnce(); }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
