import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = process.argv[2];
if (!output) {
  throw new Error('usage: node verify-generated-swift.mjs <uniffi-output-directory>');
}

const directory = resolve(output);
const [swiftSource, header, moduleMap] = await Promise.all([
  readFile(resolve(directory, 'ThreadTermNative.swift'), 'utf8'),
  readFile(resolve(directory, 'ThreadTermNativeFFI.h'), 'utf8'),
  readFile(resolve(directory, 'ThreadTermNativeFFI.modulemap'), 'utf8')
]);
const swift = swiftSource.replace(/\s+/g, ' ');

assert.match(moduleMap, /\bmodule ThreadTermNativeFFI\s*\{/);
assert.match(moduleMap, /header "ThreadTermNativeFFI\.h"/);
assert.match(header, /typedef struct RustBuffer/);
assert.match(swiftSource, /#if canImport\(ThreadTermNativeFFI\)\s*import ThreadTermNativeFFI\s*#endif/);

const signatures = [
  /public protocol ClientEventListener: AnyObject, Sendable/,
  /func runtimeEvent\(machineId: String, eventJson: String\)/,
  /func connectionState\(machineId: String, state: String, message: String\?\)/,
  /open class NativeClient:/,
  /public convenience init\(irohSecretHex: String\?\)\s*throws/,
  /open func irohSecretHex\(\) -> String/,
  /open func setEventListener\(listener: ClientEventListener\)\s*throws/,
  /open func clearEventListener\(\)\s*throws/,
  /open func preparePairing\(text: String\)\s*throws -> PairingPreparation/,
  /open func confirmPairing\(pendingId: String, deviceName: String\)\s*throws -> PairingCompletion/,
  /open func cancelPairing\(pendingId: String\)\s*throws/,
  /open func connect\(machine: MachineCredentials\)\s*throws -> ConnectionInfo/,
  /open func disconnect\(machineId: String\)\s*throws/,
  /open func request\(machineId: String, method: String, paramsJson: String\)\s*throws -> String/,
  /open func startProxy\(machineId: String\)\s*throws -> ProxyInfo/,
  /open func stopProxy\(machineId: String\)\s*throws/,
  /open func shutdown\(\)\s*throws/
];
for (const signature of signatures) {
  assert.match(swift, signature, `generated Swift signature ${signature} matches the handwritten bridge`);
}

const recordFields = {
  PairingPreparation: {
    pendingId: 'String', checkCode: 'String', endpoint: 'String', transport: 'String'
  },
  PairingCompletion: {
    machineId: 'String', credential: 'String', permission: 'String', expiresAt: 'String',
    endpoint: 'String', transport: 'String', tlsFingerprint: 'String'
  },
  MachineCredentials: {
    machineId: 'String', endpoint: 'String', tlsFingerprint: 'String', credential: 'String'
  },
  ConnectionInfo: { epoch: 'String', permission: 'String' },
  ProxyInfo: { port: 'UInt16', username: 'String', secret: 'String' }
};
for (const [record, fields] of Object.entries(recordFields)) {
  assert.match(swift, new RegExp(`public struct ${record}[^\\{]*\\{`));
  for (const [field, type] of Object.entries(fields)) {
    assert.match(swift, new RegExp(`public var ${field}: ${type}\\b`), `${record}.${field} has type ${type}`);
  }
}

console.log('PASS generated UniFFI Swift signatures, header and module map');
