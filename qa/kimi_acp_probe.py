import json, subprocess, threading

def spawn_kimi():
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
        import time
        time.sleep(90)
        try:
            proc.kill()
        except Exception:
            pass
    threading.Thread(target=watchdog, daemon=True).start()
    return proc

def send(proc, obj):
    proc.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n")
    proc.stdin.flush()

def initialize(proc):
    send(proc, {
        "jsonrpc": "2.0", "id": 0, "method": "initialize",
        "params": {
            "protocolVersion": 1,
            "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False},
            "clientInfo": {"name": "probe", "version": "0"},
        },
    })

import os
import sys

CWD = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()

# Phase 1: create a session and run a tiny prompt.
p1 = spawn_kimi()
initialize(p1)
session_id = None
while True:
    line = p1.stdout.readline()
    if not line:
        print("EOF phase1", flush=True)
        break
    msg = json.loads(line)
    if msg.get("id") == 0 and "result" in msg:
        send(p1, {"jsonrpc": "2.0", "method": "initialized", "params": {}})
        send(p1, {"jsonrpc": "2.0", "id": 1, "method": "session/new",
                  "params": {"cwd": CWD, "mcpServers": []}})
    elif msg.get("id") == 1 and "result" in msg:
        session_id = msg["result"]["sessionId"]
        print(f"session: {session_id}", flush=True)
        send(p1, {"jsonrpc": "2.0", "id": 2, "method": "session/prompt",
                  "params": {"sessionId": session_id,
                             "prompt": [{"type": "text", "text": "Reply with exactly: OK"}]}})
    elif msg.get("id") == 2:
        print("prompt finished", flush=True)
        break
try:
    p1.kill()
except Exception:
    pass

if not session_id:
    raise SystemExit("no session")

# Phase 2: fresh process, session/load the same session (this is what
# ThreadTerm's open_chat(native_id) does when reopening a chat).
p2 = spawn_kimi()
initialize(p2)
while True:
    line = p2.stdout.readline()
    if not line:
        print("EOF phase2", flush=True)
        break
    msg = json.loads(line)
    if msg.get("id") == 0 and "result" in msg:
        send(p2, {"jsonrpc": "2.0", "method": "initialized", "params": {}})
        send(p2, {"jsonrpc": "2.0", "id": 1, "method": "session/load",
                  "params": {"sessionId": session_id, "cwd": CWD, "mcpServers": []}})
    elif msg.get("method") == "session/update":
        update = msg["params"].get("update", {})
        kind = update.get("sessionUpdate")
        content = update.get("content") or {}
        text = content.get("text") or update.get("text") or ""
        has_turn = "turnId" in msg["params"] or "turnId" in update
        print(f"REPLAY [{kind}] turnId={has_turn} len={len(text)} {text[:60]!r}", flush=True)
    elif msg.get("id") == 1:
        print("load finished", flush=True)
        break
try:
    p2.kill()
except Exception:
    pass
