/**
 * lib/repo-detector.js — Detect target repos from architecture.md output
 *
 * Parses the "Impacted Repos/Modules" section of architecture.md to extract
 * which repositories are affected by a task. Falls back to configured
 * defaultRepos when detection fails or architecture.md is unavailable.
 *
 * Exports: detectRepos
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Known repo name patterns to match against.
 * These are the repo directory names used in the project.
 */
const KNOWN_REPOS = [
  'jinjer_hr_core',
  'jinjer_hr_auth',
  'jinjer_hr_authentication',
  'jinjer_hr_jinji',
  'jinjer_jinji_common'
];

/**
 * Detect target repos from architecture.md in a flow's work directory.
 *
 * Parsing strategy:
 * 1. Find section "## Impacted Repos" (case-insensitive, partial match)
 * 2. Extract lines starting with "- " that contain file paths
 * 3. Parse repo name as the first path segment (before first "/")
 * 4. Deduplicate and validate against known repos
 *
 * @param {string} workDir - Path to the flow's work directory
 * @param {Object} [options]
 * @param {string[]} [options.defaultRepos] - Fallback repos when detection fails
 * @param {string[]} [options.knownRepos] - Override known repo names for validation
 * @returns {string[]} Array of detected repo names (unique, validated)
 */
function detectRepos(workDir, options = {}) {
  const defaultRepos = options.defaultRepos || [];
  const knownRepos = options.knownRepos || KNOWN_REPOS;

  const archFile = path.join(workDir, 'output', 'architecture.md');

  // If architecture.md doesn't exist, return defaults
  if (!fs.existsSync(archFile)) {
    return defaultRepos.length > 0 ? [...defaultRepos] : [];
  }

  let content;
  try {
    content = fs.readFileSync(archFile, 'utf8');
  } catch (err) {
    return defaultRepos.length > 0 ? [...defaultRepos] : [];
  }

  // Find the "Impacted Repos" section
  const repos = parseImpactedRepos(content, knownRepos);

  // If no repos detected, fallback to defaults
  if (repos.length === 0) {
    return defaultRepos.length > 0 ? [...defaultRepos] : [];
  }

  return repos;
}

/**
 * Parse the impacted repos from architecture.md content.
 *
 * Looks for a section header matching "Impacted Repos" (case-insensitive)
 * and extracts repo names from bullet points and file paths in that section.
 *
 * @param {string} content - Full content of architecture.md
 * @param {string[]} knownRepos - Valid repo names to match against
 * @returns {string[]} Unique array of detected repo names
 */
function parseImpactedRepos(content, knownRepos) {
  const lines = content.split('\n');
  const repos = new Set();

  // Find section start
  let inSection = false;
  for (const line of lines) {
    // Detect section header (## Impacted Repos, ## Impacted Repos/Modules, etc.)
    if (/^##\s+impacted\s+repo/i.test(line)) {
      inSection = true;
      continue;
    }

    // End section on next ## header
    if (inSection && /^##\s+/.test(line)) {
      break;
    }

    if (!inSection) continue;

    // Extract repo name from lines like:
    // - `jinjer_hr_core/application/services/...`
    // - jinjer_hr_core/application/...
    // Also handle backtick-wrapped paths
    const cleanLine = line.replace(/`/g, '');

    for (const repo of knownRepos) {
      if (cleanLine.includes(repo + '/') || cleanLine.includes(repo + ' ')) {
        repos.add(repo);
      }
    }
  }

  // Also scan the entire document for repo references in file paths
  // (some architecture docs mention repos outside the Impacted section)
  if (repos.size === 0) {
    for (const repo of knownRepos) {
      // Match repo name followed by / (file path pattern)
      const pattern = new RegExp(`\\b${repo}/`, 'g');
      if (pattern.test(content)) {
        repos.add(repo);
      }
    }
  }

  return Array.from(repos);
}

module.exports = { detectRepos, parseImpactedRepos, KNOWN_REPOS };
