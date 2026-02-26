/**
 * Verification: report raw XP for a given skill as reward.
 * Reads SKILL_NAME from environment variable.
 * Writes XP to reward.json: {"xp": <number>, "level": <number>}
 * Writes raw XP to reward.txt for Harbor compatibility.
 */
import { BotSDK } from '/app/sdk/index';
import { writeFileSync, mkdirSync } from 'fs';

const SKILL_NAME = process.env.SKILL_NAME;
if (!SKILL_NAME) {
    console.error('SKILL_NAME environment variable is required');
    process.exit(1);
}

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

        const skill = sdk.getSkill(SKILL_NAME);
        const level = skill?.level ?? 1;
        const xp = skill?.experience ?? 0;

        console.log(`${SKILL_NAME}: level ${level}, xp ${xp}`);

        mkdirSync('/logs/verifier', { recursive: true });

        writeFileSync('/logs/verifier/reward.json', JSON.stringify({ skill: SKILL_NAME, xp, level }));
        writeFileSync('/logs/verifier/reward.txt', xp.toString());

        console.log(`Reward: xp=${xp}, level=${level}`);
    } finally {
        sdk.disconnect();
    }
}

main().catch(err => {
    console.error('Verification error:', err);
    try {
        mkdirSync('/logs/verifier', { recursive: true });
        writeFileSync('/logs/verifier/reward.txt', '0');
        writeFileSync('/logs/verifier/reward.json', JSON.stringify({ skill: SKILL_NAME, xp: 0, level: 1, error: err.message }));
    } catch {}
    process.exit(1);
});
