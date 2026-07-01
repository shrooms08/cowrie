import { chromium } from "playwright";
import { Horizon, Asset, Operation, Keypair, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
const NET="Test SDF Network ; September 2015", ISSUER="GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC=new Asset("USDC",ISSUER), h=new Horizon.Server("https://horizon-testnet.stellar.org"), s=new rpc.Server("https://soroban-testnet.stellar.org");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function fund(p){for(let a=0;a<5;a++){await fetch(`https://friendbot.stellar.org?addr=${p}`).catch(()=>{});for(let i=0;i<12;i++){try{await s.getAccount(p);return}catch{await sleep(1500)}}await sleep(2000)}}
async function classic(kp,op){const acc=await h.loadAccount(kp.publicKey());const tx=new TransactionBuilder(acc,{fee:"2000",networkPassphrase:NET}).addOperation(op).setTimeout(60).build();tx.sign(kp);await h.submitTransaction(tx)}
async function usdcOf(p){try{const acc=await h.loadAccount(p);const b=acc.balances.find(x=>x.asset_code==="USDC");return b?parseFloat(b.balance):0}catch{return 0}}
const buyer=Keypair.random(), merch=Keypair.random();
await fund(buyer.publicKey());
let acc=await h.loadAccount(buyer.publicKey());
if(!acc.balances.some(x=>x.asset_code==="USDC"))await classic(buyer,Operation.changeTrust({asset:USDC}));
await classic(buyer,Operation.pathPaymentStrictReceive({sendAsset:Asset.native(),sendMax:"2000",destination:buyer.publicKey(),destAsset:USDC,destAmount:"100",path:[]}));
const wSt=JSON.stringify({stellarSecret:buyer.secret(),walletPriv:"12345",handle:"sade",hideBalance:false,notes:[],payments:[]});
const link=`/?pay=${encodeURIComponent("Acme Foods")}&amt=25&addr=${merch.publicKey()}&fiat=42500&cur=NGN&id=COWRIE-ABFA`;
const b=await chromium.launch({headless:true});const pg=await(await b.newContext({viewport:{width:1200,height:900}})).newPage();
await pg.goto("http://localhost:3000"+link);
await pg.evaluate(x=>localStorage.setItem("cowrie.wallet.v1",x),wSt);
await pg.goto("http://localhost:3000"+link);
await pg.locator(".invoice-card").waitFor({timeout:90000});
await pg.waitForTimeout(1200);
await pg.locator(".sheet").screenshot({path:"/tmp/r6_buyer_sheet.png"});
console.log("OK");await b.close();
