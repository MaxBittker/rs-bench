/**
 * Verification: report XP for a specific skill as reward, with tracking data.
 *
 * Hybrid of check_xp.ts (single-skill XP) and check_total_level.ts (tracking embed).
 * Reads SKILL_NAME env var, reports that skill's XP as reward.
 * Also reads skill_tracking.json and embeds time-series data in reward.json
 * so extract-skill-results.ts can find per-sample data.
 *
 * Writes to reward.json: { skill, xp, level, tracking }
 * Writes raw XP to reward.txt for Harbor compatibility.
 */
// @ts-ignore
import { BotSDK } from '/app/sdk/index';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';

const SKILL_NAME = process.env.SKILL_NAME;
if (!SKILL_NAME) {
    console.error('SKILL_NAME environment variable is required');
    process.exit(1);
}

// Check multiple locations for tracking data
const TRACKING_PATHS = [
    '/logs/tracking/skill_tracking.json',
    '/logs/verifier/skill_tracking.json',
];

async function main() {
    const sdk = new BotSDK({
        botUsername: 'agent',
        password: 'test',
        gatewayUrl: 'ws://localhost:7780',
        connectionMode: 'observe',
        autoLaunchBrowser: false,
        autoReconnect: false,
    });

    try {
        await sdk.connect();
        await sdk.waitForCondition(s => s.inGame && s.skills.length > 0, 15000);

        const skill = sdk.getSkill(SKILL_NAME as string);
        const level = skill?.level ?? 1;
        const xp = skill?.experience ?? 0;

        console.log(`${SKILL_NAME}: level ${level}, xp ${xp}`);

        mkdirSync('/logs/verifier', { recursive: true });

        // Read tracking data from whichever location the tracker used
        let trackingData: any = null;
        for (const trackingPath of TRACKING_PATHS) {
            if (existsSync(trackingPath)) {
                try {
                    trackingData = JSON.parse(readFileSync(trackingPath, 'utf-8')) as any;
                    console.log(`Tracking data: ${trackingData?.samples?.length ?? 0} samples (from ${trackingPath})`);
                    break;
                } catch (err) {
                    console.error(`Failed to read tracking data from ${trackingPath}:`, err);
                }
            }
        }
        if (!trackingData) {
            console.log('No tracking data file found in:', TRACKING_PATHS.join(', '));
        }

        const rewardObj = {
            skill: SKILL_NAME,
            xp,
            level,
            tracking: trackingData,
        };

        writeFileSync('/logs/verifier/reward.json', JSON.stringify(rewardObj, null, 2));
        writeFileSync('/logs/verifier/reward.txt', xp.toString());

        console.log(`Reward: xp=${xp}, level=${level}`);

        // Print reward JSON to stdout so it can be recovered from test-stdout.txt
        // even when Modal file downloads fail
        console.log(`__REWARD_JSON_START__`);
        console.log(JSON.stringify(rewardObj));
        console.log(`__REWARD_JSON_END__`);
    } finally {
        sdk.disconnect();
    }
}

main().catch(err => {
    console.error('Verification error:', err);
    try {
        mkdirSync('/logs/verifier', { recursive: true });
        writeFileSync('/logs/verifier/reward.txt', '0');
        writeFileSync('/logs/verifier/reward.json', JSON.stringify({
            skill: SKILL_NAME,
            xp: 0,
            level: 1,
            error: err.message,
        }));
    } catch {}
    process.exit(1);
});
