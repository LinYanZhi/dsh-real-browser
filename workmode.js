/**
 * Work Mode + encrypted credential vault — the credential-isolation layer.
 *
 * TWO independent mechanisms:
 *
 * 1. WORK MODE (per-process toggle): when ON, the interaction layer stops
 *    echoing values back to the AI — real_page_fill / real_page_type return
 *    redacted results for EVERY field, and real_page_snapshot masks all input
 *    values (password fields are masked in ALL modes). This is the "登录/填密
 *    环节 agent 不可见" switch from the roadmap: during a login flow the AI
 *    fills fields without the values appearing in its own context.
 *
 * 2. VAULT: secrets stored in ~/.dsh/realbrowser-vault.json, each value
 *    encrypted with Windows DPAPI (user-scope, via PowerShell
 *    ConvertFrom/ConvertTo-SecureString), so at rest the file never contains
 *    plaintext and only THIS machine+user can decrypt it. Keys are stored in
 *    plaintext (so vaultList works); values never are. Combined with
 *    real_page_type_secret, the AI can type a credential into the real
 *    browser passing ONLY the vault key — the secret never enters the tool
 *    arguments, the model context, or any log.
 *
 * Zero npm dependencies: DPAPI goes through PowerShell (same pattern as
 * env.js / discover.js).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Work mode (per process)
// ---------------------------------------------------------------------------

let sensitive = false;

/** Turn sensitive mode on/off; returns the new state. */
export function setWorkMode(on) {
  sensitive = Boolean(on);
  return sensitive;
}

/** Current sensitive mode. */
export function getWorkMode() {
  return sensitive;
}

// ---------------------------------------------------------------------------
// Vault (DPAPI-encrypted at rest)
// ---------------------------------------------------------------------------

const FILE = path.join(os.homedir(), '.dsh', 'realbrowser-vault.json');

// The secret/encrypted string crosses into PowerShell via an env var, never
// via command-line arguments — avoids every quoting problem.
const ENCRYPT_SCRIPT = `
$ErrorActionPreference = 'Stop'
$v = $env:DSH_VAL
if ($null -eq $v) { Write-Error 'no value'; exit 2 }
ConvertFrom-SecureString (ConvertTo-SecureString $v -AsPlainText -Force)
`;

const DECRYPT_SCRIPT = `
$ErrorActionPreference = 'Stop'
$e = $env:DSH_VAL
if ($null -eq $e) { Write-Error 'no value'; exit 2 }
$ss = ConvertTo-SecureString $e
[Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss))
`;

function psRun(script, value) {
  try {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15000,
        env: { ...process.env, DSH_VAL: String(value) },
      },
    ).trim();
  } catch {
    return '';
  }
}

/** DPAPI-encrypt a plaintext value (user scope, machine-bound). */
export function vaultEncrypt(value) {
  const out = psRun(ENCRYPT_SCRIPT, value);
  if (!out) throw new Error('vault encryption failed (PowerShell/DPAPI unavailable)');
  return out;
}

/** DPAPI-decrypt a stored value. */
export function vaultDecrypt(encrypted) {
  const out = psRun(DECRYPT_SCRIPT, encrypted);
  if (!out) throw new Error('vault decryption failed (corrupt entry or wrong machine/user?)');
  return out;
}

function readVault() {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeVault(obj) {
  const dir = path.dirname(FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(FILE, JSON.stringify(obj, null, 2));
}

/** Store a secret under a key (encrypted at rest). */
export function vaultSet(key, value) {
  if (!key || typeof key !== 'string') throw new Error('vault key must be a non-empty string');
  const v = readVault();
  v[key] = vaultEncrypt(String(value));
  writeVault(v);
}

/** Read a secret back (decrypts). Returns undefined when the key is absent. */
export function vaultGet(key) {
  const enc = readVault()[key];
  if (enc === undefined) return undefined;
  return vaultDecrypt(enc);
}

/** List vault keys (values stay encrypted and hidden). */
export function vaultList() {
  return Object.keys(readVault());
}

/** Whether a key exists in the vault. */
export function vaultHas(key) {
  return key in readVault();
}

/** Delete a key. */
export function vaultDelete(key) {
  const v = readVault();
  delete v[key];
  writeVault(v);
}
