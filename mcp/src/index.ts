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
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

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
            const state = this.getWorkflowState(flowId, workspaceName);
            return {
              content: [{ type: "text", text: JSON.stringify(state, null, 2) }],
            };
          }

          case "update_task_status": {
             const { flowId, workspaceName, updates } = request.params.arguments as any;
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
            const { jiraKey = "", customPrompt = "", workflowId, workspaceName, workspacePath } = request.params.arguments || {};
            const args = ["start"];
            if (workflowId) args.push("--workflow", workflowId as string);
            if (workspaceName) args.push("--workspace-name", workspaceName as string);
            if (workspacePath) args.push("--workspace-dir", workspacePath as string);
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

             // Try to stop first
             try {
                execFileSync(process.execPath, [path.join(SCRIPT_DIR, "orchestrator", "index.js"), "stop", flowId], {
                  cwd: SCRIPT_DIR,
                  encoding: "utf8",
                  timeout: 10000
                });
             } catch (e) {}

             // Delete memory tree context (similar to dashboard logic)
             const memoryTreeScript = `
               const fs = require('fs');
               const path = require('path');
               try {
                 const { getFlowDir, getMetaPath } = require('./utils/memory-tree.js');
                 const flowId = process.argv[2];
                 const flowDir = getFlowDir(flowId);
                 if (fs.existsSync(flowDir)) fs.rmSync(flowDir, { recursive: true, force: true });

                 const metaPath = getMetaPath(flowId);
                 if (fs.existsSync(metaPath)) {
                   const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                   if (meta.flows) meta.flows = meta.flows.filter(f => f.flow_id !== flowId);
                   if (!meta.flows || meta.flows.length === 0) {
                     const taskDir = path.dirname(metaPath);
                     fs.rmSync(taskDir, { recursive: true, force: true });
                   } else {
                     fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
                   }
                 }
               } catch(e) {}
             `;
             try {
               execFileSync(process.execPath, ["-e", memoryTreeScript, flowId], {
                  cwd: SCRIPT_DIR,
                  encoding: "utf8",
               });
             } catch(e) {}

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
             const retryLib = path.join(SCRIPT_DIR, "orchestrator", "retry-flow.js");
             const promptArg = prompt !== undefined ? JSON.stringify(prompt) : "undefined";
             const retryExpression = `require(${JSON.stringify(retryLib)}).prepareRetry(${JSON.stringify(flowId)}, ${JSON.stringify(step)}, { clearOutput: ${clearOutput}, source: 'manual', prompt: ${promptArg} })`;

             execFileSync(process.execPath, ["-e", retryExpression], {
               cwd: SCRIPT_DIR,
               encoding: "utf8"
             });

             // Start watcher again to pick up the changes
             const args = [path.join(SCRIPT_DIR, "watcher", "index.js"), flowId];
             const spawn = require("child_process").spawn;
             const watcher = spawn(process.execPath, args, {
               detached: true,
               stdio: 'ignore'
             });
             watcher.unref();

             return {
               content: [{ type: "text", text: `Successfully retried step ${step} for ${flowId}` }],
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

const server = new TaskServer();
server.run().catch(console.error);
