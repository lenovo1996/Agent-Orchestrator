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
  }
});
