import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create DB file in project root or custom path
const dbDir = path.resolve(__dirname, '../../../');
const dbPath = path.join(dbDir, 'workflows.db');

export const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database', err);
  } else {
    // console.log('Database connected');
    db.run(`
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        steps TEXT NOT NULL
      )
    `, (createErr) => {
      if (createErr) {
        console.error('Error creating table', createErr);
      }
    });

    db.run(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        objective TEXT NOT NULL,
        model TEXT,
        thinking TEXT,
        tools TEXT NOT NULL,
        outputs TEXT NOT NULL,
        runtime TEXT,
        instructions TEXT NOT NULL
      )
    `, (createErr) => {
      if (createErr) {
        console.error('Error creating agents table', createErr);
      } else {
        // Initialize agents if table is empty
        db.get('SELECT COUNT(*) as count FROM agents', (err, row: any) => {
          if (!err && row && row.count === 0) {
            initializeAgents();
          }
        });
      }
    });
  }
});

function initializeAgents() {
  try {
    const teamJsonPath = path.join(dbDir, 'team.json');
    if (fs.existsSync(teamJsonPath)) {
      const teamConfig = JSON.parse(fs.readFileSync(teamJsonPath, 'utf8'));
      const members = teamConfig.members || {};

      const stmt = db.prepare('INSERT INTO agents (id, role, objective, model, thinking, tools, outputs, runtime, instructions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');

      for (const [id, config] of Object.entries(members) as any) {
        const promptPath = path.join(dbDir, 'prompts', `${id}.md`);
        let instructions = '';
        if (fs.existsSync(promptPath)) {
          instructions = fs.readFileSync(promptPath, 'utf8');
        }

        stmt.run([
          id,
          config.role || '',
          config.objective || '',
          config.model || '',
          config.thinking || '',
          JSON.stringify(config.tools || []),
          JSON.stringify(config.outputs || []),
          config.runtime || '',
          instructions
        ]);
      }

      stmt.finalize();
      console.log('Successfully initialized agents from team.json');
    }
  } catch (error) {
    console.error('Error initializing agents:', error);
  }
}
