"""
Custom Harbor adapter for Qwen3-Coder-Next via OpenCode + OpenRouter.

Usage with Harbor:
    PYTHONPATH=benchmark harbor run \
        --agent-import-path 'qwen3_adapter:Qwen3OpenCode' \
        -m 'openrouter/qwen/qwen3-coder-next' \
        -p benchmark/total-level-8m
"""

import json
import os
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, ExecInput
from harbor.models.agent.context import AgentContext


class Qwen3OpenCode(BaseInstalledAgent):
    """
    Runs Qwen3-Coder-Next via OpenCode CLI with OpenRouter as the provider.
    """

    @staticmethod
    def name() -> str:
        return "qwen3-opencode"

    @property
    def _install_agent_template_path(self) -> Path:
        return Path(__file__).parent / "install-kimi-opencode.sh.j2"

    def populate_context_post_run(self, context: AgentContext) -> None:
        pass

    def _build_opencode_config(self) -> dict:
        """Build opencode.json config with OpenRouter provider and MCP servers."""
        model_id = self.model_name or "openrouter/qwen/qwen3-coder-next"
        if "/" in model_id:
            parts = model_id.split("/", 1)
            provider_name = parts[0]
            model_suffix = parts[1]
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

    # Snapshot env vars at class-load time
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

        opencode_config = self._build_opencode_config()
        config_json = json.dumps(opencode_config, indent=2)
        escaped_config = shlex.quote(config_json)

        model_name = self.model_name or "openrouter/qwen/qwen3-coder-next"

        setup_command = (
            f"echo {escaped_config} > /app/opencode.json && "
            "echo '[qwen3-setup] Wrote /app/opencode.json'"
        )

        escaped_model = shlex.quote(model_name)
        continue_instruction = shlex.quote(
            "You were previously working on this task but stopped early. "
            "There is still time remaining. Check the current game state with "
            "sdk.getState() and CONTINUE training. Do NOT write a summary — "
            "keep grinding. " + instruction
        )

        run_command = (
            "echo '[qwen3-setup] Starting game services...'; "
            "/ensure-services.sh; "
            "echo '[qwen3-setup] Services ready, starting opencode'; "
            "cd /app; "
            "QWEN_START=$(date +%s); "
            "QWEN_TIMEOUT=${QWEN_TIMEOUT:-1620}; "
            "QWEN_MIN_RESTART=180; "
            "QWEN_RUN=1; "
            f"echo \"[qwen3-loop] Run $QWEN_RUN starting (budget=${{QWEN_TIMEOUT}}s)\" | tee -a /logs/agent/opencode-qwen3.txt; "
            f"timeout ${{QWEN_TIMEOUT}}s opencode --model {escaped_model} run --format=json {escaped_instruction} "
            "2>&1 </dev/null | tee -a /logs/agent/opencode-qwen3.txt; "
            "echo '[qwen3-loop] opencode exited' | tee -a /logs/agent/opencode-qwen3.txt; "
            "while true; do "
            "  QWEN_ELAPSED=$(( $(date +%s) - QWEN_START )); "
            "  QWEN_REMAINING=$(( QWEN_TIMEOUT - QWEN_ELAPSED )); "
            "  echo \"[qwen3-loop] Elapsed: ${QWEN_ELAPSED}s, Remaining: ${QWEN_REMAINING}s\" | tee -a /logs/agent/opencode-qwen3.txt; "
            "  if [ $QWEN_REMAINING -lt $QWEN_MIN_RESTART ]; then "
            "    echo \"[qwen3-loop] Less than ${QWEN_MIN_RESTART}s remaining, stopping restart loop\" | tee -a /logs/agent/opencode-qwen3.txt; "
            "    break; "
            "  fi; "
            "  QWEN_RUN=$((QWEN_RUN + 1)); "
            f"  echo \"[qwen3-loop] Run $QWEN_RUN starting (${{QWEN_REMAINING}}s remaining)\" | tee -a /logs/agent/opencode-qwen3.txt; "
            f"  timeout ${{QWEN_REMAINING}}s opencode --model {escaped_model} run --format=json {continue_instruction} "
            "  2>&1 </dev/null | tee -a /logs/agent/opencode-qwen3.txt; "
            "  echo '[qwen3-loop] opencode exited' | tee -a /logs/agent/opencode-qwen3.txt; "
            "done; "
            "echo \"[qwen3-loop] Finished after $QWEN_RUN runs\" | tee -a /logs/agent/opencode-qwen3.txt"
        )

        return [
            ExecInput(command=setup_command, env=env),
            ExecInput(command=run_command, env=env),
        ]
