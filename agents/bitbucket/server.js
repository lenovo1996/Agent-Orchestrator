#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";

// Load env from a local .env next to this server (optional)
try {
  dotenv.config({ path: new URL("./.env", import.meta.url) });
} catch {
  // ignore
}

const BITBUCKET_API_BASE = "https://api.bitbucket.org/2.0";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function authHeader() {
  // Preferred: Bitbucket Cloud API token (replacement for App passwords).
  // Atlassian docs: authenticate as Basic {base64(email:api_token)}
  const apiToken = process.env.BITBUCKET_API_TOKEN;
  const email = process.env.BITBUCKET_EMAIL || process.env.BITBUCKET_USERNAME;
  if (apiToken && email) {
    const token = Buffer.from(`${email}:${apiToken}`).toString("base64");
    return { Authorization: `Basic ${token}` };
  }

  // Fallback: Bitbucket App Password (Basic)
  const username = requireEnv("BITBUCKET_USERNAME");
  const appPassword = requireEnv("BITBUCKET_APP_PASSWORD");
  const token = Buffer.from(`${username}:${appPassword}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

async function bbFetch(path, { method = "GET", query, body, headers } = {}) {
  const url = new URL(`${BITBUCKET_API_BASE}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      ...authHeader(),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const contentType = res.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");

  if (!res.ok) {
    const errText = isJson ? JSON.stringify(await res.json()) : await res.text();
    throw new Error(`Bitbucket API error ${res.status} ${res.statusText}: ${errText}`);
  }

  if (isJson) return await res.json();
  return await res.text();
}

function parsePrUrl(prUrl) {
  // Examples:
  // https://bitbucket.org/{workspace}/{repo_slug}/pull-requests/{id}
  const u = new URL(prUrl);
  if (u.hostname !== "bitbucket.org") throw new Error("Only bitbucket.org URLs are supported");
  const parts = u.pathname.split("/").filter(Boolean);
  const [workspace, repo, prLiteral, prIdStr] = parts;
  if (!workspace || !repo || prLiteral !== "pull-requests" || !prIdStr) {
    throw new Error("Unrecognized PR URL format");
  }
  const prId = Number(prIdStr);
  if (!Number.isFinite(prId)) throw new Error("PR id is not a number");
  return { workspace, repo_slug: repo, prId };
}

function text(content) {
  return { content: [{ type: "text", text: content }] };
}

const server = new Server(
  { name: "mcp-bitbucket-cloud", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "parse_pr_url",
        description: "Parse a Bitbucket Cloud pull request URL into workspace/repo_slug/prId",
        inputSchema: {
          type: "object",
          properties: { prUrl: { type: "string" } },
          required: ["prUrl"],
        },
      },
      {
        name: "get_pullrequest",
        description: "Get pull request metadata (title, author, state, source/destination, etc.)",
        inputSchema: {
          type: "object",
          properties: {
            workspace: { type: "string" },
            repo_slug: { type: "string" },
            prId: { type: "number" },
          },
          required: ["workspace", "repo_slug", "prId"],
        },
      },
      {
        name: "get_diff",
        description: "Fetch PR diff (unified). Returns text.",
        inputSchema: {
          type: "object",
          properties: {
            workspace: { type: "string" },
            repo_slug: { type: "string" },
            prId: { type: "number" },
          },
          required: ["workspace", "repo_slug", "prId"],
        },
      },
      {
        name: "get_diffstat",
        description: "List changed files with stats for a PR",
        inputSchema: {
          type: "object",
          properties: {
            workspace: { type: "string" },
            repo_slug: { type: "string" },
            prId: { type: "number" },
            pagelen: { type: "number", default: 100 },
          },
          required: ["workspace", "repo_slug", "prId"],
        },
      },
      {
        name: "add_comment",
        description:
          "Add a PR comment. For inline comment: pass filePath + line. For general comment: only content.",
        inputSchema: {
          type: "object",
          properties: {
            workspace: { type: "string" },
            repo_slug: { type: "string" },
            prId: { type: "number" },
            content: { type: "string" },
            filePath: { type: "string" },
            line: { type: "number" },
          },
          required: ["workspace", "repo_slug", "prId", "content"],
        },
      },
      {
        name: "approve",
        description: "Approve a pull request",
        inputSchema: {
          type: "object",
          properties: {
            workspace: { type: "string" },
            repo_slug: { type: "string" },
            prId: { type: "number" },
          },
          required: ["workspace", "repo_slug", "prId"],
        },
      },
      {
        name: "get_tasks",
        description: "List tasks on a pull request",
        inputSchema: {
          type: "object",
          properties: {
            workspace: { type: "string" },
            repo_slug: { type: "string" },
            prId: { type: "number" },
            pagelen: { type: "number", default: 50 },
          },
          required: ["workspace", "repo_slug", "prId"],
        },
      },
      {
        name: "create_pullrequest",
        description: "Create a Bitbucket Cloud pull request",
        inputSchema: {
          type: "object",
          properties: {
            workspace: { type: "string" },
            repo_slug: { type: "string" },
            title: { type: "string" },
            sourceBranch: { type: "string" },
            destinationBranch: { type: "string" },
            description: { type: "string" },
            closeSourceBranch: { type: "boolean", default: false },
          },
          required: ["workspace", "repo_slug", "title", "sourceBranch", "destinationBranch"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    switch (name) {
      case "parse_pr_url": {
        const { prUrl } = args;
        return text(JSON.stringify(parsePrUrl(prUrl), null, 2));
      }

      case "get_pullrequest": {
        const { workspace, repo_slug, prId } = args;
        const data = await bbFetch(
          `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo_slug)}/pullrequests/${prId}`
        );
        return text(JSON.stringify(data, null, 2));
      }

      case "get_diff": {
        const { workspace, repo_slug, prId } = args;
        const diffText = await bbFetch(
          `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo_slug)}/pullrequests/${prId}/diff`,
          { headers: { Accept: "text/plain" } }
        );
        return text(diffText);
      }

      case "get_diffstat": {
        const { workspace, repo_slug, prId, pagelen = 100 } = args;
        const data = await bbFetch(
          `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo_slug)}/pullrequests/${prId}/diffstat`,
          { query: { pagelen } }
        );
        return text(JSON.stringify(data, null, 2));
      }

      case "add_comment": {
        const { workspace, repo_slug, prId, content, filePath, line } = args;
        const body = { content: { raw: content } };
        if (filePath) {
          body.inline = { path: filePath };
          if (line) body.inline.to = line;
        }
        const data = await bbFetch(
          `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo_slug)}/pullrequests/${prId}/comments`,
          { method: "POST", body }
        );
        return text(JSON.stringify(data, null, 2));
      }

      case "approve": {
        const { workspace, repo_slug, prId } = args;
        const data = await bbFetch(
          `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo_slug)}/pullrequests/${prId}/approve`,
          { method: "POST" }
        );
        return text(JSON.stringify(data, null, 2));
      }

      case "get_tasks": {
        const { workspace, repo_slug, prId, pagelen = 50 } = args;
        const data = await bbFetch(
          `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo_slug)}/pullrequests/${prId}/tasks`,
          { query: { pagelen } }
        );
        return text(JSON.stringify(data, null, 2));
      }

      case "create_pullrequest": {
        const {
          workspace,
          repo_slug,
          title,
          sourceBranch,
          destinationBranch,
          description = "",
          closeSourceBranch = false,
        } = args;
        const data = await bbFetch(
          `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo_slug)}/pullrequests`,
          {
            method: "POST",
            body: {
              title,
              description,
              source: { branch: { name: sourceBranch } },
              destination: { branch: { name: destinationBranch } },
              close_source_branch: closeSourceBranch,
            },
          }
        );
        return text(JSON.stringify(data, null, 2));
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return text(`ERROR: ${e?.message || String(e)}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
