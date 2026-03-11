"""
Custom Harbor adapter for GLM-5 via OpenCode + OpenRouter.

Usage with Harbor:
    PYTHONPATH=. harbor run \
        --agent-import-path 'glm_adapter:GlmOpenCode' \
        -m 'openrouter/z-ai/glm-5' \
        -p tasks/woodcutting-xp-10m
"""

from opencode_adapter import OpenCodeAdapter


class GlmOpenCode(OpenCodeAdapter):
    _default_model = "openrouter/z-ai/glm-5"
    _log_prefix = "glm"
    _log_file = "opencode-glm.txt"
    _model_options = {
        "provider": {
            "order": ["z-ai", "together", "fireworks"],
            "allow_fallbacks": False,
        }
    }

    @staticmethod
    def name() -> str:
        return "glm-opencode"
