import json


CONTRACT = "backend/tournament-seed.py"


def as_hex(addr) -> str:
    raw = addr.as_bytes if hasattr(addr, "as_bytes") else bytes(addr)
    return "0x" + raw.hex()


def deploy(direct_vm, direct_deploy, direct_owner):
    direct_vm.sender = direct_owner
    return direct_deploy(CONTRACT)


def clean_draw() -> str:
    return (
        "Format: 8-seed single-elimination chess bracket. Seeding is rank-based. "
        "Seeds 1-8 exactly follow published ranking points. Paths are 1v8, 4v5, "
        "3v6, 2v7. No withdrawals, no manual overrides, no repeated suspicious pairings."
    )


def rigged_draw() -> str:
    return (
        "Format: 8-seed single-elimination tennis bracket. Published ranking says Alpha #1, "
        "Beta #2, Gamma #3, Delta #4. The organiser manually swaps Beta into Alpha's path, "
        "places two club teammates in one quarter, and overrides the stated rank-based algorithm."
    )


def revised_draw() -> str:
    return (
        "Revised 8-seed bracket. The bracket is regenerated strictly by published ranking: "
        "1v8, 4v5, 3v6, 2v7. Manual overrides removed and the same-club entrants are distributed."
    )


def mock_audit(direct_vm, count: int):
    direct_vm.clear_mocks()
    items = []
    if count:
        items = [
            {"kind": "PATH_RIGGING", "note": "Top seed receives engineered path against lower-ranked entrants."},
            {"kind": "COLLUSION_SIGNAL", "note": "Convenient same-club placement and repeated pairings."},
            {"kind": "ALGO_OVERRIDE", "note": "Manual override contradicts the stated rank-based algorithm."},
        ][:count]
    direct_vm.mock_llm(
        r".*Return strict JSON.*",
        json.dumps(
            {
                "seeding_anomalies": count,
                "items": items,
                "rationale": "Mocked direct-mode audit for deterministic lifecycle tests.",
            }
        ),
    )


def test_clean_bracket_can_be_audited_evaluated_and_ratified(direct_vm, direct_deploy, direct_owner, direct_alice):
    contract = deploy(direct_vm, direct_deploy, direct_owner)

    direct_vm.sender = direct_alice
    bid = contract.submit_bracket("City Autumn Open", clean_draw())
    card = contract.get_bracket_card(bid)
    assert card["status"] == "SUBMITTED"
    assert card["ruling"] == "PENDING"

    mock_audit(direct_vm, 0)
    contract.audit_seed(bid)
    card = contract.get_bracket_card(bid)
    assert card["status"] == "AUDITED"
    assert card["seeding_anomalies"] == 0

    contract.evaluate_fairness(bid)
    card = contract.get_bracket_card(bid)
    assert card["status"] == "EVALUATED"
    assert card["ruling"] == "FAIR"

    contract.ratify(bid)
    card = contract.get_bracket_card(bid)
    assert card["status"] == "RATIFIED"
    assert contract.tournament_stats()["fair_count"] == 1
    assert contract.get_phase_distribution()["RATIFIED"] == 1


def test_rigged_bracket_redraw_then_resubmit_path(direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob):
    contract = deploy(direct_vm, direct_deploy, direct_owner)

    direct_vm.sender = direct_alice
    bid = contract.submit_bracket("Summer Seed Cup", rigged_draw())

    mock_audit(direct_vm, 3)
    contract.audit_seed(bid)
    contract.evaluate_fairness(bid)
    card = contract.get_bracket_card(bid)
    assert card["ruling"] == "RIGGED"

    contract.ratify(bid)
    card = contract.get_bracket_card(bid)
    assert card["status"] == "REDRAW"
    assert card["redraw_round"] == 1
    assert len(contract.get_revisions(bid)) == 1

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("seed^rule;22006"):
        contract.resubmit_draw(bid, revised_draw())

    direct_vm.sender = direct_alice
    contract.resubmit_draw(bid, revised_draw())
    mock_audit(direct_vm, 0)
    contract.audit_seed(bid)
    contract.evaluate_fairness(bid)
    contract.ratify(bid)
    assert contract.get_bracket_card(bid)["status"] == "RATIFIED"


def test_submitter_only_retire_and_views(direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob):
    contract = deploy(direct_vm, direct_deploy, direct_owner)

    direct_vm.sender = direct_alice
    bid = contract.submit_bracket("Retire Test Open", clean_draw())

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("seed^rule;22006"):
        contract.retire_bracket(bid, "not my bracket")

    direct_vm.sender = direct_alice
    contract.retire_bracket(bid, "organiser cancelled the event")
    card = contract.get_bracket_card(bid)
    assert card["status"] == "RETIRED"

    assert contract.list_brackets_by_submitter(as_hex(direct_alice))[0]["bracket_id"] == int(bid)
    assert contract.list_brackets_by_tournament("Retire Test Open", 0, 10)[0]["bracket_id"] == int(bid)
    assert contract.get_ruling_distribution()["PENDING"] == 1
    assert contract.get_audit_log(0, 10)
    assert contract.top_tournaments(5)
    assert contract.list_anomaly_kinds()
    assert contract.get_fairness_bands()["redraw_cap"] == 3
