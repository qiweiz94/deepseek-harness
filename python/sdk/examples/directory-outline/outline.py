"""Drive the real ``get_directory_outline`` tool through the SDK and a keyless mock model.

The model endpoint is a local mock: its first completion answers with a
``tool_calls`` delta for ``get_directory_outline``, and the second (after the agent
executes the tool) answers with plain text. The tool itself runs for real in
the runtime process, so the outline in the tool result is genuine tree-sitter
output for the requested repository directory.

Requires ``pnpm install`` but no build. Not collected by pytest itself; the
collected ``tests/test_directory_outline_example.py`` drives the same function.
Run directly with: ``python examples/directory-outline/outline.py``
"""

from __future__ import annotations

import argparse
import json
import shutil
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from deepseek_harness import DeepSeekHarness
from deepseek_harness_runtime import bundled_default_config_path

TOOL_NAME = "get_directory_outline"
OUTLINE_PATH = "packages/plugins/plugin-ast-context/src"
EXPECTED_SYMBOL = "AstSymbolExtractor"


class OutlineMockHandler(BaseHTTPRequestHandler):
    requests: list[dict[str, Any]] = []

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length).decode("utf-8")
        self.requests.append({
            "path": self.path,
            "authorization": self.headers.get("authorization"),
            "body": json.loads(body),
        })
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        if len(self.requests) == 1:
            self.wfile.write(
                b'data: {"choices":[{"delta":{"role":"assistant","content":null,'
                b'"tool_calls":[{"index":0,"id":"call_outline","type":"function",'
                b'"function":{"name":"get_directory_outline","arguments":""}}]}}]}\n\n'
            )
            arguments = json.dumps({"path": OUTLINE_PATH}, ensure_ascii=False)
            self.wfile.write(
                (
                    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,'
                    f'"function":{{"arguments":{json.dumps(arguments)}}}}}'
                    ']}}]}\n\n'
                ).encode()
            )
            self.wfile.write(
                b'data: {"choices":[{"delta":{"content":""},"finish_reason":"tool_calls"}],'
                b'"usage":{"prompt_tokens":7,"completion_tokens":5}}\n\n'
            )
        else:
            self.wfile.write(
                b'data: {"choices":[{"delta":{"content":'
                b'"The tool returned the outline of the directory."},"finish_reason":"stop"}],'
                b'"usage":{"prompt_tokens":7,"completion_tokens":9}}\n\n'
            )
        self.wfile.write(b"data: [DONE]\n\n")

    def log_message(self, _format: str, *_args: object) -> None:
        return


def run_outline(repo_root: Path, keep_sessions: bool) -> dict[str, Any]:
    session_root = Path(tempfile.mkdtemp(prefix="dsh-dir-outline-sessions-"))
    runtime_entry = repo_root / "packages/examples/jsonrpc-demo/src/bin.ts"
    server = ThreadingHTTPServer(("127.0.0.1", 0), OutlineMockHandler)
    thread = threading.Thread(target=server.serve_forever, name="mock-dir-outline-model", daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_address[1]}"

    print(f"repo_root={repo_root}")
    print(f"session_root={session_root}")
    print(f"mock_base_url={base_url}")

    try:
        with DeepSeekHarness(
            provider="deepseek-official",
            model="dir-outline-demo-model",
            cwd=str(repo_root),
            runtime_cwd=str(repo_root),
            session_root=str(session_root),
            cordis=str(Path(__file__).with_name("cordis.yml")),
            launch_args_override=("node", "--import", "tsx", str(runtime_entry)),
            env={
                "DEEPSEEK_BASE_URL": base_url,
                "DEEPSEEK_API_KEY": "dir-outline-demo-key",
            },
            request_timeout_seconds=30,
            shutdown_timeout_seconds=2,
        ) as harness:
            result = harness.run(
                f"Outline the directory {OUTLINE_PATH} and report the symbol names.",
                session_id="dir-outline-demo-main",
            )
        print(f"final_response={result.final_response}")
        print(f"finish_reason={result.finish_reason}")

        assert len(OutlineMockHandler.requests) == 2
        first = OutlineMockHandler.requests[0]
        tool_names = [tool["function"]["name"] for tool in first["body"].get("tools", [])]
        print(f"tools_offered_to_model={tool_names}")
        assert TOOL_NAME in tool_names

        outline_events = [event for event in result.events if event.get("type") == "tool/result"]
        print(f"tool/result events: {len(outline_events)}")
        for event in outline_events:
            print(json.dumps(event, ensure_ascii=False)[:2000])
        assert len(outline_events) == 1

        payload = json.dumps(outline_events, ensure_ascii=False)
        assert EXPECTED_SYMBOL in payload, f"outline payload missing {EXPECTED_SYMBOL}: {payload[:2000]}"
    finally:
        server.shutdown()
        server.server_close()

    if keep_sessions:
        print(f"kept_session_root={session_root}")
    else:
        shutil.rmtree(session_root)
        print("removed temporary session root")
    return {
        "requests": OutlineMockHandler.requests,
        "events": outline_events,
        "final_response": result.final_response,
        "finish_reason": result.finish_reason,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Drive the real get_directory_outline tool through the SDK against a keyless mock model."
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[4],
        help="Path to the deepseek-harness checkout.",
    )
    parser.add_argument("--keep-sessions", action="store_true")
    args = parser.parse_args()
    run_outline(args.repo_root, keep_sessions=args.keep_sessions)
    print("directory outline demo OK")


if __name__ == "__main__":
    main()
