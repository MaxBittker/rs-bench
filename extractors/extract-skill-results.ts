#!/usr/bin/env bun
/**
 * Extract skill XP tracking data from Harbor job results for the skills-30m graph viewer.
 *
 * Detects skill from job dir name: {skill}-xp-30m-{model}-...
 * Groups by model -> skill instead of model -> timeHorizon.
 *
 * Usage:
 *   bun extractors/extract-skill-results.ts                          # Auto-discover all jobs/
 *   bun extractors/extract-skill-results.ts jobs/woodcutting-xp-30m-* # Specific job dirs
 *   bun extractors/extract-skill-results.ts --filter 30m-opus        # Filter by pattern
 *
 * Output:
 *   results/skills-30m/_combined.json  — { model: { skill: { finalXp, finalLevel, samples[], tokenUsage } } }
 */

import { readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import {
  type Sample, type TrackingData, type TokenUsage,
  detectModel, detectModelFromConfig, getTrialDirs,
  parseRewardFromStdout, findTokenUsage,
  parseCLIArgs, resolveJobDirs, writeResults,
} from '../shared/extract-utils';

const RESULTS_DIR = join(import.meta.dir, '..', 'results', 'skills-30m');
const JOBS_DIR = join(import.meta.dir, '..', 'jobs');

const KNOWN_MODELS = ['opus', 'opus45', 'sonnet46', 'sonnet45', 'haiku', 'codex53', 'codex', 'gemini31', 'gemini', 'glm', 'kimi', 'qwen35', 'qwen3'];

const KNOWN_SKILLS = [
  'attack', 'defence', 'strength', 'hitpoints', 'ranged', 'prayer', 'magic',
  'woodcutting', 'fishing', 'mining', 'cooking', 'fletching', 'crafting',
  'smithing', 'firemaking', 'thieving',
];

/** Detect skill from directory name: {skill}-xp-30m-{model}-... */
function detectSkill(dirName: string): string | null {
  const lower = dirName.toLowerCase();
  for (const skill of KNOWN_SKILLS) {
    if (lower.startsWith(`${skill}-xp-30m`)) return skill;
  }
  return null;
}

function detectSkillFromConfig(jobDir: string): string | null {
  const configPath = join(jobDir, 'config.json');
  if (!existsSync(configPath)) return null;
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const taskPath = config?.tasks?.[0]?.path || '';
    const lower = taskPath.toLowerCase();
    for (const skill of KNOWN_SKILLS) {
      if (lower.includes(`${skill}-xp-30m`)) return skill;
    }
  } catch {}
  return null;
}

/** Walk a job directory and find tracking data from reward.json, skill_tracking.json, or test-stdout.txt */
function findTracking(jobDir: string): TrackingData | null {
  for (const trialDir of getTrialDirs(jobDir)) {
    const rewardPath = join(trialDir, 'verifier', 'reward.json');
    if (existsSync(rewardPath)) {
      try {
        const reward = JSON.parse(readFileSync(rewardPath, 'utf-8'));
        if (reward.tracking?.samples?.length > 0) return reward.tracking;
      } catch {}
    }

    const trackingPath = join(trialDir, 'verifier', 'skill_tracking.json');
    if (existsSync(trackingPath)) {
      try {
        const tracking = JSON.parse(readFileSync(trackingPath, 'utf-8'));
        if (tracking.samples?.length > 0) return tracking;
      } catch {}
    }

    const stdoutPath = join(trialDir, 'verifier', 'test-stdout.txt');
    if (existsSync(stdoutPath)) {
      try {
        const content = readFileSync(stdoutPath, 'utf-8');
        const reward = parseRewardFromStdout(content);
        if (reward?.tracking?.samples?.length > 0) return reward.tracking;
      } catch {}
    }
  }
  return null;
}

/** Extract final skill XP/level from reward.json or test-stdout.txt fallback */
function findRewardData(jobDir: string): { xp: number; level: number } | null {
  for (const trialDir of getTrialDirs(jobDir)) {
    const rewardPath = join(trialDir, 'verifier', 'reward.json');
    if (existsSync(rewardPath)) {
      try {
        const reward = JSON.parse(readFileSync(rewardPath, 'utf-8'));
        if (reward.xp !== undefined) return { xp: reward.xp, level: reward.level ?? 1 };
      } catch {}
    }

    const stdoutPath = join(trialDir, 'verifier', 'test-stdout.txt');
    if (existsSync(stdoutPath)) {
      try {
        const content = readFileSync(stdoutPath, 'utf-8');
        const stdoutReward = parseRewardFromStdout(content);
        if (stdoutReward?.xp !== undefined) return { xp: stdoutReward.xp, level: stdoutReward.level ?? 1 };
      } catch {}
    }
  }
  return null;
}

// ── Trajectory extraction ────────────────────────────────────────

interface TrajectoryStep {
  source: 'agent' | 'tool' | 'user';
  text: string;
}

function extractTrajectory(jobDir: string): { strategy: string; steps: TrajectoryStep[] } | null {
  for (const trialDir of getTrialDirs(jobDir)) {
    const agentDir = join(trialDir, 'agent');
    if (!existsSync(agentDir)) continue;

    const trajectoryPath = join(agentDir, 'trajectory.json');
    if (existsSync(trajectoryPath)) {
      try {
        const traj = JSON.parse(readFileSync(trajectoryPath, 'utf-8'));
        return parseClaudeTrajectory(traj);
      } catch {}
    }

    const codexPath = join(agentDir, 'codex.txt');
    if (existsSync(codexPath)) {
      try {
        return parseCodexLog(readFileSync(codexPath, 'utf-8'));
      } catch {}
    }

    const kimiPath = join(agentDir, 'opencode-kimi.txt');
    if (existsSync(kimiPath)) {
      try {
        return parseKimiLog(readFileSync(kimiPath, 'utf-8'));
      } catch {}
    }
  }
  return null;
}

function parseClaudeTrajectory(traj: any): { strategy: string; steps: TrajectoryStep[] } {
  const rawSteps = traj.steps || [];
  const steps: TrajectoryStep[] = [];
  const strategyParts: string[] = [];

  for (const step of rawSteps) {
    const src = step.source;
    const msg: string = step.message || '';
    if (!msg) continue;

    if (src === 'agent') {
      if (msg.startsWith('Executed ')) {
        const toolName = msg.replace('Executed ', '').split(' ')[0];
        steps.push({ source: 'tool', text: toolName });
      } else {
        steps.push({ source: 'agent', text: msg });
        if (strategyParts.length < 8) strategyParts.push(msg);
      }
    }
  }

  const strategy = strategyParts.join('\n\n').slice(0, 2000);
  return { strategy, steps: steps.slice(0, 200) };
}

function parseCodexLog(content: string): { strategy: string; steps: TrajectoryStep[] } {
  const steps: TrajectoryStep[] = [];
  const strategyParts: string[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'item.completed' && entry.item) {
        const item = entry.item;
        if (item.type === 'agent_message' && item.text) {
          steps.push({ source: 'agent', text: item.text });
          if (strategyParts.length < 8) strategyParts.push(item.text);
        } else if (item.type === 'reasoning' && item.text) {
          steps.push({ source: 'agent', text: item.text });
          if (strategyParts.length < 4) strategyParts.push(item.text);
        } else if (item.type === 'command_execution' && item.command) {
          steps.push({ source: 'tool', text: item.command });
        } else if (item.type === 'file_change') {
          steps.push({ source: 'tool', text: `file_change: ${item.filename || 'unknown'}` });
        }
      }
    } catch {}
  }

  const strategy = strategyParts.join('\n\n').slice(0, 2000);
  return { strategy, steps: steps.slice(0, 200) };
}

function parseKimiLog(content: string): { strategy: string; steps: TrajectoryStep[] } {
  const steps: TrajectoryStep[] = [];
  const strategyParts: string[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith('[kimi-loop]')) {
      steps.push({ source: 'agent', text: line });
      continue;
    }
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'text') {
        const text = entry.part?.content || '';
        if (text) {
          steps.push({ source: 'agent', text });
          if (strategyParts.length < 8) strategyParts.push(text);
        }
      } else if (entry.type === 'tool_use') {
        const tool = entry.part?.tool || '';
        const input = entry.part?.state?.input || {};
        if (tool === 'bash') {
          steps.push({ source: 'tool', text: `bash: ${input.command || ''}`.slice(0, 200) });
        } else if (tool === 'read') {
          steps.push({ source: 'tool', text: `read: ${input.filePath || ''}` });
        } else if (tool === 'write') {
          steps.push({ source: 'tool', text: `write: ${input.filePath || ''}` });
        } else if (tool) {
          steps.push({ source: 'tool', text: tool });
        }
      }
    } catch {}
  }

  const strategy = strategyParts.join('\n\n').slice(0, 2000);
  return { strategy, steps: steps.slice(0, 200) };
}

// ── Main ─────────────────────────────────────────────────────────

const { filter, explicitDirs } = parseCLIArgs(process.argv.slice(2));
const jobDirs = resolveJobDirs(JOBS_DIR, explicitDirs, filter, (name, f) => {
  const lower = name.toLowerCase();
  const isSkill30m = KNOWN_SKILLS.some(s => lower.startsWith(`${s}-xp-30m`));
  if (!isSkill30m) return false;
  return !f || lower.includes(f);
});

// Extract and group by model -> skill
const combined: Record<string, Record<string, {
  jobName: string;
  finalXp: number;
  finalLevel: number;
  durationSeconds: number;
  sampleCount: number;
  samples: Sample[];
  tokenUsage?: TokenUsage;
}>> = {};

let extracted = 0;

for (const dir of jobDirs) {
  const jobName = basename(dir);
  let model = detectModel(jobName, KNOWN_MODELS);
  if (model === 'unknown') model = detectModelFromConfig(dir, KNOWN_MODELS, {
    preMatch: (lower) => {
      if (lower.includes('gemini-3.1') || lower.includes('gemini-3_1')) return 'gemini31';
      return null;
    },
  });
  let skill = detectSkill(jobName);
  if (!skill) skill = detectSkillFromConfig(dir);

  if (model === 'unknown') {
    console.log(`  skip: ${jobName} (can't detect model)`);
    continue;
  }
  if (!skill) {
    console.log(`  skip: ${jobName} (can't detect skill)`);
    continue;
  }

  const tracking = findTracking(dir);
  const reward = findRewardData(dir);
  const tokenUsage = findTokenUsage(dir);
  const trajectory = extractTrajectory(dir);

  if (!tracking && !reward) {
    console.log(`  skip: ${jobName} (no tracking or reward data)`);
    continue;
  }

  const samples = tracking?.samples || [];
  const durationSeconds = samples.length > 0
    ? samples[samples.length - 1].elapsedMs / 1000
    : 0;

  const finalXp = reward?.xp ?? 0;
  const finalLevel = reward?.level ?? 1;

  if (!combined[model]) combined[model] = {};

  const existing = combined[model][skill];
  const shouldReplace = !existing
    || (samples.length > existing.sampleCount * 2)
    || (existing.sampleCount <= samples.length * 2 && finalXp > existing.finalXp);
  if (shouldReplace) {
    combined[model][skill] = {
      jobName,
      finalXp,
      finalLevel,
      durationSeconds,
      sampleCount: samples.length,
      samples,
      ...(tokenUsage ? { tokenUsage } : {}),
      ...(trajectory ? { strategy: trajectory.strategy, trajectory: trajectory.steps } : {}),
    };
  }

  const tokenStr = tokenUsage ? `, tokens: ${(tokenUsage.inputTokens / 1000).toFixed(0)}k in / ${(tokenUsage.outputTokens / 1000).toFixed(0)}k out` : '';
  console.log(`  ${model}/${skill}: ${jobName} — xp=${finalXp}, level=${finalLevel}, ${samples.length} samples${tokenStr}`);
  extracted++;
}

if (extracted === 0) {
  console.log('\nNo skill-xp-30m data found in any job directories.');
  process.exit(1);
}

writeResults(RESULTS_DIR, combined, 'COMBINED_DATA');
console.log(`\n${extracted} result(s) extracted. View: open views/graph-skills.html`);
