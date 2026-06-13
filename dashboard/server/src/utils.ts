import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

let teamConfigCache: any = null;

export function getTeamConfig(scriptDir: string) {
  if (teamConfigCache) return teamConfigCache;
  const teamJsonPath = path.resolve(scriptDir, '../../team.json');
  if (existsSync(teamJsonPath)) {
    try {
      teamConfigCache = JSON.parse(readFileSync(teamJsonPath, 'utf8'));
    } catch (e) {
      console.error('Failed to parse team.json:', e);
    }
  }
  return teamConfigCache || { members: {} };
}

export function getOutputFilename(step: string, scriptDir: string): string | null {
  const config = getTeamConfig(scriptDir);
  const member = config.members?.[step];
  if (member && member.outputs && member.outputs.length > 0) {
    // member.outputs[0] is typically 'output/something.md'
    const fullPath = member.outputs[0];
    return fullPath.split('/').pop() || null;
  }

  // Fallback map
  const OUTPUT_FILE_MAP: Record<string, string> = {
    clarifier: 'clarify.md',
    architect: 'architecture.md',
    planner: 'plan.md',
    implementer: 'implementation.md',
    verifier: 'verification.md',
  };
  return OUTPUT_FILE_MAP[step] || null;
}
