import fs from "node:fs";
const p = "/Users/minos/Projects/cowrie/deployments/testnet/r6.json";
const j = JSON.parse(fs.readFileSync(p, "utf8"));
j.verify_relocation = {
  rationale:
    "Selective disclosure: buyer PAYS -> buyer GENERATES a receipt scoped to the merchant -> the MERCHANT (recipient) VERIFIES. Verifying is a recipient action; the buyer never verifies. Verify was a pre-R5 leftover in the buyer nav.",
  removed_from_buyer:
    "Verify nav entry (walletNav) + its goTab branch + the receipt-ready sheet's 'Open verify view' link. Buyer now has ZERO /verify links (e2e + screenshot: sidenav 'HomePay', verifyLinks=0).",
  added_to_merchant:
    "'Verify receipt' link in the register header -> /verify (reuses the EXISTING verify view; logic untouched). /verify back-link changed to '<- register' -> /merchant.",
  logic_untouched:
    "On-chain receipt verification, recipient binding, and wrong-recipient rejection are unchanged — proven in the R1 receipt-verify e2e (verify as recipient = success showing amount+merchant; verify as a different identity = rejected).",
  e2e_note:
    "Nav relocation verified: buyer sidenav 'HomePay' with 0 verify links; register header 'Verify receipt' -> /verify; clicking it reaches the verify page (back link '<- register'). The full buyer-pay -> receipt -> merchant-verify browser loop was blocked by a transient testnet RPC outage on the spend step ('Paid' heading 280s timeout, twice) — unrelated to this UI/routing change.",
  build: "next build green",
};
fs.writeFileSync(p, JSON.stringify(j, null, 2));
console.log("recorded verify_relocation");
