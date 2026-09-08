// Verify config.js (global browser config persistence) and ops.getLaunchCommand.
// Backs up and restores the real ~/.dsh/realbrowser-config.json.
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readConfig, setExePath, setUserDataDirs, addUserDataDir, removeUserDataDir,
} from '../config.js';
import { getLaunchCommand } from '../ops.js';

const FILE = path.join(os.homedir(), '.dsh', 'realbrowser-config.json');
const backup = existsSync(FILE) ? readFileSync(FILE, 'utf8') : null;
const restore = () => {
  if (backup === null) {
    try { writeFileSync(FILE, JSON.stringify({ exePaths: {}, userDataDirs: {} }, null, 2)); } catch {}
  } else {
    writeFileSync(FILE, backup);
  }
};

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};

try {
  // 1. 初始空配置
  const init = readConfig();
  check('readConfig default empty', Object.keys(init.exePaths).length === 0 && Object.keys(init.userDataDirs).length === 0, JSON.stringify(init));

  // 2. setExePath：存在才写入
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'rb-config-'));
  const fakeExe = path.join(tmp, 'fake.exe');
  writeFileSync(fakeExe, 'x');
  setExePath('edge', fakeExe);
  let cfg = readConfig();
  check('setExePath persisted', cfg.exePaths.edge === fakeExe, JSON.stringify(cfg.exePaths));
  // 不存在/空 → 移除
  setExePath('edge', '');
  cfg = readConfig();
  check('setExePath empty removes', !('edge' in cfg.exePaths), JSON.stringify(cfg.exePaths));
  setExePath('chrome', path.join(tmp, 'nope.exe'));
  cfg = readConfig();
  check('setExePath nonexistent removes', !('chrome' in cfg.exePaths), JSON.stringify(cfg.exePaths));

  // 3. addUserDataDir 追加 + 去重
  addUserDataDir('edge', 'C:\\A\\B');
  addUserDataDir('edge', 'C:\\A\\B');
  addUserDataDir('edge', 'C:\\A\\C');
  cfg = readConfig();
  check('addUserDataDir dedup + append', cfg.userDataDirs.edge.length === 2, JSON.stringify(cfg.userDataDirs.edge));

  // 4. removeUserDataDir
  removeUserDataDir('edge', 'C:\\A\\B');
  cfg = readConfig();
  check('removeUserDataDir', cfg.userDataDirs.edge.length === 1 && cfg.userDataDirs.edge[0] === 'C:\\A\\C', JSON.stringify(cfg.userDataDirs.edge));

  // 5. setUserDataDirs 覆盖 / 空列表移除键
  setUserDataDirs('edge', ['C:\\D']);
  cfg = readConfig();
  check('setUserDataDirs overwrite', cfg.userDataDirs.edge.length === 1 && cfg.userDataDirs.edge[0] === 'C:\\D', JSON.stringify(cfg.userDataDirs.edge));
  setUserDataDirs('edge', []);
  cfg = readConfig();
  check('setUserDataDirs empty removes', !('edge' in cfg.userDataDirs), JSON.stringify(cfg.userDataDirs));

  // 6. getLaunchCommand 组装
  const cmd = getLaunchCommand({ exePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', userDataDir: 'C:\\Edge Rpa', profileId: 'Default', port: 9333 });
  check('command has debug port', cmd.args.includes('--remote-debugging-port=9333'), JSON.stringify(cmd.args));
  check('command has user-data-dir', cmd.args.includes('--user-data-dir=C:\\Edge Rpa'));
  check('command has profile-directory', cmd.args.includes('--profile-directory=Default'));
  check('command_line quotes exe', cmd.command_line.startsWith('"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"'), cmd.command_line);
  check('command debug_port', cmd.debug_port === 9333);

  console.log(failures === 0 ? '\nALL CONFIG/OPS CHECKS PASS ✅' : `\n${failures} CHECK(S) FAILED ❌`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  restore();
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  console.log('config file restored.');
}
