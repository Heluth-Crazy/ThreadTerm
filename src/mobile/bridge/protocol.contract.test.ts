import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BRIDGE_PROTOCOL_VERSION,
  CLIENT_MESSAGE_KINDS,
  SERVER_MESSAGE_KINDS,
} from './protocol';

const rustProtocolPath = resolve(
  process.cwd(),
  'src-tauri/src/bridge/protocol.rs',
);
const rustProtocolDirectory = resolve(
  process.cwd(),
  'src-tauri/src/bridge/protocol',
);

function rustProtocolSource(): string {
  const childModules = readdirSync(rustProtocolDirectory)
    .filter((fileName) => fileName.endsWith('.rs'))
    .sort()
    .map((fileName) =>
      readFileSync(resolve(rustProtocolDirectory, fileName), 'utf8'),
    );
  return [readFileSync(rustProtocolPath, 'utf8'), ...childModules].join('\n');
}

function extractRustProtocolVersion(source: string): number {
  const match = source.match(/pub const PROTOCOL_VERSION:\s*u16\s*=\s*(\d+);/);
  if (!match) throw new Error('PROTOCOL_VERSION constant not found in Rust bridge protocol');
  return Number(match[1]);
}

function extractRustEnumKinds(source: string, enumName: string): string[] {
  const enumMatch = source.match(new RegExp(`pub enum ${enumName} \\{([\\s\\S]*?)\\n\\}`));
  if (!enumMatch) throw new Error(`${enumName} enum not found in Rust bridge protocol`);

  return Array.from(enumMatch[1].matchAll(/^    ([A-Z][A-Za-z0-9]*)\b/gm), ([, name]) =>
    toSnakeCase(name),
  );
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

describe('mobile bridge protocol contract', () => {
  it('keeps Rust and TypeScript protocol versions in lockstep', () => {
    expect(extractRustProtocolVersion(rustProtocolSource())).toBe(BRIDGE_PROTOCOL_VERSION);
  });

  it('keeps client message kind names byte-equal across Rust and TypeScript', () => {
    expect(extractRustEnumKinds(rustProtocolSource(), 'ClientMessage')).toEqual([
      ...CLIENT_MESSAGE_KINDS,
    ]);
  });

  it('keeps server message kind names byte-equal across Rust and TypeScript', () => {
    expect(extractRustEnumKinds(rustProtocolSource(), 'ServerMessage')).toEqual([
      ...SERVER_MESSAGE_KINDS,
    ]);
  });

  it('keeps optional read-only Workbench fields backward compatible in Rust', () => {
    const source = rustProtocolSource();
    expect(source).toContain('pub followed_card_ids: Vec<String>');
    expect(source).toContain('pub project_overviews: Vec<MobileProjectWorkbenchOverview>');
    expect(source).toMatch(
      /serde\(default, skip_serializing_if = "Vec::is_empty"\)\]\s+pub followed_card_ids/,
    );
    expect(source).toMatch(
      /serde\(default, skip_serializing_if = "Vec::is_empty"\)\]\s+pub project_overviews/,
    );
  });
});
