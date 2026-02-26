#!/usr/bin/env bun
/**
 * Fresh Run - Creates a fresh account, runs a script, reports combat level.
 *
 * Usage: bun /app/benchmark/shared/fresh_run.ts <script_path>
 *
 * Each invocation:
 * 1. Ensures game services are running
 * 2. Generates a unique username (fr001, fr002, ...)
 * 3. Launches browser client for new account
 * 4. Skips tutorial
 * 5. Starts background sampler (combat level time-series)
 * 6. Runs the provided script with 5-min timeout
 * 7. Reports combat level
 * 8. Appends to tracking file (with time-series samples)
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
// @ts-ignore - absolute path resolved inside Docker container
import { BotSDK } from '/app/sdk/index';

// ── Types ────────────────────────────────────────────────────────

interface SkillSnapshot { level: number; xp: number }
interface Sample {
    elapsedMs: number;
    combatLevel: number;
    skills: Record<string, SkillSnapshot>;
}

interface RunRecord {
    runId: number;
    username: string;
    combatLevel: number;
    skills: Record<string, SkillSnapshot>;
    samples: Sample[];
    scriptPath: string;
    scriptExitCode: number;
    durationMs: number;
    timestamp: string;
    error?: string;
}

interface TrackingData {
    runs: RunRecord[];
    bestCombatLevel: number;
    bestRunId: number;
}

// ── Parse args ───────────────────────────────────────────────────

const SCRIPT_PATH = process.argv[2];
if (!SCRIPT_PATH) {
    console.error('Usage: bun /app/benchmark/shared/fresh_run.ts <script_path>');
    console.error('');
    console.error('Creates a fresh account, runs the script (5 min max), reports combat level.');
    process.exit(1);
}

if (!existsSync(SCRIPT_PATH)) {
    console.error(`Script not found: ${SCRIPT_PATH}`);
    process.exit(1);
}

const SCRIPT_TIMEOUT_MS = parseInt(process.env.FRESH_RUN_TIMEOUT_MS || String(5 * 60 * 1000));
const SAMPLE_INTERVAL_MS = parseInt(process.env.SAMPLE_INTERVAL_MS || '10000');
const TRACKING_FILE = process.env.TRACKING_FILE || '/app/fresh_run_tracking.json';
const COUNTER_FILE = '/app/fresh_run_counter';
const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://localhost:7780';

// ── Ensure services are running ──────────────────────────────────

function waitForService(url: string, label: string, maxWaitMs = 60000): void {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        try {
            execSync(`curl -sf ${url}`, { timeout: 5000, stdio: 'ignore' });
            return;
        } catch {
            execSync('sleep 1', { stdio: 'ignore' });
        }
    }
    console.error(`[fresh-run] WARNING: ${label} not ready after ${maxWaitMs / 1000}s`);
}

try {
    execSync('curl -sf http://localhost:7780', { timeout: 5000, stdio: 'ignore' });
} catch {
    console.log('[fresh-run] Services not running, starting...');
    execSync('/ensure-services.sh', { timeout: 180000, stdio: 'inherit' });
}

// Also ensure the game engine (bot client server) is fully ready
waitForService('http://localhost:8888', 'Engine (port 8888)', 30000);

// ── Generate unique username ─────────────────────────────────────

let runId = 0;
try {
    runId = parseInt(readFileSync(COUNTER_FILE, 'utf-8').trim()) || 0;
} catch {}
runId++;
writeFileSync(COUNTER_FILE, String(runId));

// Max 12 chars, alphanumeric
const username = `fr${String(runId).padStart(3, '0')}`;

console.log(`\n${'━'.repeat(60)}`);
console.log(`  Fresh Run #${runId}`);
console.log(`  Username: ${username}`);
console.log(`  Script: ${SCRIPT_PATH}`);
console.log(`  Timeout: ${SCRIPT_TIMEOUT_MS / 1000}s`);
console.log(`${'━'.repeat(60)}\n`);

// ── Launch browser + skip tutorial (with retries) ───────────────

const MAX_LAUNCH_RETRIES = 3;
let botProcess: ChildProcess | null = null;

function launchBrowser(name: string): { process: ChildProcess; ready: Promise<boolean> } {
    const proc = spawn(
        'bun', ['run', '/app/server/gateway/launch-bot.ts'],
        {
            cwd: '/app/server/gateway',
            env: {
                ...process.env,
                BOT_NAME: name,
                BOT_PASSWORD: 'test',
                GATEWAY_URL: GATEWAY_URL,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        }
    );

    let output = '';
    const ready = new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
            console.error(`[fresh-run] WARNING: Browser launch timed out after 120s`);
            resolve(false);
        }, 120000);

        const check = (data: Buffer) => {
            const text = data.toString();
            output += text;
            process.stderr.write(data);

            if (output.includes('Tutorial complete') ||
                output.includes('Not on tutorial island')) {
                clearTimeout(timeout);
                resolve(true);
            }
        };

        proc.stdout?.on('data', check);
        proc.stderr?.on('data', check);
        proc.on('exit', (code) => {
            clearTimeout(timeout);
            if (!output.includes('Tutorial complete') &&
                !output.includes('Not on tutorial island')) {
                console.error(`[fresh-run] Browser exited early with code ${code}`);
                resolve(false);
            }
        });
    });

    return { process: proc, ready };
}

let botReady = false;
for (let attempt = 1; attempt <= MAX_LAUNCH_RETRIES; attempt++) {
    console.log(`[fresh-run] Launching browser for "${username}" (attempt ${attempt}/${MAX_LAUNCH_RETRIES})...`);

    const launch = launchBrowser(username);
    botReady = await launch.ready;

    if (botReady) {
        botProcess = launch.process;
        break;
    }

    // Kill failed process
    try { launch.process.kill('SIGTERM'); } catch {}
    await new Promise(r => setTimeout(r, 1000));
    try { launch.process.kill('SIGKILL'); } catch {}

    if (attempt < MAX_LAUNCH_RETRIES) {
        const delay = attempt * 5;
        console.log(`[fresh-run] Retry in ${delay}s...`);
        await new Promise(r => setTimeout(r, delay * 1000));
        // Re-check services before retry
        waitForService('http://localhost:8888', 'Engine (port 8888)', 15000);
    }
}

if (!botReady || !botProcess) {
    console.error(`[fresh-run] Failed to launch bot "${username}" after ${MAX_LAUNCH_RETRIES} attempts, aborting run`);
    appendTracking({
        runId,
        username,
        combatLevel: 0,
        skills: {},
        samples: [],
        scriptPath: SCRIPT_PATH,
        scriptExitCode: -1,
        durationMs: 0,
        timestamp: new Date().toISOString(),
        error: 'Browser launch failed',
    });
    process.exit(1);
}

// Small delay to let the bot fully settle after tutorial
await new Promise(r => setTimeout(r, 2000));

console.log(`[fresh-run] Bot "${username}" ready. Running script...\n`);

// ── Start background sampler ─────────────────────────────────────

const samples: Sample[] = [];
let samplerSdk: BotSDK | null = null;
let samplerInterval: ReturnType<typeof setInterval> | null = null;

const scriptStart = Date.now();

try {
    samplerSdk = new BotSDK({
        botUsername: username,
        password: 'test',
        gatewayUrl: GATEWAY_URL,
        connectionMode: 'observe',
        autoLaunchBrowser: false,
        autoReconnect: true,
    });

    await samplerSdk.connect();
    await samplerSdk.waitForCondition(
        (s: any) => s.inGame && s.skills.length > 0,
        15000
    );

    // Take initial sample
    takeSample(samplerSdk, samples, scriptStart);

    // Sample periodically
    samplerInterval = setInterval(() => {
        try { takeSample(samplerSdk!, samples, scriptStart); } catch {}
    }, SAMPLE_INTERVAL_MS);

    console.error(`[fresh-run] Background sampler started (every ${SAMPLE_INTERVAL_MS / 1000}s)`);
} catch (err: any) {
    console.error(`[fresh-run] Background sampler failed to start: ${err.message}`);
    // Non-fatal — we still get the final reading
}

// ── Run user's script ────────────────────────────────────────────

const scriptProcess = spawn(
    'bun', ['run', SCRIPT_PATH],
    {
        env: {
            ...process.env,
            BOT_USERNAME: username,
            PASSWORD: 'test',
            SERVER: 'localhost',
        },
        stdio: 'inherit',
    }
);

// Enforce hard timeout
const timeoutKill = setTimeout(() => {
    console.log(`\n[fresh-run] Script timeout (${SCRIPT_TIMEOUT_MS / 1000}s) - killing...`);
    scriptProcess.kill('SIGTERM');
    setTimeout(() => {
        try { scriptProcess.kill('SIGKILL'); } catch {}
    }, 5000);
}, SCRIPT_TIMEOUT_MS);

const scriptExitCode = await new Promise<number>((resolve) => {
    scriptProcess.on('exit', (code) => {
        clearTimeout(timeoutKill);
        resolve(code ?? 1);
    });
});

const scriptDuration = Date.now() - scriptStart;
console.log(`\n[fresh-run] Script exited (code=${scriptExitCode}, duration=${(scriptDuration / 1000).toFixed(1)}s)`);

// ── Stop sampler and take final reading ──────────────────────────

if (samplerInterval) clearInterval(samplerInterval);

// Take final sample
if (samplerSdk) {
    try { takeSample(samplerSdk, samples, scriptStart); } catch {}
}

// ── Read final combat level ──────────────────────────────────────

let combatLevel = 0;
let skills: Record<string, SkillSnapshot> = {};
let readError: string | undefined;

try {
    // Reuse sampler SDK if available, otherwise create new connection
    const sdk = samplerSdk || new BotSDK({
        botUsername: username,
        password: 'test',
        gatewayUrl: GATEWAY_URL,
        connectionMode: 'observe',
        autoLaunchBrowser: false,
        autoReconnect: false,
    });

    if (!samplerSdk) {
        await sdk.connect();
        await sdk.waitForCondition(
            (s: any) => s.inGame && s.skills.length > 0,
            15000
        );
    }

    const state = sdk.getState();
    combatLevel = state?.player?.combatLevel ?? 0;

    const allSkills = sdk.getSkills();
    if (allSkills) {
        for (const s of allSkills) {
            skills[s.name] = { level: s.baseLevel, xp: s.experience };
        }
    }

    sdk.disconnect();
    samplerSdk = null;
} catch (err: any) {
    readError = err.message;
    console.error(`[fresh-run] Failed to read combat level: ${err.message}`);
}

// Disconnect sampler if still connected
if (samplerSdk) {
    try { samplerSdk.disconnect(); } catch {}
}

// ── Kill browser ─────────────────────────────────────────────────

botProcess!.kill('SIGTERM');
await new Promise(r => setTimeout(r, 1000));
try { botProcess!.kill('SIGKILL'); } catch {}

// ── Update tracking ──────────────────────────────────────────────

const record: RunRecord = {
    runId,
    username,
    combatLevel,
    skills,
    samples,
    scriptPath: SCRIPT_PATH,
    scriptExitCode,
    durationMs: scriptDuration,
    timestamp: new Date().toISOString(),
    ...(readError ? { error: readError } : {}),
};

const tracking = appendTracking(record);

// ── Print summary ────────────────────────────────────────────────

console.log(`\n${'━'.repeat(60)}`);
console.log(`  Run #${runId} Complete`);
console.log(`  Combat Level: ${combatLevel}`);
console.log(`  Duration: ${(scriptDuration / 1000).toFixed(1)}s`);
console.log(`  Script Exit: ${scriptExitCode}`);
console.log(`  Samples: ${samples.length}`);

if (Object.keys(skills).length > 0) {
    const combatSkills = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic'];
    const skillStr = combatSkills
        .map(s => `${s}: ${skills[s]?.level ?? 1}`)
        .join(', ');
    console.log(`  Skills: ${skillStr}`);
}

console.log(`  Best so far: Combat Level ${tracking.bestCombatLevel} (run #${tracking.bestRunId})`);
console.log(`  Total runs: ${tracking.runs.length}`);
console.log(`${'━'.repeat(60)}\n`);

// ── Helpers ──────────────────────────────────────────────────────

function takeSample(sdk: BotSDK, samples: Sample[], startTime: number): void {
    const state = sdk.getState();
    if (!state?.player) return;

    const elapsedMs = Date.now() - startTime;
    const cl = state.player.combatLevel ?? 0;

    const skillSnap: Record<string, SkillSnapshot> = {};
    const allSkills = sdk.getSkills();
    if (allSkills) {
        for (const s of allSkills) {
            skillSnap[s.name] = { level: s.baseLevel, xp: s.experience };
        }
    }

    samples.push({ elapsedMs, combatLevel: cl, skills: skillSnap });
}

function appendTracking(record: RunRecord): TrackingData {
    let tracking: TrackingData = { runs: [], bestCombatLevel: 0, bestRunId: 0 };
    try {
        if (existsSync(TRACKING_FILE)) {
            tracking = JSON.parse(readFileSync(TRACKING_FILE, 'utf-8'));
        }
    } catch {}

    tracking.runs.push(record);

    if (record.combatLevel > tracking.bestCombatLevel) {
        tracking.bestCombatLevel = record.combatLevel;
        tracking.bestRunId = record.runId;
    }

    writeFileSync(TRACKING_FILE, JSON.stringify(tracking, null, 2));
    return tracking;
}
