# WebView Memory Lifecycle Report

| Field | Value |
| --- | --- |
| Date (UTC) | |
| Operator | |
| Platform | Windows / macOS |
| Branch / commit | |
| Build | Release |
| App version | |
| Machine id (sanitized) | |
| Baseline kind | pre-opt / post-batch-N / final |

## Environment

| Item | Value |
| --- | --- |
| OS version | |
| CPU / RAM | |
| GPU | |
| WebView runtime | WebView2 / WKWebView |
| User-data filter used | |

## Scenario results

### S0 Cold start

| Settle | App private MB | WebView private MB | Renderers | Surfaces mounted | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| 5s | | | | | |
| 30s | | | | | |
| 120s | | | | | |

### S1 Hot 37 cards

| Settle | App | WebView | PTY | Mounted xterm | Chat items | Editors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 5s | | | | | | |
| 30s | | | | | | |
| 120s | | | | | | |

### S2 Six terminal focus

| Metric | Value |
| --- | --- |
| Peak WebView private MB | |
| 120s stable WebView private MB | |
| Mounted surfaces | |
| Active PTY | |

### S3 Main + float same PTY

| Phase | WebView private MB | Visible surfaces | Notes |
| --- | ---: | ---: | --- |
| Both visible | | | |
| Float closed +120s | | | |

### S4 Twenty rounds

| Round | T+0 WebView MB | T+120 WebView MB | Mounted surfaces | PTY |
| ---: | ---: | ---: | ---: | ---: |
| 1 | | | | |
| 10 | | | | |
| 20 | | | | |

Growth check: round20_120s ≤ 1.10 × round1_120s? `YES / NO / NOT RUN`

### S5 Overlay windows

| Window | Open MB | Closed +5s | +30s | +120s / +70s float | State |
| --- | ---: | ---: | ---: | ---: | --- |
| selector | | | | | |
| float | | | | | |
| settings | | | | | |

### S6 Editors + long chat

| Metric | Value |
| --- | --- |
| Dirty tabs (must stay loaded) | |
| Clean inactive unloaded? | |
| Claude mounted rows | |
| Codex mounted rows | |
| Hidden chat notifications OK? | |

## Terminal restore latency (Batch 2+)

| Sample | Restore ms |
| ---: | ---: |
| n | |
| P50 | |
| P95 | |
| Max | |

Budget: P95 ≤ 300 ms, max ≤ 1000 ms. `PASS / FAIL / NOT RUN`

## Functional protection checklist

- [ ] Background Agent still running for hidden cards
- [ ] PTY not killed by surface recycle
- [ ] Same session restored (no new-session substitute)
- [ ] 3000-line history intact
- [ ] No duplicate / missing / reordered output
- [ ] Main+float dual view correct
- [ ] Dirty editor drafts intact
- [ ] Chat history / pending requests / notifications intact
- [ ] Mobile mirror unchanged
- [ ] No ordinary switch resume progress curtain

## Verdict

| Gate | Result |
| --- | --- |
| Hot WebView private −30% vs pre-opt | |
| Cold start regression ≤10% | |
| 20-round stability | |
| Restore latency | |
| Functional protections | |

Overall: `PASS / FAIL / BLOCKED`

Artifact paths:

- process samples:
- app diagnostics:
- notes:
