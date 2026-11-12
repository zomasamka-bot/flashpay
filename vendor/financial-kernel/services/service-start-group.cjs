'use strict';
// Startup only: every service has its own original TLS, role and ACL check.
// Producer stays stopped until ALL dependencies are ready. On failure, wait for
// bounded startup tasks to settle so the supervisor can clean up every child.
async function startServiceGroup(jobs){
 const results=await Promise.allSettled(jobs.map(job=>Promise.resolve().then(job)));
 const failed=results.find(x=>x.status==='rejected');
 if(failed)throw failed.reason;
 return results.map(x=>x.value);
}
module.exports={startServiceGroup};
