module maker_access::access;

use sui::event;
use sui::transfer;
use sui::tx_context::{Self, TxContext};

const E_ALREADY_MEMBER: u64 = 0;
const E_NOT_MEMBER: u64 = 1;

public struct AdminCap has key {
    id: UID,
}

public struct Registry has key {
    id: UID,
    version: u64,
    members: vector<address>,
}

public struct MemberAdded has copy, drop {
    registry_id: ID,
    member: address,
    version: u64,
}

public struct MemberRemoved has copy, drop {
    registry_id: ID,
    member: address,
    version: u64,
}

fun init(ctx: &mut TxContext) {
    let operator = tx_context::sender(ctx);
    let registry = Registry {
        id: object::new(ctx),
        version: 1,
        members: vector[operator],
    };
    let admin_cap = AdminCap { id: object::new(ctx) };

    transfer::share_object(registry);
    transfer::transfer(admin_cap, operator);
}

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx);
}

public fun contains(registry: &Registry, member: address): bool {
    let mut index = 0;
    while (index < vector::length(&registry.members)) {
        if (*vector::borrow(&registry.members, index) == member) {
            return true
        };
        index = index + 1;
    };
    false
}

public fun add(
    _admin_cap: &AdminCap,
    registry: &mut Registry,
    member: address,
) {
    assert!(!contains(registry, member), E_ALREADY_MEMBER);
    vector::push_back(&mut registry.members, member);
    registry.version = registry.version + 1;
    event::emit(MemberAdded {
        registry_id: object::id(registry),
        member,
        version: registry.version,
    });
}

public fun remove(
    _admin_cap: &AdminCap,
    registry: &mut Registry,
    member: address,
) {
    let mut index = 0;
    let mut found = false;
    while (index < vector::length(&registry.members)) {
        if (*vector::borrow(&registry.members, index) == member) {
            vector::swap_remove(&mut registry.members, index);
            found = true;
            break
        };
        index = index + 1;
    };
    assert!(found, E_NOT_MEMBER);
    registry.version = registry.version + 1;
    event::emit(MemberRemoved {
        registry_id: object::id(registry),
        member,
        version: registry.version,
    });
}

public fun version(registry: &Registry): u64 {
    registry.version
}
