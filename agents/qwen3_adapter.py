"""
Custom Harbor adapter for Qwen3-Coder-Next via OpenCode + OpenRouter.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'qwen3_adapter:Qwen3OpenCode' \
        -m 'openrouter/qwen/qwen3-coder-next' \
        -p tasks/woodcutting-xp-10m
"""

from opencode_adapter import OpenCodeAdapter


class Qwen3OpenCode(OpenCodeAdapter):
    _default_model = "openrouter/qwen/qwen3-coder-next"
    _log_prefix = "qwen3"
    _log_file = "opencode-qwen3.txt"

    @staticmethod
    def name() -> str:
        return "qwen3-opencode"
