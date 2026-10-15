import { arg } from '../lib/store.mjs';
import { runCompanySearch } from '../lib/company-search.mjs';
const result = await runCompanySearch(arg('--job'));
console.log(JSON.stringify(result));
if (result.status === 'failed') process.exitCode = 1;
