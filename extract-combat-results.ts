#!/usr/bin/env bun
/**
 * Extract combat-level-30m benchmark results from Harbor job directories.
 *
 * Reads reward.json from each job's verifier output, which contains:
 * - combatLevel (best across all fresh runs)
 * - allRuns[] with per-run details
 *
 * Usage:
 *   bun benchmark/extract-combat-results.ts                          # Auto-discover jobs/
 *   bun benchmark/extract-combat-results.ts jobs/combat-level-*      # Specific job dirs
 *   bun benchmark/extract-combat-results.ts --filter combat          # Filter by pattern
 *
 * Output:
 *   benchmark/results/combat/_combined.json
 *   benchmark/results/combat/_data.js
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';

const RESULTS_DIR = join(import.meta.dir, 'results', 'combat');
const JOBS_DIR = join(import.meta.dir, '..', 'jobs');

const KNOWN_MODELS = ['opus', 'sonnet46', 'sonnet45', 'haiku', 'codex', 'gemini', 'glm', 'kimi'];

interface RunRecord {
  runId: number;
  username: string;
  combatLevel: number;
  skills: Record<string, { level: number; xp: number }>;
  scriptPath: string;
  scriptExitCode: number;
  durationMs: number;
  timestamp: string;
  error?: string;
}

interface RewardData {
  combatLevel: number;
  bestRun?: RunRecord;
  totalRuns: number;
  allRuns: RunRecord[];
}

interface TokenUsage {
  inputTokens: number;
  cacheTokens: number;
  outputTokens: number;
}

function detectModel(dirName: string): string {
  const lower = dirName.toLowerCase();
  for (const m of KNOWN_MODELS) {
    if (lower.includes(`-${m}-`) || lower.endsWith(`-${m}`)) return m;
  }
  return 'unknown';
}

function detectModelFromConfig(jobDir: string): string {
  const configPath = join(jobDir, 'config.json');
  if (!existsSync(configPath)) return 'unknown';
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const modelName = config?.agents?.[0]?.model_name || '';
    const lower = modelName.toLowerCase();
    for (const m of KNOWN_MODELS) {
      if (lower.includes(m)) return m;
    }
    const agentName = config?.agents?.[0]?.name || '';
    if (agentName.includes('codex')) return 'codex';
    if (agentName.includes('gemini')) return 'gemini';
    if (agentName.includes('kimi') || agentName.includes('opencode')) return 'kimi';
  } catch {}
  return 'unknown';
}

function getTrialDirs(jobDir: string): string[] {
  const trials: string[] = [];
  const entries = readdirSync(jobDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const subDir = join(jobDir, entry.name);

    if (existsSync(join(subDir, 'verifier')) || existsSync(join(subDir, 'agent'))) {
      trials.push(subDir);
    } else {
      try {
        const subEntries = readdirSync(subDir, { withFileTypes: true });
        for (const sub of subEntries) {
          if (!sub.isDirectory()) continue;
          const nested = join(subDir, sub.name);
          if (existsSync(join(nested, 'verifier')) || existsSync(join(nested, 'agent'))) {
            trials.push(nested);
          }
        }
      } catch {}
    }
  }
  return trials;
}

function findRewardData(jobDir: string): RewardData | null {
  for (const trialDir of getTrialDirs(jobDir)) {
    // Primary: reward.json
    const rewardPath = join(trialDir, 'verifier', 'reward.json');
    if (existsSync(rewardPath)) {
      try {
        const reward = JSON.parse(readFileSync(rewardPath, 'utf-8'));
        if (reward.combatLevel !== undefined) return reward;
      } catch {}
    }

    // Fallback: parse from test-stdout.txt
    const stdoutPath = join(trialDir, 'verifier', 'test-stdout.txt');
    if (existsSync(stdoutPath)) {
      try {
        const content = readFileSync(stdoutPath, 'utf-8');
        const startMarker = '__REWARD_JSON_START__';
        const endMarker = '__REWARD_JSON_END__';
        const startIdx = content.indexOf(startMarker);
        const endIdx = content.indexOf(endMarker);
        if (startIdx !== -1 && endIdx !== -1) {
          const reward = JSON.parse(content.slice(startIdx + startMarker.length, endIdx).trim());
          if (reward.combatLevel !== undefined) return reward;
        }
      } catch {}
    }
  }
  return null;
}

function findTokenUsage(jobDir: string): TokenUsage | null {
  for (const trialDir of getTrialDirs(jobDir)) {
    const resultPath = join(trialDir, 'result.json');
    if (!existsSync(resultPath)) continue;
    try {
      const result = JSON.parse(readFileSync(resultPath, 'utf-8'));
      const ar = result.agent_result;
      if (ar && (ar.n_input_tokens || ar.n_output_tokens)) {
        return {
          inputTokens: ar.n_input_tokens || 0,
          cacheTokens: ar.n_cache_tokens || 0,
          outputTokens: ar.n_output_tokens || 0,
        };
      }
    } catch {}
  }
  return null;
}

// ── Transcript extraction ────────────────────────────────────────

function extractTranscript(jobDir: string): string[] {
  for (const trialDir of getTrialDirs(jobDir)) {
    const agentDir = join(trialDir, 'agent');
    if (!existsSync(agentDir)) continue;

    // 1. trajectory.json (Claude Code, GLM — Harbor format)
    const trajectoryPath = join(agentDir, 'trajectory.json');
    if (existsSync(trajectoryPath)) {
      try {
        const traj = JSON.parse(readFileSync(trajectoryPath, 'utf-8'));
        const steps = traj.steps || [];
        const msgs: string[] = [];
        for (const step of steps) {
          if (step.source === 'agent' && step.message && !step.message.startsWith('Executed ')) {
            msgs.push(step.message.trim());
          }
        }
        if (msgs.length > 0) return msgs;
      } catch {}
    }

    // 2. claude-code.txt (Claude Code JSONL transcript)
    const claudePath = join(agentDir, 'claude-code.txt');
    if (existsSync(claudePath)) {
      try {
        const lines = readFileSync(claudePath, 'utf-8').split('\n');
        const msgs: string[] = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'assistant') {
              const msg = obj.message;
              const content = (typeof msg === 'object' && msg?.content) ? msg.content : [];
              if (Array.isArray(content)) {
                for (const item of content) {
                  if (item?.type === 'text' && item.text?.trim()) {
                    msgs.push(item.text.trim());
                  }
                }
              }
            }
          } catch {}
        }
        if (msgs.length > 0) return msgs;
      } catch {}
    }

    // 3. gemini-cli.txt (Gemini plaintext log)
    const geminiPath = join(agentDir, 'gemini-cli.txt');
    if (existsSync(geminiPath)) {
      try {
        const lines = readFileSync(geminiPath, 'utf-8').split('\n');
        const msgs: string[] = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          // Skip YOLO mode lines, error traces, and stack frames
          if (trimmed.startsWith('YOLO mode') ||
              trimmed.startsWith('Attempt ') ||
              trimmed.startsWith('    at ') ||
              trimmed.startsWith('{') ||
              trimmed.startsWith('[agent-loop]')) continue;
          msgs.push(trimmed);
        }
        if (msgs.length > 0) return msgs;
      } catch {}
    }

    // 4. codex.txt (Codex JSONL)
    const codexPath = join(agentDir, 'codex.txt');
    if (existsSync(codexPath)) {
      try {
        const lines = readFileSync(codexPath, 'utf-8').split('\n');
        const msgs: string[] = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'message' && obj.content) {
              const text = typeof obj.content === 'string' ? obj.content
                : Array.isArray(obj.content) ? obj.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
                : '';
              if (text.trim()) msgs.push(text.trim());
            }
          } catch {
            // Non-JSON lines from codex (agent-loop messages, etc)
            const trimmed = line.trim();
            if (trimmed.startsWith('[agent-loop]') && !trimmed.includes('restarting')) {
              msgs.push(trimmed);
            }
          }
        }
        if (msgs.length > 0) return msgs;
      } catch {}
    }
  }
  return [];
}

// ── Main ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let filter = 'combat';
let explicitDirs: string[] = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--filter' && args[i + 1]) {
    filter = args[++i];
  } else {
    explicitDirs.push(args[i]);
  }
}

let jobDirs: string[];
if (explicitDirs.length > 0) {
  jobDirs = explicitDirs.map(d => d.startsWith('/') ? d : join(process.cwd(), d));
} else if (existsSync(JOBS_DIR)) {
  jobDirs = readdirSync(JOBS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .filter(d => !filter || d.name.includes(filter))
    .map(d => join(JOBS_DIR, d.name));
} else {
  console.log('No jobs/ directory found. Pass job directories as arguments.');
  process.exit(1);
}

if (jobDirs.length === 0) {
  console.log('No matching job directories found.');
  process.exit(1);
}

mkdirSync(RESULTS_DIR, { recursive: true });

interface ModelResult {
  jobName: string;
  combatLevel: number;
  totalRuns: number;
  bestRun?: RunRecord;
  allRuns: RunRecord[];
  tokenUsage?: TokenUsage;
  transcript?: string[];
}

const combined: Record<string, ModelResult> = {};
let extracted = 0;

for (const dir of jobDirs) {
  const jobName = basename(dir);
  let model = detectModel(jobName);
  if (model === 'unknown') model = detectModelFromConfig(dir);
  if (model === 'unknown') {
    console.log(`  skip: ${jobName} (can't detect model)`);
    continue;
  }

  const reward = findRewardData(dir);
  if (!reward) {
    console.log(`  skip: ${jobName} (no reward data)`);
    continue;
  }

  const tokenUsage = findTokenUsage(dir);
  const transcript = extractTranscript(dir);

  // Keep best run per model
  const existing = combined[model];
  if (!existing || reward.combatLevel > existing.combatLevel) {
    combined[model] = {
      jobName,
      combatLevel: reward.combatLevel,
      totalRuns: reward.totalRuns,
      bestRun: reward.bestRun,
      allRuns: reward.allRuns || [],
      ...(tokenUsage ? { tokenUsage } : {}),
      ...(transcript.length > 0 ? { transcript } : {}),
    };
  }

  const tokenStr = tokenUsage ? ` tokens: ${(tokenUsage.inputTokens / 1000).toFixed(0)}k in / ${(tokenUsage.outputTokens / 1000).toFixed(0)}k out` : '';
  const runsStr = reward.allRuns ? `, ${reward.allRuns.length} runs` : '';
  console.log(`  ${model}: CL=${reward.combatLevel}${runsStr}${tokenStr} — ${jobName}`);
  extracted++;
}

if (extracted === 0) {
  console.log('\nNo combat-level results found.');
  process.exit(1);
}

// Write results
const combinedPath = join(RESULTS_DIR, '_combined.json');
writeFileSync(combinedPath, JSON.stringify(combined, null, 2));
console.log(`\nWrote ${combinedPath}`);

const dataJsPath = join(RESULTS_DIR, '_data.js');
writeFileSync(dataJsPath, `window.COMBAT_DATA = ${JSON.stringify(combined)};`);
console.log(`Wrote ${dataJsPath}`);

// Print summary table
console.log(`\n${'━'.repeat(60)}`);
console.log('  Combat Level Benchmark Results');
console.log(`${'━'.repeat(60)}`);
console.log(`  ${'Model'.padEnd(12)} ${'CL'.padStart(4)} ${'Runs'.padStart(5)}  Best Run Skills`);
console.log(`  ${'─'.repeat(55)}`);

const sorted = Object.entries(combined).sort((a, b) => b[1].combatLevel - a[1].combatLevel);
for (const [model, data] of sorted) {
  const best = data.bestRun;
  const combatSkills = ['Attack', 'Strength', 'Defence', 'Hitpoints'];
  const skillStr = best?.skills
    ? combatSkills.map(s => `${s.substring(0, 3)}:${best.skills[s]?.level ?? 1}`).join(' ')
    : '';
  console.log(`  ${model.padEnd(12)} ${String(data.combatLevel).padStart(4)} ${String(data.totalRuns).padStart(5)}  ${skillStr}`);
}
console.log(`${'━'.repeat(60)}`);
console.log(`\n${extracted} result(s) extracted.`);
