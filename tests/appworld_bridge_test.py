from __future__ import annotations

import io
import json
import unittest
import tempfile
from pathlib import Path
from typing import Any
from unittest.mock import patch

from benchmarks.appworld.bridge import AppWorldBackend, AppWorldBridge, serve, tree_fingerprint


class FakeTask:
    instruction = "Add a sample item to the todo list."
    supervisor = {"first_name": "Ada", "email": "ada@example.test"}
    allowed_apps = ["todoist", "supervisor"]
    app_descriptions = {"todoist": "A task app.", "supervisor": "Task status."}
    api_docs = {
        "api_docs": {
            "list_api_names": {"description": "Lists public API names."},
            "search_api_docs": {"description": "Searches public API docs."},
            "show_api_doc": {"description": "Returns one public API doc."},
        },
        "todoist": {"create_task": {"description": "Creates a task."}},
        "supervisor": {"complete_task": {"description": "Marks task complete."}},
    }
    ground_truth = None


class FakeRequester:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict[str, Any]]] = []

    def request(self, app: str, api: str, **arguments: Any) -> dict[str, Any]:
        self.calls.append((app, api, arguments))
        return {"id": 7, "title": arguments.get("title")}


class FakeWorld:
    def __init__(self, events: list[str]) -> None:
        self.task = FakeTask()
        self.requester = FakeRequester()
        self.saved = 0
        self.closed = 0
        self.events = events

    def save(self) -> None:
        self.saved += 1
        self.events.append("save")

    def close(self) -> None:
        self.closed += 1
        self.events.append("close")


class FakeTracker:
    def __init__(self) -> None:
        self.stats_only_arguments: list[bool] = []

    def to_dict(self, stats_only: bool = False) -> dict[str, Any]:
        self.stats_only_arguments.append(stats_only)
        if stats_only:
            return {
                "success": True,
                "difficulty": 1,
                "num_tests": 3,
                "passed_tests": 2,
                "failed_tests": 1,
            }
        return {
            "success": True,
            "difficulty": 1,
            "num_tests": 3,
            "passes": ["private assertion"],
            "failures": [],
        }


class FakeBackend:
    def __init__(self) -> None:
        self.worlds: list[FakeWorld] = []
        self.listed_splits: list[str] = []
        self.created: list[tuple[str, str]] = []
        self.evaluated: list[tuple[str, str]] = []
        self.events: list[str] = []
        self.tracker = FakeTracker()

    def ping(self) -> dict[str, Any]:
        return {
            "available": True,
            "package_version": "fake-fixture",
            "source_revision": "f" * 40,
            "data_ready": True,
            "task_counts": {"dev": 1},
        }

    def list_tasks(self, split: str) -> list[str]:
        self.listed_splits.append(split)
        return ["abc123_1"]

    def ensure_fresh_output(self, task_id: str, experiment_name: str) -> None:
        return None

    def create_world(self, task_id: str, experiment_name: str) -> FakeWorld:
        self.created.append((task_id, experiment_name))
        world = FakeWorld(self.events)
        self.worlds.append(world)
        return world

    def evaluate(self, task_id: str, experiment_name: str) -> dict[str, Any]:
        self.evaluated.append((task_id, experiment_name))
        self.events.append("evaluate")
        if self.worlds and self.worlds[-1].closed:
            raise AssertionError("The bridge closed AppWorld before official evaluation.")
        return self.tracker.to_dict(stats_only=True)


class AppWorldBridgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.backend = FakeBackend()
        self.bridge = AppWorldBridge(self.backend)

    def test_fingerprint_changes_with_data_but_ignores_bytecode_cache(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            item = root / "input.json"
            item.write_text('{"version":1}', encoding="utf-8")
            first = tree_fingerprint(root)
            cache = root / "__pycache__"
            cache.mkdir()
            (cache / "cached.pyc").write_bytes(b"temporary")
            self.assertEqual(first, tree_fingerprint(root))
            item.write_text('{"version":2}', encoding="utf-8")
            self.assertNotEqual(first["sha256"], tree_fingerprint(root)["sha256"])

    def dispatch(self, request_id: str, op: str, **fields: Any) -> dict[str, Any]:
        return self.bridge.dispatch({"id": request_id, "op": op, **fields})

    def test_ping_is_lazy_and_reports_backend_availability(self) -> None:
        response = self.dispatch("p", "ping")
        self.assertEqual(
            response["result"],
            {
                "available": True,
                "package_version": "fake-fixture",
                "source_revision": "f" * 40,
                "data_ready": True,
                "task_counts": {"dev": 1},
            },
        )
        self.assertTrue(response["ok"])

    def test_uninstalled_ping_does_not_import_appworld(self) -> None:
        with patch("benchmarks.appworld.bridge.importlib.util.find_spec", return_value=None):
            status = AppWorldBackend().ping()
        self.assertEqual(
            status,
            {
                "available": False,
                "package_version": None,
                "source_revision": None,
                "source_dirty": None,
                "data_ready": False,
                "task_counts": {},
            },
        )

    def test_start_requires_listed_task_and_exposes_only_public_metadata(self) -> None:
        denied = self.dispatch("s0", "start", task_id="abc123_1", experiment_name="run-a")
        self.assertFalse(denied["ok"])
        self.assertEqual(denied["error"]["code"], "task_not_listed")

        listed = self.dispatch("l", "list_tasks", split="test_normal")
        self.assertEqual(listed["result"], {"task_ids": ["abc123_1"]})
        started = self.dispatch("s", "start", task_id="abc123_1", experiment_name="run-a")
        self.assertTrue(started["ok"])
        result = started["result"]
        self.assertEqual(set(result), {"instruction", "supervisor", "apps", "api_docs"})
        self.assertEqual(result["instruction"], FakeTask.instruction)
        self.assertEqual(result["supervisor"], FakeTask.supervisor)
        self.assertEqual(result["apps"], FakeTask.app_descriptions)
        self.assertEqual(result["api_docs"], {"api_docs": FakeTask.api_docs["api_docs"]})
        self.assertNotIn("ground_truth", result)
        self.assertIsNone(self.backend.worlds[0].task.ground_truth)

    def test_call_uses_requester_and_enforces_task_public_api_whitelist(self) -> None:
        self.dispatch("l", "list_tasks", split="dev")
        self.dispatch("s", "start", task_id="abc123_1", experiment_name="run-a")
        result = self.dispatch(
            "c", "call", app="todoist", api="create_task", arguments={"title": "sample"}
        )
        self.assertEqual(result["result"], {"id": 7, "title": "sample"})
        self.assertEqual(
            self.backend.worlds[0].requester.calls,
            [("todoist", "create_task", {"title": "sample"})],
        )

        denied = self.dispatch("c2", "call", app="todoist", api="hidden_api", arguments={})
        self.assertFalse(denied["ok"])
        self.assertEqual(denied["error"]["code"], "api_not_allowed")

        denied_control = self.dispatch(
            "c3", "call", app="todoist", api="create_task", arguments={"track": False}
        )
        self.assertFalse(denied_control["ok"])
        self.assertEqual(denied_control["error"]["code"], "invalid_call")

    def test_evaluate_saves_scores_while_world_is_open_then_closes(self) -> None:
        self.dispatch("l", "list_tasks", split="test_challenge")
        self.dispatch("s", "start", task_id="abc123_1", experiment_name="run-b")
        response = self.dispatch("e", "evaluate")
        self.assertTrue(response["ok"])
        self.assertEqual(
            response["result"],
            {
                "success": True,
                "difficulty": 1,
                "num_tests": 3,
                "passed_tests": 2,
                "failed_tests": 1,
            },
        )
        self.assertEqual(
            set(response["result"]),
            {"success", "difficulty", "num_tests", "passed_tests", "failed_tests"},
        )
        self.assertEqual(self.backend.worlds[0].saved, 1)
        self.assertEqual(self.backend.worlds[0].closed, 1)
        self.assertEqual(self.backend.evaluated, [("abc123_1", "run-b")])
        self.assertTrue(self.backend.tracker.stats_only_arguments[-1])
        self.assertEqual(self.backend.events, ["save", "evaluate", "close"])

    def test_close_is_idempotent_and_process_cannot_start_second_world(self) -> None:
        self.dispatch("l", "list_tasks", split="train")
        self.dispatch("s", "start", task_id="abc123_1", experiment_name="run-c")
        first_close = self.dispatch("x", "close")
        second_close = self.dispatch("x2", "close")
        self.assertEqual(first_close["result"], {"closed": True, "saved": True})
        self.assertEqual(second_close["result"], {"closed": True, "saved": False})

        again = self.dispatch("s2", "start", task_id="abc123_1", experiment_name="run-d")
        self.assertFalse(again["ok"])
        self.assertEqual(again["error"]["code"], "one_world_per_process")

    def test_jsonl_protocol_emits_one_response_per_input_line(self) -> None:
        stdin = io.StringIO(
            '{"id":"1","op":"ping"}\n'
            '{"id":"2","op":"list_tasks","split":"dev"}\n'
        )
        stdout = io.StringIO()
        serve(stdin=stdin, stdout=stdout, backend=FakeBackend())
        lines = stdout.getvalue().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertEqual([json.loads(line)["id"] for line in lines], ["1", "2"])


if __name__ == "__main__":
    unittest.main()
