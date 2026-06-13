#!/usr/bin/env node
/**
 * Unit Tests for repo-detector.js
 *
 * Run: node --test .dev-team/scripts/test/repo-detector.test.js
 */

'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { detectRepos, parseImpactedRepos, KNOWN_REPOS } = require('../lib/repo-detector');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'repo-detector-test-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

describe('parseImpactedRepos', () => {
  test('extracts repos from standard Impacted Repos/Modules section', () => {
    const content = `# Architecture

## Impacted Repos/Modules
- \`jinjer_hr_core/application/services/MasterSettingCsv/Support/MasterSettingCsvRegistry.php\` — thêm target
- \`jinjer_hr_core/application/services/MasterSettingCsv/Actions/ExportMasterSettingCsvAction.php\` — cho phép schema
- \`jinjer_hr_jinji/assets/templates/hr/js/master/master_setting_csv_export.js\` — thêm whitelist

## Design Decisions
Something else.
`;
    const repos = parseImpactedRepos(content, KNOWN_REPOS);
    assert.deepStrictEqual(repos.sort(), ['jinjer_hr_core', 'jinjer_hr_jinji']);
  });

  test('extracts repos without backticks', () => {
    const content = `## Impacted Repos
- jinjer_hr_auth/application/controllers/Auth.php — update logic
- jinjer_hr_authentication/src/Services/TokenService.php — new service
`;
    const repos = parseImpactedRepos(content, KNOWN_REPOS);
    assert.deepStrictEqual(repos.sort(), ['jinjer_hr_auth', 'jinjer_hr_authentication']);
  });

  test('returns empty array when no Impacted section found but scans full doc', () => {
    const content = `# Architecture
## Overview
This changes jinjer_hr_core/application/models/User.php
`;
    const repos = parseImpactedRepos(content, KNOWN_REPOS);
    // Fallback scan finds it
    assert.deepStrictEqual(repos, ['jinjer_hr_core']);
  });

  test('returns empty array when no repo references exist', () => {
    const content = `# Architecture
## Overview
No file paths mentioned here.
## Design
Just a design.
`;
    const repos = parseImpactedRepos(content, KNOWN_REPOS);
    assert.deepStrictEqual(repos, []);
  });

  test('deduplicates repos mentioned multiple times', () => {
    const content = `## Impacted Repos
- jinjer_hr_core/app/A.php
- jinjer_hr_core/app/B.php
- jinjer_hr_core/app/C.php
`;
    const repos = parseImpactedRepos(content, KNOWN_REPOS);
    assert.deepStrictEqual(repos, ['jinjer_hr_core']);
  });

  test('handles case-insensitive section header', () => {
    const content = `## IMPACTED REPOS/MODULES
- jinjer_hr_auth/src/Controller.php
`;
    const repos = parseImpactedRepos(content, KNOWN_REPOS);
    assert.deepStrictEqual(repos, ['jinjer_hr_auth']);
  });

  test('stops at next ## section', () => {
    const content = `## Impacted Repos
- jinjer_hr_core/app/A.php

## Design Decisions
- jinjer_hr_jinji/something — this should NOT be picked up from here
`;
    const repos = parseImpactedRepos(content, KNOWN_REPOS);
    assert.deepStrictEqual(repos, ['jinjer_hr_core']);
  });
});

describe('detectRepos', () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) cleanup(tmpDir);
  });

  test('detects repos from architecture.md in workDir', () => {
    tmpDir = createTempDir();
    fs.writeFileSync(path.join(tmpDir, 'architecture.md'), `
## Impacted Repos/Modules
- jinjer_hr_core/application/services/Something.php
- jinjer_hr_authentication/src/Auth.php
`);

    const repos = detectRepos(tmpDir);
    assert.deepStrictEqual(repos.sort(), ['jinjer_hr_authentication', 'jinjer_hr_core']);
  });

  test('returns defaultRepos when architecture.md does not exist', () => {
    tmpDir = createTempDir();
    const defaults = ['jinjer_hr_core', 'jinjer_hr_auth', 'jinjer_hr_authentication', 'jinjer_hr_jinji'];

    const repos = detectRepos(tmpDir, { defaultRepos: defaults });
    assert.deepStrictEqual(repos, defaults);
  });

  test('returns defaultRepos when architecture.md has no repo references', () => {
    tmpDir = createTempDir();
    fs.writeFileSync(path.join(tmpDir, 'architecture.md'), `
## Overview
No impacted repos section here.
No file paths at all.
`);
    const defaults = ['jinjer_hr_core', 'jinjer_hr_auth'];

    const repos = detectRepos(tmpDir, { defaultRepos: defaults });
    assert.deepStrictEqual(repos, defaults);
  });

  test('returns empty array when no architecture.md and no defaults', () => {
    tmpDir = createTempDir();
    const repos = detectRepos(tmpDir);
    assert.deepStrictEqual(repos, []);
  });

  test('returns detected repos even when defaults are provided (detection wins)', () => {
    tmpDir = createTempDir();
    fs.writeFileSync(path.join(tmpDir, 'architecture.md'), `
## Impacted Repos
- jinjer_hr_jinji/views/template.php
`);
    const defaults = ['jinjer_hr_core', 'jinjer_hr_auth'];

    // Detection found jinjer_hr_jinji, so defaults are NOT used
    const repos = detectRepos(tmpDir, { defaultRepos: defaults });
    assert.deepStrictEqual(repos, ['jinjer_hr_jinji']);
  });

  test('works with real architecture.md format from JH-40515', () => {
    tmpDir = createTempDir();
    // Simulating the actual format we saw
    fs.writeFileSync(path.join(tmpDir, 'architecture.md'), `
# Architecture: JH-40515

## Impacted Repos/Modules
- \`jinjer_hr_core/application/services/MasterSettingCsv/Support/MasterSettingCsvRegistry.php\` — thêm target
- \`jinjer_hr_core/application/services/MasterSettingCsv/Actions/ExportMasterSettingCsvAction.php\` — update
- \`jinjer_hr_core/application/services/MasterSettingCsv/Tasks/GetJobTitleCsvRowsTask.php\` — task mới
- \`jinjer_hr_core/application/services/MasterSettingCsv/Adapters/JobTitleCsvAdapter.php\` — adapter mới
- \`jinjer_hr_core/application/tests/Containers/HRSection/MasterSettingCsv/Unit/MasterSettingCsvTest.php\` — tests
- \`jinjer_hr_core/application/tests/Containers/HRSection/MasterSettingCsv/API/Controllers/ControllerTest.php\` — tests
- \`jinjer_hr_jinji/assets/templates/hr/js/master/master_setting_csv_export.js\` — whitelist

## Design Decisions
Something.
`);

    const repos = detectRepos(tmpDir);
    assert.deepStrictEqual(repos.sort(), ['jinjer_hr_core', 'jinjer_hr_jinji']);
  });
});
