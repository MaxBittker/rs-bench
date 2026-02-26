"""
Custom Harbor adapter for Kimi K2.5 via OpenCode + OpenRouter.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'kimi_adapter:KimiOpenCode' \
        -m 'openrouter/moonshotai/kimi-k2.5' \
        -p tasks/woodcutting-xp-10m
"""

from opencode_adapter import OpenCodeAdapter


class KimiOpenCode(OpenCodeAdapter):
    _default_model = "openrouter/moonshotai/kimi-k2.5"
    _log_prefix = "kimi"
    _log_file = "opencode-kimi.txt"

    @staticmethod
    def name() -> str:
        return "kimi-opencode"
