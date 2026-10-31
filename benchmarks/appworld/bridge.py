"""JSONL bridge to the official AppWorld Python package.

The module intentionally imports AppWorld only when a non-ping operation needs it.
It exposes documented task metadata and public app APIs, never arbitrary Python or
the evaluator to an agent-facing call.
"""

from __future__ import annotations

import importlib.metadata
import importlib.util
import hashlib
import json
import os
import re
import subprocess
import sys
from collections.abc import Mapping
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any, Protocol


DATASET_SPLITS = frozenset({"train", "dev", "test_normal", "test_challenge"})
MAX_API_CALLS = 1000
REQUESTER_CONTROL_FIELDS = frozenset({"client", "raise_on_failure", "show", "track"})
_SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SAFE_TASK_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")


class BridgeError(Exception):
    """An expected protocol or lifecycle error safe to return to the caller."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class Backend(Protocol):
    def ping(self) -> dict[str, Any]: ...

    def list_tasks(self, split: str) -> list[str]: ...

    def ensure_fresh_output(self, task_id: str, experiment_name: str) -> None: ...

    def create_world(self, task_id: str, experiment_name: str) -> Any: ...

    def evaluate(self, task_id: str, experiment_name: str) -> dict[str, Any]: ...


class AppWorldBackend:
    """Thin lazy adapter over the public AppWorld package API."""

    def ping(self) -> dict[str, Any]:
        try:
            spec = importlib.util.find_spec("appworld")
            available = spec is not None
        except (ImportError, ValueError):
            spec = None
            available = False
        if not available:
            return {
                "available": False,
                "package_version": None,
                "source_revision": None,
                "source_dirty": None,
                "data_ready": False,
                "task_counts": {},
            }
        distribution = None
        try:
            distribution = importlib.metadata.distribution("appworld")
            version = distribution.version
        except importlib.metadata.PackageNotFoundError:
            version = None
        source_revision, source_dirty = self._source_revision(distribution, spec)
        root = Path(os.environ.get("APPWORLD_ROOT") or Path.cwd()).resolve()
        datasets_directory = root / "data" / "datasets"
        data_ready = all(
            path.is_dir()
            for path in (
                datasets_directory,
                root / "data" / "tasks",
                root / "data" / "api_docs" / "standard",
            )
        )
        task_counts: dict[str, int] = {}
        if datasets_directory.is_dir():
            for split in sorted(DATASET_SPLITS):
                dataset_file = datasets_directory / f"{split}.txt"
                if dataset_file.is_file():
                    task_counts[split] = sum(
                        1 for line in dataset_file.read_text(encoding="utf-8").splitlines() if line.strip()
                    )
        return {
            "available": True,
            "package_version": version,
            "source_revision": source_revision,
            "source_dirty": source_dirty,
            "data_ready": data_ready,
            "task_counts": task_counts,
        }

    @staticmethod
    def _source_revision(distribution: Any, spec: Any) -> tuple[str | None, bool | None]:
        direct_url_data: dict[str, Any] = {}
        if distribution is not None:
            try:
                direct_url = distribution.read_text("direct_url.json")
            except OSError:
                direct_url = None
            if direct_url:
                try:
                    parsed_direct_url = json.loads(direct_url)
                    if isinstance(parsed_direct_url, dict):
                        direct_url_data = parsed_direct_url
                except (TypeError, json.JSONDecodeError):
                    pass
        vcs_info = direct_url_data.get("vcs_info", {})
        direct_revision = vcs_info.get("commit_id") if isinstance(vcs_info, dict) else None
        dir_info = direct_url_data.get("dir_info", {})
        is_editable = bool(dir_info.get("editable")) if isinstance(dir_info, dict) else False
        if is_editable or not isinstance(direct_revision, str):
            revision, dirty = AppWorldBackend._source_git_revision(spec)
            if dirty is True:
                return None, True
            if revision is not None:
                return revision, False
        if isinstance(direct_revision, str) and re.fullmatch(r"[0-9a-fA-F]{40}", direct_revision):
            return direct_revision.lower(), None
        return None, None

    @staticmethod
    def _source_git_revision(spec: Any) -> tuple[str | None, bool | None]:
        origin = getattr(spec, "origin", None)
        if not isinstance(origin, str):
            return None, None
        try:
            source_directory = Path(origin).resolve().parent
            for candidate in (source_directory, *source_directory.parents):
                if not (candidate / ".git").exists():
                    continue
                # A wheel installed in a venv inside some unrelated repository
                # must not inherit the enclosing portfolio's HEAD/dirty state.
                if source_directory not in {
                    (candidate / "src" / "appworld").resolve(),
                    (candidate / "appworld").resolve(),
                }:
                    continue
                revision_result = subprocess.run(
                    ["git", "-C", str(candidate), "rev-parse", "HEAD"],
                    capture_output=True,
                    check=False,
                    text=True,
                    timeout=2,
                )
                revision = revision_result.stdout.strip().lower()
                if revision_result.returncode != 0 or not re.fullmatch(r"[0-9a-f]{40}", revision):
                    continue
                status_result = subprocess.run(
                    [
                        "git",
                        "-C",
                        str(candidate),
                        "status",
                        "--porcelain",
                        "--untracked-files=all",
                    ],
                    capture_output=True,
                    check=False,
                    text=True,
                    timeout=4,
                )
                if status_result.returncode != 0:
                    return None, None
                return revision, bool(status_result.stdout.strip())
        except (OSError, subprocess.SubprocessError):
            return None, None
        return None, None

    def list_tasks(self, split: str) -> list[str]:
        # Do not pass difficulty: the official helper reads ground_truth metadata
        # when filtering on difficulty. Its default only reads the split's ID list.
        from appworld.task import load_task_ids

        return load_task_ids(dataset_name=split)

    def identity(self) -> dict[str, Any]:
        """Hash installed code and data without returning task/scoring content."""
        spec = importlib.util.find_spec("appworld")
        if spec is None or spec.origin is None:
            raise BridgeError("package_missing", "AppWorld is not installed.")
        root = Path(os.environ.get("APPWORLD_ROOT") or Path.cwd()).resolve()
        dependencies = sorted(
            (distribution.metadata.get("Name", "").lower(), distribution.version)
            for distribution in importlib.metadata.distributions()
        )
        return {**self.ping(), "package": tree_fingerprint(Path(spec.origin).resolve().parent),
                "dataset": tree_fingerprint(root / "data"),
                "dependencies_sha256": hashlib.sha256(json.dumps(dependencies, separators=(",", ":")).encode()).hexdigest()}

    def ensure_fresh_output(self, task_id: str, experiment_name: str) -> None:
        from appworld.common.path_store import path_store

        task_output = (
            Path(path_store.experiment_outputs)
            / experiment_name
            / "tasks"
            / task_id
        )
        # AppWorld.initialize() deletes this whole directory before creating it.
        # Refuse collisions rather than risk erasing an earlier run.
        if task_output.exists():
            raise BridgeError(
                "output_exists",
                "This experiment/task output already exists; choose a fresh experiment name.",
            )

    def create_world(self, task_id: str, experiment_name: str) -> Any:
        from appworld import AppWorld
        try:
            from .windows_compat import apply_windows_compat
        except ImportError:
            from windows_compat import apply_windows_compat
        apply_windows_compat()

        return AppWorld(
            task_id=task_id,
            experiment_name=experiment_name,
            load_ground_truth=False,
        )

    def evaluate(self, task_id: str, experiment_name: str) -> dict[str, Any]:
        # This is control-plane only. Do not return the TestTracker's passes or
        # failures: official failure reports can contain private test assertions.
        from appworld.evaluator import evaluate_task
        try:
            from .windows_compat import apply_windows_compat
        except ImportError:
            from windows_compat import apply_windows_compat
        apply_windows_compat()

        tracker = evaluate_task(
            task_id=task_id,
            experiment_name=experiment_name,
            suppress_errors=True,
            save_report=False,
        )
        result = tracker.to_dict(stats_only=True)
        result["passed_tests"] = tracker.pass_count
        result["failed_tests"] = tracker.fail_count
        return result


def tree_fingerprint(root: Path) -> dict[str, Any]:
    if not root.is_dir():
        raise BridgeError("data_missing", "Expected installed code/data directory is missing.")
    digest = hashlib.sha256()
    count = 0
    size = 0
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if "__pycache__" in relative.parts or path.suffix in {".pyc", ".pyo"}:
            continue
        if path.is_symlink():
            raise BridgeError("linked_input", "Code/data fingerprints require regular local files.")
        if not path.is_file():
            continue
        file_digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                file_digest.update(chunk)
                size += len(chunk)
        digest.update(relative.as_posix().encode("utf-8") + b"\0" + file_digest.digest())
        count += 1
    if not count:
        raise BridgeError("empty_input", "Code/data directory is empty.")
    return {"sha256": digest.hexdigest(), "files": count, "bytes": size}


def _plain(value: Any) -> Any:
    """Convert AppWorld's dict-like values to strict JSON-compatible values."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Mapping):
        return {str(key): _plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_plain(item) for item in value]
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if hasattr(value, "to_dict") and callable(value.to_dict):
        return _plain(value.to_dict())
    return str(value)


class AppWorldBridge:
    """Stateful one-world JSONL protocol implementation."""

    def __init__(self, backend: Backend | None = None) -> None:
        self.backend: Backend = backend or AppWorldBackend()
        self.allowed_task_ids: set[str] = set()
        self.world: Any | None = None
        self.task_id: str | None = None
        self.experiment_name: str | None = None
        self.started = False
        self.closed = False
        self.evaluated = False
        self.api_call_count = 0

    def dispatch(self, request: dict[str, Any]) -> dict[str, Any]:
        request_id = request.get("id")
        if not isinstance(request_id, (str, int)) or isinstance(request_id, bool):
            raise BridgeError("invalid_request", "Request id must be a string or integer.")
        operation = request.get("op")
        if not isinstance(operation, str):
            raise BridgeError("invalid_request", "Request op must be a string.")

        try:
            # AppWorld may print setup/evaluation progress; stdout is reserved for JSONL.
            with redirect_stdout(sys.stderr):
                result = self._dispatch_operation(operation, request)
            return {"id": request_id, "ok": True, "result": _plain(result)}
        except BridgeError as error:
            return {
                "id": request_id,
                "ok": False,
                "error": {"code": error.code, "message": error.message},
            }
        except Exception as error:  # Never serialize exception text from evaluator/API internals.
            return {
                "id": request_id,
                "ok": False,
                "error": {"code": "operation_failed", "type": type(error).__name__},
            }

    def _dispatch_operation(self, operation: str, request: dict[str, Any]) -> Any:
        if operation == "ping":
            self._only_keys(request, {"id", "op"})
            return self.backend.ping()
        if operation == "identity":
            self._only_keys(request, {"id", "op"})
            return self.backend.identity()
        if operation == "list_tasks":
            self._only_keys(request, {"id", "op", "split"})
            split = request.get("split")
            if split not in DATASET_SPLITS:
                raise BridgeError(
                    "invalid_split",
                    "split must be train, dev, test_normal, or test_challenge.",
                )
            task_ids = self.backend.list_tasks(split)
            safe_ids = [task_id for task_id in task_ids if _SAFE_TASK_ID.fullmatch(task_id)]
            self.allowed_task_ids.update(safe_ids)
            return {"task_ids": safe_ids}
        if operation == "start":
            self._only_keys(request, {"id", "op", "task_id", "experiment_name"})
            return self._start(request)
        if operation == "call":
            self._only_keys(request, {"id", "op", "app", "api", "arguments"})
            return self._call(request)
        if operation == "evaluate":
            self._only_keys(request, {"id", "op"})
            return self._evaluate()
        if operation == "close":
            self._only_keys(request, {"id", "op"})
            return self._close(save=True)
        raise BridgeError("unknown_op", f"Unsupported operation: {operation}.")

    @staticmethod
    def _only_keys(request: dict[str, Any], allowed: set[str]) -> None:
        unexpected = set(request) - allowed
        if unexpected:
            names = ", ".join(sorted(str(name) for name in unexpected))
            raise BridgeError("invalid_request", f"Unexpected request field(s): {names}.")

    def _start(self, request: dict[str, Any]) -> dict[str, Any]:
        if self.started:
            raise BridgeError("one_world_per_process", "This process can start only one AppWorld.")
        task_id = request.get("task_id")
        experiment_name = request.get("experiment_name")
        if not isinstance(task_id, str) or not _SAFE_TASK_ID.fullmatch(task_id):
            raise BridgeError("invalid_task_id", "task_id must be a simple AppWorld task id.")
        if task_id not in self.allowed_task_ids:
            raise BridgeError(
                "task_not_listed",
                "Call list_tasks for the intended split before starting a task.",
            )
        if not isinstance(experiment_name, str) or not _SAFE_NAME.fullmatch(experiment_name):
            raise BridgeError(
                "invalid_experiment_name",
                "experiment_name must be a simple path-safe name.",
            )

        self.backend.ensure_fresh_output(task_id, experiment_name)
        world = self.backend.create_world(task_id, experiment_name)
        self.world = world
        self.task_id = task_id
        self.experiment_name = experiment_name
        self.started = True

        task = world.task
        supervisor = task.supervisor
        if isinstance(supervisor, Mapping):
            supervisor_data = dict(supervisor)
        elif hasattr(supervisor, "items"):
            supervisor_data = dict(supervisor.items())
        else:
            supervisor_data = vars(supervisor)
        return {
            "instruction": task.instruction,
            "supervisor": supervisor_data,
            "apps": task.app_descriptions,
            # Keep the full docs inside the bridge for call authorization. Only
            # return the helper app docs used to discover other APIs at runtime.
            "api_docs": {"api_docs": task.api_docs.get("api_docs", {})},
        }

    def _call(self, request: dict[str, Any]) -> Any:
        world = self._require_world()
        app = request.get("app")
        api = request.get("api")
        arguments = request.get("arguments", {})
        if not isinstance(app, str) or not isinstance(api, str):
            raise BridgeError("invalid_call", "app and api must be strings.")
        if not isinstance(arguments, dict):
            raise BridgeError("invalid_call", "arguments must be a JSON object.")
        if REQUESTER_CONTROL_FIELDS.intersection(arguments):
            raise BridgeError(
                "invalid_call",
                "arguments cannot override Requester control fields.",
            )
        task = world.task
        if app not in task.allowed_apps:
            raise BridgeError("api_not_allowed", "The app is not allowed for this task.")
        app_docs = task.api_docs.get(app)
        if app_docs is None or api not in app_docs:
            raise BridgeError("api_not_allowed", "The API is not in this task's public API docs.")
        if self.api_call_count >= MAX_API_CALLS:
            raise BridgeError("api_call_limit", f"The per-world API call limit is {MAX_API_CALLS}.")
        self.api_call_count += 1
        return world.requester.request(app, api, **arguments)

    def _evaluate(self) -> dict[str, Any]:
        world = self._require_world()
        if self.evaluated:
            raise BridgeError("already_evaluated", "This AppWorld has already been evaluated.")
        assert self.task_id is not None and self.experiment_name is not None
        # Save the terminal state, then grade while the native AppWorld is still
        # open. Closing first clears its live database/requester caches; the
        # backend evaluator must see the same state that the agent just changed.
        try:
            world.save()
            result = self.backend.evaluate(self.task_id, self.experiment_name)
        finally:
            self._close(save=False)
        safe_result = {
            key: result[key]
            for key in ("success", "difficulty", "num_tests", "passed_tests", "failed_tests")
            if key in result
        }
        self.evaluated = True
        return safe_result

    def _close(self, save: bool) -> dict[str, Any]:
        if self.world is None:
            self.closed = True
            return {"closed": True, "saved": False}
        world = self.world
        saved = False
        try:
            if save:
                world.save()
                saved = True
        finally:
            try:
                world.close()
            finally:
                self.world = None
                self.closed = True
        return {"closed": True, "saved": saved}

    def _require_world(self) -> Any:
        if self.world is None or self.closed:
            raise BridgeError("world_not_open", "Call start before using this operation.")
        return self.world

    def shutdown(self) -> None:
        """Save and close an active world when the JSONL input ends."""
        if self.world is not None:
            with redirect_stdout(sys.stderr):
                self._close(save=True)


def serve(stdin: Any = None, stdout: Any = None, backend: Backend | None = None) -> None:
    """Read one JSON request per line and emit exactly one JSON response per line."""
    input_stream = stdin or sys.stdin
    output_stream = stdout or sys.stdout
    bridge = AppWorldBridge(backend=backend)
    try:
        for line in input_stream:
            try:
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise BridgeError("invalid_request", "Each JSONL request must be an object.")
                response = bridge.dispatch(request)
            except json.JSONDecodeError:
                response = {
                    "id": None,
                    "ok": False,
                    "error": {"code": "invalid_json", "message": "Request line is not valid JSON."},
                }
            except BridgeError as error:
                response = {
                    "id": None,
                    "ok": False,
                    "error": {"code": error.code, "message": error.message},
                }
            output_stream.write(json.dumps(response, ensure_ascii=False, allow_nan=False) + "\n")
            output_stream.flush()
    finally:
        bridge.shutdown()


def main(argv: list[str] | None = None) -> None:
    import argparse

    parser = argparse.ArgumentParser(description="AppWorld JSONL bridge")
    parser.add_argument(
        "--root",
        type=Path,
        help="AppWorld root containing data/ and experiments/ (defaults to APPWORLD_ROOT or cwd).",
    )
    args = parser.parse_args(argv)
    if args.root is not None:
        root = args.root.expanduser().resolve()
        if not root.is_dir():
            parser.error(f"AppWorld root does not exist or is not a directory: {root}")
        os.environ["APPWORLD_ROOT"] = str(root)
        os.chdir(root)
    serve()


if __name__ == "__main__":
    main()
