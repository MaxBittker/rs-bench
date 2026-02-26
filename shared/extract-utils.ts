/**
 * Shared utilities for extract-results scripts.
 *
 * Contains common functions duplicated across:
 *   - extract-results.ts (10m total-level)
 *   - extract-skill-results.ts (30m per-skill)
 *   - extract-gold-results.ts (gold benchmarks)
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';

// ── Shared interfaces ────────────────────────────────────────────

export interface Sample {
  timestamp: string;
  elapsedMs: number;
  skills: Record<string, { level: number; xp: number }>;
  totalLevel: number;
  gold?: number;
}

export interface TrackingData {
  botName: string;
  startTime: string;
  samples: Sample[];
}

export interface TokenUsage {
  inputTokens: number;
  cacheTokens: number;
  outputTokens: number;
}

// ── Model detection ──────────────────────────────────────────────

/** Detect model from directory name by scanning for known model slugs */
export function detectModel(dirName: string, knownModels: string[]): string {
  const lower = dirName.toLowerCase();
  for (const m of knownModels) {
    if (lower.includes(`-${m}-`) || lower.endsWith(`-${m}`)) return m;
  }
  return 'unknown';
}

/**
 * Detect model from config.json when directory name doesn't contain it.
 * @param preMatch - optional callback to check model name before iterating KNOWN_MODELS
 *                   (e.g. for gemini31 special case)
 */
export function detectModelFromConfig(
  jobDir: string,
  knownModels: string[],
  opts?: { preMatch?: (lower: string) => string | null },
): string {
  const configPath = join(jobDir, 'config.json');
  if (!existsSync(configPath)) return 'unknown';
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const modelName = config?.agents?.[0]?.model_name || '';
    const lower = modelName.toLowerCase();

    // Pre-match hook (e.g. gemini31 before gemini)
    if (opts?.preMatch) {
      const result = opts.preMatch(lower);
      if (result) return result;
    }

    for (const m of knownModels) {
      if (lower.includes(m)) return m;
    }

    // Also check agent name for non-Claude agents
    const agentName = config?.agents?.[0]?.name || '';
    if (agentName.includes('codex')) return 'codex';
    if (agentName.includes('gemini')) return 'gemini';
    if (agentName.includes('kimi') || agentName.includes('opencode')) return 'kimi';
  } catch {}
  return 'unknown';
}

// ── Trial directory discovery ────────────────────────────────────

/** Get all trial directories (handles both flat and timestamp-nested layouts) */
export function getTrialDirs(jobDir: string): string[] {
  const trials: string[] = [];
  const entries = readdirSync(jobDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const subDir = join(jobDir, entry.name);

    // Check if this directory IS a trial (has verifier/ or agent/)
    if (existsSync(join(subDir, 'verifier')) || existsSync(join(subDir, 'agent'))) {
      trials.push(subDir);
    } else {
      // Might be a timestamp directory — check one level deeper
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

// ── Reward parsing ───────────────────────────────────────────────

/** Parse reward JSON embedded in file content via __REWARD_JSON_START__/__REWARD_JSON_END__ markers */
export function parseRewardFromStdout(content: string): any | null {
  const startMarker = '__REWARD_JSON_START__';
  const endMarker = '__REWARD_JSON_END__';
  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) return null;
  try {
    return JSON.parse(content.slice(startIdx + startMarker.length, endIdx).trim());
  } catch {}
  return null;
}

// ── Token usage extraction ───────────────────────────────────────

/** Sum per-message tokens from a Gemini CLI trajectory file */
function parseGeminiTrajectory(trajectoryPath: string): TokenUsage | null {
  try {
    const traj = JSON.parse(readFileSync(trajectoryPath, 'utf-8'));
    const messages = traj.messages;
    if (!Array.isArray(messages) || messages.length === 0) return null;

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheTokens = 0;

    for (const msg of messages) {
      const t = msg.tokens;
      if (!t) continue;
      inputTokens += (t.input || 0) + (t.tool || 0);
      outputTokens += (t.output || 0) + (t.thoughts || 0);
      cacheTokens += t.cached || 0;
    }

    if (inputTokens > 0 || outputTokens > 0) {
      return { inputTokens, cacheTokens, outputTokens };
    }
  } catch {}
  return null;
}

/**
 * Extract token usage from trial result.json.
 * @param geminiTrajectoryFallback - if true, check for Gemini CLI trajectory file as fallback
 */
export function findTokenUsage(jobDir: string, opts?: { geminiTrajectoryFallback?: boolean }): TokenUsage | null {
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

    // Fallback: parse Gemini CLI trajectory for per-message token counts
    if (opts?.geminiTrajectoryFallback) {
      const geminiTraj = join(trialDir, 'agent', 'gemini-cli.trajectory.json');
      if (existsSync(geminiTraj)) {
        const usage = parseGeminiTrajectory(geminiTraj);
        if (usage) return usage;
      }
    }
  }
  return null;
}

// ── CLI argument parsing ─────────────────────────────────────────

/** Parse common CLI args: --filter <pattern> and positional directories */
export function parseCLIArgs(args: string[]): { filter: string; explicitDirs: string[] } {
  let filter = '';
  const explicitDirs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--filter' && args[i + 1]) {
      filter = args[++i];
    } else {
      explicitDirs.push(args[i]);
    }
  }

  return { filter, explicitDirs };
}

// ── Job directory resolution ─────────────────────────────────────

/**
 * Resolve job directories from explicit paths or by scanning jobsDir.
 * @param dirFilter - callback to filter directory entries (receives DirEntry name)
 */
export function resolveJobDirs(
  jobsDir: string,
  explicitDirs: string[],
  filter: string,
  dirFilter?: (name: string, filter: string) => boolean,
): string[] {
  if (explicitDirs.length > 0) {
    return explicitDirs.map(d => d.startsWith('/') ? d : join(process.cwd(), d));
  }

  if (!existsSync(jobsDir)) {
    console.log('No jobs/ directory found. Pass job directories as arguments.');
    process.exit(1);
  }

  const dirs = readdirSync(jobsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .filter(d => {
      if (dirFilter) return dirFilter(d.name, filter);
      return !filter || d.name.includes(filter);
    })
    .map(d => join(jobsDir, d.name));

  if (dirs.length === 0) {
    console.log('No matching job directories found.');
    process.exit(1);
  }

  return dirs;
}

// ── Output writing ───────────────────────────────────────────────

/** Write _combined.json and _data.js (for HTML viewer file:// usage) */
export function writeResults(resultsDir: string, data: any, windowVarName: string): void {
  mkdirSync(resultsDir, { recursive: true });

  const combinedPath = join(resultsDir, '_combined.json');
  writeFileSync(combinedPath, JSON.stringify(data, null, 2));
  console.log(`\nWrote ${combinedPath}`);

  const dataJsPath = join(resultsDir, '_data.js');
  writeFileSync(dataJsPath, `window.${windowVarName} = ${JSON.stringify(data)};`);
  console.log(`Wrote ${dataJsPath}`);
}
