"""Keyless end-to-end test for the async API against the directory-outline example.

Mirrors ``test_directory_outline_example.py`` but drives the runtime through
``AsyncDeepSeekHarness`` to exercise the async wrappers.
"""

from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path

_REPO_ROOT = Path(__file__).parents[3]
_EXAMPLE_PATH = _REPO_ROOT / "python" / "sdk" / "examples" / "directory-outline" / "outline.py"


def _load_example():
    spec = importlib.util.spec_from_file_location("directory_outline_example", _EXAMPLE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_async_directory_outline_example_drives_real_tool() -> None:
    example = _load_example()
    result = asyncio.run(example.run_outline_async(_REPO_ROOT, keep_sessions=False))

    requests = result["requests"]
    assert len(requests) == 2
    tools = [tool["function"]["name"] for tool in requests[0]["body"].get("tools", [])]
    assert example.TOOL_NAME in tools
    assert result["finish_reason"] == "completed"
