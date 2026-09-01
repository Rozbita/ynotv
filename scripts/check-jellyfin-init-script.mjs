// CI-style check: the Jellyfin media-hijack hook lives as a raw-string JS blob
// (INIT_SCRIPT) inside packages/app/src-tauri/src/jellyfin_web.rs and is injected
// into the child WebView before the Jellyfin page boots.
//
// A syntax error there fails SILENTLY: WebView2 skips the whole initialization
// script, so no play() interception happens and every Jellyfin item plays in
// Jellyfin's own web player instead of mpv. This check parses the extracted
// script so a broken hook can never ship unnoticed.
//
// Exit code 1 (with the offending line) when the script does not parse.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rsPath = path.resolve(
  scriptDir,
  '../packages/app/src-tauri/src/jellyfin_web.rs',
);
const OPEN = 'const INIT_SCRIPT: &str = r##"';
const CLOSE = '"##;';

const source = fs.readFileSync(rsPath, 'utf8');
const start = source.indexOf(OPEN);
if (start === -1) {
  console.error(`check-jellyfin-init-script: could not find \`${OPEN}\` in ${rsPath}`);
  process.exit(1);
}
const bodyStart = start + OPEN.length;
const end = source.indexOf(CLOSE, bodyStart);
if (end === -1) {
  console.error(
    `check-jellyfin-init-script: could not find the closing \`${CLOSE}\` in ${rsPath}`,
  );
  process.exit(1);
}

const script = source.slice(bodyStart, end);

try {
  new vm.Script(script, { filename: 'jellyfin INIT_SCRIPT (extracted)' });
} catch (err) {
  const line = err.stack || err.message;
  const narrow =
    err.stack &&
    err.stack.split('\n').find((l) => l.includes('INIT_SCRIPT'));
  console.error('check-jellyfin-init-script: injected Jellyfin init script FAILED to parse:');
  console.error('  ' + (narrow || line || String(err)));
  console.error(
    '  This means WebView2 silently skips the hook and Jellyfin items will play in the web player.',
  );
  process.exit(1);
}

console.log(
  `check-jellyfin-init-script: OK (${script.length} chars of injected JS parse cleanly)`,
);