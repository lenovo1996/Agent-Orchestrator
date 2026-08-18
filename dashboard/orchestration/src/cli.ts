#!/usr/bin/env node
import { createOrchestrationRuntime } from './runtime.js';

function options(args: string[]): { positional: string[]; values: Record<string, string | boolean> } {
  const positional: string[] = [];
  const values: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith('--')) values[key] = true;
    else {
      values[key] = next;
      index += 1;
    }
  }
  return { positional, values };
}

function stringOption(values: Record<string, string | boolean>, key: string): string | undefined {
  return typeof values[key] === 'string' ? values[key] as string : undefined;
}

function usage(): never {
  console.error(`Usage:
  flow start --workflow <id> --workspace <id> [--jira <key>] [--prompt <text>] [--depends-on <ids>] [--worktree]
  flow list [--workspace <id>]
  flow get <flow-id>
  flow retry <flow-id> <step|--step <step>> [--clear-output] [--prompt <text>]
  flow resume <flow-id>
  flow stop <flow-id>
  flow delete <flow-id>`);
  process.exit(2);
}

const [command, ...args] = process.argv.slice(2);
const parsed = options(args);
const runtime = createOrchestrationRuntime();

try {
  let result: unknown;
  switch (command) {
    case 'start': {
      const workflowId = stringOption(parsed.values, 'workflow');
      const workspaceId = stringOption(parsed.values, 'workspace');
      if (!workflowId || !workspaceId) usage();
      result = runtime.service.createFlow({
        workflowId,
        workspaceId,
        jiraKey: stringOption(parsed.values, 'jira'),
        prompt: stringOption(parsed.values, 'prompt'),
        dependsOn: stringOption(parsed.values, 'depends-on')?.split(',').filter(Boolean),
        useWorktree: parsed.values.worktree === true,
      });
      break;
    }
    case 'list':
      result = runtime.service.listFlows(stringOption(parsed.values, 'workspace'));
      break;
    case 'get':
      if (!parsed.positional[0]) usage();
      result = runtime.service.getFlow(parsed.positional[0]);
      break;
    case 'retry':
      if (!parsed.positional[0] || !(parsed.positional[1] || stringOption(parsed.values, 'step'))) usage();
      result = runtime.service.retryFlow(parsed.positional[0], {
        step: parsed.positional[1] || stringOption(parsed.values, 'step') as string,
        clearOutput: parsed.values['clear-output'] === true,
        prompt: stringOption(parsed.values, 'prompt'),
      });
      break;
    case 'resume':
      if (!parsed.positional[0]) usage();
      result = runtime.service.resumeFlow(parsed.positional[0]);
      break;
    case 'stop':
      if (!parsed.positional[0]) usage();
      result = await runtime.stopFlow(parsed.positional[0]);
      break;
    case 'delete':
      if (!parsed.positional[0]) usage();
      result = runtime.service.deleteFlow(parsed.positional[0]);
      break;
    default:
      usage();
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  runtime.close();
}
