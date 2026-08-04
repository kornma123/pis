#!/usr/bin/env python3
"""Deterministic structural check for the run-graph-workflow skill."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path


SKILL_NAME = "run-graph-workflow"
PACKAGE_VERSION = "1.4.2"
REQUIRED_FILES = (
    "SKILL.md",
    "agents/openai.yaml",
    "references/decision-grill-gate.md",
    "references/portable-graph-handoff.md",
    "skill-package.json",
)


def configure_utf8_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def frontmatter(text: str) -> dict[str, str]:
    match = re.match(r"\A---\s*\n(.*?)\n---\s*\n", text, re.DOTALL)
    if not match:
        return {}
    values: dict[str, str] = {}
    for raw_line in match.group(1).splitlines():
        if ":" not in raw_line or raw_line[:1].isspace():
            continue
        key, value = raw_line.split(":", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def require_substrings(
    label: str, text: str, expected: tuple[str, ...], failures: list[str]
) -> None:
    for item in expected:
        if item not in text:
            failures.append(f"{label} 缺少关键合同：{item}")


def check(root: Path) -> dict[str, object]:
    failures: list[str] = []
    hashes: dict[str, str] = {}

    if root.name != SKILL_NAME:
        failures.append(f"目录名应为 {SKILL_NAME}，实际为 {root.name}")

    for relative in REQUIRED_FILES:
        path = root / relative
        if not path.is_file():
            failures.append(f"缺少文件：{relative}")
        else:
            hashes[relative] = sha256(path)

    skill_path = root / "SKILL.md"
    skill_text = skill_path.read_text(encoding="utf-8") if skill_path.is_file() else ""
    metadata = frontmatter(skill_text)
    if metadata.get("name") != SKILL_NAME:
        failures.append("SKILL.md frontmatter 的 name 不正确")
    description = metadata.get("description", "")
    require_substrings(
        "description",
        description,
        ("复杂", "多 Agent", "不要用于简单问答", "单 Agent 快速路径"),
        failures,
    )
    require_substrings(
        "SKILL.md",
        skill_text,
        (
            "REQ-v1",
            "任务节点与人工关卡合计不得超过 8 个",
            "同一文件或功能范围同一时刻只允许一个写入 owner",
            "不允许产物编写者担任最终验证者",
            "同一原因已完成 2 次定向返工仍失败",
            "保留人工确认关卡",
            "支持多 AI 与跨设备接力",
            "scripts/self_check.py --json",
            "用户已经打开的、前台可见的 Claude Code CLI 窗口",
            "不把“绑定到当前 Codex 任务”设为跨宿主通用前提",
            "VISIBLE_CLI_CONTROL_UNAVAILABLE",
            "决策澄清关卡",
            "grill-lite",
            "grill-with-docs",
            "每轮只提出一个决策问题",
            "每个短探针默认只覆盖 1–2 个场景",
            "GEW-CONTRACT-1.4.2",
        ),
        failures,
    )

    ui_path = root / "agents/openai.yaml"
    ui_text = ui_path.read_text(encoding="utf-8") if ui_path.is_file() else ""
    require_substrings(
        "agents/openai.yaml",
        ui_text,
        (
            'display_name: "Graph Engineering 工作流"',
            "$run-graph-workflow",
            "allow_implicit_invocation: true",
        ),
        failures,
    )

    handoff_path = root / "references/portable-graph-handoff.md"
    handoff_text = (
        handoff_path.read_text(encoding="utf-8") if handoff_path.is_file() else ""
    )
    require_substrings(
        "portable-graph-handoff.md",
        handoff_text,
        ("冻结需求", "节点状态表", "证据", "跨 AI / 跨设备交接包"),
        failures,
    )

    grill_path = root / "references/decision-grill-gate.md"
    grill_text = grill_path.read_text(encoding="utf-8") if grill_path.is_file() else ""
    require_substrings(
        "decision-grill-gate.md",
        grill_text,
        (
            "skipped",
            "grill-lite",
            "grill-with-docs",
            "每轮只问一个问题",
            "推荐答案",
            "默认最多 5 问",
            "绝对上限为 15 问",
            "status: pass | blocked | deferred | skipped",
            "原生 Skill 只是可选加速器",
        ),
        failures,
    )

    package_path = root / "skill-package.json"
    package: dict[str, object] = {}
    if package_path.is_file():
        try:
            package = json.loads(package_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            failures.append(f"skill-package.json 无法解析：{exc}")
    if package.get("package_id") != SKILL_NAME:
        failures.append("skill-package.json 的 package_id 不正确")
    if not re.fullmatch(r"\d+\.\d+\.\d+", str(package.get("version", ""))):
        failures.append("skill-package.json 的 version 不是语义化版本")
    if package.get("version") != PACKAGE_VERSION:
        failures.append(f"skill-package.json 的 version 必须为 {PACKAGE_VERSION}")
    if package.get("native_hosts") != ["codex-desktop", "claude-code-cli"]:
        failures.append("skill-package.json 的 native_hosts 必须仅包含 Codex 桌面端与 Claude Code CLI")
    if package.get("installer_provenance") != "run-graph-workflow-portable-kit-v1":
        failures.append("skill-package.json 缺少安装器来源标识")

    for path in root.rglob("*"):
        if path.is_file():
            if path.resolve() == Path(__file__).resolve():
                continue
            content = path.read_text(encoding="utf-8", errors="ignore")
            if re.search(r"\b(?:TODO|TBD)\b", content):
                failures.append(f"发现未完成占位符：{path.relative_to(root)}")

    return {
        "status": "PASS" if not failures else "FAIL",
        "skill": SKILL_NAME,
        "version": package.get("version"),
        "root": str(root.resolve()),
        "checks": {
            "required_files": len(REQUIRED_FILES),
            "frontmatter": metadata.get("name") == SKILL_NAME,
            "workflow_contract": not any(
                item.startswith("SKILL.md 缺少") for item in failures
            ),
            "ui_metadata": not any(
                item.startswith("agents/openai.yaml 缺少") for item in failures
            ),
            "portable_handoff": not any(
                item.startswith("portable-graph-handoff.md 缺少")
                for item in failures
            ),
            "decision_grill_gate": not any(
                item.startswith("decision-grill-gate.md 缺少")
                for item in failures
            ),
        },
        "hashes": hashes,
        "failures": failures,
        "claim_boundary": "静态 PASS 只证明安装内容完整，不证明宿主发现或行为验收通过。",
    }


def main() -> int:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="Skill 根目录；默认使用脚本所在 Skill。",
    )
    parser.add_argument("--json", action="store_true", help="输出 JSON。")
    args = parser.parse_args()

    result = check(args.root.expanduser().resolve())
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(f"[{result['status']}] {result['skill']} {result['version']}")
        for failure in result["failures"]:
            print(f"- {failure}")
        print(result["claim_boundary"])
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
