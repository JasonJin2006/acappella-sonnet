// 构建包装器：唯一目的是在 Windows 上把 TMP/TEMP 重定向到项目内目录。
// 本机的 %TEMP% 里，esbuild 的 Go 子进程删除自己刚写的大输入临时文件会被拒绝
// （Access is denied，疑似杀毒实时扫描短暂持锁），且失败稳定复现、跨会话存在。
// 小输入不走临时文件路径、重定向 TMP 后大输入正常，均已对照验证。
// esbuild 用 os.TempDir()，读 TMP/TEMP 两个变量，所以都要设。
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');

if (process.platform === 'win32') {
  const tmp = join(root, 'node_modules', '.vite-tmp');
  mkdirSync(tmp, { recursive: true });
  process.env.TMP = tmp;
  process.env.TEMP = tmp;
}

const r = spawnSync(
  process.execPath,
  [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', ...process.argv.slice(2)],
  { stdio: 'inherit', env: process.env },
);
process.exit(r.status ?? 1);
