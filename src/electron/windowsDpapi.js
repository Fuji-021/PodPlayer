// Electron 13 does not expose safeStorage. On Windows, use the OS DPAPI
// directly through a fixed PowerShell command; credential bytes travel only on
// stdin, never in the command line, renderer state, or logs.
import { spawnSync } from 'child_process';
import path from 'path';

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_CREDENTIAL_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;

const PROTECT_COMMAND = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  'Add-Type -AssemblyName System.Security',
  '$encoded = [Console]::In.ReadToEnd()',
  'if ([string]::IsNullOrWhiteSpace($encoded)) { exit 2 }',
  '$plain = [Convert]::FromBase64String($encoded.Trim())',
  '$protected = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($protected))',
].join('; ');

const UNPROTECT_COMMAND = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  'Add-Type -AssemblyName System.Security',
  '$encoded = [Console]::In.ReadToEnd()',
  'if ([string]::IsNullOrWhiteSpace($encoded)) { exit 2 }',
  '$protected = [Convert]::FromBase64String($encoded.Trim())',
  '$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($plain))',
].join('; ');

function encodeCommand(command) {
  return Buffer.from(command, 'utf16le').toString('base64');
}

function isBase64(value) {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(String(value || ''));
}

function defaultPowerShellPath() {
  return path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
}

export function createWindowsDpapiProtector(options) {
  const opts = options || {};
  const platform = opts.platform || process.platform;
  const run = opts.spawnSync || spawnSync;
  const powerShellPath = opts.powerShellPath || defaultPowerShellPath();
  const timeout = Math.max(1000, Number(opts.timeout) || DEFAULT_TIMEOUT_MS);

  function execute(command, base64Input) {
    if (platform !== 'win32' || !isBase64(base64Input)) {
      throw new Error('windows-dpapi-unavailable');
    }
    const result = run(
      powerShellPath,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        encodeCommand(command),
      ],
      {
        encoding: 'utf8',
        input: base64Input,
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout,
        windowsHide: true,
      }
    );
    const output = String((result && result.stdout) || '').trim();
    if (
      !result ||
      result.error ||
      result.status !== 0 ||
      !output ||
      !isBase64(output)
    ) {
      throw new Error('windows-dpapi-failed');
    }
    return output;
  }

  function protect(value) {
    const plaintext = Buffer.from(String(value || ''), 'utf8');
    if (!plaintext.length || plaintext.length > MAX_CREDENTIAL_BYTES) {
      throw new Error('windows-dpapi-invalid-input');
    }
    return execute(PROTECT_COMMAND, plaintext.toString('base64'));
  }

  function unprotect(ciphertext) {
    const plaintext = execute(
      UNPROTECT_COMMAND,
      String(ciphertext || '').trim()
    );
    return Buffer.from(plaintext, 'base64').toString('utf8');
  }

  function isAvailable() {
    try {
      const probe = 'podplayer-windows-dpapi-probe-v1';
      return unprotect(protect(probe)) === probe;
    } catch (e) {
      return false;
    }
  }

  return {
    id: 'windows-dpapi-v1',
    isAvailable,
    protect,
    unprotect,
  };
}
