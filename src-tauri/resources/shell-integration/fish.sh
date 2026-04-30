# ThreadTerm shell integration (fish)

function __threadterm_b64_cwd
  pwd | base64 | string collect
end

function __threadterm_now_ms
  set -l value (date +%s%3N 2>/dev/null)
  if string match -rq '^[0-9]+$' -- "$value"
    printf '%s' "$value"
  else
    printf '%s000' (date +%s)
  end
end

function __threadterm_prompt --on-event fish_prompt
  printf '\033]133;A\007'
end

function __threadterm_preexec --on-event fish_preexec
  set -l id "tt-"(date +%s%N)"-"(random)
  set -g __threadterm_block_started_at (__threadterm_now_ms)
  printf '\033]133;B\007'
  printf '\033]6973;cmd_id=%s;cwd=%s\007' "$id" (__threadterm_b64_cwd)
  printf '\033]133;C\007'
end

function __threadterm_postexec --on-event fish_postexec
  set -l now (__threadterm_now_ms)
  set -l duration 0
  if set -q __threadterm_block_started_at
    set duration (math "$now - $__threadterm_block_started_at")
    if test "$duration" -lt 0
      set duration 0
    end
  end
  printf '\033]133;D;%s\007' $status
  printf '\033]6973;duration=%s\007' $duration
  set -e __threadterm_block_started_at
end
