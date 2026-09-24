import {runPublicCli} from './distribution/cli.mjs';
const result=await runPublicCli(process.argv.slice(2));
process.stdout.write(JSON.stringify(result.envelope)+'\n');
process.exitCode=result.exitCode;
