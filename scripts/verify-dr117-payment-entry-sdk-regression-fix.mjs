import fs from 'node:fs'; import crypto from 'node:crypto'; import assert from 'node:assert/strict';
const read=p=>fs.readFileSync(p,'utf8'); const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const page=read('app/page.tsx'), loader=read('components/pi-sdk-loader.tsx'), customer=read('components/customer-payment-view.tsx'), pay=read('app/pay/[id]/payment-content-with-id.tsx');
assert.match(page,/const paymentLink[\s\S]*?`pi:\/\/flashpay-two\.vercel\.app\/pay\//,'merchant QR must open Pi Browser direct');
assert.match(page,/const sharePaymentUrl[\s\S]*?`https:\/\/flashpay-two\.vercel\.app\/pay\/[\s\S]*?entry=share/,'shared links must remain HTTPS bridge links');
assert.doesNotMatch(page,/initializePiSDK/,'home must not own Pi.init');
assert.doesNotMatch(customer,/initializePiSDK/,'legacy customer view must not own Pi.init');
assert.doesNotMatch(pay,/initializePiSDK/,'active payment view must not own Pi.init');
assert.match(loader,/await window\.Pi\.init\(\{ version: "2\.0", sandbox: false \}\)/,'loader must be sole Pi.init owner');
assert.match(loader,/unifiedStore\.updateWalletStatus\(\{[\s\S]*?isInitialized: true/,'loader must publish initialized state consumed by authentication');
assert.match(pay,/await window\.__PI_SDK_READY__/,'active payment view must await shared readiness');
assert.match(customer,/await window\.__PI_SDK_READY__/,'legacy payment view must await shared readiness');
const immutable={
 'app/api/pi/approve/route.ts':'766c30244c7edb9493e6af7cd901b0772b180dca3dfe98d285573e63d20e4133',
 'app/api/pi/complete/route.ts':'8856935d78fd46578ce84376b81b616d56f2f28161f09b0b1f09efaceedc4406',
 'lib/db.ts':'457586325a511809802cdce10d2ea7ce317d7c7bb01d386d202e80f5e8f939b8',
 'lib/refund-executor.ts':'2eac9435cd38ce03d2d65eeb0133a7f46769ff89281af35a5f5f11e317780dda',
 'lib/refund-checkpoint-store.ts':'498211b7df6a6ca4026da7ae68044bab360a5dd20bf871e592b027120c6cd570',
 'app/api/recovery/transient/route.ts':'a0ea7557d67f568f3569a2af3cddc4d131b5f81d9474cc6fab77652003778023'
};
for(const [p,h] of Object.entries(immutable)) assert.equal(sha(p),h,`${p} financial/recovery baseline drifted`);
console.log(JSON.stringify({certification:'PASS',gate:'DR117-PAYMENT-ENTRY-SDK-REGRESSION-FIX',qrDirectPiBrowser:true,shareHttpsPreserved:true,singlePiInitOwner:true,walletReadinessUnified:true,financialKernelByteIdentical:true},null,2));
