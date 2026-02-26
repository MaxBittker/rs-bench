#!/usr/bin/env bun
/**
 * Extract gold benchmark results from Harbor job directories.
 *
 * Reads reward data (gold earned) + skill tracking from verifier outputs.
 * Outputs to results/gold/_data.js for the graph viewer.
 *
 * Usage:
 *   bun extractors/extract-gold-results.ts                    # Auto-discover gold jobs
 *   bun extractors/extract-gold-results.ts --filter gold-30m  # Filter by pattern
 */

import { readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import {
  type Sample, type TrackingData, type TokenUsage,
  detectModel, detectModelFromConfig, getTrialDirs,
  parseRewardFromStdout, findTokenUsage,
  parseCLIArgs, resolveJobDirs, writeResults,
} from '../shared/extract-utils';

const RESULTS_DIR = join(import.meta.dir, '..', 'results', 'gold');
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

interface GoldReward {
  gold: number;
  inventoryGold: number;
  bankGold: number;
  totalLevel?: number;
  tracking?: TrackingData;
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

function findGoldReward(jobDir: string): GoldReward | null {
  for (const trialDir of getTrialDirs(jobDir)) {
    const rewardPath = join(trialDir, 'verifier', 'reward.json');
    if (existsSync(rewardPath)) {
      try {
        const reward = JSON.parse(readFileSync(rewardPath, 'utf-8'));
        if (typeof reward.gold === 'number') return reward;
      } catch {}
    }

    const stdoutPath = join(trialDir, 'verifier', 'test-stdout.txt');
    if (existsSync(stdoutPath)) {
      try {
        const content = readFileSync(stdoutPath, 'utf-8');
        const reward = parseRewardFromStdout(content);
        if (reward && typeof reward.gold === 'number') return reward;
      } catch {}
    }
  }
  return null;
}

// ── Main ─────────────────────────────────────────────────────────

const { filter: userFilter, explicitDirs } = parseCLIArgs(process.argv.slice(2));
const filter = userFilter || 'gold';
const jobDirs = resolveJobDirs(JOBS_DIR, explicitDirs, filter);

const results: GoldResult[] = [];

for (const dir of jobDirs) {
  const jobName = basename(dir);
  let model = detectModel(jobName, KNOWN_MODELS);
  if (model === 'unknown') model = detectModelFromConfig(dir, KNOWN_MODELS);
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
      grouped[r.horizon][r.model] = r;
    } else if (!newHasBank && existingHasBank) {
      // keep existing bank-tracked run
    } else if (r.gold > existing.gold) {
      grouped[r.horizon][r.model] = r;
    }
  }
}

writeResults(RESULTS_DIR, grouped, 'GOLD_DATA');
console.log(`\n${results.length} result(s) extracted. View: open views/graph-gold.html`);
