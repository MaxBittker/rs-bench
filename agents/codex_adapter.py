"""
Custom Harbor adapter for Codex with Modal-level exec timeout.

The built-in Codex agent can hang when harbor's asyncio.wait_for timeout
fires because Modal's synchronicity wrapper doesn't propagate CancelledError
correctly through process.stdout.read.aio().

This adapter adds a Modal-level timeout (ExecInput.timeout_sec) so Modal
kills the process server-side before harbor tries to cancel the coroutine.

Usage with Harbor:
    PYTHONPATH=agents harbor run \
        --agent-import-path 'codex_adapter:CodexWithTimeout' \
        --ak run_timeout_sec=600 \
        -m 'openai/gpt-5.2-codex' \
        -p tasks/woodcutting-xp-10m
"""

from harbor.agents.installed.base import ExecInput
from harbor.agents.installed.codex import Codex


class CodexWithTimeout(Codex):
    """Codex agent with Modal-level exec timeout to prevent hanging."""

    def __init__(self, run_timeout_sec: int | None = None, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._run_timeout_sec = int(run_timeout_sec) if run_timeout_sec is not None else None

    @staticmethod
    def name() -> str:
        return "codex-with-timeout"

    def create_run_agent_commands(self, instruction: str) -> list[ExecInput]:
        commands = super().create_run_agent_commands(instruction)

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

        return commands
