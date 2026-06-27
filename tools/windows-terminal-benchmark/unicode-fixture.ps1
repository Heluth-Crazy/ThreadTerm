[CmdletBinding()]
param(
  [ValidateRange(1, 1000)]
  [int]$Repeat = 20
)

$ErrorActionPreference = "Stop"

$cases = @(
  "CJK width: 中文测试 日本語テスト 한국어테스트 fullwidth=ＡＢＣ１２３",
  "Emoji ZWJ: 👩‍💻 👨‍👩‍👧‍👦 🧑🏽‍🚀 ❤️‍🔥 flags=🇨🇳🇺🇸🇯🇵",
  "Combining marks: café naïve coöperate a̐éö̲",
  "Arabic RTL: مرحبا بالعالم 12345 English tail",
  "Box drawing: ┌──────┬──────┐ │ left │ right │ └──────┴──────┘",
  "Powerline and symbols:     ✓ ✗ → ← ↑ ↓",
  "Ligature probes: != == === => -> <- www ffi fl"
)

for ($round = 1; $round -le $Repeat; $round++) {
  foreach ($case in $cases) {
    Write-Output ("{0:D4} {1}" -f $round, $case)
  }
}

[Console]::Error.WriteLine("ThreadTermBenchmark unicode-fixture repeat=$Repeat cases=$($cases.Count)")
