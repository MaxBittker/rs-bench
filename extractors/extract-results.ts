#!/usr/bin/env bun
/**
 * Extract skill tracking data from Harbor job results for the graph viewer.
 *
 * Reads the structured tracking data written by skill_tracker.ts (via
 * reward.json), NOT agent logs. This is the reliable data source.
 *
 * Usage:
 *   bun extractors/extract-results.ts                          # Auto-discover all jobs/
 *   bun extractors/extract-results.ts jobs/total-level-10m-*   # Specific job dirs
 *   bun extractors/extract-results.ts --filter 10m-opus        # Filter by pattern
 *
 * Output:
 *   results/_combined.json   — all models, grouped by time horizon
 *   results/_data.js         — same data as JS var for the HTML viewer (file:// safe)
 */

import { readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import {
  type Sample, type TrackingData, type TokenUsage,
  detectModel, detectModelFromConfig, getTrialDirs,
  parseRewardFromStdout, findTokenUsage,
  parseCLIArgs, resolveJobDirs, writeResults,
} from '../shared/extract-utils';

const RESULTS_DIR = join(import.meta.dir, '..', 'results');
const JOBS_DIR = join(import.meta.dir, '..', 'jobs');

const KNOWN_MODELS = ['opus', 'sonnet46', 'sonnet45', 'haiku', 'codex', 'gemini', 'glm', 'kimi', 'qwen3'];

/** Detect time horizon from task path in config.json or directory name */
function detectTimeHorizon(dirName: string, jobDir: string): string {
  const lower = dirName.toLowerCase();
  const match = lower.match(/(\d+[mh])/);
  if (match) return match[1];

  const configPath = join(jobDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const taskPath = config?.tasks?.[0]?.path || '';
      const taskMatch = taskPath.match(/(\d+[mh])/);
      if (taskMatch) return taskMatch[1];
    } catch {}
  }
  return 'unknown';
}

/** Walk a job directory and find tracking data from reward.json or skill_tracking.json */
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

// ── Main ─────────────────────────────────────────────────────────

const { filter, explicitDirs } = parseCLIArgs(process.argv.slice(2));
const jobDirs = resolveJobDirs(JOBS_DIR, explicitDirs, filter);

// Extract and group by model + time horizon
const combined: Record<string, Record<string, {
  jobName: string;
  finalTotalLevel: number;
  durationSeconds: number;
  samples: Sample[];
  tokenUsage?: TokenUsage;
}>> = {};

let extracted = 0;

for (const dir of jobDirs) {
  const jobName = basename(dir);
  let model = detectModel(jobName, KNOWN_MODELS);
  if (model === 'unknown') model = detectModelFromConfig(dir, KNOWN_MODELS);
  const horizon = detectTimeHorizon(jobName, dir);
  if (model === 'unknown') {
    console.log(`  skip: ${jobName} (can't detect model)`);
    continue;
  }

  const tracking = findTracking(dir);
  if (!tracking || tracking.samples.length === 0) {
    console.log(`  skip: ${jobName} (no tracking data)`);
    continue;
  }

  const samples = tracking.samples;
  const last = samples[samples.length - 1];
  const finalLevel = last.totalLevel;
  const durationSeconds = last.elapsedMs / 1000;
  const tokenUsage = findTokenUsage(dir, { geminiTrajectoryFallback: true });

  if (!combined[model]) combined[model] = {};

  // Keep best run per model+horizon (highest final level)
  const existing = combined[model][horizon];
  if (!existing || finalLevel > existing.finalTotalLevel) {
    combined[model][horizon] = {
      jobName,
      finalTotalLevel: finalLevel,
      durationSeconds,
      samples,
      ...(tokenUsage ? { tokenUsage } : {}),
    };
  }

  const tokenStr = tokenUsage ? `, tokens: ${(tokenUsage.inputTokens / 1000).toFixed(0)}k in / ${(tokenUsage.outputTokens / 1000).toFixed(0)}k out` : '';
  console.log(`  ${model}/${horizon}: ${jobName} — ${samples.length} samples, final level ${finalLevel}${tokenStr}`);
  extracted++;
}

if (extracted === 0) {
  console.log('\nNo tracking data found in any job directories.');
  process.exit(1);
}

writeResults(RESULTS_DIR, combined, 'COMBINED_DATA');
console.log(`\n${extracted} result(s) extracted. View: open views/10m-comparison.html`);
