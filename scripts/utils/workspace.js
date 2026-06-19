const fs = require('fs');
const path = require('path');

function getRepoRoot() {
  return process.env.WORKSPACE_PATH || path.resolve(__dirname, '../../');
}

function getOutputRoot() {
  if (process.env.OUTPUT_ROOT) {
    return process.env.OUTPUT_ROOT;
  }
  const repoRoot = getRepoRoot();
  const teamConfigPath = path.join(path.resolve(__dirname, '../../'), 'team.json');
  let outputRootConfig = 'task-flows';
  if (fs.existsSync(teamConfigPath)) {
    const teamConfig = JSON.parse(fs.readFileSync(teamConfigPath, 'utf8'));
    outputRootConfig = teamConfig.outputRoot || 'task-flows';
  }
  return path.resolve(repoRoot, outputRootConfig);
}

module.exports = {
  getRepoRoot,
  getOutputRoot
};
