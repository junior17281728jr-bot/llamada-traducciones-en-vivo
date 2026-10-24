// electron-builder afterPack hook. Without an Apple Developer certificate electron-builder skips signing,
// and an UNSIGNED app is reported by macOS on Apple Silicon as "dañada y no se puede abrir". An ad-hoc
// signature (identity "-") is enough for the app to open (with the usual "developer not verified" prompt).
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • firma ad-hoc (sin certificado) de ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=1', appPath], { stdio: 'inherit' });
};
