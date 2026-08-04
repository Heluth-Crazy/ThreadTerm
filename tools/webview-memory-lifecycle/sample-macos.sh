#!/usr/bin/env bash
# Read-only ThreadTerm process-tree RSS sampler for macOS Release acceptance.
set -euo pipefail

LABEL="${1:-sample}"
shift || true

SETTLE_CSV=""
OUT_DIR="docs/artifacts/webview-memory-lifecycle"
APP_NAME="ThreadTerm"
APP_DIAGNOSTICS=""
BUILD_KIND="Release"
SCENARIO=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --settle)
      SETTLE_CSV="${2:-}"
      shift 2
      ;;
    --out-dir)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    --app-name)
      APP_NAME="${2:-}"
      shift 2
      ;;
    --app-diagnostics)
      APP_DIAGNOSTICS="${2:-}"
      shift 2
      ;;
    --build-kind)
      BUILD_KIND="${2:-}"
      shift 2
      ;;
    --scenario)
      SCENARIO="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

case "$BUILD_KIND" in
  Release|Debug|Unknown) ;;
  *)
    echo "--build-kind must be Release, Debug, or Unknown" >&2
    exit 2
    ;;
esac

COMMIT=""
if command -v git >/dev/null 2>&1; then
  COMMIT="$(git rev-parse HEAD 2>/dev/null || true)"
fi

python3 - "$LABEL" "$SETTLE_CSV" "$OUT_DIR" "$APP_NAME" "$APP_DIAGNOSTICS" "$BUILD_KIND" "$SCENARIO" "$COMMIT" <<'PY'
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone

label, settle_csv, out_dir, app_name, diagnostics_path, build_kind, scenario, commit = sys.argv[1:]
safe_label = re.sub(r"[^A-Za-z0-9._-]+", "-", label).strip("-") or "sample"
os.makedirs(out_dir, exist_ok=True)

app_diagnostics = None
if diagnostics_path:
    with open(diagnostics_path, "r", encoding="utf-8") as handle:
        app_diagnostics = json.load(handle)
    if app_diagnostics.get("kind") != "threadterm-lifecycle-diagnostics":
        raise SystemExit(f"Unexpected app diagnostics kind in {diagnostics_path}")


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def run(command):
    return subprocess.check_output(command, text=True, stderr=subprocess.DEVNULL)


def classify(name, command):
    name_lower = name.lower()
    text = command.lower()
    if "webcontent" in text:
        return "WEBVIEW_WEBCONTENT"
    if "webkit" in text and "gpu" in text:
        return "WEBVIEW_GPU"
    if "webkit" in text and "network" in text:
        return "WEBVIEW_NETWORK"
    if "webkit" in text:
        return "WEBVIEW_OTHER"
    if "claude-host" in text or "threadterm_claude_sidecar" in text:
        return "CLAUDE_HOST"
    if name_lower == "claude" or re.search(r"(?:^|[/\s])claude(?:\s|$)", text):
        return "CLAUDE_CLI"
    if (name_lower == "codex" or re.search(r"(?:^|[/\s])codex(?:\s|$)", text)) and "app-server" in text:
        return "CODEX_APP_SERVER"
    if name_lower == "codex" or re.search(r"(?:^|[/\s])codex(?:\s|$)", text):
        return "CODEX_CLI"
    return "PTY_CHILD"


def collect(sample_label, settle_seconds):
    try:
        output = run(["ps", "-axo", "pid=,ppid=,rss=,comm=,args="])
    except subprocess.CalledProcessError:
        output = ""

    rows = []
    for line in output.splitlines():
        parts = line.strip().split(None, 4)
        if len(parts) < 4:
            continue
        pid, ppid, rss = map(int, parts[:3])
        command_name = parts[3]
        args = parts[4] if len(parts) > 4 else command_name
        rows.append({
            "pid": pid,
            "ppid": ppid,
            "rssKb": rss,
            "name": os.path.basename(command_name),
            "command": args,
        })

    by_pid = {row["pid"]: row for row in rows}
    app_name_lower = app_name.lower()
    app_ids = {
        row["pid"]
        for row in rows
        if app_name_lower in row["name"].lower() or row["name"].lower() == "threadterm"
    }

    def rooted_in_app(process_id):
        seen = set()
        current = process_id
        for _ in range(32):
            if current in app_ids:
                return True
            if current in seen or current not in by_pid:
                return False
            seen.add(current)
            parent = by_pid[current]["ppid"]
            if parent <= 0 or parent == current:
                return False
            current = parent
        return False

    selected = []
    for row in rows:
        if row["pid"] in app_ids:
            role = "THREADTERM_MAIN"
        elif rooted_in_app(row["pid"]):
            role = classify(row["name"], row["command"])
        else:
            continue
        # Do not persist command lines; they may contain user paths or prompts.
        selected.append({
            "pid": row["pid"],
            "ppid": row["ppid"],
            "name": row["name"],
            "role": role,
            "rssKb": row["rssKb"],
            "rssMb": round(row["rssKb"] / 1024.0, 1),
            "metricSource": "ps-rss-kb",
        })

    roles = (
        "THREADTERM_MAIN",
        "WEBVIEW_WEBCONTENT", "WEBVIEW_GPU", "WEBVIEW_NETWORK", "WEBVIEW_OTHER",
        "CLAUDE_HOST", "CLAUDE_CLI", "CODEX_APP_SERVER", "CODEX_CLI", "PTY_CHILD",
    )
    by_role = {}
    for role in roles:
        members = [item for item in selected if item["role"] == role]
        rss_kb = sum(item["rssKb"] for item in members)
        by_role[role] = {
            "count": len(members),
            "rssKb": rss_kb,
            "rssMb": round(rss_kb / 1024.0, 1),
        }

    app_rss = by_role["THREADTERM_MAIN"]["rssKb"]
    webview_roles = ("WEBVIEW_WEBCONTENT", "WEBVIEW_GPU", "WEBVIEW_NETWORK", "WEBVIEW_OTHER")
    webview_rss = sum(by_role[role]["rssKb"] for role in webview_roles)
    child_rss = sum(
        by_role[role]["rssKb"]
        for role in ("CLAUDE_HOST", "CLAUDE_CLI", "CODEX_APP_SERVER", "CODEX_CLI", "PTY_CHILD")
    )
    app_group_rss = app_rss + webview_rss
    owned_group_rss = app_group_rss + child_rss

    return {
        "schemaVersion": 2,
        "kind": "threadterm-memory-sample",
        "platform": "macos",
        "label": sample_label,
        "scenario": scenario,
        "settleSeconds": settle_seconds,
        "capturedAt": utc_now(),
        "filter": {
            "appName": app_name,
            "appChildSelection": "threadterm-process-tree",
            "metric": "rss-kb-from-ps",
            "note": "RSS differs from Windows private working set; compare like-for-like on the same Mac only.",
        },
        "processes": selected,
        "totals": {
            "mainRssKb": app_rss,
            "mainRssMb": round(app_rss / 1024.0, 1),
            "webviewRssKb": webview_rss,
            "webviewRssMb": round(webview_rss / 1024.0, 1),
            "appGroupRssKb": app_group_rss,
            "appGroupRssMb": round(app_group_rss / 1024.0, 1),
            "childRssKb": child_rss,
            "childRssMb": round(child_rss / 1024.0, 1),
            "ownedProcessGroupRssKb": owned_group_rss,
            "ownedProcessGroupRssMb": round(owned_group_rss / 1024.0, 1),
            "processCount": len(selected),
            "webContentCount": by_role["WEBVIEW_WEBCONTENT"]["count"],
            "rendererCount": by_role["WEBVIEW_WEBCONTENT"]["count"],
            "claudeHostCount": by_role["CLAUDE_HOST"]["count"],
            "claudeCliCount": by_role["CLAUDE_CLI"]["count"],
            "codexAppServerCount": by_role["CODEX_APP_SERVER"]["count"],
            "codexCliCount": by_role["CODEX_CLI"]["count"],
            "ptyChildCount": by_role["PTY_CHILD"]["count"],
        },
        "byRole": by_role,
        "appDiagnostics": app_diagnostics,
        "notes": [
            "Read-only sample via ps; does not create windows.",
            "Raw command lines are used only for classification and are not persisted.",
        ],
    }


if settle_csv:
    try:
        settle_targets = sorted({int(value.strip()) for value in settle_csv.split(",") if value.strip()})
    except ValueError as error:
        raise SystemExit(f"Invalid --settle value: {error}")
    if any(value < 0 for value in settle_targets):
        raise SystemExit("--settle cannot contain negative values")
else:
    settle_targets = [None]

samples = []
elapsed = 0
for target in settle_targets:
    if target is not None:
        delay = target - elapsed
        if delay > 0:
            print(f"Settling to T+{target}s before sample '{safe_label}'...")
            time.sleep(delay)
        sample_label = f"{safe_label}-t{target}s"
        elapsed = target
    else:
        sample_label = safe_label
    sample = collect(sample_label, target)
    samples.append(sample)
    totals = sample["totals"]
    print(
        f"[{sample_label}] main={totals['mainRssMb']} MB webview={totals['webviewRssMb']} MB "
        f"children={totals['childRssMb']} MB owned={totals['ownedProcessGroupRssMb']} MB "
        f"claude={totals['claudeHostCount']}/{totals['claudeCliCount']} "
        f"codex={totals['codexAppServerCount']}/{totals['codexCliCount']} pty={totals['ptyChildCount']}"
    )

app_values = [sample["totals"]["appGroupRssKb"] for sample in samples]
owned_values = [sample["totals"]["ownedProcessGroupRssKb"] for sample in samples]
document = {
    "schemaVersion": 2,
    "kind": "threadterm-memory-sample-set",
    "label": safe_label,
    "scenario": scenario,
    "capturedAt": utc_now(),
    "build": {"kind": build_kind, "commit": commit or None},
    "machine": {"platform": "macos", "logicalProcessorCount": os.cpu_count()},
    "observed": {
        "sampleCount": len(samples),
        "peakAppGroupRssKb": max(app_values),
        "peakOwnedProcessGroupRssKb": max(owned_values),
        "finalAppGroupRssKb": app_values[-1],
        "finalOwnedProcessGroupRssKb": owned_values[-1],
    },
    "samples": samples,
}
stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
out_path = os.path.join(out_dir, f"{safe_label}-{stamp}.json")
with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(document, handle, indent=2)
    handle.write("\n")
print(f"Wrote {out_path}")
PY
