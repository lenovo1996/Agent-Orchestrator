import { spawn } from 'node:child_process';
import { Router } from 'express';

const IMPROVE_SYSTEM_PROMPT = `You are a prompt engineering assistant for a dev-team AI workflow system.
Your ONLY job is to improve the user's prompt so it produces better results when given to AI coding agents.

Rules:
- Make the prompt clearer, more specific, and more actionable
- Add structure (bullet points, numbered steps) if the prompt is vague
- Preserve the user's original intent — do NOT add unrelated requirements
- Keep it concise — do NOT inflate length unnecessarily
- Return ONLY the improved prompt text, with no preamble, no explanation, no markdown fences`;

function runCodexImprove(prompt: string, model?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
    ];

    if (model) {
      args.push('-m', model);
    }

    args.push(IMPROVE_SYSTEM_PROMPT + '\n\n---\n\nImprove this prompt:\n\n' + prompt);

    const child = spawn('codex', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn codex: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`codex exited with code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }

      // codex exec (without --json) outputs plain text to stdout.
      // The entire stdout IS the improved prompt — just trim it.
      const improved = stdout.trim();
      if (!improved) {
        reject(new Error('No improved prompt returned from codex'));
        return;
      }
      resolve(improved);
    });
  });
}

export function improvePromptRouter(): Router {
  const router = Router();

  router.post('/improve-prompt', async (req, res) => {
    const { prompt, model } = req.body as { prompt?: string; model?: string };

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }

    try {
      const improved = await runCodexImprove(prompt.trim(), model);
      res.json({ improved });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[improve-prompt]', message);
      res.status(500).json({ error: message });
    }
  });

  return router;
}
