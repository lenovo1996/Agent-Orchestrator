import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutboxDispatcher, type OrchestrationDriver } from './driver.js';
import { createFlow, createTestService } from './test-helpers.js';

let context: ReturnType<typeof createTestService>;
beforeEach(() => { context = createTestService(); });
afterEach(() => context.close());

describe('durable event outbox', () => {
  it('dispatches only committed rows and marks the command dispatched', async () => {
    const command = createFlow(context.service);
    const send = vi.fn(async () => undefined);
    const dispatcher = new OutboxDispatcher(context.service, { send } satisfies OrchestrationDriver);
    expect(await dispatcher.dispatchOnce()).toBe(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      eventId: command.commandId,
      eventType: 'devteam/flow.requested',
      data: { commandId: command.commandId, flowId: command.flowId },
    }));
    expect(context.service.command(command.commandId).status).toBe('dispatched');
    expect(await dispatcher.dispatchOnce()).toBe(0);
  });

  it('releases a failed lease for retry without duplicating the row', async () => {
    createFlow(context.service);
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(undefined);
    const dispatcher = new OutboxDispatcher(context.service, { send } as OrchestrationDriver);
    expect(await dispatcher.dispatchOnce()).toBe(0);
    expect(await dispatcher.dispatchOnce()).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(context.database.get<{ count: number }>('SELECT COUNT(*) AS count FROM event_outbox')?.count).toBe(1);
  });

  it('does not lease the same unsent event twice before lease expiry', () => {
    createFlow(context.service);
    expect(context.service.claimOutbox()).toHaveLength(1);
    expect(context.service.claimOutbox()).toHaveLength(0);
  });

  it('redelivers with the same event ID after send success crashes before acknowledgement', () => {
    const command = createFlow(context.service);
    const first = context.service.claimOutbox()[0];
    context.database.run(
      "UPDATE event_outbox SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
      first.id,
    );
    const second = context.service.claimOutbox()[0];
    expect(second).toMatchObject({ eventId: command.commandId, payload: first.payload });
    expect(second.id).toBe(first.id);
  });
});
