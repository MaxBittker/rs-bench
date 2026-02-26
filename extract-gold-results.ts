#!/usr/bin/env bun
/**
 * Extract gold benchmark results from Harbor job directories.
 *
 * Reads reward data (gold earned) + skill tracking from verifier outputs.
 * Outputs to benchmark/results/gold/_data.js for the graph viewer.
 *
 * Usage:
 *   bun benchmark/extract-gold-results.ts                    # Auto-discover gold jobs
 *   bun benchmark/extract-gold-results.ts --filter gold-30m  # Filter by pattern
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';

const RESULTS_DIR = join(import.meta.dir, 'results', 'gold');
const JOBS_DIR = join(import.meta.dir, '..', 'jobs');

const KNOWN_MODELS = ['opus', 'sonnet46', 'sonnet45', 'haiku', 'codex', 'gemini', 'glm', 'kimi'];

const MODEL_LABELS: Record<string, string> = {
  opus: 'Claude Opus 4.6',
  sonnet46: 'Claude Sonnet 4.6',
  sonnet45: 'Claude Sonnet 4.5',
  haiku: 'Claude Haiku 4.5',
  codex: 'GPT-5.3 Codex',
  gemini: 'Gemini 3 Pro',
  glm: 'GLM-5',
  kimi: 'Kimi K2.5',
};

interface Sample {
  timestamp: string;
  elapsedMs: number;
  skills: Record<string, { level: number; xp: number }>;
  totalLevel: number;
  gold?: number;
}

interface TrackingData {
  botName: string;
  startTime: string;
  samples: Sample[];
}

interface GoldReward {
  gold: number;
  inventoryGold: number;
  bankGold: number;
  totalLevel?: number;
  tracking?: TrackingData;
}

interface TokenUsage {
  inputTokens: number;
  cacheTokens: number;
  outputTokens: number;
}

interface GoldResult {
  model: string;
  modelLabel: string;
  jobName: string;
  gold: number;
  inventoryGold: number;
  bankGold: number;
  totalLevel: number;
  tracking: TrackingData | null;
  tokenUsage: TokenUsage | null;
  horizon: string;
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

function detectTimeHorizon(dirName: string, jobDir: string): string {
  const lower = dirName.toLowerCase();
  const match = lower.match(/gold-(\d+[mh])/);
  if (match) return match[1];
  const configPath = join(jobDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const taskPath = config?.tasks?.[0]?.path || '';
      const taskMatch = taskPath.match(/gold-(\d+[mh])/);
      if (taskMatch) return taskMatch[1];
    } catch {}
  }
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

function findGoldReward(jobDir: string): GoldReward | null {
  for (const trialDir of getTrialDirs(jobDir)) {
    // Primary: reward.json
    const rewardPath = join(trialDir, 'verifier', 'reward.json');
    if (existsSync(rewardPath)) {
      try {
        const reward = JSON.parse(readFileSync(rewardPath, 'utf-8'));
        if (typeof reward.gold === 'number') return reward;
      } catch {}
    }

    // Fallback: test-stdout.txt with __REWARD_JSON_START__/__REWARD_JSON_END__ markers
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
          if (typeof reward.gold === 'number') return reward;
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

// ── Main ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let filter = 'gold';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--filter' && args[i + 1]) {
    filter = args[++i];
  }
}

let jobDirs: string[];
if (existsSync(JOBS_DIR)) {
  jobDirs = readdirSync(JOBS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .filter(d => d.name.includes(filter))
    .map(d => join(JOBS_DIR, d.name));
} else {
  console.log('No jobs/ directory found.');
  process.exit(1);
}

if (jobDirs.length === 0) {
  console.log(`No job directories matching "${filter}" found.`);
  process.exit(1);
}

mkdirSync(RESULTS_DIR, { recursive: true });

const results: GoldResult[] = [];

for (const dir of jobDirs) {
  const jobName = basename(dir);
  let model = detectModel(jobName);
  if (model === 'unknown') model = detectModelFromConfig(dir);
  const horizon = detectTimeHorizon(jobName, dir);

  if (model === 'unknown') {
    console.log(`  skip: ${jobName} (can't detect model)`);
    continue;
  }

  const reward = findGoldReward(dir);
  if (!reward) {
    console.log(`  skip: ${jobName} (no gold reward data)`);
    continue;
  }

  const tokenUsage = findTokenUsage(dir);
  const tracking = reward.tracking || null;
  const nSamples = tracking?.samples?.length ?? 0;
  const tokenStr = tokenUsage
    ? `, tokens: ${(tokenUsage.inputTokens / 1000).toFixed(0)}k in / ${(tokenUsage.outputTokens / 1000).toFixed(0)}k out`
    : '';

  const result: GoldResult = {
    model,
    modelLabel: MODEL_LABELS[model] || model,
    jobName,
    gold: reward.gold,
    inventoryGold: reward.inventoryGold ?? 0,
    bankGold: reward.bankGold ?? 0,
    totalLevel: reward.totalLevel ?? 0,
    tracking,
    tokenUsage,
    horizon,
  };

  results.push(result);
  console.log(`  ${model}/${horizon}: ${reward.gold} gold (inv=${reward.inventoryGold}, bank=${reward.bankGold}), ${nSamples} samples${tokenStr}`);
}

if (results.length === 0) {
  console.log('\nNo gold results found.');
  process.exit(1);
}

function hasBankTracking(r: GoldResult): boolean {
  return r.tracking?.samples?.some(s => (s as any).bankGold != null) ?? false;
}

// Group by horizon, keep best per model+horizon.
// Prefer runs with bank tracking (v15+) over inventory-only runs, then highest gold.
const grouped: Record<string, Record<string, GoldResult>> = {};
for (const r of results) {
  if (!grouped[r.horizon]) grouped[r.horizon] = {};
  const existing = grouped[r.horizon][r.model];
  if (!existing) {
    grouped[r.horizon][r.model] = r;
  } else {
    const newHasBank = hasBankTracking(r);
    const existingHasBank = hasBankTracking(existing);
    if (newHasBank && !existingHasBank) {
      grouped[r.horizon][r.model] = r; // always prefer bank-tracked
    } else if (!newHasBank && existingHasBank) {
      // keep existing bank-tracked run
    } else if (r.gold > existing.gold) {
      grouped[r.horizon][r.model] = r; // same tracking quality, prefer higher gold
    }
  }
}

// Write output
const combinedPath = join(RESULTS_DIR, '_combined.json');
writeFileSync(combinedPath, JSON.stringify(grouped, null, 2));
console.log(`\nWrote ${combinedPath}`);

const dataJsPath = join(RESULTS_DIR, '_data.js');
writeFileSync(dataJsPath, `window.GOLD_DATA = ${JSON.stringify(grouped)};`);
console.log(`Wrote ${dataJsPath}`);

console.log(`\n${results.length} result(s) extracted. View: open benchmark/graph-gold.html`);
