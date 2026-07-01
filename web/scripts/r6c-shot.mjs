import { chromium } from "playwright";
import { Horizon, Asset, Operation, Keypair, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
const NET="Test SDF Network ; September 2015", ISSUER="GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC=new Asset("USDC",ISSUER), h=new Horizon.Server("https://horizon-testnet.stellar.org"), s=new rpc.Server("https://soroban-testnet.stellar.org");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function fund(p){for(let a=0;a<5;a++){await fetch(`https://friendbot.stellar.org?addr=${p}`).catch(()=>{});for(let i=0;i<12;i++){try{await s.getAccount(p);return}catch{await sleep(1500)}}await sleep(2000)}}
async function classic(kp,op){const acc=await h.loadAccount(kp.publicKey());const tx=new TransactionBuilder(acc,{fee:"2000",networkPassphrase:NET}).addOperation(op).setTimeout(60).build();tx.sign(kp);await h.submitTransaction(tx)}
const merch=Keypair.random(); await fund(merch.publicKey()); await classic(merch,Operation.changeTrust({asset:USDC}));
const mSt=JSON.stringify({stellarSecret:merch.secret(),name:"Acme Foods",createdAt:1});
const b=await chromium.launch({headless:true});const pg=await(await b.newContext({viewport:{width:1200,height:820}})).newPage();
await pg.goto("http://localhost:3000/merchant");
await pg.evaluate(x=>localStorage.setItem("cowrie.merchant.v1",x),mSt);
await pg.reload();
await pg.locator(".merch-panel",{hasText:"ready to receive"}).waitFor({timeout:120000});
await pg.locator(".reg-input.big").fill("42500"); await pg.waitForTimeout(300);
await pg.getByRole("button",{name:"Generate charge"}).click();
await pg.locator(".qr-frame svg").waitFor({timeout:15000});
const anchorGone=(await pg.locator(".reg-card.anchor").count())===0 && !/MOCK — not real fiat rails|SEP-38/.test(await pg.locator(".reg-root").textContent());
console.log("anchor_panel_gone:",anchorGone);
await pg.screenshot({path:"/tmp/r6c_merchant.png"});
console.log("OK");await b.close();
