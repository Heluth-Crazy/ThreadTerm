# Windows Terminal Baseline Report

Date:
Operator:
ThreadTerm branch:
ThreadTerm commit:
Build type: dev / packaged

## Machine

Windows version:
GPU / driver:
CPU:
Memory:
Display refresh rate:
Display scale:
WebView2 Runtime version:
ThreadTerm feature flags:

## Control Terminal

Windows Terminal version:
Shell:
Font family / size:

## WebGL / Hardware Acceleration

DevTools renderer string:
GPU usage while scrolling:
CPU usage while scrolling:
Verdict: hardware accelerated / software fallback / unknown

## Scenario Results

| Scenario | ThreadTerm result | Windows Terminal control | Verdict | Evidence |
| --- | --- | --- | --- | --- |
| 10 MB continuous output | | | pass / warn / fail | |
| 100 MB continuous output | | | pass / warn / fail | |
| High-refresh TUI | | | pass / warn / fail | |
| Long selection over 2,000 lines | | | pass / warn / fail | |
| Unicode / emoji / bidi / CJK | | | pass / warn / fail | |
| Microsoft Pinyin IME | | | pass / warn / fail | |
| Japanese IME | | | pass / warn / fail | |
| Korean IME | | | pass / warn / fail | |
| Font clarity at 11 px | | | pass / warn / fail | |
| Font clarity at 12 px | | | pass / warn / fail | |
| Font clarity at 13 px | | | pass / warn / fail | |
| Multi-terminal stress: 1 + 8 cards | | | pass / warn / fail | |
| Multi-terminal stress: 1 + 16 cards | | | pass / warn / fail | |
| Multi-terminal stress: 1 + 32 cards | | | pass / warn / fail | |

## Metrics

| Metric | P50 | P95 | Peak / notes |
| --- | --- | --- | --- |
| input-to-echo latency | | | |
| `term.write()` completion latency | | | |
| output completion time | | | |
| scroll FPS / frame interval | | | |
| CPU | | | |
| GPU | | | |
| memory | | | |

## Raw Artifacts

Store logs, screenshots, traces, and videos under:

`docs/artifacts/windows-terminal-baseline/`

Artifacts captured:

- [ ] environment JSON from `capture-env.ps1`
- [ ] DevTools Performance trace for pure scroll
- [ ] DevTools Performance trace for restart/session restore
- [ ] screen recording for output flood
- [ ] screenshots for Unicode and IME
- [ ] Windows Terminal control screenshots or notes

## Findings

### Likely Fixable In Current xterm Path

-

### Likely WebView / xterm Ceiling

-

### Unknown / Needs Repeat

-

## Decision

Choose one:

- stop native renderer work and optimize xterm only
- continue to W1 native host spike
- repeat W0 after instrumentation fixes

Decision:

## Follow-Up Tasks

-
