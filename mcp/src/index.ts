import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";
import { execFileSync, spawn } from "child_process";
import { fileURLToPath } from "url";

const TOOL_DESCRIPTIONS: Record<string, string> = {
  get_task_list: `Tool: get_task_list
Description: Lists all currently tracked tasks (flows).
Parameters:
  - workspaceName (string, optional): Specific workspace to filter tasks.
Example:
  {
    "workspaceName": "my-workspace"
  }`,
  get_task_status: `Tool: get_task_status
Description: Retrieves detailed JSON status and metadata for a specific task.
Parameters:
  - flowId (string, required): The ID of the flow to check.
  - workspaceName (string, optional): Specific workspace the flow belongs to.
Example:
  {
    "flowId": "flow_12345678",
    "workspaceName": "my-workspace"
  }`,
  update_task_status: `Tool: update_task_status
Description: Directly patches the workflow.json for a given flowId.
Parameters:
  - flowId (string, required): The ID of the flow.
  - updates (object, required): Key-value pairs to merge into workflow.json.
  - workspaceName (string, optional): Specific workspace.
Example:
  {
    "flowId": "flow_12345678",
    "updates": {
      "status": "running",
      "steps.implementer": "done"
    }
  }`,
  create_task: `Tool: create_task
Description: Bootstraps a new workflow via the orchestrator.
Parameters:
  - jiraKey (string, optional): Jira ticket key. Required if customPrompt is missing.
  - customPrompt (string, optional): Custom instructions for the task. Required if jiraKey is missing.
  - workflowId (string, optional): Force a specific flow ID.
  - workspaceName (string, optional): Specific workspace name.
  - workspacePath (string, optional): Specific workspace path.
Example:
  {
    "jiraKey": "PROJ-123",
    "customPrompt": "Fix the background color in the header",
    "workspaceName": "my-workspace"
  }`,
  delete_task: `Tool: delete_task
Description: Forcefully stops and deletes a task and its history.
Parameters:
  - flowId (string, required): The ID of the flow to delete.
Example:
  {
    "flowId": "flow_12345678"
  }`,
  retry_step_with_prompt_update: `Tool: retry_step_with_prompt_update
Description: Forces the orchestrator to retry a specific step and optionally allows you to provide a brand new custom prompt.
Parameters:
  - flowId (string, required): The ID of the flow.
  - step (string, required): The step to retry (e.g., 'implementer', 'verifier').
  - prompt (string, optional): New prompt to use for the retry.
  - clearOutput (boolean, optional): Clear previous outputs. Defaults to true.
Example:
  {
    "flowId": "flow_12345678",
    "step": "implementer",
    "prompt": "Please make sure to use array instead of list this time."
  }`,
  get_help: `Tool: get_help
Description: Get comprehensive help about how to use the DevTeam Task MCP Server tools.
Parameters:
  - topic (string, optional): Specific tool name to get detailed help for.
Example:
  {
    "topic": "create_task"
  }`
};


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Root path to the overall repository, useful for scripts and config
const REPO_ROOT = path.resolve(__dirname, "../../");
const SCRIPT_DIR = path.join(REPO_ROOT, "scripts");

// Read team.json for config
let teamConfig: any;
try {
  teamConfig = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "team.json"), "utf8")
  );
} catch (e) {
  console.error("Warning: Could not read team.json", e);
  teamConfig = {};
}

const OUTPUT_ROOT = path.resolve(REPO_ROOT, teamConfig.outputRoot || "task-flows");

class TaskServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: "devteam-task-mcp",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private resolveWorkDir(flowId: string, workspaceName?: string): string {
    if (workspaceName) {
      return path.join(OUTPUT_ROOT, workspaceName, flowId);
    }
    const directPath = path.join(OUTPUT_ROOT, flowId);
    if (fs.existsSync(directPath)) return directPath;

    // Search in workspaces
    if (fs.existsSync(OUTPUT_ROOT)) {
      for (const ws of fs.readdirSync(OUTPUT_ROOT)) {
        const potentialPath = path.join(OUTPUT_ROOT, ws, flowId);
        if (fs.existsSync(potentialPath)) return potentialPath;
      }
    }
    return directPath;
  }

  private getWorkflowState(flowId: string, workspaceName?: string) {
    const workDir = this.resolveWorkDir(flowId, workspaceName);
    const workflowPath = path.join(workDir, "workflow.json");

    if (!fs.existsSync(workflowPath)) {
      throw new Error(`Workflow not found: ${flowId}`);
    }

    return JSON.parse(fs.readFileSync(workflowPath, "utf8"));
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "get_task_list",
          description: "Get a list of all current tasks (flows) in the system",
          inputSchema: {
            type: "object",
            properties: {
              workspaceName: {
                type: "string",
                description: "Optional workspace name to filter tasks",
              },
            },
          },
        },
        {
          name: "get_task_status",
          description: "Get detailed status of a specific task (flow)",
          inputSchema: {
            type: "object",
            properties: {
              flowId: { type: "string" },
              workspaceName: { type: "string", description: "Optional workspace name" },
            },
            required: ["flowId"],
          },
        },
        {
          name: "update_task_status",
          description: "Update the status of a specific task by modifying its workflow.json",
          inputSchema: {
            type: "object",
            properties: {
              flowId: { type: "string" },
              workspaceName: { type: "string", description: "Optional workspace name" },
              updates: {
                type: "object",
                description: "Key-value pairs of updates to apply to the workflow.json (e.g. {'status': 'completed'})",
              },
            },
            required: ["flowId", "updates"],
          },
        },
        {
          name: "create_task",
          description: "Create/start a new task using the orchestrator",
          inputSchema: {
            type: "object",
            properties: {
              jiraKey: { type: "string" },
              customPrompt: { type: "string" },
              workflowId: { type: "string", description: "Optional specific flow ID to use" },
              workspaceName: { type: "string" },
              workspacePath: { type: "string" },
              dependsOn: {
                type: "array",
                items: { type: "string" },
                description: "List of task flow IDs that must complete before this task starts"
              },
            },
          },
        },
        {
          name: "delete_task",
          description: "Delete a task completely (stops orchestrator if running and removes data directory)",
          inputSchema: {
            type: "object",
            properties: {
              flowId: { type: "string" },
            },
            required: ["flowId"],
          },
        },
        {
          name: "get_help",
          description: "Get comprehensive help about how to use the DevTeam Task MCP Server tools",
          inputSchema: {
            type: "object",
            properties: {
              topic: { type: "string", description: "Optional specific topic or tool name to get help for" },
            },
          },
        },
        {
          name: "retry_step_with_prompt_update",
          description: "Retry a specific step in a task, with an optional new prompt",
          inputSchema: {
            type: "object",
            properties: {
              flowId: { type: "string" },
              step: { type: "string" },
              prompt: { type: "string", description: "New prompt to use for the retry" },
              clearOutput: { type: "boolean", description: "Whether to clear existing output files for the step", default: true },
            },
            required: ["flowId", "step"],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        switch (request.params.name) {
          case "get_task_list": {
            const { workspaceName } = request.params.arguments || {};

            const summaries: any[] = [];

            if (!fs.existsSync(OUTPUT_ROOT)) {
              return { content: [{ type: "text", text: JSON.stringify([]) }] };
            }

            const searchDirs = [];
            if (workspaceName && typeof workspaceName === "string") {
              searchDirs.push(path.join(OUTPUT_ROOT, workspaceName));
            } else {
               // Add direct flows
               searchDirs.push(OUTPUT_ROOT);

               // Read workspaces dynamically (subfolders that don't have workflow.json directly but contain flows)
               const entries = fs.readdirSync(OUTPUT_ROOT, { withFileTypes: true });
               for(const entry of entries) {
                 if (entry.isDirectory() && entry.name !== 'logs' && !fs.existsSync(path.join(OUTPUT_ROOT, entry.name, 'workflow.json'))) {
                   searchDirs.push(path.join(OUTPUT_ROOT, entry.name));
                 }
               }
            }

            for (const dir of searchDirs) {
               if (!fs.existsSync(dir)) continue;
               try {
                 const flowDirs = fs.readdirSync(dir, { withFileTypes: true });
                 for (const fd of flowDirs) {
                   if (!fd.isDirectory()) continue;
                   const wfPath = path.join(dir, fd.name, "workflow.json");
                   if (fs.existsSync(wfPath)) {
                      try {
                        const wf = JSON.parse(fs.readFileSync(wfPath, "utf8"));
                        summaries.push({
                           flowId: wf.flowId,
                           jiraKey: wf.jiraKey,
                           status: wf.status,
                           currentStep: wf.currentStep,
                           startedAt: wf.startedAt,
                           workspaceName: dir !== OUTPUT_ROOT ? path.basename(dir) : undefined
                        });
                      } catch (e) {}
                   }
                 }
               } catch(e) {}
            }

            return {
              content: [{ type: "text", text: JSON.stringify(summaries, null, 2) }],
            };
          }

          case "get_task_status": {
            const { flowId, workspaceName } = request.params.arguments as any;
            if (!flowId) throw new McpError(ErrorCode.InvalidParams, "flowId is required");
            const state = this.getWorkflowState(flowId, workspaceName);
            return {
              content: [{ type: "text", text: JSON.stringify(state, null, 2) }],
            };
          }

          case "update_task_status": {
             const { flowId, workspaceName, updates } = request.params.arguments as any;
             if (!flowId) throw new McpError(ErrorCode.InvalidParams, "flowId is required");
             if (!updates || typeof updates !== "object" || Array.isArray(updates)) throw new McpError(ErrorCode.InvalidParams, "updates must be a valid JSON object");
             const workDir = this.resolveWorkDir(flowId, workspaceName);
             const workflowPath = path.join(workDir, "workflow.json");

             if (!fs.existsSync(workflowPath)) {
               throw new McpError(ErrorCode.InvalidParams, `Workflow not found: ${flowId}`);
             }

             const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf8"));

             for (const [key, value] of Object.entries(updates)) {
               if (key.startsWith("steps.")) {
                 const stepName = key.split(".")[1];
                 if (!workflow.steps) workflow.steps = {};
                 workflow.steps[stepName] = value;
               } else {
                 workflow[key] = value;
               }
             }

             fs.writeFileSync(workflowPath, JSON.stringify(workflow, null, 2));

             return {
               content: [{ type: "text", text: `Successfully updated workflow ${flowId}` }],
             };
          }

          case "create_task": {
            const { jiraKey = "", customPrompt = "", workflowId, workspaceName, workspacePath, dependsOn } = request.params.arguments || {};
            if (!jiraKey && !customPrompt) throw new McpError(ErrorCode.InvalidParams, "Must provide jiraKey or customPrompt");
            const args = ["start"];
            if (workflowId) args.push("--workflow", workflowId as string);
            if (workspaceName) args.push("--workspace-name", workspaceName as string);
            if (workspacePath) args.push("--workspace-dir", workspacePath as string);
            if (dependsOn && Array.isArray(dependsOn) && dependsOn.length > 0) {
              args.push("--depends-on", dependsOn.join(','));
            }
            if (jiraKey && customPrompt) {
              args.push(jiraKey as string, customPrompt as string);
            } else if (jiraKey) {
              args.push(jiraKey as string);
            } else if (customPrompt) {
              args.push("--prompt", customPrompt as string);
            } else {
              throw new McpError(ErrorCode.InvalidParams, "Must provide jiraKey or customPrompt");
            }

            const output = execFileSync(process.execPath, [path.join(SCRIPT_DIR, "orchestrator", "index.js"), ...args], {
               cwd: SCRIPT_DIR,
               encoding: "utf8",
            });

            return {
               content: [{ type: "text", text: output }],
            };
          }

          case "delete_task": {
             const { flowId } = request.params.arguments as any;
             if (!flowId) throw new McpError(ErrorCode.InvalidParams, "flowId is required");

             // Try to stop first
             try {
                execFileSync(process.execPath, [path.join(SCRIPT_DIR, "orchestrator", "index.js"), "stop", flowId], {
                  cwd: SCRIPT_DIR,
                  encoding: "utf8",
                  timeout: 10000
                });
             } catch (e) {}

             // Delete memory tree context (similar to dashboard logic)
             try {
               // Resolve task ID from workflow.json if available
               let taskId = flowId;
               const workDir = this.resolveWorkDir(flowId);
               const workflowPath = path.join(workDir, "workflow.json");
               if (fs.existsSync(workflowPath)) {
                 try {
                   const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf8"));
                   if (workflow.jiraKey) {
                     taskId = workflow.jiraKey;
                   }
                 } catch (e) {}
               }

               const taskDir = path.join(REPO_ROOT, ".tasks", taskId);
               const flowDir = path.join(taskDir, "flows", flowId);
               const metaPath = path.join(taskDir, "meta.json");

               if (fs.existsSync(flowDir)) {
                 fs.rmSync(flowDir, { recursive: true, force: true });
               }

               if (fs.existsSync(metaPath)) {
                 const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                 if (meta.flows) {
                   meta.flows = meta.flows.filter((f: any) => f.flow_id !== flowId);
                 }
                 if (!meta.flows || meta.flows.length === 0) {
                   fs.rmSync(taskDir, { recursive: true, force: true });
                 } else {
                   fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
                 }
               }
             } catch (e) {}

             // Delete data folder
             const workDir = this.resolveWorkDir(flowId);
             if (fs.existsSync(workDir)) {
               fs.rmSync(workDir, { recursive: true, force: true });
             }

             return {
               content: [{ type: "text", text: `Successfully deleted task ${flowId}` }],
             };
          }

          case "retry_step_with_prompt_update": {
             const { flowId, step, prompt, clearOutput = true } = request.params.arguments as any;
             if (!flowId) throw new McpError(ErrorCode.InvalidParams, "flowId is required");
             if (!step) throw new McpError(ErrorCode.InvalidParams, "step is required");
             const retryLib = path.join(SCRIPT_DIR, "orchestrator", "retry-flow.js");
             const promptArg = prompt !== undefined ? JSON.stringify(prompt) : "undefined";
             const retryExpression = `require(${JSON.stringify(retryLib)}).prepareRetry(${JSON.stringify(flowId)}, ${JSON.stringify(step)}, { clearOutput: ${clearOutput}, source: 'manual', prompt: ${promptArg} })`;

             execFileSync(process.execPath, ["-e", retryExpression], {
               cwd: SCRIPT_DIR,
               encoding: "utf8"
             });

             // Start watcher again to pick up the changes
             const args = [path.join(SCRIPT_DIR, "watcher", "index.js"), flowId];

             const watcher = spawn(process.execPath, args, {
               detached: true,
               stdio: 'ignore'
             });
             watcher.unref();

             return {
               content: [{ type: "text", text: `Successfully retried step ${step} for ${flowId}` }],
             };
          }

          case "get_help": {
            const { topic } = (request.params.arguments || {}) as any;
            if (topic && TOOL_DESCRIPTIONS[topic]) {
               return {
                 content: [{ type: "text", text: TOOL_DESCRIPTIONS[topic] }]
               };
            }

            const helpContent = `
DevTeam Task MCP Server Help Guide
====================================

This MCP server provides direct local access to the workflow and task orchestration engine.

Tools available:
1. get_task_list: Lists all currently tracked tasks (flows). You can optionally filter by workspaceName.
2. get_task_status: Retrieves detailed JSON status and metadata for a specific task using its flowId.
3. update_task_status: Directly patches the workflow.json for a given flowId. Use this to update statuses like 'currentStep', 'status', or 'steps.<stepName>'.
4. create_task: Bootstraps a new workflow. Must provide either a jiraKey or customPrompt. Can optionally run inside a specific workspace.
5. delete_task: Forcefully stops and deletes a task and its history.
6. retry_step_with_prompt_update: Forces the orchestrator to retry a specific step (e.g. 'implementer', 'verifier') and optionally allows you to provide a brand new custom prompt to guide the AI for that specific step. It clears previous outputs by default.

Common Workflows:
- To see what AI tasks are running: call get_task_list.
- To view logs or details of a blocked task: call get_task_status.
- If an AI step failed and needs redirection: call retry_step_with_prompt_update with a new prompt.
- To start a completely new instruction: call create_task with a customPrompt.
            `.trim();

            return {
              content: [{ type: "text", text: helpContent }],
            };
          }

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('DevTeam Task MCP Server running on stdio');
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: node dist/index.js [options]

Options:
  --help, -h     Show this help message and exit

Description:
  DevTeam Task MCP Server.
  This server connects via stdio and implements the Model Context Protocol (MCP).
  It provides tools to manage local DevTeam tasks.

  Configure your MCP Client to spawn this process.
  Example config (Cursor / Claude Desktop):
  { "command": "node", "args": ["/path/to/devteam/mcp/dist/index.js"] }

Available Tools:
${Object.values(TOOL_DESCRIPTIONS).join('\n\n')}
    `.trim());
    process.exit(0);
  }

  const server = new TaskServer();
  server.run().catch(console.error);
}

main();
