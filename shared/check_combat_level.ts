/**
 * Verification: report best combat level from fresh-run tracking data.
 *
 * Reads /app/fresh_run_tracking.json and reports the best combat level
 * achieved across all runs.
 *
 * Writes to reward.json: { combatLevel, bestRun, totalRuns, allRuns }
 * Writes raw combat level to reward.txt for Harbor compatibility.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';

const TRACKING_PATHS = [
    '/app/fresh_run_tracking.json',
    '/logs/verifier/fresh_run_tracking.json',
];

function main() {
    mkdirSync('/logs/verifier', { recursive: true });

    // Find tracking data
    let trackingData: any = null;
    for (const path of TRACKING_PATHS) {
        if (existsSync(path)) {
            try {
                trackingData = JSON.parse(readFileSync(path, 'utf-8'));
                console.log(`Tracking data found at ${path}: ${trackingData.runs?.length ?? 0} runs`);
                break;
            } catch (err) {
                console.error(`Failed to read tracking data from ${path}:`, err);
            }
        }
    }

    if (!trackingData || !trackingData.runs || trackingData.runs.length === 0) {
        console.log('No tracking data found — agent may not have completed any runs.');
        const emptyReward = { combatLevel: 0, totalRuns: 0, error: 'no tracking data found' };
        writeFileSync('/logs/verifier/reward.txt', '0');
        writeFileSync('/logs/verifier/reward.json', JSON.stringify(emptyReward, null, 2));
        console.log('__REWARD_JSON_START__');
        console.log(JSON.stringify(emptyReward));
        console.log('__REWARD_JSON_END__');
        process.exit(1);
    }

    // Find best run by combat level
    const bestRun = trackingData.runs.reduce((best: any, run: any) =>
        (run.combatLevel > (best?.combatLevel ?? 0)) ? run : best,
        null
    );

    const bestCombatLevel = bestRun?.combatLevel ?? 0;

    console.log(`\nBest combat level: ${bestCombatLevel} (run #${bestRun?.runId}, username: ${bestRun?.username})`);
    console.log(`Total runs: ${trackingData.runs.length}`);

    // Print all runs
    console.log('\nAll runs:');
    for (const run of trackingData.runs) {
        const combatSkills = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic'];
        const skillStr = combatSkills
            .map((s: string) => `${s.substring(0, 3)}:${run.skills?.[s]?.level ?? 1}`)
            .join(' ');
        const marker = run.runId === bestRun?.runId ? ' ★' : '';
        console.log(`  Run #${run.runId}: CL=${run.combatLevel} ${skillStr} (${(run.durationMs / 1000).toFixed(0)}s, exit=${run.scriptExitCode})${marker}`);
    }

    const rewardObj = {
        combatLevel: bestCombatLevel,
        bestRun,
        totalRuns: trackingData.runs.length,
        allRuns: trackingData.runs,
    };

    writeFileSync('/logs/verifier/reward.json', JSON.stringify(rewardObj, null, 2));
    writeFileSync('/logs/verifier/reward.txt', bestCombatLevel.toString());

    console.log(`\nReward: combatLevel=${bestCombatLevel}`);

    // Print reward JSON to stdout for recovery from test-stdout.txt
    console.log('__REWARD_JSON_START__');
    console.log(JSON.stringify(rewardObj));
    console.log('__REWARD_JSON_END__');
}

main();
