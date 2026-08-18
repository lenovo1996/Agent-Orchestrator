import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { createOrchestrationRuntime, DomainError } from '@devteam-dashboard/orchestration';

const directory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(directory, '../..');
const runtime = createOrchestrationRuntime({ repoRoot });

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new McpError(ErrorCode.InvalidParams, `${name} is required`);
  }
  return value.trim();
}

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

const server = new Server(
  { name: 'devteam-flow-mcp', version: '2.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'start_flow',
      description: 'Create a SQLite-backed flow and enqueue its durable Inngest start command.',
      inputSchema: {
        type: 'object',
        properties: {
          jiraKey: { type: 'string' },
          prompt: { type: 'string' },
          workflowId: { type: 'string' },
          workspaceId: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } },
          useWorktree: { type: 'boolean', default: false },
          idempotencyKey: { type: 'string' },
        },
        required: ['workflowId', 'workspaceId'],
      },
    },
    {
      name: 'list_flows',
      description: 'List flow state from workflows.db; never scans task-flow directories.',
      inputSchema: {
        type: 'object',
        properties: { workspaceId: { type: 'string' } },
      },
    },
    {
      name: 'get_flow',
      description: 'Get a flow, steps, dependencies and attempt summaries from workflows.db.',
      inputSchema: {
        type: 'object',
        properties: { flowId: { type: 'string' } },
        required: ['flowId'],
      },
    },
    {
      name: 'retry_flow_step',
      description: 'Reset one step and its downstream steps, then enqueue a new coordinator generation.',
      inputSchema: {
        type: 'object',
        properties: {
          flowId: { type: 'string' },
          step: { type: 'string' },
          clearOutput: { type: 'boolean', default: false },
          prompt: { type: 'string' },
          idempotencyKey: { type: 'string' },
        },
        required: ['flowId', 'step'],
      },
    },
    {
      name: 'resume_flow',
      description: 'Resume a blocked flow or create a new generation from an expired checkpoint.',
      inputSchema: {
        type: 'object',
        properties: { flowId: { type: 'string' }, idempotencyKey: { type: 'string' } },
        required: ['flowId'],
      },
    },
    {
      name: 'stop_flow',
      description: 'Kill local process groups and enqueue durable cancellation for a flow.',
      inputSchema: {
        type: 'object',
        properties: { flowId: { type: 'string' }, idempotencyKey: { type: 'string' } },
        required: ['flowId'],
      },
    },
    {
      name: 'delete_flow',
      description: 'Delete a terminal flow and its artifacts. Active flows must be stopped first.',
      inputSchema: {
        type: 'object',
        properties: { flowId: { type: 'string' }, idempotencyKey: { type: 'string' } },
        required: ['flowId'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments || {}) as Record<string, unknown>;
  try {
    switch (request.params.name) {
      case 'start_flow':
        return text(runtime.service.createFlow({
          jiraKey: typeof args.jiraKey === 'string' ? args.jiraKey : undefined,
          prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
          workflowId: requiredString(args.workflowId, 'workflowId'),
          workspaceId: requiredString(args.workspaceId, 'workspaceId'),
          dependsOn: Array.isArray(args.dependsOn)
            ? args.dependsOn.map((value) => requiredString(value, 'dependsOn item'))
            : undefined,
          useWorktree: args.useWorktree === true,
        }, typeof args.idempotencyKey === 'string' ? args.idempotencyKey : undefined));

      case 'list_flows':
        return text(runtime.service.listFlows(
          typeof args.workspaceId === 'string' ? args.workspaceId : undefined,
        ));

      case 'get_flow': {
        const flowId = requiredString(args.flowId, 'flowId');
        return text({ flow: runtime.service.getFlow(flowId), attempts: runtime.service.listAttempts(flowId) });
      }

      case 'retry_flow_step':
        return text(runtime.service.retryFlow(
          requiredString(args.flowId, 'flowId'),
          {
            step: requiredString(args.step, 'step'),
            clearOutput: args.clearOutput === true,
            prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
          },
          typeof args.idempotencyKey === 'string' ? args.idempotencyKey : undefined,
        ));

      case 'resume_flow':
        return text(runtime.service.resumeFlow(
          requiredString(args.flowId, 'flowId'),
          typeof args.idempotencyKey === 'string' ? args.idempotencyKey : undefined,
        ));

      case 'stop_flow':
        return text(await runtime.stopFlow(
          requiredString(args.flowId, 'flowId'),
          typeof args.idempotencyKey === 'string' ? args.idempotencyKey : undefined,
        ));

      case 'delete_flow':
        return text(runtime.service.deleteFlow(
          requiredString(args.flowId, 'flowId'),
          typeof args.idempotencyKey === 'string' ? args.idempotencyKey : undefined,
        ));

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({
        error: message,
        ...(error instanceof DomainError ? { code: error.code, details: error.details } : {}),
      }) }],
      isError: true,
    };
  }
});

server.onerror = (error) => console.error('[MCP Error]', error);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server.close().finally(() => {
      runtime.close();
      process.exit(0);
    });
  });
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write('DevTeam Flow MCP v2: start_flow, list_flows, get_flow, retry_flow_step, resume_flow, stop_flow, delete_flow\n');
  runtime.close();
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('DevTeam Flow MCP v2 running on stdio');
}
