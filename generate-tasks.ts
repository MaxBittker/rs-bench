/**
 * Generates all benchmark task directories for Harbor.
 *
 * Standard tasks: 16 skills × max XP in 10 minutes
 * Variants: 16 skill-xp-30m tasks, 6 total-level tasks (5m through 3h)
 *
 * All generated output is gitignored — run this before `harbor run`.
 *
 * Usage: bun benchmark/generate-tasks.ts
 */
import { mkdirSync, writeFileSync, copyFileSync } from 'fs';
import { join } from 'path';

const BENCHMARK_DIR = join(import.meta.dir);
const TASKS_DIR = join(BENCHMARK_DIR, 'tasks');
const SHARED_DIR = join(BENCHMARK_DIR, 'shared');

const DOCKER_IMAGE = 'ghcr.io/maxbittker/rs-agent-benchmark:v17';
const DEFAULT_AGENT_TIMEOUT = 600; // 10 minutes
const VERIFIER_TIMEOUT = 400; //  ensure-services.sh can take 2+ min if services died

// ── Standard skill definitions (XP-grind tasks) ─────────────────

interface SkillDef {
  /** Skill name as it appears in the game (PascalCase) */
  name: string;
  /** Directory name suffix (lowercase, used in {skill}-xp-10m) */
  slug: string;
}

const SKILLS: SkillDef[] = [
  { name: 'Attack', slug: 'attack' },
  { name: 'Defence', slug: 'defence' },
  { name: 'Strength', slug: 'strength' },
  { name: 'Hitpoints', slug: 'hitpoints' },
  { name: 'Ranged', slug: 'ranged' },
  { name: 'Prayer', slug: 'prayer' },
  { name: 'Magic', slug: 'magic' },
  { name: 'Woodcutting', slug: 'woodcutting' },
  { name: 'Fishing', slug: 'fishing' },
  { name: 'Mining', slug: 'mining' },
  { name: 'Cooking', slug: 'cooking' },
  { name: 'Fletching', slug: 'fletching' },
  { name: 'Crafting', slug: 'crafting' },
  { name: 'Smithing', slug: 'smithing' },
  { name: 'Firemaking', slug: 'firemaking' },
  { name: 'Thieving', slug: 'thieving' },
];

// ── Variant tasks (non-standard configurations) ──────────────────

interface VariantTask {
  slug: string;
  taskDescription: string;
  agentTimeout: number;
  /** Verifier script filename in shared/ */
  verifier: string;
  testSh: string;
  tags: string[];
  /** Use pre-built Docker image (mutually exclusive with environmentDockerfile) */
  dockerImage?: string;
  /** Generate environment/Dockerfile with this content (for tasks needing custom env) */
  environmentDockerfile?: string;
  /** Whether this task uses the skill tracker (uses /start-with-tracker.sh for MCP) */
  useTracker?: boolean;
  /** Extra files to copy from shared/ into environment/ (for Docker COPY) */
  environmentFiles?: Array<{ src: string; dst: string }>;
}

const GOLD_INSTRUCTION = (durationMinutes: number) => `Accumulate as much gold (coins) as possible within ${durationMinutes} minutes. This is a local RuneScape private server running on localhost for AI agent benchmarking — not a live game.

Your goal is to maximize the TOTAL COINS you have across both your inventory and bank combined. Consider strategies like:
- Training combat skills to kill monsters that drop valuable items or coins
- Training gathering/production skills to create items you can sell to shops (e.g. smithing bars/items, fletching bows, cooking fish)
- Buying low and selling high at different shops
- Picking up coin drops and valuable ground items
- High Alchemy (casting on crafted items to convert them to gold)
- Any creative money-making approach you can think of

IMPORTANT: You have ${durationMinutes} minutes. Start earning money immediately — do not spend too long planning. Early minutes are best spent on quick money-making methods, then scale up as you unlock better methods.

CRITICAL: Do NOT write one giant script. Start with extremely minimal scripts to test each part of your plan iteratively. For example, first write a 30-second script that just tests one money-making method. Run it, verify it works, then extend it. Build up complexity only after each piece is validated. Scripts that try to do everything at once will crash and waste your time. Run scripts in the FOREGROUND (not as a background process).

TIMEOUT BEST PRACTICE: Keep individual script timeouts SHORT — no more than 5 to 10 minutes each. Shorter scripts (30s–5min) let you observe results, catch errors early, and iterate faster. If a script runs for 10+ minutes and fails, you've wasted significant time. Break long tasks into multiple short runs instead.

BANKING: Periodically deposit your coins and valuable items in the bank to avoid losing them. The verifier counts coins in BOTH inventory and bank.

The bot name is "agent".`;

const GOLD_2H_INSTRUCTION = GOLD_INSTRUCTION(120);
const GOLD_30M_INSTRUCTION = GOLD_INSTRUCTION(30);
const GOLD_15M_INSTRUCTION = GOLD_INSTRUCTION(15);

const COMBAT_LEVEL_INSTRUCTION = `Maximize your combat level within 30 minutes by writing and iterating on combat training scripts. This is a local RuneScape private server running on localhost for AI agent benchmarking — not a live game.

IMPORTANT — FRESH ACCOUNT EACH RUN:
- Each script run starts from a FRESH ACCOUNT (new character, all stats at default)
- Each script run has a maximum timeout of 5 minutes
- Your score is the BEST combat level achieved in any single run
- You can run as many attempts as you want within the 30-minute time limit

WORKFLOW:
1. Read the CLAUDE.md and learnings/ folder for tips (especially learnings/combat.md)
2. Write a combat training script (e.g., /app/combat.ts)
3. Run it with: bun /app/benchmark/shared/fresh_run.ts /app/combat.ts
4. Observe the results — combat level, skill levels, errors
5. Iterate on your script and run again
6. Each run creates a FRESH account and reports the combat level achieved

SCRIPT FORMAT:
Your script should use the standard runScript API:

\`\`\`typescript
import { runScript } from '/app/sdk/runner';

await runScript(async ({ bot, sdk, log }) => {
    // Your combat training logic here
    // The bot starts at Lumbridge with all skills at level 1 (except 10 Hitpoints)
    // Combat level starts at 3
}, { timeout: 4.5 * 60_000 }); // Stay well under the 5-min hard limit
\`\`\`

COMBAT LEVEL FORMULA:
Combat level = floor(base + max(melee, range, magic))
- base = 0.25 * (Defence + Hitpoints + floor(Prayer/2))
- melee = 0.325 * (Attack + Strength)
- range = 0.325 * (floor(Ranged/2) + Ranged)
- magic = 0.325 * (floor(Magic/2) + Magic)

Starting stats: All level 1 except Hitpoints = 10. Starting combat level = 3.

STRATEGY TIPS:
- The game runs at 8x speed, so 5 real minutes ≈ 40 game minutes
- Melee is simplest: train Attack + Strength by killing NPCs. Hitpoints trains automatically.
- Kill chickens (very weak, near Lumbridge) first to test, then move to stronger monsters for faster XP
- Cows and goblins give good early XP
- Each script starts fresh — your code must be self-contained and handle everything from a new character
- Focus on making your script RELIABLE first, then optimize for speed
- If a run errors out, you get combat level 0 — reliability matters more than aggression

The bot name is "agent".`;

const FRESH_RUN_DOCKERFILE = `FROM ${DOCKER_IMAGE}
COPY fresh_run.ts /app/benchmark/shared/fresh_run.ts
`;

const TOTAL_LEVEL_INSTRUCTION = (durationMinutes: number) => `Holistically improve this RuneScape private server account to achieve the highest possible total level within ${durationMinutes} minutes. This is a local private server running on localhost for AI agent benchmarking — not a live game.

Your goal is to maximize the TOTAL LEVEL of the account — the sum of all individual skill levels. You should strategically choose which skills to train based on what's most efficient to level up. Consider:
- Which skills are fastest to level at low levels
- Resource availability near your current location
- Combining skills that complement each other (e.g. woodcutting + firemaking, fishing + cooking, mining + smithing)
- Moving between different training spots as needed

STRATEGY TIP — Variety beats depth: The first 10–20 levels of any skill are extremely fast (often just minutes each). You will almost always score higher by training many different skills to low levels than by grinding one skill deep. For example, getting 10 skills from level 1 to level 15 is far more total levels than getting one skill from 1 to 50. Start a new skill whenever the current one starts feeling slow.

IMPORTANT: You have ${durationMinutes} minutes. Plan your time wisely and keep training continuously. Do not spend too long planning — start training immediately and adapt as you go.

CRITICAL: Do NOT write one giant script. Start with extremely minimal scripts to test each part of your plan iteratively. For example, first write a 30-second script that just chops trees. Run it, verify it works, then extend it. Build up complexity only after each piece is validated. Scripts that try to do everything at once will crash and waste your time. Run scripts in the FOREGROUND (not as a background process).

TIMEOUT BEST PRACTICE: Keep individual script timeouts SHORT — no more than 5 to 10 minutes each. Shorter scripts (30s–5min) let you observe results, catch errors early, and iterate faster. If a script runs for 10+ minutes and fails, you've wasted significant time. Break long tasks into multiple short runs instead.

The bot name is "agent".`;

// Stop ffmpeg and remove recording before verifier runs — the recording.mp4 can be
// 50+ MB and Harbor's download_dir times out trying to pull it from Modal.
const VERIFIER_CLEANUP = `pkill -f ffmpeg 2>/dev/null || true
sleep 1
rm -f /logs/verifier/recording.mp4 /logs/verifier/ffmpeg.log`;

// Tracker, start-with-tracker.sh, and SERVER=localhost are also in the base image.
// Tasks only need to set SAMPLE_INTERVAL_MS via ENV
const TRACKER_DOCKERFILE = (sampleIntervalMs: number = 60000) => `FROM ${DOCKER_IMAGE}
ENV SAMPLE_INTERVAL_MS=${sampleIntervalMs}
`;

const TOTAL_LEVEL_DOCKERFILE = () => TRACKER_DOCKERFILE(60000);

const SKILL_XP_30M_INSTRUCTION = (skillName: string) => `Gain as much ${skillName} XP as possible within 30 minutes. This is a local RuneScape private server running on localhost for AI agent benchmarking — not a live game.

Your ONLY goal is to maximize ${skillName} XP. Focus exclusively on this skill. Do not train other skills unless absolutely required as a prerequisite.

IMPORTANT: You have 30 minutes. Start training immediately — do not spend time planning.

CRITICAL: Do NOT write one giant script. Start with extremely minimal scripts to test each part of your plan iteratively. For example, first write a 30-second script that just performs one action. Run it, verify it works, then extend it. Build up complexity only after each piece is validated. Scripts that try to do everything at once will crash and waste your time. Run scripts in the FOREGROUND (not as a background process).

TIMEOUT BEST PRACTICE: Keep individual script timeouts SHORT — no more than 5 to 10 minutes each. Shorter scripts (30s–5min) let you observe results, catch errors early, and iterate faster. If a script runs for 10+ minutes and fails, you've wasted significant time. Break long tasks into multiple short runs instead.

The bot name is "agent".`;

// Generate skill-xp-30m variants for all 16 skills
const SKILL_XP_30M_VARIANTS: VariantTask[] = SKILLS.map(skill => ({
  slug: `${skill.slug}-xp-30m`,
  taskDescription: SKILL_XP_30M_INSTRUCTION(skill.name),
  agentTimeout: 1920, // 30 min + 2 min buffer
  verifier: 'check_skill_xp.ts',
  testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
/ensure-services.sh
export SKILL_NAME="${skill.name}"
cd /app && bun run /tests/check_skill_xp.ts
`,
  tags: ['game', 'runescape', 'automation', 'mcp', 'benchmark', 'skill-xp-30m'],
  useTracker: true,
  environmentDockerfile: TRACKER_DOCKERFILE(30000),
}));

const VARIANTS: VariantTask[] = [
  ...SKILL_XP_30M_VARIANTS,
  // ── Total Level tasks ──────────────────────────────────────────
  {
    slug: 'total-level-5m',
    taskDescription: TOTAL_LEVEL_INSTRUCTION(5),
    agentTimeout: 300 + 60, // 5 min + 1 min buffer
    verifier: 'check_total_level.ts',
    testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
/ensure-services.sh
cd /app && bun run /tests/check_total_level.ts
`,
    tags: ['game', 'runescape', 'automation', 'mcp', 'benchmark', 'total-level'],
    useTracker: true,
    environmentDockerfile: TOTAL_LEVEL_DOCKERFILE(),
  },
  {
    slug: 'total-level-8m',
    taskDescription: TOTAL_LEVEL_INSTRUCTION(8),
    agentTimeout: 480 + 60, // 8 min + 1 min buffer for agent to wrap up
    verifier: 'check_total_level.ts',
    testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
/ensure-services.sh
cd /app && bun run /tests/check_total_level.ts
`,
    tags: ['game', 'runescape', 'automation', 'mcp', 'benchmark', 'total-level'],
    useTracker: true,
    environmentDockerfile: TOTAL_LEVEL_DOCKERFILE(),
  },
  {
    slug: 'total-level-10m',
    taskDescription: TOTAL_LEVEL_INSTRUCTION(10),
    agentTimeout: 600 + 60, // 10 min + 1 min buffer
    verifier: 'check_total_level.ts',
    testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
/ensure-services.sh
cd /app && bun run /tests/check_total_level.ts
`,
    tags: ['game', 'runescape', 'automation', 'mcp', 'benchmark', 'total-level'],
    useTracker: true,
    environmentDockerfile: TOTAL_LEVEL_DOCKERFILE(),
  },
  {
    slug: 'total-level-30m',
    taskDescription: TOTAL_LEVEL_INSTRUCTION(30),
    agentTimeout: 1800 + 120, // 30 min + 2 min buffer
    verifier: 'check_total_level.ts',
    testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
/ensure-services.sh
cd /app && bun run /tests/check_total_level.ts
`,
    tags: ['game', 'runescape', 'automation', 'mcp', 'benchmark', 'total-level'],
    useTracker: true,
    environmentDockerfile: TOTAL_LEVEL_DOCKERFILE(),
  },
  {
    slug: 'total-level-1h',
    taskDescription: TOTAL_LEVEL_INSTRUCTION(60),
    agentTimeout: 3600 + 120, // 60 min + 2 min buffer
    verifier: 'check_total_level.ts',
    testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
/ensure-services.sh
cd /app && bun run /tests/check_total_level.ts
`,
    tags: ['game', 'runescape', 'automation', 'mcp', 'benchmark', 'total-level'],
    useTracker: true,
    environmentDockerfile: TOTAL_LEVEL_DOCKERFILE(),
  },
  {
    slug: 'total-level-3h',
    taskDescription: TOTAL_LEVEL_INSTRUCTION(180),
    agentTimeout: 10800 + 180, // 3 hr + 3 min buffer
    verifier: 'check_total_level.ts',
    testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
/ensure-services.sh
cd /app && bun run /tests/check_total_level.ts
`,
    tags: ['game', 'runescape', 'automation', 'mcp', 'benchmark', 'total-level'],
    useTracker: true,
    environmentDockerfile: TOTAL_LEVEL_DOCKERFILE(),
  },
  // ── Gold accumulation tasks ─────────────────────────────────────
  {
    slug: 'gold-15m',
    taskDescription: GOLD_15M_INSTRUCTION,
    agentTimeout: 900 + 120, // 15 min + 2 min buffer
    verifier: 'check_gold.ts',
    testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
cd /app && bun run /tests/check_gold.ts
`,
    tags: ['game', 'runescape', 'automation', 'mcp', 'benchmark', 'gold'],
    useTracker: true,
    environmentDockerfile: TRACKER_DOCKERFILE(30000),
  },
  {
    slug: 'gold-30m',
    taskDescription: GOLD_30M_INSTRUCTION,
    agentTimeout: 1800 + 120, // 30 min + 2 min buffer
    verifier: 'check_gold.ts',
    testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
cd /app && bun run /tests/check_gold.ts
`,
    tags: ['game', 'runescape', 'automation', 'mcp', 'benchmark', 'gold'],
    useTracker: true,
    environmentDockerfile: TRACKER_DOCKERFILE(30000),
  },
  {
    slug: 'gold-2h',
    taskDescription: GOLD_2H_INSTRUCTION,
    agentTimeout: 7200 + 180, // 2 hr + 3 min buffer
    verifier: 'check_gold.ts',
    testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
cd /app && bun run /tests/check_gold.ts
`,
    tags: ['game', 'runescape', 'automation', 'mcp', 'benchmark', 'gold'],
    useTracker: true,
    environmentDockerfile: TRACKER_DOCKERFILE(60000),
  },
  // ── Combat Level (fresh-run) tasks ──────────────────────────────
  {
    slug: 'combat-level-30m',
    taskDescription: COMBAT_LEVEL_INSTRUCTION,
    agentTimeout: 1800 + 120, // 30 min + 2 min buffer
    verifier: 'check_combat_level.ts',
    testSh: `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
cd /app && bun run /tests/check_combat_level.ts
`,
    tags: ['game', 'runescape', 'combat', 'benchmark', 'fresh-run'],
    environmentDockerfile: FRESH_RUN_DOCKERFILE,
    environmentFiles: [{ src: 'fresh_run.ts', dst: 'fresh_run.ts' }],
  },
];

// ── Template generators ──────────────────────────────────────────

function generateSkillTaskToml(): string {
  return `version = "1.0"

[metadata]
author_name = "Sean Lee"
difficulty = "medium"
category = "agent"
tags = ["game", "runescape", "automation", "mcp", "benchmark", "xp-grind"]

[verifier]
timeout_sec = ${VERIFIER_TIMEOUT}.0

[agent]
timeout_sec = ${DEFAULT_AGENT_TIMEOUT}.0

[environment]
cpus = 2
memory_mb = 4096
storage_mb = 10240
allow_internet = true

[[environment.mcp_servers]]
name = "rs-agent"
transport = "stdio"
command = "bash"
args = ["-c", "/start-services.sh && cd /app && bun run mcp/server.ts"]
`;
}

function generateVariantTaskToml(v: VariantTask): string {
  const tagsStr = v.tags.map(t => `"${t}"`).join(', ');

  // Tracker is started by entrypoint.sh / start-services.sh (infrastructure concern),
  // so all tasks use the same MCP command regardless of useTracker flag.
  const mcpCommand = '/start-services.sh && cd /app && bun run mcp/server.ts';

  return `version = "1.0"

[metadata]
author_name = "Sean Lee"
difficulty = "medium"
category = "agent"
tags = [${tagsStr}]

[verifier]
timeout_sec = ${VERIFIER_TIMEOUT}.0

[agent]
timeout_sec = ${v.agentTimeout}.0

[environment]
cpus = 2
memory_mb = 4096
storage_mb = 10240
allow_internet = true

[[environment.mcp_servers]]
name = "rs-agent"
transport = "stdio"
command = "bash"
args = ["-c", "${mcpCommand}"]
`;
}

function generateTaskDescription(skill: SkillDef): string {
  return `Gain as much ${skill.name} XP as possible within the time limit. The bot name is "agent".`;
}

function generateTestSh(skill: SkillDef): string {
  return `#!/bin/bash
set -e
mkdir -p /logs/verifier
${VERIFIER_CLEANUP}
/ensure-services.sh
export SKILL_NAME="${skill.name}"
cd /app && bun run /tests/check_xp.ts
`;
}

// ── Main ─────────────────────────────────────────────────────────

console.log(`Generating ${SKILLS.length} standard + ${VARIANTS.length} variant benchmark tasks...`);

mkdirSync(TASKS_DIR, { recursive: true });

// Standard XP-grind tasks (all share identical task.toml)
const skillToml = generateSkillTaskToml();

for (const skill of SKILLS) {
  const taskDir = join(TASKS_DIR, `${skill.slug}-xp-10m`);
  const testsDir = join(taskDir, 'tests');

  console.log(`  tasks/${skill.slug}-xp-10m/ (${skill.name})`);

  mkdirSync(testsDir, { recursive: true });

  // Dockerfile for cloud providers that don't support docker_image.
  // Just pulls the pre-built image — no additional build steps needed.
  const envDir = join(taskDir, 'environment');
  mkdirSync(envDir, { recursive: true });
  writeFileSync(join(envDir, 'Dockerfile'), `FROM ${DOCKER_IMAGE}\n`);

  writeFileSync(join(taskDir, 'task.toml'), skillToml);
  writeFileSync(join(taskDir, 'instruction.md'), generateTaskDescription(skill));
  writeFileSync(join(testsDir, 'test.sh'), generateTestSh(skill));
  copyFileSync(join(SHARED_DIR, 'check_xp.ts'), join(testsDir, 'check_xp.ts'));
}

// Variant tasks
for (const variant of VARIANTS) {
  const taskDir = join(TASKS_DIR, variant.slug);
  const testsDir = join(taskDir, 'tests');

  console.log(`  tasks/${variant.slug}/`);

  mkdirSync(testsDir, { recursive: true });
  writeFileSync(join(taskDir, 'task.toml'), generateVariantTaskToml(variant));
  writeFileSync(join(taskDir, 'instruction.md'), variant.taskDescription);
  writeFileSync(join(testsDir, 'test.sh'), variant.testSh);
  copyFileSync(
    join(SHARED_DIR, variant.verifier),
    join(testsDir, variant.verifier),
  );

  // Dockerfile for cloud providers — either custom env or
  // a thin FROM layer on the pre-built image.
  const envDir = join(taskDir, 'environment');
  mkdirSync(envDir, { recursive: true });
  writeFileSync(
    join(envDir, 'Dockerfile'),
    variant.environmentDockerfile ?? `FROM ${DOCKER_IMAGE}\n`,
  );

  // Copy extra files into environment/ for Docker build context
  if (variant.environmentFiles) {
    for (const file of variant.environmentFiles) {
      copyFileSync(
        join(SHARED_DIR, file.src),
        join(envDir, file.dst),
      );
    }
  }

}

console.log(`\nDone! Generated ${SKILLS.length + VARIANTS.length} task directories.`);
console.log(`\nTo build the shared Docker image:`);
console.log(`  cd benchmark/docker && ./build.sh`);
