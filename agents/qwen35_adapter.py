"""
Custom Harbor adapter for Qwen3.5-35B-A3B via OpenCode + OpenRouter.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'qwen35_adapter:Qwen35OpenCode' \
        -m 'openrouter/qwen/qwen3.5-35b-a3b' \
        -p tasks/woodcutting-xp-10m
"""

from opencode_adapter import OpenCodeAdapter


class Qwen35OpenCode(OpenCodeAdapter):
    _default_model = "openrouter/qwen/qwen3.5-35b-a3b"
    _log_prefix = "qwen35"
    _log_file = "opencode-qwen35.txt"

    @staticmethod
    def name() -> str:
        return "qwen35-opencode"
