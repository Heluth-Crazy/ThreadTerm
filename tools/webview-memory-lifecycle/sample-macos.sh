#!/usr/bin/env bash
# Sample ThreadTerm + WebKit helper process memory on macOS.
# Read-only: does not launch the app or create windows.
set -euo pipefail

LABEL="${1:-sample}"
shift || true

SETTLE_CSV=""
OUT_DIR="docs/artifacts/webview-memory-lifecycle"
APP_NAME="ThreadTerm"

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
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
SAFE_LABEL="$(printf '%s' "$LABEL" | tr -cs 'A-Za-z0-9._-' '-' | sed 's/^-//;s/-$//')"
if [[ -z "$SAFE_LABEL" ]]; then
  SAFE_LABEL="sample"
fi

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()[:-1] if False else sys.argv[1]))' "$1"
}

collect_sample() {
  local sample_label="$1"
  local settle="${2:-null}"

  python3 - "$APP_NAME" "$sample_label" "$settle" <<'PY'
import json, subprocess, sys, time
from datetime import datetime, timezone

app_name, sample_label, settle = sys.argv[1], sys.argv[2], sys.argv[3]
settle_val = None if settle in ("", "null", "None") else int(settle)

def run(cmd):
    return subprocess.check_output(cmd, text=True, stderr=subprocess.DEVNULL)

# Collect processes: ThreadTerm and WebKit helpers whose parent chain includes it.
try:
    ps = run(["ps", "-axo", "pid=,ppid=,rss=,comm="])
except subprocess.CalledProcessError:
    ps = ""

rows = []
for line in ps.splitlines():
    line = line.strip()
    if not line:
        continue
    parts = line.split(None, 3)
    if len(parts) < 4:
        continue
    pid, ppid, rss, comm = int(parts[0]), int(parts[1]), int(parts[2]), parts[3]
    rows.append({"pid": pid, "ppid": ppid, "rssKb": rss, "comm": comm})

by_pid = {r["pid"]: r for r in rows}
app_pids = {r["pid"] for r in rows if app_name.lower() in r["comm"].lower() or r["comm"].endswith("threadterm")}

def rooted_in_app(pid, depth=0):
    if pid in app_pids:
        return True
    if depth > 8:
        return False
    row = by_pid.get(pid)
    if not row:
        return False
    if row["ppid"] in app_pids:
        return True
    return rooted_in_app(row["ppid"], depth + 1)

def role_for(comm: str) -> str:
    c = comm.lower()
    if "webcontent" in c:
        return "WEBCONTENT"
    if "gpu" in c:
        return "GPU"
    if "network" in c:
        return "NETWORK"
    if "webkit" in c:
        return "WEBKIT"
    if "threadterm" in c or app_name.lower() in c:
        return "APP"
    return "OTHER"

selected = []
for r in rows:
    if r["pid"] in app_pids or rooted_in_app(r["pid"]):
        if r["pid"] in app_pids or any(k in r["comm"].lower() for k in ("webkit", "webcontent", "gpu", "network")):
            selected.append({
                "pid": r["pid"],
                "ppid": r["ppid"],
                "role": role_for(r["comm"]),
                "comm": r["comm"],
                "rssKb": r["rssKb"],
                "rssMb": round(r["rssKb"] / 1024.0, 1),
            })

app_rss = sum(x["rssKb"] for x in selected if x["role"] == "APP")
helper_rss = sum(x["rssKb"] for x in selected if x["role"] != "APP")
by_role = {}
for role in ("APP", "WEBCONTENT", "GPU", "NETWORK", "WEBKIT", "OTHER"):
    members = [x for x in selected if x["role"] == role]
    total = sum(x["rssKb"] for x in members)
    by_role[role] = {
        "count": len(members),
        "rssKb": total,
        "rssMb": round(total / 1024.0, 1),
    }

sample = {
    "schemaVersion": 1,
    "kind": "threadterm-webview-memory-sample",
    "platform": "macos",
    "label": sample_label,
    "settleSeconds": settle_val,
    "capturedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "filter": {
        "appName": app_name,
        "metric": "rss-kb-from-ps",
        "note": "RSS is not identical to Windows private working set; compare like-for-like on the same Mac only.",
    },
    "processes": selected,
    "totals": {
        "appRssKb": app_rss,
        "appRssMb": round(app_rss / 1024.0, 1),
        "helperRssKb": helper_rss,
        "helperRssMb": round(helper_rss / 1024.0, 1),
        "appGroupRssKb": app_rss + helper_rss,
        "appGroupRssMb": round((app_rss + helper_rss) / 1024.0, 1),
        "processCount": len(selected),
        "webContentCount": by_role["WEBCONTENT"]["count"],
        "gpuCount": by_role["GPU"]["count"],
    },
    "byRole": by_role,
    "notes": [
        "Read-only sample via ps; does not create windows.",
        "Paste window.__threadtermLifecycleDiagnostics() separately as appDiagnostics.",
    ],
}
print(json.dumps(sample, ensure_ascii=True))
PY
}

SAMPLES_JSON="[]"
if [[ -z "$SETTLE_CSV" ]]; then
  SAMPLES_JSON="[$(collect_sample "$SAFE_LABEL" null)]"
else
  IFS=',' read -r -a settles <<< "$SETTLE_CSV"
  first=1
  SAMPLES_JSON="["
  for wait in "${settles[@]}"; do
    wait_trim="$(echo "$wait" | tr -d '[:space:]')"
    if [[ -n "$wait_trim" && "$wait_trim" -gt 0 ]]; then
      echo "Settling ${wait_trim}s before sample '$SAFE_LABEL'..."
      sleep "$wait_trim"
    fi
    sample_json="$(collect_sample "${SAFE_LABEL}-t${wait_trim}s" "$wait_trim")"
    if [[ $first -eq 1 ]]; then
      SAMPLES_JSON+="$sample_json"
      first=0
    else
      SAMPLES_JSON+=",$sample_json"
    fi
  done
  SAMPLES_JSON+="]"
fi

OUT_PATH="$OUT_DIR/${SAFE_LABEL}-${STAMP}.json"
python3 - "$OUT_PATH" "$SAFE_LABEL" "$SAMPLES_JSON" <<'PY'
import json, sys
from datetime import datetime, timezone
out_path, label, samples_raw = sys.argv[1], sys.argv[2], sys.argv[3]
samples = json.loads(samples_raw)
doc = {
    "schemaVersion": 1,
    "kind": "threadterm-webview-memory-sample-set",
    "label": label,
    "capturedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "machine": {"platform": "macos"},
    "samples": samples,
}
with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(doc, fh, indent=2)
    fh.write("\n")
for sample in samples:
    t = sample["totals"]
    print(
        f"[{sample['label']}] app={t['appRssMb']} MB  helpers={t['helperRssMb']} MB  "
        f"group={t['appGroupRssMb']} MB  processes={t['processCount']} webcontent={t['webContentCount']}"
    )
print(f"Wrote {out_path}")
PY
