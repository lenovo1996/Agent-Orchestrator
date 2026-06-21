import { Router } from "express";
import { db } from "../db.js";
import type { AgentConfig } from "@devteam-dashboard/shared";
import {
  syncAgentsToFileSystem,
  removeAgentPrompt,
} from "../services/agent.service.js";

export function agentsRouter() {
  const router = Router();

  // GET /api/agents
  router.get("/agents", (req, res) => {
    db.all("SELECT * FROM agents", [], (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      const agents: AgentConfig[] = rows.map((row: any) => ({
        id: row.id,
        role: row.role,
        objective: row.objective,
        model: row.model,
        thinking: row.thinking,
        tools: JSON.parse(row.tools),
        outputs: JSON.parse(row.outputs),
        runtime: row.runtime,
        instructions: row.instructions,
      }));
      res.json(agents);
    });
  });

  // POST /api/agents
  router.post("/agents", (req, res) => {
    const {
      id,
      role,
      objective,
      model,
      thinking,
      tools,
      outputs,
      runtime,
      instructions,
    } = req.body;

    if (!id || !role || !objective || !tools || !outputs || !instructions) {
      return res.status(400).json({ error: "Missing required agent data" });
    }

    const stmt = db.prepare(
      "INSERT INTO agents (id, role, objective, model, thinking, tools, outputs, runtime, instructions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    stmt.run(
      [
        id,
        role,
        objective,
        model || "",
        thinking || "",
        JSON.stringify(tools),
        JSON.stringify(outputs),
        runtime || "",
        instructions,
      ],
      function (err) {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        syncAgentsToFileSystem();
        res.status(201).json({ success: true, id });
      },
    );
    stmt.finalize();
  });

  // PUT /api/agents/:id
  router.put("/agents/:id", (req, res) => {
    const { id } = req.params;
    const {
      role,
      objective,
      model,
      thinking,
      tools,
      outputs,
      runtime,
      instructions,
    } = req.body;

    if (!role || !objective || !tools || !outputs || !instructions) {
      return res.status(400).json({ error: "Missing required agent data" });
    }

    const stmt = db.prepare(
      "UPDATE agents SET role = ?, objective = ?, model = ?, thinking = ?, tools = ?, outputs = ?, runtime = ?, instructions = ? WHERE id = ?",
    );
    stmt.run(
      [
        role,
        objective,
        model || "",
        thinking || "",
        JSON.stringify(tools),
        JSON.stringify(outputs),
        runtime || "",
        instructions,
        id,
      ],
      function (err) {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        if (this.changes === 0) {
          return res.status(404).json({ error: "Agent not found" });
        }
        syncAgentsToFileSystem();
        res.json({ success: true });
      },
    );
    stmt.finalize();
  });

  // DELETE /api/agents/:id
  router.delete("/agents/:id", (req, res) => {
    const { id } = req.params;

    const stmt = db.prepare("DELETE FROM agents WHERE id = ?");
    stmt.run([id], function (err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: "Agent not found" });
      }

      removeAgentPrompt(id);
      syncAgentsToFileSystem();
      res.json({ success: true });
    });
    stmt.finalize();
  });

  return router;
}
