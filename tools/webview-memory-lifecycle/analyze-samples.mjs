#!/usr/bin/env node
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SAMPLE_SET_KINDS = new Set([
  'threadterm-memory-sample-set',
  'threadterm-webview-memory-sample-set',
]);

function bytesToMb(value) {
  return Math.round((Number(value || 0) / (1024 * 1024)) * 10) / 10;
}

function metricBytes(sample, name) {
  const totals = sample?.totals ?? {};
  if (name === 'appGroup') {
    return Number(
      totals.appGroupPrivateBytes ??
        (totals.appGroupRssKb == null ? 0 : totals.appGroupRssKb * 1024),
    );
  }
  if (name === 'webview') {
    return Number(
      totals.webviewPrivateBytes ??
        ((totals.webviewRssKb ?? totals.helperRssKb) == null
          ? 0
          : (totals.webviewRssKb ?? totals.helperRssKb) * 1024),
    );
  }
  return Number(
    totals.ownedProcessGroupPrivateBytes ??
      (totals.ownedProcessGroupRssKb == null
        ? undefined
        : totals.ownedProcessGroupRssKb * 1024) ??
      totals.appGroupPrivateBytes ??
      (totals.appGroupRssKb == null ? 0 : totals.appGroupRssKb * 1024),
  );
}

function stableSample(document) {
  const samples = Array.isArray(document.samples) ? document.samples : [];
  if (samples.length === 0) return null;
  return [...samples].sort((left, right) => {
    const leftSettle = Number.isFinite(Number(left.settleSeconds))
      ? Number(left.settleSeconds)
      : -1;
    const rightSettle = Number.isFinite(Number(right.settleSeconds))
      ? Number(right.settleSeconds)
      : -1;
    return leftSettle - rightSettle;
  }).at(-1);
}

function roundNumber(document, stable) {
  const text = [document.scenario, document.label, stable?.label]
    .filter(Boolean)
    .join(' ');
  const match = text.match(/(?:round|\br)[-_ ]?0*(\d{1,3})\b/i);
  return match ? Number(match[1]) : null;
}

export function linearSlope(points) {
  if (points.length < 2) return null;
  const count = points.length;
  const sumX = points.reduce((sum, point) => sum + point.x, 0);
  const sumY = points.reduce((sum, point) => sum + point.y, 0);
  const sumXY = points.reduce((sum, point) => sum + point.x * point.y, 0);
  const sumXX = points.reduce((sum, point) => sum + point.x * point.x, 0);
  const denominator = count * sumXX - sumX * sumX;
  if (denominator === 0) return null;
  return (count * sumXY - sumX * sumY) / denominator;
}

export function analyzeDocuments(documents) {
  const rows = documents
    .filter((document) => SAMPLE_SET_KINDS.has(document?.kind))
    .map((document) => {
      const stable = stableSample(document);
      if (!stable) return null;
      return {
        label: String(document.label ?? stable.label ?? 'sample'),
        scenario: String(document.scenario ?? stable.scenario ?? ''),
        platform: String(stable.platform ?? document.machine?.platform ?? 'unknown'),
        buildKind: String(document.build?.kind ?? 'Unknown'),
        commit: document.build?.commit ?? null,
        settleSeconds: stable.settleSeconds ?? null,
        round: roundNumber(document, stable),
        appGroupBytes: metricBytes(stable, 'appGroup'),
        webviewBytes: metricBytes(stable, 'webview'),
        ownedGroupBytes: metricBytes(stable, 'ownedGroup'),
        rendererCount: Number(stable.totals?.rendererCount ?? stable.totals?.webContentCount ?? 0),
        claudeHostCount: Number(stable.totals?.claudeHostCount ?? 0),
        claudeCliCount: Number(stable.totals?.claudeCliCount ?? 0),
        codexAppServerCount: Number(stable.totals?.codexAppServerCount ?? 0),
        codexCliCount: Number(stable.totals?.codexCliCount ?? 0),
        ptyChildCount: Number(stable.totals?.ptyChildCount ?? 0),
        appDiagnostics: stable.appDiagnostics ?? null,
      };
    })
    .filter(Boolean);

  const roundRows = rows
    .filter((row) => Number.isInteger(row.round))
    .sort((left, right) => left.round - right.round);
  const uniqueRounds = [...new Map(roundRows.map((row) => [row.round, row])).values()];
  let stability = {
    status: 'not-run',
    firstRound: null,
    lastRound: null,
    stableRatio: null,
    slopeBytesPerRound: null,
    slopeMbPerRound: null,
    limitRatio: 1.1,
  };
  if (uniqueRounds.length >= 2) {
    const first = uniqueRounds[0];
    const last = uniqueRounds.at(-1);
    const ratio = first.ownedGroupBytes > 0
      ? last.ownedGroupBytes / first.ownedGroupBytes
      : null;
    const slope = linearSlope(
      uniqueRounds.map((row) => ({ x: row.round, y: row.ownedGroupBytes })),
    );
    stability = {
      status: ratio == null ? 'not-comparable' : ratio <= 1.1 ? 'pass' : 'fail',
      firstRound: first.round,
      lastRound: last.round,
      stableRatio: ratio,
      slopeBytesPerRound: slope,
      slopeMbPerRound: slope == null ? null : slope / (1024 * 1024),
      limitRatio: 1.1,
    };
  }

  return {
    schemaVersion: 1,
    kind: 'threadterm-memory-analysis',
    generatedAt: new Date().toISOString(),
    sampleSetCount: rows.length,
    rows,
    stability,
  };
}

export function renderMarkdown(analysis) {
  const lines = [
    '# ThreadTerm Memory Sample Analysis',
    '',
    `Generated: ${analysis.generatedAt}`,
    '',
    '| Label | Scenario | Platform | Build | Stable | App/WebView/Owned MB | Claude host/CLI | Codex server/CLI | PTY |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const row of analysis.rows) {
    lines.push(
      `| ${row.label} | ${row.scenario || '-'} | ${row.platform} | ${row.buildKind} | ${row.settleSeconds ?? '-'}s | ` +
        `${bytesToMb(row.appGroupBytes)} / ${bytesToMb(row.webviewBytes)} / ${bytesToMb(row.ownedGroupBytes)} | ` +
        `${row.claudeHostCount} / ${row.claudeCliCount} | ${row.codexAppServerCount} / ${row.codexCliCount} | ${row.ptyChildCount} |`,
    );
  }
  const stability = analysis.stability;
  lines.push('', '## Twenty-round stability', '');
  if (stability.status === 'not-run') {
    lines.push('Result: `NOT RUN` — at least two labels containing `round-N` are required.');
  } else {
    const ratio = stability.stableRatio == null
      ? 'n/a'
      : `${(stability.stableRatio * 100).toFixed(1)}%`;
    const slope = stability.slopeMbPerRound == null
      ? 'n/a'
      : `${stability.slopeMbPerRound.toFixed(2)} MB/round`;
    lines.push(
      `Result: \`${stability.status.toUpperCase()}\` — round ${stability.firstRound} → ${stability.lastRound}, ` +
        `final/first ${ratio} (limit 110%), slope ${slope}.`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

async function jsonFiles(inputPath) {
  const info = await stat(inputPath);
  if (info.isFile()) return inputPath.toLowerCase().endsWith('.json') ? [inputPath] : [];
  if (!info.isDirectory()) return [];
  const entries = await readdir(inputPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map((entry) => path.join(inputPath, entry.name));
}

async function loadDocuments(inputPaths) {
  const files = (await Promise.all(inputPaths.map(jsonFiles))).flat();
  return Promise.all(files.map(async (file) => JSON.parse(await readFile(file, 'utf8'))));
}

async function main(argv) {
  const args = [...argv];
  let outPath = null;
  const outIndex = args.indexOf('--out');
  if (outIndex >= 0) {
    outPath = args[outIndex + 1];
    if (!outPath) throw new Error('--out requires a Markdown file path');
    args.splice(outIndex, 2);
  }
  if (args.length === 0) {
    throw new Error('Usage: analyze-samples.mjs <sample.json|directory> [...] [--out report.md]');
  }
  const analysis = analyzeDocuments(await loadDocuments(args));
  if (analysis.sampleSetCount === 0) {
    throw new Error('No ThreadTerm memory sample sets found');
  }
  if (outPath) {
    await writeFile(outPath, renderMarkdown(analysis), 'utf8');
    process.stdout.write(`Wrote ${outPath}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(analysis, null, 2)}\n`);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
