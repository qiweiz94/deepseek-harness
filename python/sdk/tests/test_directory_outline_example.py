"""Keyless end-to-end test for the directory-outline example: the mock model requests
a get_directory_outline tool call, the runtime executes the real tool against the
repository, and the tool/result event carries genuine tree-sitter output.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

from deepseek_harness.models import DirectoryOutlineResult

_REPO_ROOT = Path(__file__).parents[3]
_EXAMPLE_PATH = _REPO_ROOT / "python" / "sdk" / "examples" / "directory-outline" / "outline.py"


def _load_example():
    spec = importlib.util.spec_from_file_location("directory_outline_example", _EXAMPLE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_directory_outline_example_drives_real_tool() -> None:
    example = _load_example()
    result = example.run_outline(_REPO_ROOT, keep_sessions=False)

    requests = result["requests"]
    assert len(requests) == 2
    tools = [tool["function"]["name"] for tool in requests[0]["body"].get("tools", [])]
    assert example.TOOL_NAME in tools

    payload = result["events"]
    assert len(payload) == 1
    outline = DirectoryOutlineResult.from_event(payload[0])
    symbol_names = {symbol.name for file in outline.files for symbol in file.symbols}
    assert example.EXPECTED_SYMBOL in symbol_names
    assert result["finish_reason"] == "completed"
