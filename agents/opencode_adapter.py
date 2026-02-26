"""
Base adapter for OpenCode-based agents (Kimi, Qwen3, etc.) via OpenRouter.

Subclasses only need to override:
  - name()           — agent name
  - _default_model   — fallback model ID
  - _log_prefix      — prefix for log messages (e.g. 'kimi', 'qwen3')
  - _log_file        — log file name (e.g. 'opencode-kimi.txt')
"""

import json
import os
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, ExecInput
from harbor.models.agent.context import AgentContext


class OpenCodeAdapter(BaseInstalledAgent):
    """
    Base class for agents that run via OpenCode CLI with OpenRouter.
    """

    _default_model: str = ""
    _log_prefix: str = "opencode"
    _log_file: str = "opencode.txt"

    @property
    def _install_agent_template_path(self) -> Path:
        return Path(__file__).parent / "install-opencode.sh.j2"

    def populate_context_post_run(self, context: AgentContext) -> None:
        pass

    def _build_opencode_config(self) -> dict:
        """Build opencode.json config with OpenRouter provider and MCP servers."""
        model_id = self.model_name or self._default_model
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

        opencode_config = self._build_opencode_config()
        config_json = json.dumps(opencode_config, indent=2)
        escaped_config = shlex.quote(config_json)

        model_name = self.model_name or self._default_model

        prefix = self._log_prefix
        log_file = self._log_file

        setup_command = (
            f"echo {escaped_config} > /app/opencode.json && "
            f"echo '[{prefix}-setup] Wrote /app/opencode.json'"
        )

        escaped_model = shlex.quote(model_name)
        continue_instruction = shlex.quote(
            "You were previously working on this task but stopped early. "
            "There is still time remaining. Check the current game state with "
            "sdk.getState() and CONTINUE training. Do NOT write a summary — "
            "keep grinding. " + instruction
        )

        # Variable prefix for the restart loop (uppercase of log_prefix)
        vp = prefix.upper()

        run_command = (
            f"echo '[{prefix}-setup] Starting game services...'; "
            "/ensure-services.sh; "
            f"echo '[{prefix}-setup] Services ready, starting opencode'; "
            "cd /app; "
            f"{vp}_START=$(date +%s); "
            f"{vp}_TIMEOUT=${{{vp}_TIMEOUT:-1620}}; "
            f"{vp}_MIN_RESTART=180; "
            f"{vp}_RUN=1; "
            f"echo \"[{prefix}-loop] Run ${vp}_RUN starting (budget=${{{vp}_TIMEOUT}}s)\" | tee -a /logs/agent/{log_file}; "
            f"timeout ${{{vp}_TIMEOUT}}s opencode --model {escaped_model} run --format=json {escaped_instruction} "
            f"2>&1 </dev/null | tee -a /logs/agent/{log_file}; "
            f"echo '[{prefix}-loop] opencode exited' | tee -a /logs/agent/{log_file}; "
            "while true; do "
            f"  {vp}_ELAPSED=$(( $(date +%s) - {vp}_START )); "
            f"  {vp}_REMAINING=$(( {vp}_TIMEOUT - {vp}_ELAPSED )); "
            f"  echo \"[{prefix}-loop] Elapsed: ${{{vp}_ELAPSED}}s, Remaining: ${{{vp}_REMAINING}}s\" | tee -a /logs/agent/{log_file}; "
            f"  if [ ${vp}_REMAINING -lt ${vp}_MIN_RESTART ]; then "
            f"    echo \"[{prefix}-loop] Less than ${{{vp}_MIN_RESTART}}s remaining, stopping restart loop\" | tee -a /logs/agent/{log_file}; "
            "    break; "
            "  fi; "
            f"  {vp}_RUN=$(({vp}_RUN + 1)); "
            f"  echo \"[{prefix}-loop] Run ${vp}_RUN starting (${{{vp}_REMAINING}}s remaining)\" | tee -a /logs/agent/{log_file}; "
            f"  timeout ${{{vp}_REMAINING}}s opencode --model {escaped_model} run --format=json {continue_instruction} "
            f"  2>&1 </dev/null | tee -a /logs/agent/{log_file}; "
            f"  echo '[{prefix}-loop] opencode exited' | tee -a /logs/agent/{log_file}; "
            "done; "
            f"echo \"[{prefix}-loop] Finished after ${vp}_RUN runs\" | tee -a /logs/agent/{log_file}"
        )

        return [
            ExecInput(command=setup_command, env=env),
            ExecInput(command=run_command, env=env),
        ]
