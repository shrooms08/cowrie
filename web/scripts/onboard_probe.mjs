import { Horizon, Asset, Operation, Keypair, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
const NET="Test SDF Network ; September 2015";
const USDC=new Asset("USDC","GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
const h=new Horizon.Server("https://horizon-testnet.stellar.org");
const s=new rpc.Server("https://soroban-testnet.stellar.org");
const t=()=>new Date().toISOString().slice(11,19);
const kp=Keypair.random();
console.log(t(),"friendbot",kp.publicKey().slice(0,6));
await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
for(let i=0;i<15;i++){try{await s.getAccount(kp.publicKey());break}catch{await new Promise(r=>setTimeout(r,1500))}}
console.log(t(),"funded. trustline…");
let acc=await h.loadAccount(kp.publicKey());
let tx=new TransactionBuilder(acc,{fee:"2000",networkPassphrase:NET}).addOperation(Operation.changeTrust({asset:USDC})).setTimeout(60).build();
tx.sign(kp); await h.submitTransaction(tx);
console.log(t(),"trustline done. checking DEX path…");
const paths=await h.strictReceivePaths([Asset.native()],USDC,"100").call();
console.log(t(),"paths:",paths.records?.length);
if(!(paths.records?.length)){console.log("DEX DRY");process.exit(1)}
acc=await h.loadAccount(kp.publicKey());
tx=new TransactionBuilder(acc,{fee:"2000",networkPassphrase:NET}).addOperation(Operation.pathPaymentStrictReceive({sendAsset:Asset.native(),sendMax:"2000",destination:kp.publicKey(),destAsset:USDC,destAmount:"100",path:[]})).setTimeout(60).build();
tx.sign(kp); await h.submitTransaction(tx);
acc=await h.loadAccount(kp.publicKey());
const b=acc.balances.find(x=>x.asset_code==="USDC");
console.log(t(),"USDC:",b?.balance,"— ONBOARDING OK");
