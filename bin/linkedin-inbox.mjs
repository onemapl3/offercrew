import { runLinkedInInbox } from '../lib/linkedin-inbox.mjs';
const args=process.argv.slice(2),value=k=>{const i=args.indexOf(k);return i>=0?args[i+1]:null;};
const r=await runLinkedInInbox({force:args.includes('--now'),thread_url:value('--thread'),record_id:value('--record')});
console.log(JSON.stringify(r));
if(['failed','login_required','verification_required','skipped'].includes(r.status))process.exitCode=1;
