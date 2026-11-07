import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const mobile = resolve(import.meta.dirname, '..');
const [contract, facade, swift, rust, proxy, picker, hostSmoke, buildScript, moduleConfig] = await Promise.all([
  readFile(resolve(mobile, '..', 'docs', 'mobile-contract.md'), 'utf8'),
  readFile(resolve(mobile, 'modules', 'threadterm-mobile', 'index.ts'), 'utf8'),
  readFile(resolve(mobile, 'modules', 'threadterm-mobile', 'ios', 'ThreadTermMobileModule.swift'), 'utf8'),
  readFile(resolve(mobile, 'native-client', 'src', 'lib.rs'), 'utf8'),
  readFile(resolve(mobile, 'native-client', 'src', 'proxy.rs'), 'utf8'),
  readFile(resolve(mobile, 'modules', 'threadterm-mobile', 'ios', 'AttachmentPicker.swift'), 'utf8'),
  readFile(resolve(mobile, 'native-client', 'examples', 'host_smoke.rs'), 'utf8'),
  readFile(resolve(mobile, 'scripts', 'build-native-ios.sh'), 'utf8'),
  readFile(resolve(mobile, 'modules', 'threadterm-mobile', 'expo-module.config.json'), 'utf8')
]);

const methods = [
  'listMachines', 'preparePairing', 'confirmPairing', 'cancelPairing', 'removeMachine',
  'renameMachine', 'connect', 'disconnect', 'request', 'unlockControl', 'lockControl',
  'openPreview', 'chooseAttachment', 'readAttachment'
];
for (const method of methods) {
  assert.match(contract, new RegExp(`\\b${method}\\b`), `${method} is documented`);
  assert.match(facade, new RegExp(`\\b${method}\\(`), `${method} is typed for JavaScript`);
  assert.match(swift, new RegExp(`AsyncFunction\\(\"${method}\"\\)`), `${method} is exported by Swift`);
}
for (const event of ['onRuntimeEvent', 'onConnectionState', 'onControlLock']) {
  assert.match(facade, new RegExp(event), `${event} is typed for JavaScript`);
  assert.match(swift, new RegExp(event), `${event} is emitted by Swift`);
}
assert.doesNotMatch(facade, /credential\s*:/i, 'JavaScript facade never exposes a credential field');
assert.match(rust, /pending_pairings/, 'Rust retains the checked pairing connection');
assert.match(rust, /start_proxy/, 'Rust exposes the private preview proxy only to Swift');
assert.match(proxy, /impl Drop for ProxyHandle/, 'replaced proxy listeners are closed');
assert.match(swift, /NativeEvents:\s*ClientEventListener,\s*@unchecked Sendable/, 'UniFFI callbacks declare their audited Sendable boundary');
assert.match(picker, /purgePriorProcessCopies/, 'private attachment copies are purged after process restart');
assert.match(
  picker,
  /if length == 0\s*\{\s*guard UInt64\(offset\) == size/,
  'a zero-length read is accepted only at the picked file EOF'
);
assert.match(swift, /controlGeneration/, 'biometric unlocks are generation fenced');
assert.match(
  swift,
  /OnAppEntersBackground\s*\{[\s\S]*?setControlUnlocked\(false\)[\s\S]*?nativeQueue\.async/,
  'background closes the control gate before queued network teardown'
);
assert.match(
  swift,
  /OnAppEntersBackground\s*\{[\s\S]*?nativeQueue\.async[\s\S]*?attachmentPicker\.cleanup\(\)/,
  'background teardown purges this module instance attachment copies'
);
for (const generatedName of [
  'ThreadTermNative.swift',
  'ThreadTermNativeFFI.h',
  'ThreadTermNativeFFI.modulemap'
]) {
  assert.match(buildScript, new RegExp(generatedName.replace('.', '\\.')), `native build selects ${generatedName} exactly`);
}
assert.match(buildScript, /verify-generated-swift\.mjs/, 'native build verifies the real generated Swift surface');
assert.match(buildScript, /packaged_module_maps/, 'native build checks both packaged module maps');
for (const flag of ['--descriptor-file', '--device-name', '--ready-file', '--revoked-file']) {
  assert.match(hostSmoke, new RegExp(flag), `native host smoke accepts ${flag}`);
}
assert.match(hostSmoke, /mobile_readonly: This phone has view-only access/, 'native host smoke checks the readonly denial');
assert.match(hostSmoke, /b"REVOKED\\n"/, 'native host smoke persists the terminal revoke observation');
const config = JSON.parse(moduleConfig);
assert.deepEqual(config.platforms, ['ios']);
assert.deepEqual(config.ios.modules, ['ThreadTermMobileModule']);
console.log(`PASS native mobile contract: ${methods.length} methods and 3 events`);
