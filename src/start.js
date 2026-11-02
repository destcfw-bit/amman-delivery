require('dotenv').config();
const { spawn } = require('child_process');

let worker=null,stopping=false;
function startWorker(){
  if(String(process.env.RUN_WORKER||'0')!=='1'||stopping)return;
  worker=spawn(process.execPath,['src/worker.js'],{stdio:'inherit',env:process.env});
  worker.on('exit',(code,signal)=>{
    worker=null;
    if(!stopping){
      console.error('AMMAN DELIVERY worker exited',{code,signal});
      setTimeout(startWorker,2000).unref();
    }
  });
}
const server=spawn(process.execPath,['src/server.js'],{stdio:'inherit',env:process.env});
if(String(process.env.RUN_WORKER||'0')==='1')setTimeout(startWorker,4000).unref();
server.on('exit',(code,signal)=>{
  stopping=true;
  if(worker)worker.kill('SIGTERM');
  process.exit(code??(signal?1:0));
});
for(const sig of ['SIGTERM','SIGINT']){
  process.on(sig,()=>{
    stopping=true;
    if(worker)worker.kill(sig);
    if(server&&!server.killed)server.kill(sig);
  });
}

