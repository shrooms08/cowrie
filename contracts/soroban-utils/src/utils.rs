//! Admin + mock-token helpers (no arkworks deps).

use soroban_sdk::{Address, Env, IntoVal, TryFromVal, Val, contract, contractimpl};

/// Update the contract administrator (requires current admin auth).
pub fn update_admin<K>(env: &Env, admin_key: &K, new_admin: &Address)
where
    K: IntoVal<Env, Val> + TryFromVal<Env, Val> + Clone,
{
    let store = env.storage().persistent();
    let admin: Address = store.get(admin_key).expect("admin not initialized");
    admin.require_auth();
    store.set(admin_key, new_admin);
}

/// Mock token used in place of a real USDC SAC for the demo.
#[contract]
pub struct MockToken;

#[contractimpl]
impl MockToken {
    pub fn balance(_env: Env, _id: Address) -> i128 { 0 }
    pub fn transfer(_env: Env, _from: Address, _to: Address, _amount: i128) {}
}
