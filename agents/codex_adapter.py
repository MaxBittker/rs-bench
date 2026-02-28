"""
Custom Harbor adapter for Codex with Modal-level exec timeout and OAuth support.

The built-in Codex agent can hang when harbor's asyncio.wait_for timeout
fires because Modal's synchronicity wrapper doesn't propagate CancelledError
correctly through process.stdout.read.aio().

This adapter adds:
  - Modal-level timeout (ExecInput.timeout_sec) so Modal kills the process
    server-side before harbor tries to cancel the coroutine.
  - Post-run cleanup of $CODEX_HOME/tmp (contains the ~17MB apply_patch binary).
    Harbor's download_file() has no timeout on Modal file reads, so downloading
    large files from /logs/agent/tmp/ causes harbor to hang indefinitely due to
    the same synchronicity bug.
  - OAuth auth support via CODEX_AUTH_JSON_B64 env var (base64-encoded auth.json)
    for models like gpt-5.3-codex that require ChatGPT OAuth instead of API keys.

Usage with Harbor:
    # API key auth (gpt-5.2-codex):
    PYTHONPATH=agents harbor run \
        --agent-import-path 'codex_adapter:CodexWithTimeout' \
        --ak run_timeout_sec=600 \
        -m 'openai/gpt-5.2-codex' \
        -p tasks/woodcutting-xp-10m

    # OAuth auth (gpt-5.3-codex):
    CODEX_AUTH_JSON_B64=$(base64 < ~/.codex/auth.json) \
    PYTHONPATH=agents harbor run \
        --agent-import-path 'codex_adapter:CodexWithTimeout' \
        --ak run_timeout_sec=600 \
        -m 'openai/gpt-5.3-codex' \
        -p tasks/woodcutting-xp-10m
"""

import os

from harbor.agents.installed.base import ExecInput
from harbor.agents.installed.codex import Codex


class CodexWithTimeout(Codex):
    """Codex agent with Modal-level exec timeout and OAuth auth support."""

    def __init__(self, run_timeout_sec: int | None = None, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._run_timeout_sec = int(run_timeout_sec) if run_timeout_sec is not None else None

    @staticmethod
    def name() -> str:
        return "codex-with-timeout"

    def create_run_agent_commands(self, instruction: str) -> list[ExecInput]:
        commands = super().create_run_agent_commands(instruction)

        # If OAuth auth is provided via base64-encoded auth.json, replace the
        # setup command (command[0]) to write the full OAuth auth.json instead
        # of the API-key-only version that the base class generates.
        codex_auth_b64 = os.environ.get("CODEX_AUTH_JSON_B64", "")
        if codex_auth_b64 and len(commands) > 0:
            setup_cmd = commands[0]
            env = dict(setup_cmd.env) if setup_cmd.env else {}
            env["CODEX_AUTH_JSON_B64"] = codex_auth_b64
            # Remove OPENAI_API_KEY since OAuth doesn't use it
            env.pop("OPENAI_API_KEY", None)

            setup_command = """
mkdir -p /tmp/codex-secrets
echo "$CODEX_AUTH_JSON_B64" | base64 -d > /tmp/codex-secrets/auth.json
ln -sf /tmp/codex-secrets/auth.json "$CODEX_HOME/auth.json"
"""
            mcp_command = self._build_register_mcp_servers_command()
            if mcp_command:
                setup_command += f"\n{mcp_command}"

            commands[0] = ExecInput(
                command=setup_command,
                env=env,
            )
            # Also update the run command env to remove OPENAI_API_KEY
            if len(commands) > 1:
                run_env = dict(commands[1].env) if commands[1].env else {}
                run_env.pop("OPENAI_API_KEY", None)
                run_env["CODEX_AUTH_JSON_B64"] = codex_auth_b64
                commands[1] = ExecInput(
                    command=commands[1].command,
                    env=run_env,
                    cwd=commands[1].cwd,
                    timeout_sec=commands[1].timeout_sec,
                )

        if self._run_timeout_sec and len(commands) > 1:
            run_cmd = commands[-1]
            # Set Modal-level timeout on the long-running codex exec command.
            # Modal will kill the process after this duration, causing
            # process.stdout.read.aio() to return cleanly instead of hanging.
            commands[-1] = ExecInput(
                command=run_cmd.command,
                env=run_cmd.env,
                cwd=run_cmd.cwd,
                timeout_sec=self._run_timeout_sec,
            )

        # Post-run cleanup: remove large/binary files from $CODEX_HOME before
        # harbor downloads /logs/agent/. Harbor's download_file() has no timeout
        # on Modal file reads (file_handle.read.aio), so downloading ANY large
        # file can cause harbor to hang indefinitely due to the synchronicity
        # bug. Keep only: codex.txt (agent output), config.toml (MCP config),
        # and sessions/ (JSONL trajectory data for ATIF conversion).
        env = commands[0].env if commands[0].env else {}
        commands.append(ExecInput(
            command=(
                'cd "$CODEX_HOME" && '
                'rm -rf tmp/ skills/ 2>/dev/null; '
                'rm -f *.sqlite *.sqlite-wal *.sqlite-shm auth.json .lock 2>/dev/null; '
                'echo "Cleaned up codex home, remaining:"; ls -la "$CODEX_HOME"'
            ),
            env=env,
            timeout_sec=10,
        ))

        return commands
