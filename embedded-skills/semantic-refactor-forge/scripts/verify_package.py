#!/usr/bin/env python3
"""Fail-closed installed-Skill package validator; Python standard library only."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

from refactor_gate import markdown_structure

NAME = "semantic-refactor-forge"
NEEDED = [
    "SKILL.md", "assets/audit.schema.json",
    "scripts/refactor_gate.py", "scripts/verify_package.py",
    "tests/test_refactor_gate.py", "tests/fixtures/source.md", "tests/fixtures/target.md",
    *[f"references/{name}.md" for name in [
        "atomization", "terminology", "density", "markdown", "verification",
        "edge-matrix", "output-contract", "expert-review"
    ]],
]
KEY = re.compile(r"^([a-z][a-z0-9_-]*):(?:\s+(.*))?$")
LOCAL_LINK = re.compile(r"!?\[[^\]\n]+\]\(([^)\s]+)(?:\s+\"[^\"]+\")?\)")
INLINE_CODE = re.compile(r"(?<!\x60)\x60[^\x60\n]*\x60(?!\x60)")
FENCE = re.compile(r"^ {0,3}(\x60{3,}|~{3,})")


def scalar(token: str) -> str:
    """Parse the published frontmatter scalar subset; reject YAML structures."""
    if not token or token.strip() != token:
        raise ValueError("scalar must be nonempty and have no trailing whitespace")
    if token.startswith('"'):
        value = json.loads(token)
        if not isinstance(value, str):
            raise ValueError("quoted scalar must be text")
        return value
    if token.startswith("'"):
        if len(token) < 2 or not token.endswith("'"):
            raise ValueError("unclosed single quote")
        return token[1:-1].replace("''", "'")
    if not re.fullmatch(r"[^\s\[\]{}:,#&*!>|%@\x60\"'](?:[^\[\]{}:,#&*!>|%@\x60\"']*[^\s\[\]{}:,#&*!>|%@\x60\"'])?", token):
        raise ValueError("unsupported YAML scalar")
    if token in {"true", "false", "null", "~"}:
        raise ValueError("YAML implicit scalar cannot substitute for text")
    return token


def skill_frontmatter(raw: str, expected_name: str = NAME) -> dict[str, object]:
    """Strict supported subset: top-level text keys; metadata = map of strings."""
    lines = raw.splitlines()
    if not lines or lines[0] != "---":
        raise ValueError("SKILL.md requires top-of-file YAML frontmatter")
    try:
        end = lines.index("---", 1)
    except ValueError as ex:
        raise ValueError("frontmatter is unclosed") from ex
    if end > 256:
        raise ValueError("frontmatter exceeds 256 lines")
    data: dict[str, object] = {}
    metadata: dict[str, str] = {}
    nested = False
    for line in lines[1:end]:
        if not line.strip() or line.lstrip().startswith("#"):
            raise ValueError("frontmatter disallows blank/comment lines")
        if line.startswith("  "):
            if not nested or line.startswith("   "):
                raise ValueError("invalid metadata indentation")
            match = KEY.fullmatch(line[2:])
            if not match or match.group(2) is None:
                raise ValueError("metadata entries must be scalar key: value")
            key, value = match.groups()
            if key in metadata:
                raise ValueError("duplicate metadata key")
            metadata[key] = scalar(value)
            continue
        if line[0].isspace():
            raise ValueError("top-level YAML key cannot be indented")
        match = KEY.fullmatch(line)
        if not match:
            raise ValueError("unsupported YAML syntax")
        key, token = match.groups()
        if key in data:
            raise ValueError("duplicate top-level YAML key")
        if key == "metadata":
            if token is not None:
                raise ValueError("metadata must be a nested mapping")
            nested = True
            data[key] = metadata
        else:
            if token is None:
                raise ValueError("top-level YAML value must be scalar")
            data[key] = scalar(token)
            nested = False
    allowed = {"name", "description", "compatibility", "metadata"}
    if set(data) - allowed or not {"name", "description"} <= set(data):
        raise ValueError("frontmatter required/allowed keys violated")
    if data["name"] != expected_name:
        raise ValueError("name and install directory disagree")
    if len(expected_name) > 64 or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", expected_name):
        raise ValueError("invalid Agent Skills name")
    if not 1 <= len(str(data["description"])) <= 1024:
        raise ValueError("description must be 1..1024 characters")
    if "compatibility" in data and len(str(data["compatibility"])) > 500:
        raise ValueError("compatibility exceeds 500 characters")
    if not all(isinstance(v, str) for v in metadata.values()):
        raise ValueError("metadata values must be strings")
    return data


def slug(heading: str) -> str:
    """GitHub-style common heading slug (subset; ambiguous duplicates need review)."""
    label = re.sub(r"\[[^]]+\]\([^)]+\)", "", heading).lower()
    label = re.sub(r"[^\w \-]", "", label, flags=re.UNICODE)
    return re.sub(r" +", "-", label.strip())


def anchors(text: str) -> set[str]:
    result: set[str] = set()
    seen: dict[str, int] = {}
    fence: tuple[str, int] | None = None
    for line in text.splitlines():
        fm = FENCE.match(line)
        if fm:
            run = fm.group(1)
            if fence is None:
                fence = (run[0], len(run))
            elif run[0] == fence[0] and len(run) >= fence[1] and not line[len(fm.group(0)):].strip():
                fence = None
            continue
        if fence:
            continue
        h = re.match(r"^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?$", line)
        if h:
            base = slug(h.group(1))
            suffix = seen.get(base, 0)
            seen[base] = suffix + 1
            result.add(base if suffix == 0 else f"{base}-{suffix}")
    return result


def check_links(file: Path, root: Path, errors: list[str]) -> None:
    rel = file.relative_to(root).as_posix()
    text = file.read_text(encoding="utf-8-sig")
    fence: tuple[str, int] | None = None
    for number, line in enumerate(text.splitlines(), 1):
        fm = FENCE.match(line)
        if fm:
            run = fm.group(1)
            if fence is None:
                fence = (run[0], len(run))
            elif run[0] == fence[0] and len(run) >= fence[1] and re.fullmatch(r" {0,3}[\x60~]+\s*", line):
                fence = None
            continue
        if fence:
            continue
        for found in LOCAL_LINK.finditer(INLINE_CODE.sub("", line)):
            url = found.group(1)
            if url.startswith(("//", "http:", "https:", "mailto:", "data:")):
                continue
            parsed = urlsplit(url)
            if parsed.scheme or parsed.netloc:
                continue
            dest_name = unquote(parsed.path)
            if dest_name and ("\\" in dest_name or Path(dest_name).is_absolute()):
                errors.append(f"UNSAFE_LINK: {rel}:{number}: {url}")
                continue
            dest = (file.parent / dest_name).resolve() if dest_name else file
            try:
                dest.relative_to(root)
            except ValueError:
                errors.append(f"ESCAPED_LINK: {rel}:{number}: {url}")
                continue
            if not dest.is_file():
                errors.append(f"BROKEN_LINK: {rel}:{number}: {url}")
            elif parsed.fragment and dest.suffix.lower() == ".md":
                target = dest.read_text(encoding="utf-8-sig")
                if unquote(parsed.fragment).lower() not in anchors(target):
                    errors.append(f"BROKEN_ANCHOR: {rel}:{number}: {url}")


def verify(root: Path) -> list[str]:
    errors: list[str] = []
    root = root.resolve()
    if root.name != NAME:
        errors.append(f"skill folder must be called {NAME}: {root}")
    for rel in NEEDED:
        path = root / rel
        if not path.is_file() or path.is_symlink():
            errors.append(f"required regular file missing: {rel}")
    path = root / "SKILL.md"
    if not path.is_file():
        return errors
    try:
        skill_frontmatter(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, ValueError, TypeError) as ex:
        errors.append(f"FRONTMATTER_INVALID: {ex}")
    for file in sorted(root.rglob("*")):
        if file.is_symlink():
            errors.append(f"SYMLINK_FORBIDDEN: {file.relative_to(root)}")
            continue
        if not file.is_file():
            continue
        rel = file.relative_to(root).as_posix()
        if "__pycache__" in file.parts or file.suffix == ".pyc":
            errors.append(f"RUNTIME_CACHE_PRESENT: {rel}")
            continue
        if file.suffix.lower() == ".md":
            try:
                raw = file.read_bytes()
                text = raw.decode("utf-8-sig")
                issues: list[dict[str, str]] = []
                markdown_structure(text, rel, issues)
                errors.extend(f"{entry['code']}: {entry['detail']}" for entry in issues)
                if not raw.endswith(b"\n"):
                    errors.append(f"TRAILING_LF_MISSING: {rel}")
                if b"\r" in raw:
                    errors.append(f"MIXED_OR_CRLF: {rel}")
                check_links(file, root, errors)
            except (OSError, UnicodeError) as ex:
                errors.append(f"MD_READ_FAILED: {rel}: {ex}")
        if file.suffix.lower() == ".json":
            try:
                json.loads(file.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, ValueError) as ex:
                errors.append(f"JSON_INVALID: {rel}: {ex}")
    try:
        schema = json.loads((root / "assets/audit.schema.json").read_text(encoding="utf-8"))
        if schema.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
            errors.append("SCHEMA_VERSION_INVALID")
        if "RECOMMEND" not in schema["properties"]["units"]["items"]["properties"]["kind"]["enum"]:
            errors.append("SCHEMA_KIND_RECOMMEND_MISSING")
    except (OSError, ValueError, KeyError, TypeError) as ex:
        errors.append(f"SCHEMA_INVALID: {ex}")
    manifest = root / "SHA256SUMS"
    if not manifest.is_file() or manifest.is_symlink():
        errors.append("MANIFEST_MISSING: SHA256SUMS required")
        return errors
    seen: set[str] = set()
    for line in manifest.read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"([a-f0-9]{64})  (.+)", line)
        if not match:
            errors.append("MANIFEST_FORMAT_INVALID")
            continue
        expected_hash, rel = match.groups()
        posix = Path(rel.replace("\\", "/"))
        if rel in seen or rel.startswith(("/", "\\")) or posix.is_absolute() or ".." in posix.parts or "\\" in rel:
            errors.append(f"MANIFEST_PATH_INVALID: {rel}")
            continue
        seen.add(rel)
        item = (root / rel).resolve()
        if not item.is_file() or item.is_symlink() or not item.is_relative_to(root):
            errors.append(f"MANIFEST_FILE_MISSING: {rel}")
        elif hashlib.sha256(item.read_bytes()).hexdigest() != expected_hash:
            errors.append(f"MANIFEST_HASH_MISMATCH: {rel}")
    actual = {f.relative_to(root).as_posix() for f in root.rglob("*")
              if f.is_file() and f.name != "SHA256SUMS"}
    if actual - seen:
        errors.append(f"MANIFEST_UNLISTED_FILES: {sorted(actual - seen)}")
    if seen - actual:
        errors.append(f"MANIFEST_LISTS_NONEXISTENT_FILES: {sorted(seen - actual)}")
    return errors



def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", nargs="?", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    errors = verify(args.root)
    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1
    print("PASS: package frontmatter, Markdown subset, links, SHA256SUMS and file inventory")
    return 0


if __name__ == "__main__":
    sys.exit(main())
