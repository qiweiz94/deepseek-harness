"""Unit tests for the typed outline models.

These validate the known JSON shape of ``get_file_outline`` and
``get_directory_outline`` results, independent of the running harness.
"""

from __future__ import annotations

from deepseek_harness.models import DirectoryOutlineResult, FileOutlineResult, SymbolEntry


def test_file_outline_result_validates_known_shape() -> None:
    symbol = SymbolEntry(kind="class", name="Foo", line=1, endLine=3, children=[
        SymbolEntry(kind="function", name="bar", line=2, endLine=2),
    ])
    result = FileOutlineResult.model_validate({
        "path": "packages/plugins/plugin-ast-context/src/extractor.ts",
        "symbols": [symbol.model_dump()],
    })
    assert result.path.endswith("extractor.ts")
    assert result.symbols[0].name == "Foo"
    assert result.symbols[0].children[0].name == "bar"


def test_directory_outline_result_validates_known_shape() -> None:
    result = DirectoryOutlineResult.model_validate({
        "path": "packages/plugins/plugin-ast-context/src",
        "files": [
            {
                "path": "packages/plugins/plugin-ast-context/src/extractor.ts",
                "symbols": [{"kind": "class", "name": "AstSymbolExtractor", "line": 1, "endLine": 1}],
            }
        ],
        "skippedFiles": 0,
    })
    assert result.path.endswith("src")
    assert result.files[0].symbols[0].name == "AstSymbolExtractor"
    assert result.skippedFiles == 0


def test_from_event_reads_meta_outline() -> None:
    event = {
        "type": "tool/result",
        "meta": {
            "outline": {
                "path": "p",
                "files": [{"path": "p/a.ts", "symbols": [{"kind": "function", "name": "f", "line": 1, "endLine": 1}]}],
                "skippedFiles": 1,
            }
        },
    }
    outline = DirectoryOutlineResult.from_event(event)
    assert outline.skippedFiles == 1
    assert outline.files[0].symbols[0].name == "f"


def test_from_event_rejects_missing_meta() -> None:
    import pytest

    with pytest.raises(ValueError):
        DirectoryOutlineResult.from_event({"type": "tool/result"})
