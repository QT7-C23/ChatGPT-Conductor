import * as fs from 'node:fs/promises';
import http from 'node:http';
import {runPublicCli} from '../../scripts/distribution/cli.mjs';
import {createTransport,runGh} from '../../scripts/distribution/transport.mjs';
const input=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const sourcePorts={transport:createTransport({request:(url,options,cb)=>http.request(`http://127.0.0.1:${input.port}${url.pathname}${url.search}`,options,cb)}),authenticate:({tag,file})=>runGh(['release',file?'verify-asset':'verify',tag,...(file?[file]:[]),'--repo','github.com/QT7-C23/ChatGPT-Conductor','--format','json'],{executable:process.execPath,prefixArgs:['-e','process.stdout.write(JSON.stringify({authenticated:true}))','--']})};
let fired=false;
const fault=async(point,destination)=>{
  if(!input.fault||fired||point!==input.fault.point||input.fault.destination&&destination?.destination!==input.fault.destination)return;fired=true;
  if(input.fault.kind==='crash'){process.send('BOUNDARY');await new Promise(()=>{});}
  if(input.fault.kind==='dirty'){await fs.writeFile(`${input.fault.active}/foreign.txt`,'preserve unexpected writer');}
  throw new Error('private-secret-from-internal-fixture');
};
const output=await runPublicCli(input.args,{sourcePorts,fault});process.stdout.write(JSON.stringify(output.envelope)+'\n');process.exitCode=output.exitCode;
