"""Positive and adversarial checks; no LLM behavior testing is implied."""
from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from refactor_gate import run, markdown_structure  # noqa: E402
from verify_package import verify  # noqa: E402


def digest(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


class GateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.src = self.base / "source.md"
        self.dst = self.base / "target.md"
        self.src.write_bytes((ROOT / "tests/fixtures/source.md").read_bytes())
        self.dst.write_bytes((ROOT / "tests/fixtures/target.md").read_bytes())
        self.audit = self.base / "audit.json"
        self.data = {
            "source_id": "source.md",
            "target_id": "target.md",
            "scope": "FULL",
            "source_sha256": digest(self.src),
            "target_sha256": digest(self.dst),
            "units": [
                {"id": "A001", "kind": "MUST", "source_lines": [3],
                 "source_quote": "必须验证每个变更。", "target_quote": "判定：每项变更必须经验证。",
                 "decision": "REFORMULATED", "rationale": "责任与强度保持。"},
                {"id": "A002", "kind": "MUST_NOT", "source_lines": [5],
                 "source_quote": "禁止跳过人工复核。", "target_quote": "断路：禁止跳过人工复核。",
                 "decision": "REFORMULATED", "rationale": "禁止维持。"},
            ],
            "unmapped_source": [], "unauthorized_additions": [], "open_issues": [],
            "review": {"semantic_equivalence": "PASS", "structural_integrity": "PASS",
                       "authority_consistency": "PASS", "reviewer": "测试审查主体",
                       "reviewed_at_utc": "2026-10-27T00:00:00Z",
                       "evidence_refs": ["fixture:review:two-atoms"]},
        }

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def check(self) -> int:
        self.audit.write_text(json.dumps(self.data, ensure_ascii=False), encoding="utf-8")
        return run(self.src, self.dst, self.audit, self.base / "report.json")

    def test_positive(self) -> None:
        self.assertEqual(self.check(), 0)

    def test_report_must_not_overwrite_evidence_inputs(self) -> None:
        from contextlib import redirect_stdout
        from io import StringIO
        self.audit.write_text(json.dumps(self.data, ensure_ascii=False), encoding="utf-8")
        for protected in (self.src, self.dst, self.audit):
            with self.subTest(path=protected.name):
                original = protected.read_bytes()
                with redirect_stdout(StringIO()):
                    status = run(self.src, self.dst, self.audit, protected)
                self.assertEqual(status, 2, "Report alias must be rejected before writing")
                self.assertEqual(protected.read_bytes(), original)

    def test_report_atomic_failure_preserves_existing_result(self) -> None:
        from contextlib import redirect_stdout
        from io import StringIO
        from unittest.mock import patch
        self.audit.write_text(json.dumps(self.data, ensure_ascii=False), encoding="utf-8")
        report = self.base / "report.json"
        previous = b'{"result":"previous-verified-report"}\n'
        report.write_bytes(previous)
        with patch("refactor_gate.os.replace", side_effect=OSError("simulated rename failure")):
            with redirect_stdout(StringIO()):
                self.assertEqual(run(self.src, self.dst, self.audit, report), 2)
        self.assertEqual(report.read_bytes(), previous)
        self.assertEqual(sorted(p.name for p in self.base.iterdir()),
                         sorted((self.src.name, self.dst.name, self.audit.name, report.name)))

    def test_report_write_never_creates_input_alias_via_dotdot(self) -> None:
        from contextlib import redirect_stdout
        from io import StringIO
        self.audit.write_text(json.dumps(self.data, ensure_ascii=False), encoding="utf-8")
        alias = self.base / "folder" / ".." / self.src.name
        (self.base / "folder").mkdir()
        original = self.src.read_bytes()
        with redirect_stdout(StringIO()):
            self.assertEqual(run(self.src, self.dst, self.audit, alias), 2)
        self.assertEqual(self.src.read_bytes(), original)

    def test_malformed_enum_shapes_fail_with_structured_issues(self) -> None:
        import copy
        from contextlib import redirect_stdout
        from io import StringIO
        cases = [
            ("scope-array", lambda audit: audit.update(scope=["FULL"])),
            ("review-array", lambda audit: audit["review"].update(semantic_equivalence=["PASS"])),
            ("kind-object", lambda audit: audit["units"][0].update(kind={"type": "MUST"})),
            ("decision-array", lambda audit: audit["units"][0].update(decision=["REFORMULATED"])),
        ]
        for label, change in cases:
            with self.subTest(label=label):
                audit = copy.deepcopy(self.data)
                change(audit)
                self.audit.write_text(json.dumps(audit, ensure_ascii=False), encoding="utf-8")
                with redirect_stdout(StringIO()):
                    result = run(self.src, self.dst, self.audit, None)
                self.assertEqual(result, 1, "Malformed JSON value caused a crash or false PASS")

    def test_hash_and_text_share_a_single_read_snapshot(self) -> None:
        from contextlib import redirect_stdout
        from io import StringIO
        from unittest.mock import patch
        self.audit.write_text(json.dumps(self.data, ensure_ascii=False), encoding="utf-8")
        real_read = Path.read_bytes
        count = {self.src: 0, self.dst: 0, self.audit: 0}

        def observed_read(path):
            if path in count:
                count[path] += 1
            return real_read(path)

        with patch.object(Path, "read_bytes", observed_read):
            with redirect_stdout(StringIO()):
                self.assertEqual(run(self.src, self.dst, self.audit, None), 0)
        self.assertEqual(count, {self.src: 1, self.dst: 1, self.audit: 1})

    def test_report_rejects_hardlink_to_evidence(self) -> None:
        from contextlib import redirect_stdout
        from io import StringIO
        from os import link
        self.audit.write_text(json.dumps(self.data, ensure_ascii=False), encoding="utf-8")
        alias = self.base / "report-hardlink.json"
        try:
            link(self.src, alias)
        except OSError as exc:
            self.skipTest(f"hardlinks unavailable: {exc}")
        original = self.src.read_bytes()
        with redirect_stdout(StringIO()):
            self.assertEqual(run(self.src, self.dst, self.audit, alias), 2)
        self.assertEqual(self.src.read_bytes(), original)

    def test_missing_atom(self) -> None:
        self.data["units"].pop()
        self.assertEqual(self.check(), 1)

    def test_unresolved(self) -> None:
        self.data["units"][0]["decision"] = "UNRESOLVED"
        self.assertEqual(self.check(), 1)

    def test_unapproved_removal(self) -> None:
        self.data["units"][0]["decision"] = "JUSTIFIED_REMOVAL"
        self.data["units"][0]["target_quote"] = ""
        self.assertEqual(self.check(), 1)

    def test_duplicate_audit_json_keys_are_rejected(self) -> None:
        valid = json.dumps(self.data, ensure_ascii=False)
        # A repeated root key must not let the final value silently overwrite evidence.
        doubled = valid.replace('"scope": "FULL",',
                                '"scope": "SELECTION", "scope": "FULL",', 1)
        self.assertNotEqual(doubled, valid)
        self.audit.write_text(doubled, encoding="utf-8")
        self.assertNotEqual(run(self.src, self.dst, self.audit, None), 0)

    def test_changed_source_invalidates_hash(self) -> None:
        self.src.write_text(self.src.read_text() + "\n", encoding="utf-8")
        self.assertEqual(self.check(), 1)

    def test_changed_target_invalidates_hash(self) -> None:
        self.dst.write_text(self.dst.read_text() + "\n", encoding="utf-8")
        self.assertEqual(self.check(), 1)

    def test_claimed_review_not_passed(self) -> None:
        self.data["review"]["semantic_equivalence"] = "PENDING"
        self.assertEqual(self.check(), 1)

    def test_foreign_target_rule(self) -> None:
        self.dst.write_text(self.dst.read_text() + "\n必须删除全部历史文件。\n", encoding="utf-8")
        self.data["target_sha256"] = digest(self.dst)
        self.assertEqual(self.check(), 1)

    def test_fence_missing(self) -> None:
        self.dst.write_text(self.dst.read_text() + "\n```python\nprint(1)\n", encoding="utf-8")
        self.data["target_sha256"] = digest(self.dst)
        self.assertEqual(self.check(), 1)

    def test_anchor_rewrite_prohibited(self) -> None:
        self.data["units"][0]["kind"] = "ANCHOR"
        self.assertEqual(self.check(), 1)

    def test_extra_unit_field(self) -> None:
        self.data["units"][0]["unknown"] = "bad"
        self.assertEqual(self.check(), 1)

    def test_concatenated_list_item_is_rejected(self) -> None:
        problems = []
        markdown_structure(
            "- **范围**：保留输入原意。- **开放性**：扩展须有证据。\\n",
            "list-fixture", problems,
        )
        self.assertTrue(any(x["code"] == "LIST_BOUNDARY" for x in problems))

    def test_package(self) -> None:
        self.assertEqual(verify(ROOT), [])


    def test_unrecognized_prohibition_cannot_disappear(self) -> None:
        self.src.write_text(self.src.read_text(encoding="utf-8") + "\n绝不可损毁历史记录。\n", encoding="utf-8")
        self.data["source_sha256"] = digest(self.src)
        self.assertEqual(self.check(), 1)

    def test_nonkeyword_target_addition_is_tracked(self) -> None:
        self.dst.write_text(self.dst.read_text(encoding="utf-8") + "\n这份规则仅适用于管理员。\n", encoding="utf-8")
        self.data["target_sha256"] = digest(self.dst)
        self.assertEqual(self.check(), 1)

    def test_claimed_source_lines_must_match_whole_lines(self) -> None:
        self.data["units"][0]["source_lines"] = [3, 5]
        self.assertEqual(self.check(), 1)

    def test_review_requires_traceable_evidence(self) -> None:
        self.data["review"]["evidence_refs"] = []
        self.assertEqual(self.check(), 1)

    def test_manifest_is_required(self) -> None:
        import shutil
        dest = self.base / "semantic-refactor-forge"
        shutil.copytree(ROOT, dest, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        (dest / "SHA256SUMS").unlink()
        self.assertNotEqual(verify(dest), [])

    def test_invalid_frontmatter_yaml(self) -> None:
        dest = self._copy_skill()
        path = dest / "SKILL.md"
        path.write_text(path.read_text(encoding="utf-8").replace(
            'display_name: "语义重构与契约治理"',
            "display_name: [this is not valid YAML"), encoding="utf-8")
        self._rehash(dest)
        self.assertNotEqual(verify(dest), [])

    def test_dead_relative_link(self) -> None:
        dest = self._copy_skill()
        path = dest / "references/density.md"
        path.write_text(path.read_text(encoding="utf-8") +
                        "\n[不可用](not-present.md)\n", encoding="utf-8")
        self._rehash(dest)
        self.assertNotEqual(verify(dest), [])

    def test_broken_package_hash_fails(self) -> None:
        dest = self._copy_skill()
        (dest / "references/density.md").write_text("tampered\n", encoding="utf-8")
        self.assertNotEqual(verify(dest), [])

    def test_comprehensive_catalogue_is_consistent(self) -> None:
        schema = json.loads((ROOT / "assets/audit.schema.json").read_text(encoding="utf-8"))
        kinds = set(schema["properties"]["units"]["items"]["properties"]["kind"]["enum"])
        self.assertIn("RECOMMEND", kinds)
        self.assertIn("MUST_NOT", kinds)

    def test_review_evidence_does_not_claim_semantic_proof(self) -> None:
        report = self.base / "report.json"
        self.assertEqual(self.check(), 0)
        data = json.loads(report.read_text(encoding="utf-8"))
        self.assertTrue(data["structural_gate_only"])
        self.assertFalse(data["semantic_equivalence_proved"])


    def test_frontmatter_duplicate_key(self) -> None:
        dest = self._copy_skill()
        path = dest / "SKILL.md"
        path.write_text(path.read_text(encoding="utf-8").replace(
            "metadata:\n", 'metadata:\n  version: "duplicate"\n'),
            encoding="utf-8")
        self._rehash(dest)
        self.assertNotEqual(verify(dest), [])

    def test_broken_relative_anchor(self) -> None:
        dest = self._copy_skill()
        path = dest / "references/density.md"
        path.write_text(path.read_text(encoding="utf-8") +
                        "\n[跳转](../SKILL.md#non-existent-anchor)\n", encoding="utf-8")
        self._rehash(dest)
        self.assertNotEqual(verify(dest), [])

    def test_path_escape_link(self) -> None:
        dest = self._copy_skill()
        path = dest / "references/density.md"
        path.write_text(path.read_text(encoding="utf-8") +
                        "\n[非法链接](../../outside.md)\n", encoding="utf-8")
        self._rehash(dest)
        self.assertNotEqual(verify(dest), [])

    def test_invalid_audit_timestamp(self) -> None:
        self.data["review"]["reviewed_at_utc"] = "yesterday"
        self.assertEqual(self.check(), 1)

    def test_duplicate_evidence_ref(self) -> None:
        self.data["review"]["evidence_refs"] = ["receipt:1", "receipt:1"]
        self.assertEqual(self.check(), 1)

    def test_keyword_free_source_is_still_in_inventory(self) -> None:
        self.src.write_text(self.src.read_text(encoding="utf-8") +
                            "\n用户信任边界不得发生变化。\n", encoding="utf-8")
        self.data["source_sha256"] = digest(self.src)
        self.assertEqual(self.check(), 1)



    def test_package_without_optional_peer_skills(self) -> None:
        dest = self._copy_skill()
        self.assertEqual(verify(dest), [])


    def test_normative_documentation_contract(self) -> None:
        main = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn('version: "2.0.0"', main)
        self.assertIn("DISCOVERED", main)
        self.assertIn("RELEASED", main)
        self.assertIn("BLOCKED", main)
        self.assertEqual(
            [f"R{i}" for i in range(8)],
            __import__("re").findall(r"(?m)^\| (R[0-7]) \|", main),
        )
        references = sorted((ROOT / "references").glob("*.md"))
        self.assertEqual(len(references), 8)
        required = {
            "atomization.md": ("source_revision", "source_quote", "target_quote"),
            "terminology.md": ("MUST_NOT", "RECHECK", "S0_FATAL"),
            "density.md": ("REPHRASE", "DELETE_DUPLICATE", "反证"),
            "markdown.md": ("frontmatter", "Markdown", "Schema"),
            "verification.md": ("V01", "V12", "audit.schema.json"),
            "edge-matrix.md": ("SEMANTIC_DRIFT", "STALE_SNAPSHOT", "FAIL"),
            "output-contract.md": ("PURE_MARKDOWN", "IN_PLACE", "ARTIFACT"),
            "expert-review.md": ("反证", "责任", "审查"),
        }
        for file in references:
            text = file.read_text(encoding="utf-8")
            with self.subTest(reference=file.name):
                for term in required[file.name]:
                    self.assertIn(term, text)
                for informal in ("帮我", "快点", "没用", "废话", "大白话", "一刀切", "随便"):
                    self.assertNotIn(informal, text)
                self.assertGreater(len(text), 1200)
                self.assertIn("## 1.", text)
                self.assertTrue(text.endswith("\n"))

    def _copy_skill(self) -> Path:
        import shutil
        dest = self.base / "semantic-refactor-forge"
        shutil.copytree(ROOT, dest, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        return dest

    @staticmethod
    def _rehash(dest: Path) -> None:
        lines = []
        for f in sorted(dest.rglob("*")):
            if f.is_file() and f.name != "SHA256SUMS":
                lines.append(digest(f) + "  " + f.relative_to(dest).as_posix())
        (dest / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")

if __name__ == "__main__":
    unittest.main()