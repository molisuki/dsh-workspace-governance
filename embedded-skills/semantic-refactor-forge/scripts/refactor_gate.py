#!/usr/bin/env python3
"""Structural and audit-index gate; never claims natural-language equivalence."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Single authority: audit.schema.json owns all finite vocabulary sets.
CONTRACT = json.loads((Path(__file__).resolve().parents[1] / "assets" / "audit.schema.json").read_text(encoding="utf-8"))
PROPS = CONTRACT["properties"]
ATOM_PROPS = PROPS["units"]["items"]["properties"]
REVIEW_PROPS = PROPS["review"]["properties"]
KINDS = frozenset(ATOM_PROPS["kind"]["enum"])
DECISIONS = frozenset(ATOM_PROPS["decision"]["enum"])
REVIEWS = frozenset(REVIEW_PROPS["semantic_equivalence"]["enum"])
SCOPES = frozenset(PROPS["scope"]["enum"])
RULE_LINE = re.compile(r"判定[：:]|断路[：:]|必须|严禁|不得|禁止|不准|不可|绝不可|应当|允许|仅当|建议|MUST_NOT|\bMUST\b|\bSHALL\b", re.I)
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(?:[^`~]*)?$")
HEADING = re.compile(r"^ {0,3}(#{1,6})(?:\s|$)")
UNIT = re.compile(r"^A[0-9]{3,}$")
HASH = re.compile(r"^[a-f0-9]{64}$")


def unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """Reject ambiguous audit records instead of silently accepting a later key."""
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate audit JSON key: {key}")
        result[key] = value
    return result


def reject_json_constant(value: str) -> None:
    raise ValueError(f"nonstandard audit JSON constant: {value}")


def read_snapshot(path: Path) -> tuple[str, str]:
    """Decode and hash exactly the same immutable byte snapshot."""
    data = path.read_bytes()
    return data.decode("utf-8-sig"), hashlib.sha256(data).hexdigest()


def report_conflicts(report: Path, inputs: tuple[Path, ...]) -> bool:
    """Reject aliases, hard links, and symbolic-link outputs to evidence files."""
    if report.is_symlink():
        return True
    destination = report.resolve()
    return any(destination == source.resolve() or
               (report.exists() and report.samefile(source))
               for source in inputs)


def write_report_atomic(report: Path, contents: str) -> None:
    """Commit a complete UTF-8 report without truncating an existing report on failure."""
    staging: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", newline="\n",
            prefix=f".{report.name}.", suffix=".tmp",
            dir=report.parent, delete=False,
        ) as stream:
            staging = Path(stream.name)
            stream.write(contents + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(staging, report)
    finally:
        if staging is not None:
            staging.unlink(missing_ok=True)


def issue(issues: list[dict[str, str]], code: str, detail: str) -> None:
    issues.append({"code": code, "detail": detail})


def markdown_structure(text: str, label: str, issues: list[dict[str, str]]) -> list[tuple[int, str]]:
    """Validate basic fences, heading levels, and pipe-table column counts.

    Not a complete CommonMark parser. The report explicitly bounds this fact.
    """
    lines = text.splitlines()
    current: tuple[str, int, int] | None = None
    normative: list[tuple[int, str]] = []
    last_h = 0
    table_expected: int | None = None
    frontmatter = bool(lines and lines[0].strip() == "---")
    frontmatter_closed = not frontmatter

    def cols(row: str) -> list[str]:
        raw = row.strip().strip("|")
        return re.split(r"(?<!\\)\|", raw)

    def delimiter(row: str) -> bool:
        cells = cols(row)
        return len(cells) >= 2 and all(re.fullmatch(r"\s*:?-{3,}:?\s*", x) for x in cells)

    for i, line in enumerate(lines, 1):
        if not frontmatter_closed:
            if i > 1 and line.strip() == "---":
                frontmatter_closed = True
            elif i > 256:
                issue(issues, "FRONTMATTER_UNCLOSED", f"{label}:{i}")
                frontmatter_closed = True
            continue

        fence_match = FENCE.match(line)
        if current:
            char, count, start = current
            stripped = line.lstrip(" ")
            if len(line) - len(stripped) <= 3 and re.fullmatch(re.escape(char) + "{" + str(count) + r",}\s*", stripped):
                current = None
            continue
        if fence_match:
            run = fence_match.group(1)
            current = (run[0], len(run), i)
            table_expected = None
            continue
        # A second Markdown list item joined to a prior sentence is not a valid rule boundary.
        inline_normalized = re.sub(r"\x60[^\x60]*\x60", "", line)
        if (line.lstrip().startswith(("- ", "* ")) and
                re.search(r"[。.!?；;]\s*[-*]\s+\*\*", inline_normalized)):
            issue(issues, "LIST_BOUNDARY", f"{label}:{i}, joined list entries")

        h = HEADING.match(line)
        if h:
            depth = len(h.group(1))
            if last_h and depth > last_h + 1:
                issue(issues, "HEADING_SKIP", f"{label}:{i}, h{last_h}->h{depth}")
            last_h = depth
            table_expected = None
        if RULE_LINE.search(line) and not line.strip().startswith(">"):
            normative.append((i, line.strip()))
        if delimiter(line):
            n = len(cols(line))
            if i == 1 or len(cols(lines[i - 2])) != n:
                issue(issues, "TABLE_HEADER", f"{label}:{i}, separator has {n} cells")
            table_expected = n
            continue
        if line.strip() and "|" in line and table_expected is not None:
            n = len(cols(line))
            if n != table_expected:
                issue(issues, "TABLE_WIDTH", f"{label}:{i}, expected {table_expected}, got {n}")
        elif not line.strip() or line.startswith("#"):
            table_expected = None
    if current:
        issue(issues, "FENCE_UNCLOSED", f"{label}:{current[2]} {current[0] * current[1]}")
    if frontmatter and not frontmatter_closed:
        issue(issues, "FRONTMATTER_UNCLOSED", f"{label}:1")
    return normative


def significant_lines(text: str) -> list[tuple[int, str]]:
    """Conservative source/target inventory; language-independent, not a semantics oracle.

    Blank lines, syntax-only fence markers, table delimiters and Markdown headings
    are structural. Every other nonblank line requires a mapped quoted span.
    """
    result: list[tuple[int, str]] = []
    in_frontmatter = text.startswith("---\n") or text.startswith("---\r\n")
    for i, line in enumerate(text.splitlines(), 1):
        value = line.strip()
        if in_frontmatter and value == "---":
            if i > 1:
                in_frontmatter = False
            continue
        if not value or FENCE.match(line) or HEADING.match(line):
            continue
        if re.fullmatch(r"\s*[-*_]{3,}\s*", line):
            continue
        cells = re.split(r"(?<!\\)\|", value.strip("|"))
        if len(cells) >= 2 and all(re.fullmatch(r"\s*:?-{3,}:?\s*", x) for x in cells):
            continue
        result.append((i, value))
    return result


def check_audit(src: str, dst: str, audit: Any, issues: list[dict[str, str]]) -> dict[str, int]:
    counts = {"units": 0, "source_rule_lines": 0, "target_rule_lines": 0,
              "mapped_source_rule_lines": 0, "mapped_target_rule_lines": 0,
              "source_content_lines": 0, "target_content_lines": 0,
              "mapped_source_content_lines": 0, "mapped_target_content_lines": 0}
    if not isinstance(audit, dict):
        issue(issues, "AUDIT_FORMAT", "root must be an object")
        return counts
    mandatory = {"source_id", "target_id", "scope", "source_sha256", "target_sha256", "units", "unmapped_source", "unauthorized_additions", "open_issues", "review"}
    for field in sorted(mandatory - set(audit)):
        issue(issues, "AUDIT_MISSING", field)
    if set(audit) - mandatory:
        issue(issues, "AUDIT_EXTRA", ", ".join(sorted(set(audit) - mandatory)))
    for key in ("source_id", "target_id"):
        if not isinstance(audit.get(key), str) or not audit[key].strip():
            issue(issues, "AUDIT_FIELD", f"{key} must be nonempty text")
    if not isinstance(audit.get("scope"), str) or audit["scope"] not in SCOPES:
        issue(issues, "AUDIT_SCOPE", repr(audit.get("scope")))
    for k in ("source_sha256", "target_sha256"):
        if not isinstance(audit.get(k), str) or not HASH.fullmatch(audit[k]):
            issue(issues, "AUDIT_SHA_FORMAT", k)
    for k in ("unmapped_source", "unauthorized_additions", "open_issues"):
        value = audit.get(k)
        if not isinstance(value, list) or any(not isinstance(x, str) for x in value):
            issue(issues, "AUDIT_FIELD", f"{k} must be string array")
        elif value:
            issue(issues, "AUDIT_OPEN", f"{k} = {len(value)}")
    review = audit.get("review")
    if not isinstance(review, dict):
        issue(issues, "REVIEW_INVALID", "review must be an object")
    else:
        expected = set(PROPS["review"]["required"])
        if set(review) != expected:
            issue(issues, "REVIEW_FIELDS", f"expected {sorted(expected)}")
        for k in ("semantic_equivalence", "structural_integrity", "authority_consistency"):
            if not isinstance(review.get(k), str) or review[k] not in REVIEWS:
                issue(issues, "REVIEW_INVALID", f"{k}: invalid")
            elif review[k] != "PASS":
                issue(issues, "REVIEW_NOT_PASSED", f"{k}: {review[k]}")
        reviewer = review.get("reviewer")
        if not isinstance(reviewer, str) or not reviewer.strip():
            issue(issues, "REVIEWER_MISSING", "an accountable reviewer identifier is required")
        refs = review.get("evidence_refs")
        if not isinstance(refs, list) or not refs or any(not isinstance(v, str) or not v.strip() for v in refs):
            issue(issues, "REVIEW_EVIDENCE_MISSING", "nonempty evidence_refs required")
        elif len(refs) != len(set(refs)):
            issue(issues, "REVIEW_EVIDENCE_DUPLICATE", "evidence_refs must be unique")
        stamp = review.get("reviewed_at_utc")
        try:
            if not isinstance(stamp, str):
                raise ValueError("timestamp missing")
            parsed = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
            if parsed.tzinfo is None or parsed.utcoffset() is None or parsed.utcoffset().total_seconds() != 0:
                raise ValueError("timestamp must be UTC")
        except ValueError:
            issue(issues, "REVIEW_TIME_INVALID", "reviewed_at_utc must be ISO-8601 UTC")
        # Evidence refs are declarations, not independently authenticated signatures.
    units = audit.get("units")
    if not isinstance(units, list) or not units:
        issue(issues, "AUDIT_UNITS", "at least one atom is required")
        units = []
    counts["units"] = len(units)
    source_lines = src.splitlines()
    source_rules = markdown_structure(src, "source", issues)
    target_rules = markdown_structure(dst, "target", issues)
    counts["source_rule_lines"] = len(source_rules)
    counts["target_rule_lines"] = len(target_rules)
    mapped_lines: set[int] = set()
    target_quotes: list[str] = []
    seen_ids: set[str] = set()

    for idx, atom in enumerate(units, 1):
        ref = f"unit[{idx}]"
        if not isinstance(atom, dict):
            issue(issues, "UNIT_FORMAT", ref)
            continue
        fields = {"id", "kind", "source_lines", "source_quote", "target_quote", "decision", "rationale"}
        extra = set(atom) - (fields | {"removal_evidence"})
        if fields - set(atom) or extra:
            issue(issues, "UNIT_FIELDS", f"{ref} missing={sorted(fields-set(atom))}, extra={sorted(extra)}")
        aid = atom.get("id")
        if not isinstance(aid, str) or not UNIT.fullmatch(aid) or aid in seen_ids:
            issue(issues, "UNIT_ID", f"{ref}: {aid!r}")
        if isinstance(aid, str):
            seen_ids.add(aid)
        kind = atom.get("kind")
        decision = atom.get("decision")
        if not isinstance(kind, str) or kind not in KINDS:
            issue(issues, "UNIT_KIND", f"{ref}: {kind!r}")
        if not isinstance(decision, str) or decision not in DECISIONS:
            issue(issues, "UNIT_DECISION", f"{ref}: {decision!r}")
        if decision == "UNRESOLVED":
            issue(issues, "UNIT_UNRESOLVED", ref)
        for field in ("source_quote", "target_quote", "rationale"):
            if not isinstance(atom.get(field), str):
                issue(issues, "UNIT_TEXT", f"{ref}.{field}")
        if not isinstance(atom.get("rationale"), str) or not atom["rationale"].strip():
            issue(issues, "UNIT_RATIONALE", ref)
        srcquote, dstquote = atom.get("source_quote"), atom.get("target_quote")
        if isinstance(srcquote, str) and (not srcquote or srcquote not in src):
            issue(issues, "SOURCE_QUOTE_MISSING", ref)
        if decision != "JUSTIFIED_REMOVAL":
            if not isinstance(dstquote, str) or not dstquote or dstquote not in dst:
                issue(issues, "TARGET_QUOTE_MISSING", ref)
            elif dstquote:
                target_quotes.append(dstquote)
        if kind == "ANCHOR" and (decision != "PRESERVED" or srcquote != dstquote):
            issue(issues, "ANCHOR_CHANGED", ref)
        if decision == "PRESERVED" and srcquote != dstquote:
            issue(issues, "PRESERVE_CHANGED", ref)
        if decision == "JUSTIFIED_REMOVAL":
            if not isinstance(kind, str) or kind not in {"REDUNDANCY", "OBSOLETE"}:
                issue(issues, "UNAUTHORIZED_REMOVAL", ref)
            if not isinstance(atom.get("removal_evidence"), str) or not atom["removal_evidence"].strip():
                issue(issues, "REMOVAL_EVIDENCE_MISSING", ref)
            if dstquote:
                issue(issues, "REMOVED_HAS_TARGET", ref)
        elif "removal_evidence" in atom:
            issue(issues, "UNEXPECTED_REMOVAL_EVIDENCE", ref)
        indices = atom.get("source_lines")
        if not isinstance(indices, list) or not indices or any(type(x) is not int or x < 1 or x > len(source_lines) for x in indices):
            issue(issues, "SOURCE_LINES_INVALID", ref)
            continue
        if len(indices) != len(set(indices)):
            issue(issues, "SOURCE_LINES_DUPLICATE", ref)
        else:
            mapped_lines.update(indices)
            if isinstance(srcquote, str) and (srcquote not in "\n".join(source_lines[x - 1] for x in sorted(indices)) or any(source_lines[x - 1].strip() not in srcquote for x in indices if source_lines[x - 1].strip())):
                issue(issues, "QUOTE_LINE_MISMATCH", ref)

    source_content = significant_lines(src)
    target_content = significant_lines(dst)
    # A quote may cover multiple lines only when it contains each quoted line.
    for line, content in source_content:
        if line not in mapped_lines:
            issue(issues, "SOURCE_CONTENT_UNMAPPED", f"line {line}: {content[:90]}")
    for line, content in target_content:
        if not any(content in quote for quote in target_quotes):
            issue(issues, "TARGET_CONTENT_UNMAPPED", f"line {line}: {content[:90]}")
    for line, content in source_rules:
        if line not in mapped_lines:
            issue(issues, "SOURCE_RULE_UNMAPPED", f"line {line}: {content[:90]}")
    for line, content in target_rules:
        if not any(content in quote for quote in target_quotes):
            issue(issues, "TARGET_RULE_UNMAPPED", f"line {line}: {content[:90]}")
    counts["source_content_lines"] = len(source_content)
    counts["target_content_lines"] = len(target_content)
    counts["mapped_source_content_lines"] = sum(n in mapped_lines for n, _ in source_content)
    counts["mapped_target_content_lines"] = sum(any(t in q for q in target_quotes) for _, t in target_content)
    counts["mapped_source_rule_lines"] = sum(n in mapped_lines for n, _ in source_rules)
    counts["mapped_target_rule_lines"] = sum(any(t in q for q in target_quotes) for _, t in target_rules)
    return counts


def run(source: Path, target: Path, audit_path: Path, report: Path | None) -> int:
    try:
        if report is not None and report_conflicts(report, (source, target, audit_path)):
            raise ValueError("report path aliases an input or is a symbolic link")
        src, sh = read_snapshot(source)
        dst, th = read_snapshot(target)
        audit_text, _ = read_snapshot(audit_path)
        aud = json.loads(audit_text,
                         object_pairs_hook=unique_json_object,
                         parse_constant=reject_json_constant)
    except (OSError, UnicodeError, ValueError) as ex:
        print(f"USAGE: {type(ex).__name__}: {ex}", file=sys.stderr)
        return 2
    problems: list[dict[str, str]] = []
    counts = check_audit(src, dst, aud, problems)
    if isinstance(aud, dict):
        if aud.get("source_sha256") != sh:
            issue(problems, "SOURCE_HASH_MISMATCH", "source differs from reviewed snapshot")
        if aud.get("target_sha256") != th:
            issue(problems, "TARGET_HASH_MISMATCH", "target differs from reviewed snapshot")
    result = {
        "status": "FAIL" if problems else "PASS",
        "structural_gate_only": True,
        "semantic_equivalence_proved": False,
        "review_claim_authenticated": False,
        "meaning": "PASS asserts checked syntax, line-inventory coverage and recorded review fields only; neither semantic equivalence nor review identity is independently authenticated.",
        "checked_at_utc": datetime.now(timezone.utc).isoformat(),
        "source_sha256": sh,
        "target_sha256": th,
        "counts": counts,
        "issues": problems,
    }
    data = json.dumps(result, ensure_ascii=False, indent=2)
    if report:
        try:
            write_report_atomic(report, data)
        except OSError as ex:
            print(f"USAGE: could not write report: {ex}", file=sys.stderr)
            return 2
    print(data)
    return 1 if problems else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--target", type=Path, required=True)
    parser.add_argument("--audit", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    return run(args.source, args.target, args.audit, args.report)


if __name__ == "__main__":
    sys.exit(main())
