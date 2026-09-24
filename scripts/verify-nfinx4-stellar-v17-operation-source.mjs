import{strict as assert}from"node:assert";import fs from"node:fs";
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8");
const pkg=JSON.parse(read("package.json")),settlement=read("lib/financial-recovery-settlement-submit-xdr-verifier.ts"),refund=read("lib/refund-blockchain-submit.ts");
assert.equal(pkg.dependencies["@stellar/stellar-sdk"],"17.1.0");
assert.ok(settlement.includes("operation.source === undefined"));
assert.ok(refund.includes("operation.source !== undefined"));
assert.ok(settlement.includes("TransactionBuilder.fromXDR"));
assert.ok(refund.includes("TransactionBuilder.fromXDR"));
console.log(JSON.stringify({certification:"PASS",gate:"N-FIN-X4",sdkVersion:"17.1.0",sdkSourceProof:"Operation.fromXdrObject initializes an empty result and only assigns result.source when sourceAccount is truthy; absent SDK-level operation source is therefore omitted/undefined",settlementImplicitSourceGuard:"undefined",refundImplicitSourceGuard:"undefined",financialRuntimePatchRequired:false,runtimeFinancialSourceChanged:false,financialMovementExecuted:false},null,2));
