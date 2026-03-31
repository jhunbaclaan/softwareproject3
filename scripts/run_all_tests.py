#!/usr/bin/env python3
"""
Unified Test Runner and Report Generator for the Nexus Agent project.

Runs all test suites (backend, mcp-server, frontend, e2e), collects JUnit XML
results, and produces a single unified Markdown report.

Usage:
    python scripts/run_all_tests.py
    python scripts/run_all_tests.py --skip-e2e   # Skip E2E tests (requires dev server)

Output:
    test-results/UNIFIED_TEST_REPORT.md
    test-results/<component>-junit.xml  (per-component JUnit XML)
"""

import os
import sys
import subprocess
import time
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path

# Project root (parent of scripts/)
PROJECT_ROOT = Path(__file__).resolve().parent.parent
TEST_RESULTS_DIR = PROJECT_ROOT / "test-results"


def ensure_results_dir():
    TEST_RESULTS_DIR.mkdir(exist_ok=True)


def find_python():
    """Find the Python executable for the NexusAgent conda env."""
    candidates = [
        Path.home() / "miniconda3" / "envs" / "NexusAgent" / "python.exe",
        Path.home() / "anaconda3" / "envs" / "NexusAgent" / "python.exe",
        Path.home() / "miniconda3" / "envs" / "NexusAgent" / "bin" / "python",
        Path.home() / "anaconda3" / "envs" / "NexusAgent" / "bin" / "python",
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    # Fallback to PATH
    return sys.executable


def find_conda_env_dir():
    """Find the NexusAgent conda env directory (for node/npx/npm)."""
    candidates = [
        Path.home() / "miniconda3" / "envs" / "NexusAgent",
        Path.home() / "anaconda3" / "envs" / "NexusAgent",
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    return None


def run_suite(name: str, cmd: list[str], cwd: str, env_override: dict | None = None) -> dict:
    """Run a single test suite and return timing + exit code."""
    print(f"\n{'='*60}")
    print(f"  Running: {name}")
    print(f"  Command: {' '.join(cmd)}")
    print(f"  CWD: {cwd}")
    print(f"{'='*60}\n")

    start = time.time()
    # On Windows, use shell=True so that npx/npm can be found via PATH
    use_shell = sys.platform == "win32"
    run_env = {**os.environ, **(env_override or {})}
    result = subprocess.run(
        cmd if not use_shell else " ".join(cmd),
        cwd=cwd,
        capture_output=False,
        text=True,
        timeout=300,  # 5 minute timeout per suite
        shell=use_shell,
        env=run_env,
    )
    elapsed = time.time() - start

    return {
        "name": name,
        "exit_code": result.returncode,
        "duration_s": round(elapsed, 2),
    }


def parse_junit_xml(xml_path: str) -> dict:
    """Parse a JUnit XML file and return summary stats."""
    if not os.path.exists(xml_path):
        return {
            "tests": 0, "passed": 0, "failed": 0, "skipped": 0,
            "errors": 0, "duration_s": 0, "failures": [],
        }

    tree = ET.parse(xml_path)
    root = tree.getroot()

    total_tests = 0
    total_failures = 0
    total_errors = 0
    total_skipped = 0
    total_time = 0.0
    failure_details = []

    # Handle both <testsuites> and <testsuite> root elements
    suites = root.findall(".//testsuite")
    if not suites and root.tag == "testsuite":
        suites = [root]

    for suite in suites:
        tests = int(suite.get("tests", 0))
        failures = int(suite.get("failures", 0))
        errors = int(suite.get("errors", 0))
        skipped = int(suite.get("skipped", 0))
        suite_time = float(suite.get("time", 0))

        total_tests += tests
        total_failures += failures
        total_errors += errors
        total_skipped += skipped
        total_time += suite_time

        # Collect failure details
        for testcase in suite.findall("testcase"):
            failure = testcase.find("failure")
            error = testcase.find("error")
            if failure is not None or error is not None:
                elem = failure if failure is not None else error
                failure_details.append({
                    "class": testcase.get("classname", ""),
                    "name": testcase.get("name", ""),
                    "message": (elem.get("message", "") or "")[:200],
                })

    passed = total_tests - total_failures - total_errors - total_skipped

    return {
        "tests": total_tests,
        "passed": passed,
        "failed": total_failures + total_errors,
        "skipped": total_skipped,
        "errors": total_errors,
        "duration_s": round(total_time, 2),
        "failures": failure_details,
    }


def generate_report(results: list[dict], xml_results: dict[str, dict]) -> str:
    """Generate a unified Markdown report."""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    lines = [
        "# Nexus Agent - Unified Test Report",
        "",
        f"**Generated:** {now}",
        "",
        "---",
        "",
        "## Summary",
        "",
        "| Component | Tests | Passed | Failed | Skipped | Duration |",
        "|-----------|------:|-------:|-------:|--------:|---------:|",
    ]

    grand_tests = 0
    grand_passed = 0
    grand_failed = 0
    grand_skipped = 0
    grand_duration = 0.0

    for r in results:
        name = r["name"]
        xml = xml_results.get(name, {
            "tests": 0, "passed": 0, "failed": 0, "skipped": 0, "duration_s": 0,
        })

        tests = xml.get("tests", 0)
        passed = xml.get("passed", 0)
        failed = xml.get("failed", 0)
        skipped = xml.get("skipped", 0)
        duration = xml.get("duration_s", r.get("duration_s", 0))

        grand_tests += tests
        grand_passed += passed
        grand_failed += failed
        grand_skipped += skipped
        grand_duration += duration

        status = "PASS" if failed == 0 and r["exit_code"] == 0 else "FAIL"
        lines.append(
            f"| {name} | {tests} | {passed} | {failed} | {skipped} | {duration:.1f}s |"
        )

    lines.append(
        f"| **TOTAL** | **{grand_tests}** | **{grand_passed}** | **{grand_failed}** "
        f"| **{grand_skipped}** | **{grand_duration:.1f}s** |"
    )

    # Overall status
    all_pass = grand_failed == 0 and all(r["exit_code"] == 0 for r in results)
    status_emoji = "PASSED" if all_pass else "FAILED"
    lines.extend(["", f"**Overall Status:** {status_emoji}", ""])

    # Failed tests section
    all_failures = []
    for name, xml in xml_results.items():
        for f in xml.get("failures", []):
            all_failures.append({"component": name, **f})

    if all_failures:
        lines.extend(["---", "", "## Failed Tests", ""])
        for f in all_failures:
            lines.append(
                f"- **[{f['component']}]** `{f['class']}::{f['name']}`: {f['message']}"
            )
        lines.append("")

    # Per-component details
    lines.extend(["---", "", "## Per-Component Details", ""])
    for r in results:
        name = r["name"]
        xml = xml_results.get(name, {})
        exit_code = r["exit_code"]
        duration = r["duration_s"]
        tests = xml.get("tests", 0)
        passed = xml.get("passed", 0)
        failed = xml.get("failed", 0)

        status = "PASS" if exit_code == 0 else f"FAIL (exit {exit_code})"
        lines.append(f"### {name}")
        lines.append(f"- Status: {status}")
        lines.append(f"- Tests: {tests} (passed: {passed}, failed: {failed})")
        lines.append(f"- Wall-clock time: {duration:.1f}s")
        lines.append("")

    lines.extend([
        "---",
        "",
        "*Report generated by `scripts/run_all_tests.py`*",
    ])

    return "\n".join(lines)


def main():
    skip_e2e = "--skip-e2e" in sys.argv

    ensure_results_dir()
    python_exe = find_python()

    # Build a PATH override that includes the NexusAgent conda env so
    # node/npx/npm are always found, even when the env isn't activated.
    env_dir = find_conda_env_dir()
    node_env = {}
    if env_dir:
        import os as _os
        current_path = _os.environ.get("PATH", "")
        node_env["PATH"] = f"{env_dir}{_os.pathsep}{current_path}"
        print(f"  Using NexusAgent env: {env_dir}")

    # Define test suites
    suites = [
        {
            "name": "Backend (pytest)",
            "cmd": [
                python_exe, "-m", "pytest", "tests/", "-v",
                f"--junitxml={TEST_RESULTS_DIR / 'backend-junit.xml'}",
            ],
            "cwd": str(PROJECT_ROOT / "backend"),
            "xml": str(TEST_RESULTS_DIR / "backend-junit.xml"),
        },
        {
            "name": "MCP-Server (vitest)",
            "cmd": [
                "npx", "vitest", "run",
                "--reporter=default", "--reporter=junit",
                f"--outputFile.junit={TEST_RESULTS_DIR / 'mcp-server-junit.xml'}",
            ],
            "cwd": str(PROJECT_ROOT / "mcp-server"),
            "xml": str(TEST_RESULTS_DIR / "mcp-server-junit.xml"),
        },
        {
            "name": "Frontend (vitest)",
            "cmd": [
                "npx", "vitest", "run",
                "--reporter=default", "--reporter=junit",
                f"--outputFile.junit={TEST_RESULTS_DIR / 'frontend-junit.xml'}",
            ],
            "cwd": str(PROJECT_ROOT / "frontend"),
            "xml": str(TEST_RESULTS_DIR / "frontend-junit.xml"),
        },
    ]

    if not skip_e2e:
        suites.append({
            "name": "E2E (playwright)",
            "cmd": [
                "npx", "playwright", "test",
            ],
            "cwd": str(PROJECT_ROOT / "e2e"),
            "xml": str(TEST_RESULTS_DIR / "e2e-junit.xml"),
        })

    # Run all suites
    results = []
    for suite in suites:
        try:
            result = run_suite(suite["name"], suite["cmd"], suite["cwd"], env_override=node_env)
        except subprocess.TimeoutExpired:
            result = {"name": suite["name"], "exit_code": -1, "duration_s": 300}
            print(f"  TIMEOUT: {suite['name']} exceeded 5-minute limit")
        except FileNotFoundError as e:
            result = {"name": suite["name"], "exit_code": -2, "duration_s": 0}
            print(f"  ERROR: Could not run {suite['name']}: {e}")
        results.append(result)

    # Parse JUnit XML results
    xml_results = {}
    for suite in suites:
        xml_results[suite["name"]] = parse_junit_xml(suite["xml"])

    # Generate unified report
    report = generate_report(results, xml_results)
    report_path = TEST_RESULTS_DIR / "UNIFIED_TEST_REPORT.md"
    report_path.write_text(report, encoding="utf-8")

    print(f"\n{'='*60}")
    print(f"  Unified Test Report: {report_path}")
    print(f"{'='*60}\n")
    print(report)

    # Exit with non-zero if any suite failed
    any_failed = any(r["exit_code"] != 0 for r in results)
    sys.exit(1 if any_failed else 0)


if __name__ == "__main__":
    main()
