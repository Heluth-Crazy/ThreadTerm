# ThreadTerm shell integration (bash)

_threadterm_b64_cwd() {
  pwd | base64 | tr -d '\n'
}

_threadterm_now_ms() {
  local value
  value=$(date +%s%3N 2>/dev/null)
  case "$value" in
    ''|*[!0-9]*) printf '%s000' "$(date +%s)" ;;
    *) printf '%s' "$value" ;;
  esac
}

_threadterm_prompt() {
  local code=$?
  if [ -n "${_THREADTERM_BLOCK_ACTIVE:-}" ]; then
    local now duration
    now=$(_threadterm_now_ms)
    duration=0
    if [ -n "${_THREADTERM_BLOCK_STARTED_AT:-}" ]; then
      duration=$(( now - _THREADTERM_BLOCK_STARTED_AT ))
      if [ "$duration" -lt 0 ]; then
        duration=0
      fi
    fi
    printf '\033]133;D;%s\007' "$code"
    printf '\033]6973;duration=%s\007' "$duration"
    unset _THREADTERM_BLOCK_ACTIVE
    unset _THREADTERM_BLOCK_STARTED_AT
  fi
  printf '\033]133;A\007'
  return "$code"
}

_threadterm_preexec() {
  local id="tt-$(date +%s%N)-$RANDOM"
  _THREADTERM_BLOCK_ACTIVE=1
  _THREADTERM_BLOCK_STARTED_AT=$(_threadterm_now_ms)
  printf '\033]133;B\007'
  printf '\033]6973;cmd_id=%s;cwd=%s\007' "$id" "$(_threadterm_b64_cwd)"
  printf '\033]133;C\007'
}

PROMPT_COMMAND="_threadterm_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
trap '_threadterm_preexec' DEBUG
