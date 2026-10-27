#[test_only]
module maker_access::access_tests;

use maker_access::access::{Self, AdminCap, Registry};
use sui::test_scenario;

const OPERATOR: address = @0xA;
const MEMBER: address = @0xB;

#[test]
fun operator_can_add_and_remove_member() {
    let mut scenario = test_scenario::begin(OPERATOR);
    access::init_for_testing(scenario.ctx());

    scenario.next_tx(OPERATOR);
    {
        let admin_cap = scenario.take_from_sender<AdminCap>();
        let mut registry = scenario.take_shared<Registry>();

        assert!(access::contains(&registry, OPERATOR));
        assert!(!access::contains(&registry, MEMBER));

        access::add(&admin_cap, &mut registry, MEMBER);
        assert!(access::contains(&registry, MEMBER));
        assert!(access::version(&registry) == 2);

        access::remove(&admin_cap, &mut registry, MEMBER);
        assert!(!access::contains(&registry, MEMBER));
        assert!(access::version(&registry) == 3);

        scenario.return_to_sender(admin_cap);
        test_scenario::return_shared(registry);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 0, location = maker_access::access)]
fun duplicate_member_is_rejected() {
    let mut scenario = test_scenario::begin(OPERATOR);
    access::init_for_testing(scenario.ctx());

    scenario.next_tx(OPERATOR);
    {
        let admin_cap = scenario.take_from_sender<AdminCap>();
        let mut registry = scenario.take_shared<Registry>();
        access::add(&admin_cap, &mut registry, MEMBER);
        access::add(&admin_cap, &mut registry, MEMBER);
        scenario.return_to_sender(admin_cap);
        test_scenario::return_shared(registry);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 1, location = maker_access::access)]
fun removing_a_non_member_is_rejected() {
    let mut scenario = test_scenario::begin(OPERATOR);
    access::init_for_testing(scenario.ctx());

    scenario.next_tx(OPERATOR);
    {
        let admin_cap = scenario.take_from_sender<AdminCap>();
        let mut registry = scenario.take_shared<Registry>();
        access::remove(&admin_cap, &mut registry, MEMBER);
        scenario.return_to_sender(admin_cap);
        test_scenario::return_shared(registry);
    };
    scenario.end();
}
