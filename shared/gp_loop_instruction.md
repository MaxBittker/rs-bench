You are one agent in a 5-loop iterative GP-earning benchmark. You have been spawned fresh for **one loop**. After you finish, your context is discarded — only the files you write will carry forward to the next agent.

This is a local RuneScape private server running on localhost for AI agent benchmarking.

## Your Process

1. **Read `/app/gp_results.json`** to determine your loop number. Count entries in the `loops` array — if the file is missing or the array is empty, you are **loop 1**. Otherwise you are loop N+1.
2. **Read `/app/learnings.md`** for what previous agents learned (empty on loop 1).
3. **Read the SDK docs** at `/app/sdk/API.md` and files in `/app/learnings/` to understand available game APIs. On loop 1 especially, spend time here.
4. **Write one money-making script** and run it on all 5 bots in parallel using `execute_code(bot_name, code)`.
5. **Record results** to `/app/gp_results.json` (read existing file first, append your entry).
6. **Update `/app/learnings.md`** with what you learned for the next agent.

## Your Bots

Each loop uses a unique set of 5 bots that start fresh (level 50 all skills, 0 coins, Lumbridge). Bot names follow the pattern `l{loop}a{1-5}`:
- Loop 1: `l1a1`, `l1a2`, `l1a3`, `l1a4`, `l1a5`
- Loop 2: `l2a1`, `l2a2`, `l2a3`, `l2a4`, `l2a5`
- Loop 3: `l3a1`, `l3a2`, `l3a3`, `l3a4`, `l3a5`
- Loop 4: `l4a1`, `l4a2`, `l4a3`, `l4a4`, `l4a5`
- Loop 5: `l5a1`, `l5a2`, `l5a3`, `l5a4`, `l5a5`

Write **one script** and run it on all 5 of your loop's bots using `execute_code(bot_name, code)`.

## Rules

- **No pickpocketing** — any other money-making method is fair game
- **10,000 tick limit** — each bot's script must finish within 10,000 game ticks
- **GP is measured from inventory** — coins must be in inventory, not banked, at the end
- **Same script on all 5 bots** — write one script, run it 5 times in parallel

## GP Tracking Within Scripts

Your scripts MUST track GP throughout execution. Every ~500 ticks, check coins and log the count. At the end, return the final coin count:

```typescript
const COINS_ID = 995;
const inv = sdk.getInventory();
const coins = inv?.filter(i => i.id === COINS_ID).reduce((sum, i) => sum + i.count, 0) ?? 0;
console.log(\`[GP] \${coins} coins\`);
return { gp: coins };
```

If the script errors partway through, whatever GP was last measured still counts.

## Recording Results

After all 5 bots finish, check final coins on each and write to `/app/gp_results.json`:
```json
{
  "loops": [
    {
      "loop": 1,
      "totalGp": 12500,
      "perBot": { "l1a1": 2500, "l1a2": 2500, "l1a3": 2500, "l1a4": 2500, "l1a5": 2500 },
      "method": "sold oak logs to general store",
      "gpPerTick": 1.25
    }
  ]
}
```
**Read the existing file first** and append your loop's entry to the `loops` array.

## Writing Learnings (CRITICAL)

`/app/learnings.md` and `/app/gp_results.json` are the only things that carry forward. Write learnings well:
- **What method you tried** and exact GP earned / GP per tick
- **What worked** — specific code patterns, coordinates, NPC interactions
- **What failed** — errors, pathing issues, things that earned less than expected
- **Recommendations for the next agent** — "try X instead of Y", "shop at Z overstocks after N sales"
- **Working code snippets** — the next agent starts fresh, so include copy-pasteable code

## Strategy Suggestions

- Selling to shops (beware overstocking!), high-alchemy, crafting + selling, resource gathering + selling, monster loot
- Early loops should explore different methods. Later loops should exploit the best method found so far.
- Think about bottlenecks: shop stock limits, resource competition between 5 bots, travel time

## Reference

- SDK API docs: `/app/sdk/API.md`
- Game tips: `/app/learnings/` (banking, combat, shops, etc.)
- Codebase: `/app`
