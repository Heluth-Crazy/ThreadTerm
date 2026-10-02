import json, os, subprocess, sys, threading, time

CWD = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()

proc = subprocess.Popen(
    ["kimi", "acp"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.DEVNULL,
    text=True,
    encoding="utf-8",
    errors="replace",
    bufsize=1,
)

def watchdog():
    time.sleep(100)
    try:
        proc.kill()
    except Exception:
        pass

threading.Thread(target=watchdog, daemon=True).start()
t0 = time.monotonic()

def stamp(label):
    print(f"+{time.monotonic() - t0:6.2f}s {label}", flush=True)

def send(obj):
    proc.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n")
    proc.stdin.flush()

send({
    "jsonrpc": "2.0", "id": 0, "method": "initialize",
    "params": {
        "protocolVersion": 1,
        "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False},
        "clientInfo": {"name": "probe", "version": "0"},
    },
})

while True:
    line = proc.stdout.readline()
    if not line:
        stamp("EOF")
        break
    try:
        msg = json.loads(line)
    except json.JSONDecodeError:
        continue
    if msg.get("id") == 0 and "result" in msg:
        stamp("initialize")
        send({"jsonrpc": "2.0", "method": "initialized", "params": {}})
        send({"jsonrpc": "2.0", "id": 1, "method": "session/new",
              "params": {"cwd": CWD, "mcpServers": []}})
    elif msg.get("id") == 1 and "result" in msg:
        stamp("session/new")
        send({"jsonrpc": "2.0", "id": 2, "method": "session/prompt",
              "params": {"sessionId": msg["result"]["sessionId"],
                         "prompt": [{"type": "text", "text": "/usage"}]}})
    elif msg.get("method") == "session/update":
        update = msg["params"].get("update", {})
        kind = update.get("sessionUpdate")
        content = update.get("content") or {}
        text = content.get("text") or update.get("text") or ""
        stamp(f"update[{kind}] {text[:40]!r}")
    elif msg.get("id") == 2:
        stamp("PROMPT COMPLETE")
        break

try:
    proc.kill()
except Exception:
    pass
