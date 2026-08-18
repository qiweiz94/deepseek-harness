"""Keyless end-to-end test for the file-outline example: the mock model requests
a get_file_outline tool call, the runtime executes the real tool against the
repository, and the tool/result event carries genuine tree-sitter output.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

_REPO_ROOT = Path(__file__).parents[3]
_EXAMPLE_PATH = _REPO_ROOT / "python" / "sdk" / "examples" / "file-outline" / "outline.py"


def _load_example():
    spec = importlib.util.spec_from_file_location("file_outline_example", _EXAMPLE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_file_outline_example_drives_real_tool() -> None:
    example = _load_example()
    result = example.run_outline(_REPO_ROOT, keep_sessions=False)

    requests = result["requests"]
    assert len(requests) == 2
    tools = [tool["function"]["name"] for tool in requests[0]["body"].get("tools", [])]
    assert example.TOOL_NAME in tools

    payload = result["events"]
    assert len(payload) == 1
    assert example.EXPECTED_SYMBOL in str(payload)
    assert result["finish_reason"] == "completed"