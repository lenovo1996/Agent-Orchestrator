import { Router } from 'express';
import type { AppServerClient } from '@devteam-dashboard/orchestration';

const IMPROVE_SYSTEM_PROMPT = `You are a prompt engineering assistant for a dev-team AI workflow system.
Your ONLY job is to improve the user's prompt so it produces better results when given to AI coding agents.

Rules:
- Make the prompt clearer, more specific, and more actionable
- Add structure (bullet points, numbered steps) if the prompt is vague
- Preserve the user's original intent — do NOT add unrelated requirements
- Keep it concise — do NOT inflate length unnecessarily
- Return ONLY the improved prompt text, with no preamble, no explanation, no markdown fences`;

async function runAppServerImprove(
  client: AppServerClient,
  cwd: string,
  prompt: string,
  model?: string,
): Promise<string> {
  const thread = await client.createThread({
    cwd,
    model,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    ephemeral: true,
  });
  let expectedTurnId: string | null = null;
  let observedTurnId: string | null = null;
  let finalMessage = '';
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;

  const cleanup = (): void => {
    if (timeout) clearTimeout(timeout);
    client.removeListener('item:completed', onItemCompleted);
    client.removeListener('turn:completed', onTurnCompleted);
    client.removeListener('error', onError);
  };
  const complete = (error?: Error): void => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) rejectCompletion(error);
    else resolveCompletion();
  };
  const onItemCompleted = (
    threadId: string,
    turnId: string,
    item: Record<string, unknown>,
  ): void => {
    if (threadId !== thread.threadId || (expectedTurnId && turnId !== expectedTurnId)) return;
    if (item.type === 'agentMessage' && typeof item.text === 'string') finalMessage = item.text;
  };
  const onTurnCompleted = (threadId: string, turnId: string, status: string): void => {
    if (threadId !== thread.threadId || (expectedTurnId && turnId !== expectedTurnId)) return;
    observedTurnId = turnId;
    complete(status === 'completed'
      ? undefined
      : new Error(`Prompt improvement turn finished with status ${status}`));
  };
  const onError = (threadId: string | null, message: string): void => {
    if (threadId === thread.threadId) complete(new Error(message));
  };
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  client.on('item:completed', onItemCompleted);
  client.on('turn:completed', onTurnCompleted);
  client.on('error', onError);
  timeout = setTimeout(() => complete(new Error('Prompt improvement timed out after 60 seconds')), 60_000);
  timeout.unref();

  try {
    const turn = await client.startTurn(
      thread.threadId,
      `${IMPROVE_SYSTEM_PROMPT}\n\n---\n\nImprove this prompt:\n\n${prompt}`,
      { model, cwd, sandboxPolicy: { type: 'readOnly', networkAccess: false } },
    );
    expectedTurnId = turn.turnId;
    if (observedTurnId && observedTurnId !== expectedTurnId) {
      throw new Error(`Unexpected prompt improvement turn ${observedTurnId}`);
    }
    await completion;
    const improved = finalMessage.trim();
    if (!improved) throw new Error('No improved prompt returned from app-server');
    return improved;
  } finally {
    cleanup();
    await client.unsubscribeThread(thread.threadId).catch(() => undefined);
  }
}

export function improvePromptRouter(client: AppServerClient, cwd: string): Router {
  const router = Router();

  router.post('/improve-prompt', async (req, res) => {
    const { prompt, model } = req.body as { prompt?: string; model?: string };

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }

    if (!client.connected) {
      res.status(503).json({ error: 'App-server not connected' });
      return;
    }

    try {
      const improved = await runAppServerImprove(client, cwd, prompt.trim(), model);
      res.json({ improved });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[improve-prompt]', message);
      res.status(500).json({ error: message });
    }
  });

  return router;
}
