import { execFileSync } from 'node:child_process';

const REPORT_MAX_BYTES = 64 * 1024 * 1024;

const cruiseReport = JSON.parse(
  execFileSync('depcruise', ['src', '--output-type', 'json'], {
    encoding: 'utf8',
    maxBuffer: REPORT_MAX_BYTES,
  }),
);
const modulesCruised = cruiseReport.summary.totalCruised;

if (modulesCruised === 0) {
  console.error(
    'Architecture gate cruised 0 modules — the check is vacuous and proves nothing.\n' +
      'Check the source path, that dependencies are installed, and that a compatible ' +
      'TypeScript (>=2 <7) is present. Aborting.',
  );
  process.exit(1);
}

console.log(`Architecture gate cruised ${modulesCruised} modules.`);
