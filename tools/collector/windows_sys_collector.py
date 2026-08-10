#!/usr/bin/env python3
"""Collect drivers and kernel components from Windows 10 and Windows 11 UUP releases.

The program uses the documented UUP dump JSON API only for catalog discovery and
signed-link generation.  The operating-system payloads are accepted only from
Microsoft hosts, verified against UUP-provided SHA-1 hashes, converted with the
hash-pinned UUP dump Windows converter, and mounted read-only with DISM.
"""

from __future__ import annotations

import argparse
import ctypes
import datetime as dt
import hashlib
import json
import locale
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import stat
import subprocess
import sys
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable
from urllib.parse import urlparse

try:
    import requests
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry
except ImportError:  # Reported cleanly after argument parsing.
    requests = None
    HTTPAdapter = None
    Retry = None


PROGRAM_VERSION = "1.4.0"
COLLECTION_SCHEMA_VERSION = 2
SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_OUTPUT = SCRIPT_DIR / "Collected_SYS"
DEFAULT_WORK_DIR = (
    Path(os.environ.get("ProgramData", str(SCRIPT_DIR)))
    / "WindowsSysCollector"
    / "work"
)
RELEASES_FILE = SCRIPT_DIR / "releases.json"
UUP_API_BASE = "https://api.uupdump.net"
CONVERTER_MANIFEST_URL = (
    "https://git.uupdump.net/uup-dump/misc/raw/branch/master/"
    "autodl_files/converter_windows"
)
USER_AGENT = f"WindowsSysCollector/{PROGRAM_VERSION} (+local archival tool)"
API_TIMEOUT = (30, 120)
DOWNLOAD_TIMEOUT = (30, 60)
DOWNLOAD_ATTEMPTS = 5
COPY_BUFFER_SIZE = 4 * 1024 * 1024
PROGRESS_REFRESH_SECONDS = 0.5
PROGRESS_LOG_SECONDS = 15.0
MIN_OUTPUT_FREE_GIB = 5
DRIVERS_ONLY_APP_EXTENSIONS = (
    ".appx",
    ".appxbundle",
    ".msix",
    ".msixbundle",
)

UNAVAILABLE_API_ERRORS = {
    "EMPTY_FILELIST",
    "MISSING_FILES",
    "NO_FILES",
    "SEARCH_NO_RESULTS",
    "UNSUPPORTED_COMBINATION",
    "UNSUPPORTED_EDITION",
    "UNSUPPORTED_LANG",
    "UPDATE_INFORMATION_NOT_EXISTS",
}

KERNEL_COMPONENT_NAMES = frozenset(
    {
        "bootvid.dll",
        "ci.dll",
        "hal.dll",
        "hvax64.exe",
        "hvix64.exe",
        "hvloader.dll",
        "hvloader.efi",
        "kd.dll",
        "kd1394.dll",
        "kdcom.dll",
        "kdcpw.dll",
        "kdhvcom.dll",
        "kdnet.dll",
        "kdnet_uart16550.dll",
        "kdstub.dll",
        "kdusb.dll",
        "ntoskrnl.exe",
        "pshed.dll",
        "securekernel.exe",
        "skci.dll",
        "symcryptk.dll",
        "winload.exe",
        "winload.efi",
        "winresume.exe",
        "winresume.efi",
    }
)


class CollectorError(RuntimeError):
    """Base class for expected collector failures."""


class ApiUnavailable(CollectorError):
    """The requested UUP release, language, edition, or files are unavailable."""


class DownloadError(CollectorError):
    """A download could not be completed or verified."""


class ExpiredDownloadError(DownloadError):
    """A signed Microsoft payload URL expired and must be refreshed."""


class CommandError(CollectorError):
    """An external command returned an error."""


class CleanupError(CollectorError):
    """Owned temporary data or a mounted image could not be cleaned safely."""


@dataclass(frozen=True)
class Release:
    release_id: str
    product: str
    version: str
    display_name: str
    build_major: int
    release_date: str
    minimum_free_gib: int
    architecture: str = "amd64"
    aliases: tuple[str, ...] = ()

    @property
    def architecture_label(self) -> str:
        return "x64" if self.architecture == "amd64" else self.architecture

    @classmethod
    def from_json(cls, value: dict[str, Any]) -> "Release":
        required = {
            "id",
            "product",
            "version",
            "display_name",
            "build_major",
            "release_date",
        }
        missing = sorted(required - value.keys())
        if missing:
            raise CollectorError(
                f"Release entry is missing required keys: {', '.join(missing)}"
            )
        return cls(
            release_id=str(value["id"]),
            product=str(value["product"]),
            version=str(value["version"]),
            display_name=str(value["display_name"]),
            build_major=int(value["build_major"]),
            release_date=str(value["release_date"]),
            minimum_free_gib=int(value.get("minimum_free_gib", 45)),
            architecture="amd64",
            aliases=tuple(str(item) for item in value.get("aliases", [])),
        )


@dataclass
class UupSelection:
    update_id: str
    title: str
    build: str
    arch: str
    created: int
    language: str
    edition: str
    files: dict[str, dict[str, Any]]


@dataclass(frozen=True)
class MountedImage:
    mount_dir: Path
    image_file: Path | None
    status: str | None


@dataclass
class RunSummary:
    completed: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    unavailable: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)

    def format(self) -> str:
        def line(name: str, values: list[str]) -> str:
            rendered = ", ".join(values) if values else "none"
            return f"{name} ({len(values)}): {rendered}"

        return "\n".join(
            [
                line("Completed", self.completed),
                line("Skipped", self.skipped),
                line("Unavailable", self.unavailable),
                line("Failed", self.failed),
            ]
        )


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def configure_standard_streams() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(errors="replace")
            except (OSError, ValueError):
                pass


def setup_logging(output_dir: Path) -> logging.Logger:
    output_dir.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("windows_sys_collector")
    logger.setLevel(logging.INFO)
    logger.handlers.clear()
    logger.propagate = False

    formatter = logging.Formatter(
        "%(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S"
    )
    file_handler = RotatingFileHandler(
        output_dir / "windows_sys_collector.log",
        maxBytes=10 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)

    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(formatter)
    logger.addHandler(console_handler)
    return logger


def is_administrator() -> bool:
    if os.name != "nt":
        return False
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except (AttributeError, OSError):
        return False


def windows_console_encoding() -> str:
    if os.name == "nt":
        try:
            return f"cp{ctypes.windll.kernel32.GetOEMCP()}"
        except (AttributeError, OSError):
            pass
    return locale.getpreferredencoding(False) or "utf-8"


def decode_command_output(data: bytes) -> str:
    return data.decode(windows_console_encoding(), errors="replace")


def write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(path.name + ".tmp")
    with temp_path.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, indent=2, ensure_ascii=False, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp_path, path)


def hash_file(path: Path, algorithm: str) -> str:
    digest = hashlib.new(algorithm)
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(COPY_BUFFER_SIZE)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def format_bytes(value: float) -> str:
    units = ("B", "KiB", "MiB", "GiB", "TiB")
    amount = float(max(0, value))
    for unit in units[:-1]:
        if amount < 1024:
            return f"{amount:.1f} {unit}"
        amount /= 1024
    return f"{amount:.1f} {units[-1]}"


def format_duration(seconds: float) -> str:
    value = max(0, int(seconds))
    hours, remainder = divmod(value, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f"{hours:d}:{minutes:02d}:{seconds:02d}"
    return f"{minutes:02d}:{seconds:02d}"


class DownloadProgress:
    def __init__(
        self,
        label: str,
        total: int | None,
        initial: int,
        overall_base: int,
        overall_total: int | None,
        logger: logging.Logger,
    ):
        self.label = label
        self.total = total
        self.initial = initial
        self.overall_base = overall_base
        self.overall_total = overall_total
        self.logger = logger
        self.started = time.monotonic()
        self.last_render = 0.0
        self.last_log = self.started
        self.rendered_width = 0
        self.tty = bool(getattr(sys.stdout, "isatty", lambda: False)())
        self.finished = False

    def message(self, current: int) -> str:
        elapsed = max(time.monotonic() - self.started, 0.001)
        transferred = max(0, current - self.initial)
        speed = transferred / elapsed
        parts = [self.label]
        if self.total:
            percent = min(100.0, current * 100.0 / self.total)
            parts.append(
                f"{percent:5.1f}% {format_bytes(current)}/{format_bytes(self.total)}"
            )
        else:
            parts.append(format_bytes(current))
        parts.append(f"{format_bytes(speed)}/s")
        if self.total and speed > 0 and current < self.total:
            parts.append(f"ETA {format_duration((self.total - current) / speed)}")
        if self.overall_total:
            overall = min(
                100.0,
                (self.overall_base + current) * 100.0 / self.overall_total,
            )
            parts.append(f"release {overall:5.1f}%")
        return " | ".join(parts)

    def update(self, current: int, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self.last_render < PROGRESS_REFRESH_SECONDS:
            return
        self.last_render = now
        message = self.message(current)
        if self.tty:
            columns = shutil.get_terminal_size((140, 25)).columns
            maximum = max(20, columns - 1)
            if len(message) > maximum:
                message = message[: max(0, maximum - 3)] + "..."
            padding = " " * max(0, self.rendered_width - len(message))
            sys.stdout.write("\r" + message + padding)
            sys.stdout.flush()
            self.rendered_width = len(message)
        elif force or now - self.last_log >= PROGRESS_LOG_SECONDS:
            self.logger.info("%s", message)
            self.last_log = now

    def finish(self, current: int) -> None:
        if self.finished:
            return
        self.update(current, force=True)
        if self.tty:
            sys.stdout.write("\n")
            sys.stdout.flush()
        self.finished = True


def normalized_path(path: Path) -> str:
    return os.path.normcase(os.path.abspath(str(path)))


def is_within(path: Path, root: Path) -> bool:
    try:
        return os.path.commonpath([normalized_path(path), normalized_path(root)]) == normalized_path(root)
    except ValueError:
        return False


def make_writable_and_retry(function: Callable[..., Any], path: str, _: Any) -> None:
    os.chmod(path, stat.S_IWRITE)
    function(path)


def safe_rmtree(path: Path, allowed_root: Path) -> None:
    if not path.exists():
        return
    if normalized_path(path) == normalized_path(allowed_root) or not is_within(
        path, allowed_root
    ):
        raise CleanupError(f"Refusing to delete unsafe path: {path}")
    for attempt in range(5):
        if not path.exists():
            return
        try:
            shutil.rmtree(path, onerror=make_writable_and_retry)
            return
        except OSError as exc:
            if getattr(exc, "winerror", None) not in {5, 32, 145} or attempt == 4:
                raise
            time.sleep(attempt + 1)


def existing_ancestor(path: Path) -> Path:
    current = path
    while not current.exists() and current.parent != current:
        current = current.parent
    if not current.exists():
        raise CollectorError(f"No existing ancestor found for path: {path}")
    return current


def check_disk_space(release: Release, output_dir: Path, work_dir: Path) -> None:
    work_anchor = existing_ancestor(work_dir)
    output_anchor = existing_ancestor(output_dir)
    work_free = shutil.disk_usage(work_anchor).free
    work_required = release.minimum_free_gib * 1024**3
    if work_free < work_required:
        raise CollectorError(
            f"{release.display_name} needs at least {release.minimum_free_gib} GiB "
            f"free on {work_anchor}; only {work_free / 1024**3:.1f} GiB is available"
        )

    if Path(work_anchor.anchor).resolve() != Path(output_anchor.anchor).resolve():
        output_free = shutil.disk_usage(output_anchor).free
        output_required = MIN_OUTPUT_FREE_GIB * 1024**3
        if output_free < output_required:
            raise CollectorError(
                f"The output volume needs at least {MIN_OUTPUT_FREE_GIB} GiB free; "
                f"only {output_free / 1024**3:.1f} GiB is available"
            )


class StateStore:
    def __init__(self, path: Path):
        self.path = path
        self.data: dict[str, Any] = {
            "schema_version": 1,
            "program_version": PROGRAM_VERSION,
            "releases": {},
            "active_mount": None,
            "active_subst": None,
            "last_updated_utc": utc_now(),
        }
        if path.exists():
            try:
                with path.open("r", encoding="utf-8-sig") as handle:
                    loaded = json.load(handle)
            except (OSError, json.JSONDecodeError) as exc:
                raise CollectorError(f"State file is unreadable: {path}: {exc}") from exc
            if not isinstance(loaded, dict) or loaded.get("schema_version") != 1:
                raise CollectorError(f"Unsupported or invalid state file: {path}")
            self.data.update(loaded)
            self.data.setdefault("releases", {})
            self.data.setdefault("active_mount", None)
            self.data.setdefault("active_subst", None)

    def save(self) -> None:
        self.data["program_version"] = PROGRAM_VERSION
        self.data["last_updated_utc"] = utc_now()
        write_json_atomic(self.path, self.data)

    def release(self, release_id: str) -> dict[str, Any]:
        return self.data.setdefault("releases", {}).setdefault(release_id, {})

    def update_release(self, release_id: str, status: str, **values: Any) -> None:
        entry = self.release(release_id)
        entry.update(values)
        entry["status"] = status
        entry["updated_utc"] = utc_now()
        self.save()

    def set_active_mount(self, value: dict[str, Any] | None) -> None:
        self.data["active_mount"] = value
        self.save()

    def set_active_subst(self, value: dict[str, Any] | None) -> None:
        self.data["active_subst"] = value
        self.save()


class InstanceLock:
    """Prevent two collectors from using the same work directory concurrently."""

    def __init__(self, path: Path):
        self.path = path
        self.handle: Any = None

    def __enter__(self) -> "InstanceLock":
        import msvcrt

        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = self.path.open("a+b")
        self.handle.seek(0)
        if self.handle.tell() == 0:
            self.handle.write(b"0")
            self.handle.flush()
        self.handle.seek(0)
        try:
            msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as exc:
            self.handle.close()
            self.handle = None
            raise CollectorError(
                f"Another collector is already using work directory {self.path.parent}"
            ) from exc
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        if self.handle is None:
            return
        import msvcrt

        try:
            self.handle.seek(0)
            msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
        finally:
            self.handle.close()
            self.handle = None


def create_http_session() -> Any:
    if requests is None or HTTPAdapter is None or Retry is None:
        raise CollectorError(
            "Missing Python dependencies. Run: py -3 -m pip install -r requirements.txt"
        )
    retry = Retry(
        total=5,
        connect=5,
        read=5,
        status=5,
        backoff_factor=1.0,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET"}),
        respect_retry_after_header=True,
        raise_on_status=False,
    )
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
    adapter = HTTPAdapter(max_retries=retry, pool_connections=4, pool_maxsize=4)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def host_matches(host: str, suffix: str) -> bool:
    return host == suffix or host.endswith("." + suffix)


def validate_source_url(url: str, source_type: str) -> str:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in {"http", "https"} or not host:
        raise DownloadError(f"Rejected malformed download URL: {url}")

    if source_type == "microsoft":
        allowed = host_matches(host, "microsoft.com") or host_matches(
            host, "windowsupdate.com"
        )
    elif source_type == "uupdump":
        allowed = parsed.scheme == "https" and host_matches(host, "uupdump.net")
    else:
        allowed = False
    if not allowed:
        raise DownloadError(f"Rejected untrusted {source_type} host: {host}")
    return host


class UupDumpApi:
    def __init__(self, session: Any, logger: logging.Logger):
        self.session = session
        self.logger = logger

    def request(self, endpoint: str, params: dict[str, Any]) -> dict[str, Any]:
        url = f"{UUP_API_BASE}/{endpoint}"
        try:
            response = self.session.get(url, params=params, timeout=API_TIMEOUT)
        except requests.RequestException as exc:
            raise CollectorError(f"UUP dump API request failed: {exc}") from exc
        if response.status_code == 429:
            raise CollectorError("UUP dump API rate limit was exceeded")
        try:
            payload = response.json()
        except (ValueError, json.JSONDecodeError) as exc:
            raise CollectorError(
                f"UUP dump API returned non-JSON data (HTTP {response.status_code})"
            ) from exc
        body = payload.get("response") if isinstance(payload, dict) else None
        if not isinstance(body, dict):
            raise CollectorError("UUP dump API response did not contain a response object")
        error = body.get("error")
        if error:
            error_text = str(error)
            error_code = error_text.split()[0].strip(":")
            if error_code in UNAVAILABLE_API_ERRORS:
                raise ApiUnavailable(error_text)
            raise CollectorError(f"UUP dump API error: {error_text}")
        if not response.ok:
            raise CollectorError(f"UUP dump API returned HTTP {response.status_code}")
        return body

    @staticmethod
    def candidate_score(release: Release, candidate: dict[str, Any]) -> tuple[int, int, int]:
        title = str(candidate.get("title", "")).lower()
        score = 0
        if release.product.lower() in title:
            score += 100
        if release.version.lower() in title:
            score += 80
        if "feature update" in title or ", version " in title:
            score += 20
        if "retail" in title:
            score += 10
        for unwanted in ("insider", "server", "cumulative update", "dynamic update"):
            if unwanted in title:
                score -= 250
        created = int(candidate.get("created") or 0)
        build = str(candidate.get("build") or "0.0")
        try:
            revision = int(build.split(".", 1)[1])
        except (IndexError, ValueError):
            revision = 0
        return score, created, revision

    def list_candidates(self, release: Release) -> list[dict[str, Any]]:
        body = self.request(
            "listid.php",
            {"search": f"{release.build_major} {release.architecture}", "sortByDate": 1},
        )
        builds = body.get("builds", [])
        if isinstance(builds, dict):
            candidates = [value for value in builds.values() if isinstance(value, dict)]
        elif isinstance(builds, list):
            candidates = [value for value in builds if isinstance(value, dict)]
        else:
            raise CollectorError("UUP dump listid.php returned an invalid builds value")

        filtered: list[dict[str, Any]] = []
        for candidate in candidates:
            arch = str(candidate.get("arch", "")).lower()
            build = str(candidate.get("build", ""))
            title = str(candidate.get("title", ""))
            if arch != release.architecture or build.split(".", 1)[0] != str(release.build_major):
                continue
            title_lower = title.lower()
            if release.product.lower() not in title_lower:
                continue
            if any(
                unwanted in title_lower
                for unwanted in (
                    "insider preview",
                    "server",
                    "cumulative update",
                    "dynamic update",
                    "servicing stack",
                    "safe os",
                    "windows pe",
                )
            ):
                continue
            filtered.append(candidate)
        filtered.sort(key=lambda item: self.candidate_score(release, item), reverse=True)
        return filtered

    def language_and_edition(self, update_id: str) -> tuple[str, str]:
        languages = self.request("listlangs.php", {"id": update_id}).get("langList", [])
        language = next(
            (str(item) for item in languages if str(item).casefold() == "en-us"), None
        )
        if language is None:
            raise ApiUnavailable("English (United States) is not available")

        editions = self.request(
            "listeditions.php", {"id": update_id, "lang": language}
        ).get("editionList", [])
        edition = next(
            (str(item) for item in editions if str(item).casefold() == "professional"),
            None,
        )
        if edition is None:
            raise ApiUnavailable("Windows Pro (PROFESSIONAL) is not available")
        return language, edition

    def get_files(
        self,
        release: Release,
        update_id: str,
        language: str,
        edition: str,
        title: str = "",
        created: int = 0,
    ) -> UupSelection:
        body = self.request(
            "get.php",
            {"id": update_id, "lang": language, "edition": edition},
        )
        arch = str(body.get("arch", ""))
        build = str(body.get("build", ""))
        files = body.get("files")
        if arch.lower() != release.architecture:
            raise ApiUnavailable(
                f"UUP set architecture is {arch}, not {release.architecture}"
            )
        if build.split(".", 1)[0] != str(release.build_major):
            raise ApiUnavailable(
                f"UUP set build {build} does not match {release.build_major}"
            )
        if not isinstance(files, dict) or not files:
            raise ApiUnavailable("UUP set contains no downloadable files")
        return UupSelection(
            update_id=update_id,
            title=str(body.get("updateName") or title),
            build=build,
            arch=arch,
            created=created,
            language=language,
            edition=edition,
            files={str(name): value for name, value in files.items() if isinstance(value, dict)},
        )

    def discover(self, release: Release) -> UupSelection:
        candidates = self.list_candidates(release)
        if not candidates:
            raise ApiUnavailable(
                f"No {release.architecture_label} {release.product} build "
                f"{release.build_major} is indexed"
            )
        reasons: list[str] = []
        for candidate in candidates:
            update_id = str(candidate.get("uuid", ""))
            if not update_id:
                continue
            try:
                language, edition = self.language_and_edition(update_id)
                selection = self.get_files(
                    release,
                    update_id,
                    language,
                    edition,
                    title=str(candidate.get("title", "")),
                    created=int(candidate.get("created") or 0),
                )
                self.logger.info(
                    "Selected %s: %s (%s)",
                    release.display_name,
                    selection.title,
                    selection.update_id,
                )
                return selection
            except ApiUnavailable as exc:
                reasons.append(f"{update_id}: {exc}")
        suffix = f" Last result: {reasons[-1]}" if reasons else ""
        raise ApiUnavailable(
            f"No indexed build offers {release.architecture_label} en-US "
            f"Windows Pro.{suffix}"
        )

    def resume_or_discover(
        self, release: Release, previous: dict[str, Any]
    ) -> UupSelection:
        selected = previous.get("selection")
        if isinstance(selected, dict) and selected.get("update_id"):
            update_id = str(selected["update_id"])
            language = str(selected.get("language", "en-us"))
            edition = str(selected.get("edition", "PROFESSIONAL"))
            try:
                result = self.get_files(
                    release,
                    update_id,
                    language,
                    edition,
                    title=str(selected.get("title", "")),
                    created=int(selected.get("created") or 0),
                )
                self.logger.info("Resuming selected UUP set %s", update_id)
                return result
            except ApiUnavailable:
                self.logger.warning(
                    "Previously selected UUP set %s is unavailable; rediscovering", update_id
                )
        return self.discover(release)


def sanitize_uup_filename(name: str) -> str:
    if not name or name in {".", ".."}:
        raise DownloadError("UUP API returned an empty or invalid filename")
    if any(character in name for character in ("/", "\\", ":")):
        raise DownloadError(f"UUP API returned a path instead of a filename: {name}")
    if name.rstrip(" .") != name:
        raise DownloadError(f"UUP API returned an unsafe Windows filename: {name}")
    stem = name.split(".", 1)[0].casefold()
    if stem in {"con", "prn", "aux", "nul"} or re.fullmatch(r"(?:com|lpt)[1-9]", stem):
        raise DownloadError(f"UUP API returned a reserved Windows filename: {name}")
    return name


def verify_file(path: Path, size: int | None, algorithm: str, expected_hash: str) -> bool:
    if not path.is_file():
        return False
    if size is not None and path.stat().st_size != size:
        return False
    return hash_file(path, algorithm).casefold() == expected_hash.casefold()


def download_with_resume(
    session: Any,
    logger: logging.Logger,
    url: str,
    destination: Path,
    expected_size: int | None,
    algorithm: str,
    expected_hash: str,
    source_type: str,
    progress_label: str | None = None,
    overall_base: int = 0,
    overall_total: int | None = None,
) -> None:
    validate_source_url(url, source_type)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file():
        logger.info("Checking existing download: %s", destination.name)
    if verify_file(destination, expected_size, algorithm, expected_hash):
        logger.info("Verified existing download: %s", destination.name)
        return
    if destination.exists():
        destination.unlink()

    partial = destination.with_name(destination.name + ".part")
    if partial.exists() and expected_size is not None and partial.stat().st_size > expected_size:
        partial.unlink()

    last_error: Exception | None = None
    label = progress_label or destination.name
    for attempt in range(1, DOWNLOAD_ATTEMPTS + 1):
        start = partial.stat().st_size if partial.exists() else 0
        written = start
        headers = {"Accept": "*/*"}
        if start:
            headers["Range"] = f"bytes={start}-"
        progress = DownloadProgress(
            label,
            expected_size,
            start,
            overall_base,
            overall_total,
            logger,
        )
        try:
            logger.info(
                "Downloading %s%s (%s, attempt %d/%d)",
                destination.name,
                f" from {format_bytes(start)}" if start else "",
                format_bytes(expected_size) if expected_size is not None else "size unknown",
                attempt,
                DOWNLOAD_ATTEMPTS,
            )
            progress.update(written, force=True)
            with session.get(
                url,
                headers=headers,
                stream=True,
                timeout=DOWNLOAD_TIMEOUT,
                allow_redirects=True,
            ) as response:
                if response.status_code in {403, 404, 410}:
                    raise ExpiredDownloadError(
                        f"Download URL returned HTTP {response.status_code}"
                    )
                if response.status_code == 416:
                    if partial.exists() and verify_file(
                        partial, expected_size, algorithm, expected_hash
                    ):
                        progress.finish(partial.stat().st_size)
                        os.replace(partial, destination)
                        logger.info(
                            "Completed download verified after HTTP 416: %s",
                            destination.name,
                        )
                        return
                    partial.unlink(missing_ok=True)
                    raise DownloadError("Server rejected the saved HTTP range")
                response.raise_for_status()
                validate_source_url(response.url, source_type)

                mode = "ab"
                if start and response.status_code == 200:
                    progress.finish(written)
                    logger.warning(
                        "Server ignored HTTP Range for %s; restarting that file",
                        destination.name,
                    )
                    start = 0
                    written = 0
                    mode = "wb"
                    progress = DownloadProgress(
                        label,
                        expected_size,
                        0,
                        overall_base,
                        overall_total,
                        logger,
                    )
                    progress.update(0, force=True)
                elif start and response.status_code != 206:
                    raise DownloadError(
                        f"Expected HTTP 206 while resuming, got {response.status_code}"
                    )
                elif not start:
                    mode = "wb"

                if response.status_code == 206 and start:
                    content_range = response.headers.get("Content-Range", "")
                    if not content_range.startswith(f"bytes {start}-"):
                        raise DownloadError(
                            f"Invalid Content-Range while resuming {destination.name}: "
                            f"{content_range!r}"
                        )

                if expected_size is None:
                    content_length = response.headers.get("Content-Length")
                    if content_length and content_length.isdigit():
                        response_size = int(content_length)
                        progress.total = (
                            start + response_size
                            if response.status_code == 206
                            else response_size
                        )

                digest = hashlib.new(algorithm)
                if mode == "ab" and start:
                    with partial.open("rb") as existing_handle:
                        while True:
                            chunk = existing_handle.read(COPY_BUFFER_SIZE)
                            if not chunk:
                                break
                            digest.update(chunk)

                with partial.open(mode) as handle:
                    for chunk in response.iter_content(chunk_size=COPY_BUFFER_SIZE):
                        if not chunk:
                            continue
                        handle.write(chunk)
                        digest.update(chunk)
                        written += len(chunk)
                        progress.update(written)
                    handle.flush()
                    os.fsync(handle.fileno())

            if expected_size is not None and partial.stat().st_size != expected_size:
                raise DownloadError(
                    f"Size mismatch for {destination.name}: got {partial.stat().st_size}, "
                    f"expected {expected_size}"
                )
            actual_hash = digest.hexdigest()
            if actual_hash.casefold() != expected_hash.casefold():
                partial.unlink(missing_ok=True)
                raise DownloadError(
                    f"{algorithm.upper()} mismatch for {destination.name}: "
                    f"got {actual_hash}, expected {expected_hash}"
                )
            progress.finish(written)
            os.replace(partial, destination)
            logger.info("Download verified: %s", destination.name)
            return
        except ExpiredDownloadError:
            current = partial.stat().st_size if partial.exists() else written
            progress.finish(current)
            raise
        except (requests.RequestException, OSError, DownloadError) as exc:
            current = partial.stat().st_size if partial.exists() else written
            progress.finish(current)
            last_error = exc
            if attempt < DOWNLOAD_ATTEMPTS:
                delay = min(30, 2 ** (attempt - 1))
                logger.warning(
                    "Download attempt failed for %s: %s; retrying in %d seconds",
                    destination.name,
                    exc,
                    delay,
                )
                time.sleep(delay)
    raise DownloadError(f"Download failed for {destination.name}: {last_error}")

def selection_state(selection: UupSelection) -> dict[str, Any]:
    return {
        "update_id": selection.update_id,
        "title": selection.title,
        "build": selection.build,
        "arch": selection.arch,
        "created": selection.created,
        "language": selection.language,
        "edition": selection.edition,
    }


def uup_file_is_optional_for_drivers_only(name: str, build: str) -> bool:
    lowered = name.casefold()
    if lowered.endswith(".wim") and "edge" in lowered:
        return True
    try:
        build_number = int(build.partition(".")[0])
    except ValueError:
        return False
    return build_number >= 22563 and lowered.endswith(DRIVERS_ONLY_APP_EXTENSIONS)


def download_uup_files(
    release: Release,
    selection: UupSelection,
    api: UupDumpApi,
    session: Any,
    destination: Path,
    drivers_only: bool,
    logger: logging.Logger,
) -> list[dict[str, Any]]:
    destination.mkdir(parents=True, exist_ok=True)
    casefold_names: dict[str, str] = {}
    download_records: list[dict[str, Any]] = []
    excluded_count = 0
    excluded_size = 0

    for raw_name in sorted(selection.files, key=str.casefold):
        name = sanitize_uup_filename(raw_name)
        entry = selection.files[raw_name]
        if drivers_only and uup_file_is_optional_for_drivers_only(
            name, selection.build
        ):
            excluded_count += 1
            try:
                excluded_size += max(0, int(entry.get("size", 0)))
            except (TypeError, ValueError):
                pass
            logger.debug("Skipping converter-optional UUP payload: %s", name)
            continue
        folded = name.casefold()
        if folded in casefold_names and casefold_names[folded] != name:
            raise DownloadError(
                f"Case-insensitive filename collision in UUP set: "
                f"{casefold_names[folded]!r} and {name!r}"
            )
        casefold_names[folded] = name

        expected_hash = str(entry.get("sha1") or "").lower()
        url = str(entry.get("url") or "")
        try:
            expected_size = int(entry["size"])
        except (KeyError, TypeError, ValueError) as exc:
            raise DownloadError(f"Missing size for UUP file {name}") from exc
        if not re.fullmatch(r"[0-9a-f]{40}", expected_hash):
            raise DownloadError(f"Missing or invalid SHA-1 for UUP file {name}")
        if not url:
            raise ApiUnavailable(f"No current Microsoft download URL for {name}")
        download_records.append(
            {
                "name": name,
                "size": expected_size,
                "sha1": expected_hash,
                "url": url,
            }
        )

    if excluded_count:
        logger.info(
            "Drivers-only optimization: skipping %d converter-optional UUP "
            "payload(s), saving %s of downloads",
            excluded_count,
            format_bytes(excluded_size),
        )

    total_files = len(download_records)
    total_size = sum(int(record["size"]) for record in download_records)
    saved_size = 0
    for record in download_records:
        name = str(record["name"])
        size = int(record["size"])
        complete_path = destination / name
        partial_path = destination / f"{name}.part"
        if complete_path.is_file():
            saved_size += min(size, complete_path.stat().st_size)
        elif partial_path.is_file():
            saved_size += min(size, partial_path.stat().st_size)

    logger.info(
        "UUP download plan for %s: %d files, %s total, %s already saved",
        release.display_name,
        total_files,
        format_bytes(total_size),
        format_bytes(saved_size),
    )

    completed_size = 0
    for index, record in enumerate(download_records, start=1):
        name = str(record["name"])
        expected_size = int(record["size"])
        expected_hash = str(record["sha1"])
        url = str(record["url"])
        if len(name) > 52:
            progress_name = name[:25] + "..." + name[-24:]
        else:
            progress_name = name
        progress_label = f"[UUP {index}/{total_files}] {progress_name}"

        expired_attempts = 0
        while True:
            try:
                download_with_resume(
                    session,
                    logger,
                    url,
                    destination / name,
                    expected_size,
                    "sha1",
                    expected_hash,
                    "microsoft",
                    progress_label=progress_label,
                    overall_base=completed_size,
                    overall_total=total_size,
                )
                break
            except ExpiredDownloadError:
                expired_attempts += 1
                if expired_attempts >= 3:
                    raise DownloadError(
                        f"Microsoft download URL repeatedly expired for {name}"
                    )
                logger.info("Refreshing signed UUP links after expiry for %s", name)
                refreshed = api.get_files(
                    release,
                    selection.update_id,
                    selection.language,
                    selection.edition,
                    title=selection.title,
                    created=selection.created,
                )
                refreshed_by_name = {
                    key.casefold(): value for key, value in refreshed.files.items()
                }
                refreshed_entry = refreshed_by_name.get(name.casefold())
                if not isinstance(refreshed_entry, dict):
                    raise ApiUnavailable(f"Refreshed UUP set no longer contains {name}")
                new_hash = str(refreshed_entry.get("sha1") or "").lower()
                try:
                    new_size = int(refreshed_entry["size"])
                except (KeyError, TypeError, ValueError) as exc:
                    raise DownloadError(f"Refreshed metadata is invalid for {name}") from exc
                if new_hash != expected_hash or new_size != expected_size:
                    raise DownloadError(
                        f"Refreshed metadata changed unexpectedly for UUP file {name}"
                    )
                url = str(refreshed_entry.get("url") or "")
                if not url:
                    raise ApiUnavailable(f"No refreshed Microsoft URL for {name}")

        completed_size += expected_size
        logger.info(
            "UUP file %d/%d complete; release download %.1f%%",
            index,
            total_files,
            completed_size * 100.0 / total_size if total_size else 100.0,
        )

    source_records = [
        {
            "name": str(record["name"]),
            "size": int(record["size"]),
            "sha1": str(record["sha1"]),
        }
        for record in download_records
    ]
    write_json_atomic(
        destination.parent / "uup_manifest.json",
        {
            "release": release.release_id,
            "selection": selection_state(selection),
            "files": source_records,
        },
    )
    return source_records

def fetch_converter_manifest(
    session: Any, cache_dir: Path, logger: logging.Logger
) -> str:
    validate_source_url(CONVERTER_MANIFEST_URL, "uupdump")
    cache_path = cache_dir / "converter_windows.manifest"
    try:
        response = session.get(CONVERTER_MANIFEST_URL, timeout=API_TIMEOUT)
        response.raise_for_status()
        validate_source_url(response.url, "uupdump")
        text = response.text
        if "checksum=sha-256=" not in text:
            raise DownloadError("UUP converter manifest has no SHA-256 checksums")
        cache_dir.mkdir(parents=True, exist_ok=True)
        temp_path = cache_path.with_name(cache_path.name + ".tmp")
        temp_path.write_text(text, encoding="utf-8", newline="\n")
        os.replace(temp_path, cache_path)
        return text
    except (requests.RequestException, OSError, DownloadError) as exc:
        if cache_path.is_file():
            logger.warning(
                "Could not refresh converter manifest (%s); using verified cached manifest",
                exc,
            )
            return cache_path.read_text(encoding="utf-8-sig")
        raise DownloadError(f"Could not retrieve UUP converter manifest: {exc}") from exc


def parse_converter_manifest(text: str) -> dict[str, dict[str, str]]:
    records: dict[str, dict[str, str]] = {}
    current: dict[str, str] | None = None
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith(("https://", "http://")):
            current = {"url": line}
            continue
        if current is None:
            continue
        if line.startswith("out="):
            current["name"] = line[4:].strip()
        elif line.startswith("checksum=sha-256="):
            current["sha256"] = line.partition("checksum=sha-256=")[2].strip().lower()
            name = current.get("name")
            if name:
                records[name] = current
            current = None
    return records


def prepare_converter_archive(
    session: Any, work_dir: Path, logger: logging.Logger
) -> tuple[Path, dict[str, str], Path]:
    cache_dir = work_dir / "tools"
    manifest = fetch_converter_manifest(session, cache_dir, logger)
    records = parse_converter_manifest(manifest)
    record = records.get("uup-converter-wimlib.7z")
    extractor_record = records.get("7zr.exe")
    if not record:
        raise DownloadError("UUP converter manifest does not define uup-converter-wimlib.7z")
    if not extractor_record:
        raise DownloadError("UUP converter manifest does not define 7zr.exe")

    for index, (name, item) in enumerate(
        (
            ("uup-converter-wimlib.7z", record),
            ("7zr.exe", extractor_record),
        ),
        start=1,
    ):
        expected_hash = item.get("sha256", "")
        if not re.fullmatch(r"[0-9a-f]{64}", expected_hash):
            raise DownloadError(f"UUP converter manifest has an invalid SHA-256 for {name}")
        download_with_resume(
            session,
            logger,
            item.get("url", ""),
            cache_dir / name,
            None,
            "sha256",
            expected_hash,
            "uupdump",
            progress_label=f"[tool {index}/2] {name}",
        )

    record = dict(record)
    record["extractor_url"] = extractor_record["url"]
    record["extractor_sha256"] = extractor_record["sha256"]
    return (
        cache_dir / "uup-converter-wimlib.7z",
        record,
        cache_dir / "7zr.exe",
    )


def validate_archive_member(name: str) -> None:
    normalized = name.replace("\\", "/")
    path = PurePosixPath(normalized)
    if path.is_absolute() or ".." in path.parts or any(":" in part for part in path.parts):
        raise DownloadError(f"Unsafe path in converter archive: {name}")


def extract_converter(
    archive: Path,
    release_dir: Path,
    extractor: Path,
    logger: logging.Logger,
) -> None:
    converter_script = release_dir / "convert-UUP.cmd"
    if converter_script.is_file():
        return
    release_dir.mkdir(parents=True, exist_ok=True)

    listing = run_capture(
        [str(extractor), "l", "-slt", str(archive)],
        logger,
    )
    in_members = False
    member_count = 0
    for line in decode_command_output(listing.stdout).splitlines():
        if line.strip().startswith("----------"):
            in_members = True
            continue
        if in_members and line.startswith("Path = "):
            validate_archive_member(line.partition("Path = ")[2])
            member_count += 1
    if member_count == 0:
        raise DownloadError("UUP converter archive contained no listable members")

    run_capture(
        [str(extractor), "x", "-y", f"-o{release_dir}", str(archive)],
        logger,
    )
    if not converter_script.is_file():
        raise DownloadError("UUP converter archive did not contain convert-UUP.cmd")


def write_converter_config(release_dir: Path, drivers_only: bool) -> None:
    value = 1 if drivers_only else 0
    config = f"""[convert-UUP]
AutoStart =1
AddUpdates =1
Cleanup =0
ResetBase =0
NetFx3 =0
StartVirtual =0
wim2esd =0
wim2swm =0
SkipISO =1
SkipWinRE ={value}
LCUwinre =0
LCUmsuExpand =0
UpdtBootFiles =0
ForceDism =0
RefESD =0
SkipLCUmsu =0
SkipEdge ={value}
AutoExit =1
DisableUpdatingUpgrade =0
AddDrivers =0
Drv_Source =\\Drivers

[Store_Apps]
SkipApps ={value}
AppsLevel =0
StubAppsFull =0
CustomList =0

[create_virtual_editions]
vUseDism =1
vAutoStart =0
vDeleteSource =0
vPreserve =0
vwim2esd =0
vwim2swm =0
vSkipISO =1
vAutoEditions =
vSortEditions =
"""
    (release_dir / "ConvertConfig.ini").write_text(
        config, encoding="utf-8", newline="\r\n"
    )


def run_capture(
    arguments: list[str],
    logger: logging.Logger,
    cwd: Path | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[bytes]:
    logger.info("Running: %s", subprocess.list2cmdline(arguments))
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    result = subprocess.run(
        arguments,
        cwd=str(cwd) if cwd else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        shell=False,
        check=False,
        creationflags=creationflags,
    )
    output = decode_command_output(result.stdout)
    if output.strip():
        logger.info("Command output:\n%s", output.rstrip())
    if check and result.returncode != 0:
        raise CommandError(
            f"Command failed with exit code {result.returncode}: "
            f"{subprocess.list2cmdline(arguments)}\n{output[-4000:]}"
        )
    return result


def stop_process_tree(process: subprocess.Popen[bytes], logger: logging.Logger) -> None:
    if process.poll() is not None:
        return
    try:
        process.send_signal(signal.CTRL_BREAK_EVENT)
        process.wait(timeout=10)
        return
    except (OSError, subprocess.TimeoutExpired):
        pass
    taskkill = shutil.which("taskkill.exe")
    if taskkill:
        run_capture(
            [taskkill, "/PID", str(process.pid), "/T", "/F"],
            logger,
            check=False,
        )
    else:
        process.kill()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        logger.error("Converter process %d did not terminate", process.pid)


def run_streamed(arguments: list[str], cwd: Path, logger: logging.Logger) -> None:
    logger.info("Running: %s", subprocess.list2cmdline(arguments))
    creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    process = subprocess.Popen(
        arguments,
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        shell=False,
        creationflags=creationflags,
    )
    try:
        assert process.stdout is not None
        for raw_line in iter(process.stdout.readline, b""):
            logger.info("[converter] %s", decode_command_output(raw_line).rstrip())
        return_code = process.wait()
    except KeyboardInterrupt:
        logger.warning("Interrupt received; stopping UUP converter")
        stop_process_tree(process, logger)
        raise
    if return_code != 0:
        raise CommandError(f"UUP converter exited with code {return_code}")


def list_subst_mappings(logger: logging.Logger) -> dict[str, Path]:
    subst = shutil.which("subst.exe")
    if subst is None:
        return {}
    result = run_capture([subst], logger, check=False)
    mappings: dict[str, Path] = {}
    text = decode_command_output(result.stdout)
    for line in text.splitlines():
        match = re.match(r"^([A-Za-z]):\\:\s*=>\s*(.+)$", line.strip())
        if match:
            mappings[match.group(1).upper() + ":"] = Path(match.group(2).strip())
    return mappings


def remove_owned_subst_mappings(work_dir: Path, logger: logging.Logger) -> None:
    subst = shutil.which("subst.exe")
    if subst is None:
        return
    for drive, target in list_subst_mappings(logger).items():
        if is_within(target, work_dir):
            logger.warning("Removing stale collector SUBST mapping %s -> %s", drive, target)
            result = run_capture([subst, drive, "/D"], logger, check=False)
            if result.returncode != 0:
                raise CleanupError(f"Could not remove owned SUBST mapping {drive}")


class SpaceSafeWorkingDirectory:
    """Expose a space-containing converter path through a temporary SUBST drive."""

    def __init__(
        self,
        physical_path: Path,
        state: StateStore,
        logger: logging.Logger,
    ):
        self.physical_path = physical_path
        self.state = state
        self.logger = logger
        self.drive: str | None = None
        self.command_path = physical_path

    def __enter__(self) -> Path:
        if " " not in str(self.physical_path):
            return self.command_path
        if str(self.physical_path).startswith("\\\\"):
            raise CollectorError(
                "The UUP converter cannot use a space-containing UNC work directory; "
                "choose a local --work-dir"
            )
        subst = shutil.which("subst.exe")
        if subst is None:
            raise CollectorError("subst.exe is required for a work path containing spaces")
        used_mask = ctypes.windll.kernel32.GetLogicalDrives()
        mappings = list_subst_mappings(self.logger)
        for letter in reversed("PQRSTUVWXYZ"):
            bit = 1 << (ord(letter) - ord("A"))
            drive = letter + ":"
            if not (used_mask & bit) and drive not in mappings:
                self.drive = drive
                break
        if self.drive is None:
            raise CollectorError("No free drive letter is available for the UUP converter")
        run_capture([subst, self.drive, str(self.physical_path)], self.logger)
        self.command_path = Path(self.drive + "\\")
        self.state.set_active_subst(
            {"drive": self.drive, "target": str(self.physical_path)}
        )
        return self.command_path

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        if self.drive is None:
            return
        subst = shutil.which("subst.exe")
        if subst:
            result = run_capture([subst, self.drive, "/D"], self.logger, check=False)
            if result.returncode != 0:
                message = f"Failed to remove collector SUBST mapping {self.drive}"
                if exc_type is None:
                    raise CleanupError(message)
                self.logger.error(message)
                return
        self.state.set_active_subst(None)


def find_install_wim(release_dir: Path) -> Path | None:
    candidates: list[Path] = []
    for path in release_dir.rglob("install.wim"):
        relative_parts = [part.casefold() for part in path.relative_to(release_dir).parts]
        if path.parent.name.casefold() != "sources":
            continue
        if "temp" in relative_parts or "uups" in relative_parts:
            continue
        candidates.append(path)
    if not candidates:
        return None
    candidates.sort(key=lambda item: (item.stat().st_size, item.stat().st_mtime), reverse=True)
    return candidates[0]


def convert_uup_set(
    release_dir: Path,
    drivers_only: bool,
    state: StateStore,
    logger: logging.Logger,
) -> Path:
    existing = find_install_wim(release_dir)
    if existing:
        logger.info("Resuming from existing install.wim: %s", existing)
        return existing
    write_converter_config(release_dir, drivers_only)
    command_processor = os.environ.get("COMSPEC") or str(
        Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "cmd.exe"
    )
    with SpaceSafeWorkingDirectory(release_dir, state, logger) as command_dir:
        run_streamed(
            [command_processor, "/d", "/c", "convert-UUP.cmd"],
            command_dir,
            logger,
        )
    image = find_install_wim(release_dir)
    if image is None:
        raise CommandError(
            "UUP converter returned without producing a distribution sources\\install.wim"
        )
    return image


class DismManager:
    def __init__(self, state: StateStore, logger: logging.Logger):
        self.state = state
        self.logger = logger
        self.executable = shutil.which("dism.exe") or str(
            Path(os.environ.get("SystemRoot", r"C:\Windows"))
            / "System32"
            / "dism.exe"
        )
        if not Path(self.executable).is_file():
            raise CollectorError("dism.exe was not found")

    def mounted_image_info(self) -> list[MountedImage]:
        result = run_capture(
            [self.executable, "/English", "/Get-MountedImageInfo"],
            self.logger,
            check=False,
        )
        if result.returncode != 0:
            raise CommandError("DISM could not enumerate mounted images")
        text = decode_command_output(result.stdout)
        mounted: list[MountedImage] = []
        current_mount: Path | None = None
        current_image: Path | None = None
        current_status: str | None = None
        for line in text.splitlines():
            mount_match = re.match(
                r"^\s*Mount Dir\s*:\s*(.+?)\s*$",
                line,
                re.IGNORECASE,
            )
            if mount_match:
                if current_mount is not None:
                    mounted.append(
                        MountedImage(current_mount, current_image, current_status)
                    )
                current_mount = Path(mount_match.group(1))
                current_image = None
                current_status = None
                continue
            image_match = re.match(
                r"^\s*Image File\s*:\s*(.+?)\s*$",
                line,
                re.IGNORECASE,
            )
            if image_match and current_mount is not None:
                current_image = Path(image_match.group(1))
                continue
            status_match = re.match(
                r"^\s*Status\s*:\s*(.+?)\s*$",
                line,
                re.IGNORECASE,
            )
            if status_match and current_mount is not None:
                current_status = status_match.group(1)
        if current_mount is not None:
            mounted.append(MountedImage(current_mount, current_image, current_status))
        return mounted

    def mounted_images(self) -> list[Path]:
        return [item.mount_dir for item in self.mounted_image_info()]

    def is_mounted(self, mount_dir: Path) -> bool:
        return any(
            normalized_path(item.mount_dir) == normalized_path(mount_dir)
            for item in self.mounted_image_info()
        )

    @staticmethod
    def mount_is_owned(mounted: MountedImage, root: Path) -> bool:
        return is_within(mounted.mount_dir, root) or (
            mounted.image_file is not None and is_within(mounted.image_file, root)
        )

    def cleanup_invalid_owned_mounts(self, root: Path) -> int:
        mounted = self.mounted_image_info()
        invalid = [
            item
            for item in mounted
            if (item.status or "").casefold() == "invalid"
        ]
        owned = [item for item in invalid if self.mount_is_owned(item, root)]
        if not owned:
            return 0
        foreign = [item for item in invalid if not self.mount_is_owned(item, root)]
        if foreign:
            paths = ", ".join(str(item.mount_dir) for item in foreign)
            raise CleanupError(
                "Refusing global DISM invalid-mount cleanup while unrelated invalid "
                f"mounts exist: {paths}"
            )
        self.logger.warning(
            "Cleaning %d invalid collector-owned DISM mount registration(s)",
            len(owned),
        )
        result = run_capture(
            [self.executable, "/English", "/Cleanup-Mountpoints"],
            self.logger,
            check=False,
        )
        if result.returncode != 0:
            output = decode_command_output(result.stdout)
            raise CleanupError(
                f"DISM could not clean invalid collector mounts: {output[-2000:]}"
            )
        target_mounts = {normalized_path(item.mount_dir) for item in owned}
        remaining = [
            item
            for item in self.mounted_image_info()
            if normalized_path(item.mount_dir) in target_mounts
            and (item.status or "").casefold() == "invalid"
        ]
        if remaining:
            paths = ", ".join(str(item.mount_dir) for item in remaining)
            raise CleanupError(
                f"Invalid collector mounts remain after DISM cleanup: {paths}"
            )
        return len(owned)

    def unmount_owned_images(self, root: Path) -> int:
        recovered = 0
        while True:
            owned = [
                item
                for item in self.mounted_image_info()
                if self.mount_is_owned(item, root)
            ]
            if not owned:
                return recovered
            mounted = owned[0]
            self.logger.warning(
                "Recovering collector-owned mount %s (image: %s)",
                mounted.mount_dir,
                mounted.image_file or "unknown",
            )
            try:
                self.unmount(mounted.mount_dir)
                recovered += 1
            except CleanupError:
                current = next(
                    (
                        item
                        for item in self.mounted_image_info()
                        if normalized_path(item.mount_dir)
                        == normalized_path(mounted.mount_dir)
                    ),
                    None,
                )
                if current is None or (current.status or "").casefold() != "invalid":
                    raise
                recovered += self.cleanup_invalid_owned_mounts(root)

    def recover_owned_mounts(self, work_dir: Path) -> None:
        self.unmount_owned_images(work_dir / "releases")
        self.state.set_active_mount(None)

    def image_indexes(self, image: Path) -> list[tuple[int, str]]:
        result = run_capture(
            [
                self.executable,
                "/English",
                "/Get-WimInfo",
                f"/WimFile:{image}",
            ],
            self.logger,
        )
        text = decode_command_output(result.stdout)
        indexes: list[tuple[int, str]] = []
        current_index: int | None = None
        current_name = ""
        for line in text.splitlines():
            index_match = re.match(r"^\s*Index\s*:\s*(\d+)\s*$", line, re.IGNORECASE)
            if index_match:
                if current_index is not None:
                    indexes.append((current_index, current_name))
                current_index = int(index_match.group(1))
                current_name = ""
                continue
            name_match = re.match(r"^\s*Name\s*:\s*(.+?)\s*$", line, re.IGNORECASE)
            if name_match and current_index is not None:
                current_name = name_match.group(1)
        if current_index is not None:
            indexes.append((current_index, current_name))
        if not indexes:
            raise CommandError("DISM did not report any image indexes")
        return indexes

    def select_professional_index(self, image: Path) -> tuple[int, str]:
        indexes = self.image_indexes(image)
        exact_pro = [
            item
            for item in indexes
            if re.search(r"\bPro\b", item[1], re.IGNORECASE)
            and not re.search(
                r"\b(?:Education|Workstation|N)\b", item[1], re.IGNORECASE
            )
        ]
        if exact_pro:
            return exact_pro[0]
        if len(indexes) == 1:
            self.logger.warning(
                "The single image index is named %r; using it because the UUP API "
                "request was restricted to PROFESSIONAL",
                indexes[0][1],
            )
            return indexes[0]
        raise CommandError(
            "The converted image has multiple indexes but no unambiguous Windows Pro index"
        )

    def mount(self, image: Path, index: int, mount_dir: Path, release_id: str) -> None:
        if mount_dir.exists():
            safe_rmtree(mount_dir, mount_dir.parent)
        mount_dir.mkdir(parents=True, exist_ok=False)
        self.state.set_active_mount(
            {
                "release_id": release_id,
                "image": str(image),
                "index": index,
                "mount_dir": str(mount_dir),
            }
        )
        base = [
            self.executable,
            "/English",
            "/Mount-Image",
            f"/ImageFile:{image}",
            f"/Index:{index}",
            f"/MountDir:{mount_dir}",
            "/ReadOnly",
        ]
        result = run_capture(base + ["/Optimize", "/CheckIntegrity"], self.logger, check=False)
        if result.returncode == 0:
            return
        self.logger.warning(
            "Optimized integrity-checked DISM mount failed; cleaning it and retrying "
            "with the minimal read-only options"
        )
        if self.is_mounted(mount_dir):
            self.unmount_owned_images(mount_dir.parent)
        if mount_dir.exists():
            safe_rmtree(mount_dir, mount_dir.parent)
        mount_dir.mkdir(parents=True, exist_ok=False)
        self.state.set_active_mount(
            {
                "release_id": release_id,
                "image": str(image),
                "index": index,
                "mount_dir": str(mount_dir),
            }
        )
        run_capture(base, self.logger)

    def unload_offline_hives(self, mount_dir: Path) -> int:
        reg = shutil.which("reg.exe") or str(
            Path(os.environ.get("SystemRoot", r"C:\Windows"))
            / "System32"
            / "reg.exe"
        )
        if not Path(reg).is_file():
            raise CleanupError("reg.exe was not found for offline-hive cleanup")
        result = run_capture(
            [reg, "query", "HKLM"],
            self.logger,
            check=False,
        )
        if result.returncode != 0:
            output = decode_command_output(result.stdout)
            raise CleanupError(
                f"Could not enumerate loaded registry hives: {output[-2000:]}"
            )
        mount_prefix = (
            os.path.abspath(str(mount_dir)).replace("\\", "/").rstrip("/") + "/"
        ).casefold()
        keys: list[str] = []
        for raw_line in decode_command_output(result.stdout).splitlines():
            key = raw_line.strip()
            match = re.match(
                r"^HKEY_LOCAL_MACHINE\\\{[0-9a-f-]{36}\}(.+)$",
                key,
                re.IGNORECASE,
            )
            if match and match.group(1).replace("\\", "/").casefold().startswith(
                mount_prefix
            ):
                keys.append(key)
        for key in keys:
            self.logger.warning("Unloading offline registry hive: %s", key)
            result = run_capture(
                [reg, "unload", key],
                self.logger,
                check=False,
            )
            if result.returncode != 0:
                output = decode_command_output(result.stdout)
                raise CleanupError(
                    f"Could not unload offline registry hive {key}: {output[-2000:]}"
                )
        return len(keys)

    def unmount(self, mount_dir: Path) -> None:
        last_result: subprocess.CompletedProcess[bytes] | None = None
        for attempt in range(2):
            last_result = run_capture(
                [
                    self.executable,
                    "/English",
                    "/Unmount-Image",
                    f"/MountDir:{mount_dir}",
                    "/Discard",
                ],
                self.logger,
                check=False,
            )
            if last_result.returncode == 0:
                self.state.set_active_mount(None)
                try:
                    mount_dir.rmdir()
                except OSError:
                    pass
                return
            if attempt == 0:
                output = decode_command_output(last_result.stdout)
                if "0xc1420117" in output.casefold():
                    try:
                        self.unload_offline_hives(mount_dir)
                    except CleanupError as exc:
                        self.logger.warning(
                            "Offline-hive cleanup failed before DISM retry: %s",
                            exc,
                        )
                time.sleep(2)
        if self.is_mounted(mount_dir):
            output = decode_command_output(last_result.stdout if last_result else b"")
            raise CleanupError(
                f"DISM could not unmount owned image at {mount_dir}: {output[-2000:]}"
            )
        self.state.set_active_mount(None)


def long_windows_path(path: Path) -> str:
    absolute = os.path.abspath(str(path))
    if os.name != "nt" or absolute.startswith("\\\\?\\"):
        return absolute
    if absolute.startswith("\\\\"):
        return "\\\\?\\UNC\\" + absolute[2:]
    return "\\\\?\\" + absolute


def copy_and_hash(source: Path, destination: Path) -> tuple[int, str]:
    os.makedirs(long_windows_path(destination.parent), exist_ok=True)
    partial = destination.with_name(destination.name + ".collector-part")
    digest = hashlib.sha256()
    total = 0
    try:
        with open(long_windows_path(source), "rb") as source_handle, open(
            long_windows_path(partial), "wb"
        ) as destination_handle:
            while True:
                chunk = source_handle.read(COPY_BUFFER_SIZE)
                if not chunk:
                    break
                destination_handle.write(chunk)
                digest.update(chunk)
                total += len(chunk)
            destination_handle.flush()
        os.replace(long_windows_path(partial), long_windows_path(destination))
        shutil.copystat(long_windows_path(source), long_windows_path(destination))
    finally:
        if os.path.exists(long_windows_path(partial)):
            os.unlink(long_windows_path(partial))
    return total, digest.hexdigest()


def is_kernel_component_name(name: str) -> bool:
    folded = name.casefold()
    return folded in KERNEL_COMPONENT_NAMES or re.fullmatch(
        r"(?:kd_[0-9a-f].*\.dll|ntkrnl.*\.exe|securekernel.*\.exe|win32k.*\.sys)",
        folded,
    ) is not None


def extract_system_files(
    mount_dir: Path,
    output_dir: Path,
    include_driverstore: bool,
    logger: logging.Logger,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    system32 = mount_dir / "Windows" / "System32"
    syswow64 = mount_dir / "Windows" / "SysWOW64"
    driver_roots = [
        system32 / "drivers",
        syswow64 / "drivers",
    ]
    if include_driverstore:
        driver_roots.insert(
            1,
            system32 / "DriverStore" / "FileRepository",
        )

    candidates: dict[str, dict[str, Any]] = {}

    def add_candidate(source: Path, categories: set[str]) -> None:
        relative = source.relative_to(mount_dir)
        relative_text = str(relative).replace("/", "\\")
        folded = relative_text.casefold()
        existing = candidates.get(folded)
        if existing is not None:
            if existing["path"] != relative_text:
                raise CollectorError(
                    f"Case-insensitive output collision: {existing['path']!r} and "
                    f"{relative_text!r}"
                )
            existing["categories"].update(categories)
            return
        candidates[folded] = {
            "source": source,
            "path": relative_text,
            "size": source.stat().st_size,
            "categories": set(categories),
        }

    for root in driver_roots:
        if not root.is_dir():
            logger.warning("Driver source directory is absent: %s", root)
            continue
        logger.info("Scanning for .sys files in %s", root)
        for current, directory_names, file_names in os.walk(root, followlinks=False):
            directory_names.sort(key=str.casefold)
            file_names.sort(key=str.casefold)
            for file_name in file_names:
                if file_name.casefold().endswith(".sys"):
                    add_candidate(Path(current) / file_name, {"driver"})

    for directory in (system32, syswow64):
        if not directory.is_dir():
            logger.warning("System directory is absent: %s", directory)
            continue
        logger.info("Scanning top-level system files in %s", directory)
        for source in sorted(directory.iterdir(), key=lambda item: item.name.casefold()):
            if not source.is_file():
                continue
            categories: set[str] = set()
            if source.suffix.casefold() == ".sys":
                categories.add("driver")
            if directory == system32 and is_kernel_component_name(source.name):
                categories.add("kernel")
            if categories:
                add_candidate(source, categories)

    ordered = sorted(candidates.values(), key=lambda item: str(item["path"]).casefold())
    total_files = len(ordered)
    total_bytes = sum(int(item["size"]) for item in ordered)
    driver_count = sum("driver" in item["categories"] for item in ordered)
    kernel_count = sum("kernel" in item["categories"] for item in ordered)
    logger.info(
        "System archive extraction plan: %d files (%d drivers, %d kernel components), "
        "%s total",
        total_files,
        driver_count,
        kernel_count,
        format_bytes(total_bytes),
    )
    if not ordered:
        return [], []

    driver_records: list[dict[str, Any]] = []
    kernel_records: list[dict[str, Any]] = []
    copied_bytes = 0
    progress = DownloadProgress(
        f"[extract 0/{total_files}] preparing",
        total_bytes,
        0,
        0,
        None,
        logger,
    )
    progress.update(0, force=True)
    try:
        for index, item in enumerate(ordered, start=1):
            source = item["source"]
            relative_text = str(item["path"])
            file_name = source.name
            if len(file_name) > 52:
                file_name = file_name[:25] + "..." + file_name[-24:]
            progress.label = f"[extract {index}/{total_files}] {file_name}"
            size, sha256 = copy_and_hash(
                source,
                output_dir / Path(relative_text),
            )
            copied_bytes += size
            record = {
                "path": relative_text,
                "size": size,
                "sha256": sha256,
            }
            if "driver" in item["categories"]:
                driver_records.append(record)
            if "kernel" in item["categories"]:
                kernel_records.append(record)
            progress.update(copied_bytes)
    finally:
        progress.finish(copied_bytes)

    if not any(
        str(record["path"]).rsplit("\\", 1)[-1].casefold() == "ntoskrnl.exe"
        for record in kernel_records
    ):
        raise CollectorError("The mounted image did not contain Windows\\System32\\ntoskrnl.exe")

    logger.info("Collected %d .sys driver files", len(driver_records))
    logger.info(
        "Collected kernel components: %s",
        ", ".join(
            str(record["path"]).rsplit("\\", 1)[-1]
            for record in kernel_records
        ),
    )
    return driver_records, kernel_records

def complete_marker_valid(
    release_output: Path,
    release: Release | None = None,
) -> bool:
    metadata_path = release_output / "metadata.json"
    marker_path = release_output / ".complete.json"
    if not metadata_path.is_file() or not marker_path.is_file():
        return False
    try:
        with marker_path.open("r", encoding="utf-8-sig") as handle:
            marker = json.load(handle)
        expected = str(marker.get("metadata_sha256", ""))
        collection_schema = int(marker.get("collection_schema", 0))
        marker_release_id = str(marker.get("release_id", ""))
        marker_architecture = str(marker.get("architecture", ""))
    except (
        OSError,
        TypeError,
        ValueError,
        json.JSONDecodeError,
        AttributeError,
    ):
        return False
    identity_matches = release is None or (
        marker_release_id.casefold() == release.release_id.casefold()
        and marker_architecture.casefold() == release.architecture_label.casefold()
    )
    return (
        identity_matches
        and collection_schema == COLLECTION_SCHEMA_VERSION
        and bool(expected)
        and hash_file(metadata_path, "sha256") == expected
    )

def catalog_created_utc(timestamp: int) -> str | None:
    if timestamp <= 0:
        return None
    try:
        return dt.datetime.fromtimestamp(timestamp, dt.timezone.utc).replace(
            microsecond=0
        ).isoformat()
    except (OSError, OverflowError, ValueError):
        return None


def payload_hosts(selection: UupSelection) -> list[str]:
    hosts: set[str] = set()
    for entry in selection.files.values():
        url = str(entry.get("url") or "")
        if url:
            hosts.add(validate_source_url(url, "microsoft"))
    return sorted(hosts)


def build_metadata(
    release: Release,
    selection: UupSelection,
    source_records: list[dict[str, Any]],
    converter_record: dict[str, str],
    image_index: int,
    image_name: str,
    image_record: dict[str, Any] | None,
    image_retention_requested: bool,
    image_retention_error: str | None,
    driver_records: list[dict[str, Any]],
    kernel_records: list[dict[str, Any]],
    started_utc: str,
    drivers_only: bool,
    include_driverstore: bool,
) -> dict[str, Any]:
    return {
        "schema_version": COLLECTION_SCHEMA_VERSION,
        "release": {
            "id": release.release_id,
            "name": release.display_name,
            "product": release.product,
            "version": release.version,
            "release_date": release.release_date,
            "architecture": release.architecture_label,
            "language": "English (United States)",
            "language_code": selection.language,
            "edition": "Windows Pro",
            "edition_id": selection.edition,
        },
        "build": {
            "number": selection.build,
            "uup_update_id": selection.update_id,
            "title": selection.title,
            "catalog_created_utc": catalog_created_utc(selection.created),
        },
        "source": {
            "description": "Microsoft-hosted UUP payloads selected through UUP dump",
            "uup_dump_api": UUP_API_BASE,
            "uup_payload_hosts": payload_hosts(selection),
            "uup_files": source_records,
            "converter_manifest": CONVERTER_MANIFEST_URL,
            "converter_url": converter_record.get("url"),
            "converter_sha256": converter_record.get("sha256"),
            "extractor_url": converter_record.get("extractor_url"),
            "extractor_sha256": converter_record.get("extractor_sha256"),
        },
        "collection": {
            "program": "windows_sys_collector.py",
            "program_version": PROGRAM_VERSION,
            "collection_schema": COLLECTION_SCHEMA_VERSION,
            "started_utc": started_utc,
            "completed_utc": utc_now(),
            "drivers_only": drivers_only,
            "include_driverstore": include_driverstore,
            "include_kernel_components": True,
        },
        "image": {
            "source_name": image_name,
            "index": image_index,
            "retention_requested": image_retention_requested,
            "retained": image_record,
            "retention_error": image_retention_error,
        },
        "drivers": {
            "count": len(driver_records),
            "total_bytes": sum(item["size"] for item in driver_records),
            "hash_algorithm": "SHA-256",
            "files": driver_records,
        },
        "kernel_components": {
            "count": len(kernel_records),
            "total_bytes": sum(item["size"] for item in kernel_records),
            "hash_algorithm": "SHA-256",
            "files": kernel_records,
        },
    }

def preserve_image(
    image: Path,
    release_output: Path,
    build: str,
) -> dict[str, Any]:
    image_dir = release_output / "_images"
    retained = image_dir / f"install-{build}.wim"
    size, sha256 = copy_and_hash(image, retained)
    return {
        "path": str(retained.relative_to(release_output)).replace("/", "\\"),
        "size": size,
        "sha256": sha256,
    }


def source_records_from_selection(
    selection: UupSelection,
    drivers_only: bool,
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw_name in sorted(selection.files, key=str.casefold):
        name = sanitize_uup_filename(raw_name)
        if drivers_only and uup_file_is_optional_for_drivers_only(
            name, selection.build
        ):
            continue
        if name.casefold() in seen:
            raise DownloadError(f"Case-insensitive filename collision for {name}")
        seen.add(name.casefold())
        entry = selection.files[raw_name]
        sha1 = str(entry.get("sha1") or "").lower()
        try:
            size = int(entry["size"])
        except (KeyError, TypeError, ValueError) as exc:
            raise DownloadError(f"Missing size for UUP file {name}") from exc
        if not re.fullmatch(r"[0-9a-f]{40}", sha1):
            raise DownloadError(f"Missing or invalid SHA-1 for UUP file {name}")
        records.append({"name": name, "size": size, "sha1": sha1})
    return records


def load_source_records(
    release_dir: Path,
    selection: UupSelection,
    drivers_only: bool,
    logger: logging.Logger,
) -> list[dict[str, Any]]:
    manifest_path = release_dir / "uup_manifest.json"
    try:
        with manifest_path.open("r", encoding="utf-8-sig") as handle:
            payload = json.load(handle)
        saved_selection = payload["selection"]
        records = payload["files"]
        if saved_selection["update_id"] != selection.update_id or not isinstance(records, list):
            raise ValueError("manifest does not match the selected UUP set")
        for record in records:
            if not isinstance(record, dict):
                raise ValueError("manifest contains an invalid file record")
            sanitize_uup_filename(str(record["name"]))
            if not re.fullmatch(r"[0-9a-f]{40}", str(record["sha1"]).lower()):
                raise ValueError("manifest contains an invalid SHA-1")
            int(record["size"])
        return records
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        logger.warning(
            "Could not reuse saved UUP source manifest (%s); rebuilding it from API metadata",
            exc,
        )
        return source_records_from_selection(selection, drivers_only)


def cleanup_release_work(
    release_dir: Path,
    work_dir: Path,
    dism: DismManager,
    logger: logging.Logger,
    display_name: str,
) -> str | None:
    try:
        dism.unmount_owned_images(release_dir)
        if release_dir.exists():
            safe_rmtree(release_dir, work_dir)
        return None
    except (CollectorError, OSError) as exc:
        logger.warning(
            "Temporary work cleanup deferred for %s: %s",
            display_name,
            exc,
        )
        return str(exc)


def process_release(
    release: Release,
    args: argparse.Namespace,
    output_dir: Path,
    work_dir: Path,
    state: StateStore,
    api: UupDumpApi,
    session: Any,
    dism: DismManager,
    logger: logging.Logger,
) -> None:
    release_dir = work_dir / "releases" / release.release_id
    release_output = output_dir / release.display_name
    started = utc_now()
    previous = state.release(release.release_id)

    if release_output.exists() and not complete_marker_valid(release_output, release):
        logger.warning("Removing incomplete output for %s", release.display_name)
        safe_rmtree(release_output, output_dir)
    release_output.mkdir(parents=True, exist_ok=True)
    release_dir.mkdir(parents=True, exist_ok=True)

    state.update_release(
        release.release_id,
        "in_progress",
        phase="discovering",
        started_utc=started,
        attempts=int(previous.get("attempts", 0)) + 1,
    )
    selection = api.resume_or_discover(release, previous)
    state.update_release(
        release.release_id,
        "in_progress",
        phase="downloading",
        selection=selection_state(selection),
    )

    image = find_install_wim(release_dir)
    if image is not None:
        try:
            dism.image_indexes(image)
        except (CollectorError, OSError) as exc:
            logger.warning(
                "Discarding incomplete install.wim left by an interrupted conversion: %s",
                exc,
            )
            image.unlink(missing_ok=True)
            image = None
    uup_dir = release_dir / "UUPs"
    if image is None:
        archive, converter_record, extractor = prepare_converter_archive(
            session, work_dir, logger
        )
        state.update_release(
            release.release_id,
            "in_progress",
            phase="downloading",
            converter=converter_record,
        )
        extract_converter(archive, release_dir, extractor, logger)
        source_records = download_uup_files(
            release, selection, api, session, uup_dir, args.drivers_only, logger
        )
        state.update_release(release.release_id, "in_progress", phase="converting")
        image = convert_uup_set(release_dir, args.drivers_only, state, logger)
        if uup_dir.exists():
            safe_rmtree(uup_dir, release_dir)
    else:
        logger.info("Resuming from previously built image without downloading UUPs again")
        source_records = load_source_records(
            release_dir, selection, args.drivers_only, logger
        )
        saved_converter = previous.get("converter")
        if (
            isinstance(saved_converter, dict)
            and saved_converter.get("url")
            and re.fullmatch(r"[0-9a-f]{64}", str(saved_converter.get("sha256", "")))
        ):
            converter_record = {str(key): str(value) for key, value in saved_converter.items()}
        else:
            _, converter_record, _ = prepare_converter_archive(
                session, work_dir, logger
            )

    dism.unmount_owned_images(release_dir)
    state.update_release(release.release_id, "in_progress", phase="mounting")
    image_index, image_name = dism.select_professional_index(image)
    mount_dir = release_dir / "mount"
    driver_records: list[dict[str, Any]] = []
    kernel_records: list[dict[str, Any]] = []
    try:
        dism.mount(image, image_index, mount_dir, release.release_id)
        state.update_release(release.release_id, "in_progress", phase="extracting")
        driver_records, kernel_records = extract_system_files(
            mount_dir,
            release_output,
            args.include_driverstore,
            logger,
        )
    finally:
        try:
            dism.unmount_owned_images(release_dir)
            if mount_dir.exists() and not dism.is_mounted(mount_dir):
                safe_rmtree(mount_dir, release_dir)
        except (CollectorError, OSError) as exc:
            logger.warning(
                "Mount cleanup deferred for %s: %s",
                release.display_name,
                exc,
            )

    if not driver_records:
        raise CollectorError("No .sys files were found in the converted Windows image")

    image_record = None
    image_retention_error = None
    if args.keep_images:
        state.update_release(release.release_id, "in_progress", phase="preserving_image")
        try:
            dism.unmount_owned_images(release_dir)
            image_record = preserve_image(image, release_output, selection.build)
        except (CollectorError, OSError) as exc:
            image_retention_error = str(exc)
            logger.warning(
                "Could not retain the WIM for %s; the extracted system archive will "
                "still be completed: %s",
                release.display_name,
                exc,
            )

    metadata = build_metadata(
        release,
        selection,
        source_records,
        converter_record,
        image_index,
        image_name,
        image_record,
        args.keep_images,
        image_retention_error,
        driver_records,
        kernel_records,
        started,
        args.drivers_only,
        args.include_driverstore,
    )
    metadata_path = release_output / "metadata.json"
    write_json_atomic(metadata_path, metadata)
    write_json_atomic(
        release_output / ".complete.json",
        {
            "release_id": release.release_id,
            "build": selection.build,
            "architecture": release.architecture_label,
            "collection_schema": COLLECTION_SCHEMA_VERSION,
            "completed_utc": metadata["collection"]["completed_utc"],
            "metadata_sha256": hash_file(metadata_path, "sha256"),
        },
    )

    state.update_release(release.release_id, "in_progress", phase="cleaning")
    cleanup_error = cleanup_release_work(
        release_dir,
        work_dir,
        dism,
        logger,
        release.display_name,
    )
    completion_warnings = []
    if image_retention_error:
        completion_warnings.append(
            f"Requested image retention failed: {image_retention_error}"
        )
    if cleanup_error:
        completion_warnings.append(f"Temporary cleanup pending: {cleanup_error}")
    state.update_release(
        release.release_id,
        "completed",
        phase=(
            "cleanup_pending"
            if cleanup_error
            else "complete_with_warnings"
            if completion_warnings
            else "complete"
        ),
        completed_utc=metadata["collection"]["completed_utc"],
        build=selection.build,
        output=str(release_output),
        driver_count=len(driver_records),
        kernel_component_count=len(kernel_records),
        error="; ".join(completion_warnings) if completion_warnings else None,
    )


def load_releases(path: Path) -> list[Release]:
    try:
        with path.open("r", encoding="utf-8-sig") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise CollectorError(f"Could not read release catalog {path}: {exc}") from exc
    raw_releases = payload.get("releases") if isinstance(payload, dict) else None
    if not isinstance(raw_releases, list) or not raw_releases:
        raise CollectorError("releases.json must contain a non-empty releases array")
    releases = [Release.from_json(item) for item in raw_releases if isinstance(item, dict)]
    ids = [release.release_id.casefold() for release in releases]
    if len(ids) != len(set(ids)):
        raise CollectorError("releases.json contains duplicate release IDs")
    return releases


def release_lookup(releases: Iterable[Release]) -> dict[str, list[Release]]:
    lookup: dict[str, list[Release]] = {}
    for release in releases:
        values = {
            release.release_id,
            release.display_name,
            f"{release.product} {release.version}",
            *release.aliases,
        }
        for value in values:
            lookup.setdefault(value.strip().casefold(), []).append(release)
    return lookup


def resolve_release(value: str, releases: list[Release]) -> Release:
    matches = release_lookup(releases).get(value.strip().casefold(), [])
    if not matches:
        valid = ", ".join(release.release_id for release in releases)
        raise CollectorError(f"Unknown release {value!r}. Valid IDs: {valid}")
    unique = {item.release_id: item for item in matches}
    if len(unique) != 1:
        valid = ", ".join(unique)
        raise CollectorError(f"Ambiguous release {value!r}; use one of: {valid}")
    return next(iter(unique.values()))


def select_releases(args: argparse.Namespace, releases: list[Release]) -> list[Release]:
    if args.release and args.start_from:
        raise CollectorError("--release and --start-from cannot be used together")
    if args.release:
        selected: list[Release] = []
        seen: set[str] = set()
        for group in args.release:
            for value in group.split(","):
                release = resolve_release(value, releases)
                if release.release_id not in seen:
                    selected.append(release)
                    seen.add(release.release_id)
        return selected
    if args.start_from:
        first = resolve_release(args.start_from, releases)
        start_index = next(
            index for index, item in enumerate(releases) if item.release_id == first.release_id
        )
        return releases[start_index:]
    return releases


def expand_release_architectures(
    releases: Iterable[Release],
    architecture: str = "x64",
) -> list[Release]:
    if architecture not in {"x64", "x86", "both"}:
        raise CollectorError(f"Unsupported architecture mode: {architecture}")
    targets: list[Release] = []
    for release in releases:
        if architecture in {"x64", "both"}:
            targets.append(release)
        if (
            architecture in {"x86", "both"}
            and release.product.casefold() == "windows 10"
        ):
            targets.append(
                Release(
                    release_id=f"{release.release_id}-x86",
                    product=release.product,
                    version=release.version,
                    display_name=f"{release.display_name} x86",
                    build_major=release.build_major,
                    release_date=release.release_date,
                    minimum_free_gib=release.minimum_free_gib,
                    architecture="x86",
                )
            )
    if not targets:
        raise CollectorError(
            f"No selected releases support architecture mode {architecture!r}"
        )
    return targets


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Download Microsoft-hosted UUP files and preserve .sys drivers and "
            "kernel components from Windows 10 x64/x86 and Windows 11 x64 "
            "en-US Pro images. The default architecture mode is x64."
        )
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"collection directory (default: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--work-dir",
        type=Path,
        default=DEFAULT_WORK_DIR,
        help=f"temporary/state directory (default: {DEFAULT_WORK_DIR})",
    )
    parser.add_argument(
        "--release",
        action="append",
        metavar="RELEASE",
        help="process one release ID; repeat or use commas for several",
    )
    parser.add_argument(
        "--start-from",
        metavar="RELEASE",
        help="start at this release ID and continue in releases.json order",
    )
    parser.add_argument(
        "--architecture",
        choices=("x64", "x86", "both"),
        default="x64",
        help=(
            "target architecture mode: x64 (default), x86 Windows 10 only, "
            "or both"
        ),
    )
    parser.add_argument(
        "--keep-images",
        action="store_true",
        help="retain the converted install.wim under each release's _images directory",
    )
    parser.add_argument(
        "--drivers-only",
        action="store_true",
        help="omit Store apps, WinRE, and Edge from conversion when only drivers are needed",
    )
    parser.add_argument(
        "--include-driverstore",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="include DriverStore FileRepository (default: enabled)",
    )
    parser.add_argument(
        "--cleanup",
        action="store_true",
        help="unmount owned stale images, delete temporary release/tool data, and exit",
    )
    parser.add_argument(
        "--retry-failed",
        action="store_true",
        help="retry releases recorded as failed instead of skipping them",
    )
    return parser


def clean_work_data(
    work_dir: Path,
    state: StateStore,
    dism: DismManager,
    logger: logging.Logger,
) -> None:
    dism.recover_owned_mounts(work_dir)
    remove_owned_subst_mappings(work_dir, logger)
    for child_name in ("releases", "tools"):
        child = work_dir / child_name
        if child.exists():
            safe_rmtree(child, work_dir)
            logger.info("Deleted temporary data: %s", child)
    state.set_active_mount(None)
    state.set_active_subst(None)


def clean_release_after_error(
    release: Release,
    output_dir: Path,
    work_dir: Path,
    dism: DismManager,
    logger: logging.Logger,
) -> bool:
    release_dir = work_dir / "releases" / release.release_id
    release_output = output_dir / release.display_name
    cleanup_ok = True
    try:
        dism.unmount_owned_images(release_dir)
        if release_dir.exists():
            safe_rmtree(release_dir, work_dir)
    except (CollectorError, OSError) as exc:
        cleanup_ok = False
        logger.error("Work cleanup failed for %s: %s", release.display_name, exc)
    try:
        if release_output.exists() and not complete_marker_valid(
            release_output, release
        ):
            safe_rmtree(release_output, output_dir)
    except (CollectorError, OSError) as exc:
        cleanup_ok = False
        logger.error("Output cleanup failed for %s: %s", release.display_name, exc)
    return cleanup_ok


def run(args: argparse.Namespace) -> int:
    if os.name != "nt":
        print("This program requires Windows 10 or Windows 11.", file=sys.stderr)
        return 2
    if not is_administrator():
        print(
            "Administrator privileges are required for DISM image mounting.",
            file=sys.stderr,
        )
        return 2
    output_dir = args.output.expanduser().resolve()
    work_dir = args.work_dir.expanduser().resolve()
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
        work_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise CollectorError(f"Could not create output/work directories: {exc}") from exc
    logger = setup_logging(output_dir)
    logger.info("Windows SYS Collector %s starting", PROGRAM_VERSION)
    logger.info("Output directory: %s", output_dir)
    logger.info("Work directory: %s", work_dir)

    if sys.getwindowsversion().major < 10:
        logger.error("Windows 10 or later is required")
        return 2
    if not args.cleanup and requests is None:
        logger.error(
            "Missing Python dependencies. Run: py -3 -m pip install -r requirements.txt"
        )
        return 2

    releases = load_releases(RELEASES_FILE)
    selected_releases = expand_release_architectures(
        select_releases(args, releases),
        args.architecture,
    )
    state = StateStore(work_dir / "collector_state.json")

    with InstanceLock(work_dir / "collector.lock"):
        dism = DismManager(state, logger)
        try:
            dism.recover_owned_mounts(work_dir)
        except (CollectorError, OSError) as exc:
            logger.warning(
                "Startup mount recovery is incomplete; per-release cleanup will retry: %s",
                exc,
            )
        remove_owned_subst_mappings(work_dir, logger)
        state.set_active_subst(None)

        if args.cleanup:
            clean_work_data(work_dir, state, dism, logger)
            logger.info("Temporary data cleanup completed; state and collected files were kept")
            return 0

        session = create_http_session()
        api = UupDumpApi(session, logger)
        summary = RunSummary()
        completion_by_id = {
            release.release_id: complete_marker_valid(
                output_dir / release.display_name,
                release,
            )
            for release in selected_releases
        }
        completed_on_disk = [
            release
            for release in selected_releases
            if completion_by_id[release.release_id]
        ]
        missing_on_disk = [
            release
            for release in selected_releases
            if not completion_by_id[release.release_id]
        ]
        logger.info(
            "Archive scan for %s mode: %d complete, %d missing",
            args.architecture,
            len(completed_on_disk),
            len(missing_on_disk),
        )
        if missing_on_disk:
            logger.info("Next missing target: %s", missing_on_disk[0].display_name)
        else:
            logger.info("All selected archive targets are already complete")

        for release in selected_releases:
            release_output = output_dir / release.display_name
            release_work = work_dir / "releases" / release.release_id
            entry = state.release(release.release_id)
            if complete_marker_valid(release_output, release):
                cleanup_error = cleanup_release_work(
                    release_work,
                    work_dir,
                    dism,
                    logger,
                    release.display_name,
                )
                state.update_release(
                    release.release_id,
                    "completed",
                    phase="cleanup_pending" if cleanup_error else "complete",
                    output=str(release_output),
                    error=(
                        f"Temporary cleanup pending: {cleanup_error}"
                        if cleanup_error
                        else None
                    ),
                )
                logger.info("Skipping completed release: %s", release.display_name)
                summary.skipped.append(release.display_name)
                continue
            if entry.get("status") == "failed" and not args.retry_failed:
                cleanup_release_work(
                    release_work,
                    work_dir,
                    dism,
                    logger,
                    release.display_name,
                )
                if release_output.exists() and not complete_marker_valid(
                    release_output, release
                ):
                    safe_rmtree(release_output, output_dir)
                logger.info(
                    "Skipping previously failed release %s; use --retry-failed to retry",
                    release.display_name,
                )
                summary.skipped.append(release.display_name)
                continue

            logger.info("Starting release: %s", release.display_name)
            try:
                check_disk_space(release, output_dir, work_dir)
                process_release(
                    release,
                    args,
                    output_dir,
                    work_dir,
                    state,
                    api,
                    session,
                    dism,
                    logger,
                )
                summary.completed.append(release.display_name)
                logger.info("Completed release: %s", release.display_name)
            except KeyboardInterrupt:
                state.update_release(
                    release.release_id,
                    "interrupted",
                    phase="interrupted",
                    error="Interrupted by user; partial downloads were retained for resume",
                )
                logger.warning(
                    "Interrupted. Partial data for %s was retained and will resume next run.",
                    release.display_name,
                )
                logger.info("Final summary:\n%s", summary.format())
                return 130
            except ApiUnavailable as exc:
                logger.warning("Release unavailable: %s: %s", release.display_name, exc)
                state.update_release(
                    release.release_id,
                    "unavailable",
                    phase="unavailable",
                    error=str(exc),
                )
                cleanup_ok = clean_release_after_error(
                    release, output_dir, work_dir, dism, logger
                )
                if not cleanup_ok:
                    state.update_release(
                        release.release_id,
                        "failed",
                        phase="cleanup_failed",
                        error=f"{exc}; owned temporary data could not be cleaned",
                    )
                    summary.failed.append(release.display_name)
                    logger.error(
                        "Cleanup remains pending for %s; continuing with the next "
                        "release",
                        release.display_name,
                    )
                    continue
                summary.unavailable.append(release.display_name)
            except Exception as exc:
                logger.exception("Release failed: %s: %s", release.display_name, exc)
                state.update_release(
                    release.release_id,
                    "failed",
                    phase="failed",
                    error=str(exc),
                )
                cleanup_ok = clean_release_after_error(
                    release, output_dir, work_dir, dism, logger
                )
                summary.failed.append(release.display_name)
                if not cleanup_ok:
                    state.update_release(
                        release.release_id,
                        "failed",
                        phase="cleanup_failed",
                        error=f"{exc}; owned temporary data could not be cleaned",
                    )
                    logger.error(
                        "Cleanup remains pending for %s; continuing with the next "
                        "release",
                        release.display_name,
                    )

        logger.info("Final summary:\n%s", summary.format())
        return 1 if summary.failed else 0


def main() -> int:
    configure_standard_streams()
    parser = build_argument_parser()
    args = parser.parse_args()
    try:
        return run(args)
    except (CollectorError, OSError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
