"""
Custom Harbor adapter for Kimi K2.5 via OpenCode + OpenRouter.

Usage with Harbor:
    PYTHONPATH=benchmark harbor run \
        --agent-import-path 'kimi_adapter:KimiOpenCode' \
        -m 'openrouter/moonshotai/kimi-k2.5' \
        -p benchmark/total-level-8m
"""

import json
import os
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, ExecInput
from harbor.models.agent.context import AgentContext


class KimiOpenCode(BaseInstalledAgent):
    """
    Runs Kimi K2.5 via OpenCode CLI with OpenRouter as the provider.
    """

    @staticmethod
    def name() -> str:
        return "kimi-opencode"

    @property
    def _install_agent_template_path(self) -> Path:
        return Path(__file__).parent / "install-kimi-opencode.sh.j2"

    def populate_context_post_run(self, context: AgentContext) -> None:
        pass

    def _build_opencode_config(self) -> dict:
        """Build opencode.json config with OpenRouter provider and MCP servers."""
        # Extract model ID from full model name (e.g. openrouter/moonshotai/kimi-k2.5)
        model_id = self.model_name or "openrouter/moonshotai/kimi-k2.5"
        if "/" in model_id:
            parts = model_id.split("/", 1)
            provider_name = parts[0]
            model_suffix = parts[1]  # e.g. moonshotai/kimi-k2.5
        else:
            provider_name = "openrouter"
            model_suffix = model_id

        config: dict = {
            "$schema": "https://opencode.ai/config.json",
            "provider": {
                provider_name: {
                    "models": {
                        model_suffix: {}
                    }
                }
            },
            "model": model_id,
            "permission": {
                "*": "allow",
            },
        }

        # Add MCP servers from task config
        if self.mcp_servers:
            mcp = {}
            for server in self.mcp_servers:
                if server.transport == "stdio":
                    cmd_parts = [server.command] + (server.args or [])
                    mcp[server.name] = {
                        "type": "local",
                        "command": cmd_parts,
                        "enabled": True,
                    }
                else:
                    mcp[server.name] = {
                        "type": "remote",
                        "url": server.url,
                        "enabled": True,
                    }
            config["mcp"] = mcp

        return config

    # Snapshot env vars at class-load time (same pattern as Claude Code adapter)
    _original_env = {
        k: os.environ.get(k, "")
        for k in ["OPENROUTER_API_KEY"]
    }

    def create_run_agent_commands(self, instruction: str) -> list[ExecInput]:
        escaped_instruction = shlex.quote(instruction)

        _e = self._original_env
        openrouter_key = _e.get("OPENROUTER_API_KEY") or os.environ.get("OPENROUTER_API_KEY", "")

        env = {
            "OPENROUTER_API_KEY": openrouter_key,
            "OPENCODE_YOLO": "true",
            "OPENCODE_DANGEROUSLY_SKIP_PERMISSIONS": "true",
        }
        env = {k: v for k, v in env.items() if v}

        # Build and serialize the opencode config
        opencode_config = self._build_opencode_config()
        config_json = json.dumps(opencode_config, indent=2)
        escaped_config = shlex.quote(config_json)

        model_name = self.model_name or "openrouter/moonshotai/kimi-k2.5"

        # Setup: write opencode.json to project root and ensure services are running
        setup_command = (
            f"echo {escaped_config} > /app/opencode.json && "
            "echo '[kimi-setup] Wrote /app/opencode.json'"
        )

        # Run: start services then run opencode in a restart loop.
        # Kimi tends to exit early ("I'm done") with time remaining.
        # We detect this and relaunch with a "continue" prompt until
        # the agent timeout is nearly exhausted (leave 60s buffer for verifier).
        escaped_model = shlex.quote(model_name)
        continue_instruction = shlex.quote(
            "You were previously working on this task but stopped early. "
            "There is still time remaining. Check the current game state with "
            "sdk.getState() and CONTINUE training. Do NOT write a summary — "
            "keep grinding. " + instruction
        )

        run_command = (
            "echo '[kimi-setup] Starting game services...'; "
            "/ensure-services.sh; "
            "echo '[kimi-setup] Services ready, starting opencode'; "
            "cd /app; "
            "KIMI_START=$(date +%s); "
            # Budget: 1620s (27min) — leaves 5min buffer before harbor's
            # 1920s agent timeout so the verifier can run.
            "KIMI_TIMEOUT=${KIMI_TIMEOUT:-1620}; "
            # Don't restart unless at least 3min remain (short runs are wasteful)
            "KIMI_MIN_RESTART=180; "
            "KIMI_RUN=1; "
            # First run uses the original instruction
            f"echo \"[kimi-loop] Run $KIMI_RUN starting (budget=${{KIMI_TIMEOUT}}s)\" | tee -a /logs/agent/opencode-kimi.txt; "
            f"timeout ${{KIMI_TIMEOUT}}s opencode --model {escaped_model} run --format=json {escaped_instruction} "
            "2>&1 </dev/null | tee -a /logs/agent/opencode-kimi.txt; "
            "echo '[kimi-loop] opencode exited' | tee -a /logs/agent/opencode-kimi.txt; "
            # Restart loop: keep relaunching while enough time remains
            "while true; do "
            "  KIMI_ELAPSED=$(( $(date +%s) - KIMI_START )); "
            "  KIMI_REMAINING=$(( KIMI_TIMEOUT - KIMI_ELAPSED )); "
            "  echo \"[kimi-loop] Elapsed: ${KIMI_ELAPSED}s, Remaining: ${KIMI_REMAINING}s\" | tee -a /logs/agent/opencode-kimi.txt; "
            "  if [ $KIMI_REMAINING -lt $KIMI_MIN_RESTART ]; then "
            "    echo \"[kimi-loop] Less than ${KIMI_MIN_RESTART}s remaining, stopping restart loop\" | tee -a /logs/agent/opencode-kimi.txt; "
            "    break; "
            "  fi; "
            "  KIMI_RUN=$((KIMI_RUN + 1)); "
            f"  echo \"[kimi-loop] Run $KIMI_RUN starting (${{KIMI_REMAINING}}s remaining)\" | tee -a /logs/agent/opencode-kimi.txt; "
            # Cap each restart with `timeout` so it can't overrun the budget
            f"  timeout ${{KIMI_REMAINING}}s opencode --model {escaped_model} run --format=json {continue_instruction} "
            "  2>&1 </dev/null | tee -a /logs/agent/opencode-kimi.txt; "
            "  echo '[kimi-loop] opencode exited' | tee -a /logs/agent/opencode-kimi.txt; "
            "done; "
            "echo \"[kimi-loop] Finished after $KIMI_RUN runs\" | tee -a /logs/agent/opencode-kimi.txt"
        )

        return [
            ExecInput(command=setup_command, env=env),
            ExecInput(command=run_command, env=env),
        ]
