import { runDr17SharedResourceSafe10k } from '../lib/dr17-shared-certification.mjs'

const result = await runDr17SharedResourceSafe10k()
console.log(JSON.stringify(result, null, 2))
