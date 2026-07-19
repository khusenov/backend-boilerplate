import { readFileSync } from 'node:fs';

const cruiseReport = JSON.parse(readFileSync(0, 'utf8'));
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
