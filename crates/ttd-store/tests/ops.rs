//! Pure-function tests: apply_op, trim, validation, parsing, normalisation, seeded random sequences.

mod common;

use common::*;
use serde_json::{json, Value};
use std::collections::HashSet;
use ttd_store::{apply_op, trim_contract, Applied, Doc, ErrorCode, ParseError, StoreError};

type Mutation = Box<dyn Fn(&mut Value)>;

const T0: &str = "2026-01-01T09:00:00.000Z";
const T1: &str = "2026-01-01T10:00:00.000Z";

fn doc_of(v: Value) -> Doc {
    Doc::from_value(v).expect("valid doc")
}

fn counter() -> impl FnMut() -> String {
    let mut n = 0;
    move || {
        n += 1;
        format!("gen{n}")
    }
}

fn run(doc: &Doc, op: Value, now: &str) -> Result<Applied, StoreError> {
    apply_op(doc, &op, now, &mut counter())
}

fn code(r: Result<Applied, StoreError>) -> ErrorCode {
    r.expect_err("expected an error").code
}

fn abc() -> Doc {
    doc_of(doc_json(
        3,
        vec![item("a", "A", 0, "2026-01-01T08:00:00.000Z"), item("b", "B", 1, "2026-01-01T08:01:00.000Z"), item("c", "C", 2, "2026-01-01T08:02:00.000Z")],
    ))
}

fn ids(d: &Doc) -> Vec<&str> {
    d.items.iter().map(|i| i.id.as_str()).collect()
}

#[test]
fn trim_removes_only_the_contract_set() {
    assert_eq!(trim_contract("\u{9}\u{a}\u{b}\u{c}\u{d} \u{a0}\u{2028}\u{2029}\u{feff}x\u{feff}\u{2029}\u{2028}\u{a0} \u{d}\u{c}\u{b}\u{a}\u{9}"), "x");
    // Unicode whitespace outside the set is NOT trimmed (Rust's str::trim would strip all of these).
    for keep in ["\u{85}", "\u{1680}", "\u{2000}", "\u{2003}", "\u{200a}", "\u{202f}", "\u{205f}", "\u{3000}"] {
        let s = format!("{keep}x{keep}");
        assert_eq!(trim_contract(&s), s, "must keep U+{:04X}", keep.chars().next().unwrap() as u32);
    }
    assert_eq!(trim_contract("a b"), "a b");
    assert_eq!(trim_contract("   "), "");
}

#[test]
fn add_stores_the_contract_trimmed_title_and_keeps_other_whitespace() {
    let r = run(&Doc::empty(), json!({"op":"add","id":"x","title":"\u{a0}\u{feff} hi \u{3000}\u{2029}"}), T0).unwrap();
    assert_eq!(r.doc.items[0].title, "hi \u{3000}");
}

#[test]
fn add_defaults_and_append_at_bottom() {
    let r = run(&abc(), json!({"op":"add","id":"d","title":"D"}), T1).unwrap();
    assert!(r.changed);
    assert_eq!(ids(&r.doc), ["a", "b", "c", "d"]);
    assert_eq!(r.result["item"]["order"], 3);
    assert_eq!(r.result["item"]["status"], "todo");
    assert_eq!(r.result["item"]["body"], "");
    assert_eq!(r.result["item"]["createdAt"], T1);
    assert_eq!(r.result["item"]["updatedAt"], T1);
    assert_eq!(r.doc.rev, 3, "apply never touches rev");
}

#[test]
fn add_without_id_uses_the_generator_and_with_id_does_not() {
    let r = run(&Doc::empty(), json!({"op":"add","title":"x"}), T0).unwrap();
    assert_eq!(r.doc.items[0].id, "gen1");
    let r = run(&Doc::empty(), json!({"op":"add","id":"mine","title":"x"}), T0).unwrap();
    assert_eq!(r.doc.items[0].id, "mine");
}

#[test]
fn id_regex() {
    let ok64 = "a".repeat(64);
    let ok_mixed = "aZ09_-x".to_string();
    for id in [ok64.as_str(), ok_mixed.as_str(), "_", "-"] {
        assert!(run(&Doc::empty(), json!({"op":"add","id":id,"title":"x"}), T0).is_ok(), "{id} must be valid");
    }
    let bad65 = "a".repeat(65);
    for id in ["", bad65.as_str(), "bad id", "a/b", "ä", "x.y", "a\n", "emoji\u{1f600}"] {
        assert_eq!(code(run(&Doc::empty(), json!({"op":"add","id":id,"title":"x"}), T0)), ErrorCode::InvalidOp, "id {id:?}");
    }
    assert_eq!(code(run(&Doc::empty(), json!({"op":"add","id":5,"title":"x"}), T0)), ErrorCode::InvalidOp);
    assert_eq!(code(run(&Doc::empty(), json!({"op":"add","id":null,"title":"x"}), T0)), ErrorCode::InvalidOp);
}

#[test]
fn lengths_are_code_points() {
    let emoji = |n: usize| "\u{1f600}".repeat(n);
    assert!(run(&Doc::empty(), json!({"op":"add","title":emoji(200)}), T0).is_ok());
    assert_eq!(code(run(&Doc::empty(), json!({"op":"add","title":emoji(201)}), T0)), ErrorCode::TooLong);
    assert!(run(&Doc::empty(), json!({"op":"add","title":"x","body":emoji(10000)}), T0).is_ok());
    assert_eq!(code(run(&Doc::empty(), json!({"op":"add","title":"x","body":emoji(10001)}), T0)), ErrorCode::TooLong);
    // The limit applies after trim.
    let padded = format!("  {}  ", "x".repeat(200));
    assert!(run(&Doc::empty(), json!({"op":"add","title":padded}), T0).is_ok());
}

#[test]
fn title_validation() {
    for t in ["", "   ", "\t\u{a0}", "a\nb", "a\u{0}b", "a\u{1f}b", "x\ty"] {
        assert_eq!(code(run(&Doc::empty(), json!({"op":"add","title":t}), T0)), ErrorCode::InvalidTitle, "title {t:?}");
    }
    // U+007F and U+0085 are >= U+0020, so allowed.
    assert!(run(&Doc::empty(), json!({"op":"add","title":"a\u{7f}\u{85}b"}), T0).is_ok());
    for t in [json!(null), json!(5), json!(["x"]), json!({})] {
        assert_eq!(code(run(&Doc::empty(), json!({"op":"add","title":t}), T0)), ErrorCode::InvalidOp);
    }
    assert_eq!(code(run(&Doc::empty(), json!({"op":"add"}), T0)), ErrorCode::InvalidOp);
}

#[test]
fn validation_order_shape_then_values_then_lookups() {
    // shape (status) beats value (empty title)
    assert_eq!(code(run(&Doc::empty(), json!({"op":"add","title":"","status":"blocked"}), T0)), ErrorCode::InvalidOp);
    // shape (body type) beats value (empty title)
    assert_eq!(code(run(&abc(), json!({"op":"update","id":"nope","title":"","body":1}), T0)), ErrorCode::InvalidOp);
    // value beats lookup
    assert_eq!(code(run(&abc(), json!({"op":"update","id":"nope","title":""}), T0)), ErrorCode::InvalidTitle);
    assert_eq!(code(run(&abc(), json!({"op":"update","id":"nope","title":"x"}), T0)), ErrorCode::NotFound);
    // value validation of an existing add id still runs before the idempotent no-op
    assert_eq!(code(run(&abc(), json!({"op":"add","id":"a","title":""}), T0)), ErrorCode::InvalidTitle);
}

#[test]
fn op_shape_errors() {
    for op in [
        json!({"op":"frobnicate"}),
        json!({}),
        json!({"op":5}),
        json!("add"),
        json!(null),
        json!([]),
        json!({"op":"set_status","id":"a","status":"DONE"}),
        json!({"op":"set_status","id":"a"}),
        json!({"op":"set_status","status":"done"}),
        json!({"op":"update","id":"a"}),
        json!({"op":"update","id":"a","title":null}),
        json!({"op":"update","id":"a","body":123}),
        json!({"op":"delete"}),
        json!({"op":"delete","id":7}),
        json!({"op":"move","id":"a"}),
        json!({"op":"move","id":"a","after":7}),
        json!({"op":"move","id":"a","after":"a"}),
        json!({"op":"add","title":"x","body":null}),
        json!({"op":"add","title":"x","status":null}),
    ] {
        assert_eq!(code(run(&abc(), op.clone(), T0)), ErrorCode::InvalidOp, "{op}");
    }
}

#[test]
fn update_changed_only_when_a_value_differs() {
    let d = abc();
    let r = run(&d, json!({"op":"update","id":"a","title":"  A  "}), T1).unwrap();
    assert!(!r.changed, "title compared after trim");
    assert_eq!(r.doc, d.clone().normalized());
    let r = run(&d, json!({"op":"update","id":"a","body":""}), T1).unwrap();
    assert!(!r.changed);
    let r = run(&d, json!({"op":"update","id":"a","body":"new"}), T1).unwrap();
    assert!(r.changed);
    assert_eq!(r.result["item"]["updatedAt"], T1);
    assert_eq!(r.result["item"]["createdAt"], "2026-01-01T08:00:00.000Z");
    let r = run(&d, json!({"op":"update","id":"a","title":"A2","body":""}), T1).unwrap();
    assert_eq!(r.result["item"]["title"], "A2");
}

#[test]
fn set_status_bumps_updated_at_only_on_change() {
    let d = abc();
    let r = run(&d, json!({"op":"set_status","id":"b","status":"todo"}), T1).unwrap();
    assert!(!r.changed);
    assert_eq!(r.result["item"]["updatedAt"], "2026-01-01T08:01:00.000Z");
    let r = run(&d, json!({"op":"set_status","id":"b","status":"in_progress"}), T1).unwrap();
    assert!(r.changed);
    assert_eq!(r.result["item"]["status"], "in_progress");
    assert_eq!(r.result["item"]["updatedAt"], T1);
    assert_eq!(code(run(&d, json!({"op":"set_status","id":"zz","status":"done"}), T1)), ErrorCode::NotFound);
}

#[test]
fn move_semantics() {
    let d = abc();
    let r = run(&d, json!({"op":"move","id":"c","after":null}), T1).unwrap();
    assert_eq!(ids(&r.doc), ["c", "a", "b"]);
    assert_eq!(r.result["item"]["order"], 0);
    assert_eq!(r.result["item"]["updatedAt"], "2026-01-01T08:02:00.000Z", "move must not bump updatedAt");
    let r = run(&d, json!({"op":"move","id":"a","after":"c"}), T1).unwrap();
    assert_eq!(ids(&r.doc), ["b", "c", "a"]);
    assert_eq!(r.result["item"]["order"], 2);
    // same position => no change
    assert!(!run(&d, json!({"op":"move","id":"b","after":"a"}), T1).unwrap().changed);
    assert!(!run(&d, json!({"op":"move","id":"a","after":null}), T1).unwrap().changed);
    assert_eq!(code(run(&d, json!({"op":"move","id":"a","after":"zz"}), T1)), ErrorCode::NotFound);
    assert_eq!(code(run(&d, json!({"op":"move","id":"zz","after":null}), T1)), ErrorCode::NotFound);
    assert_eq!(code(run(&d, json!({"op":"move","id":"zz","after":"a"}), T1)), ErrorCode::NotFound);
    assert_eq!(code(run(&d, json!({"op":"move","id":"zz","after":"zz"}), T1)), ErrorCode::InvalidOp);
}

#[test]
fn delete_is_idempotent_and_renumbers() {
    let d = abc();
    let r = run(&d, json!({"op":"delete","id":"a"}), T1).unwrap();
    assert!(r.changed);
    assert_eq!(r.result, json!({"id":"a"}));
    assert_eq!(ids(&r.doc), ["b", "c"]);
    assert_eq!(r.doc.items.iter().map(|i| i.order).collect::<Vec<_>>(), [0, 1]);
    let r = run(&d, json!({"op":"delete","id":"nope"}), T1).unwrap();
    assert!(!r.changed);
    assert_eq!(r.result, json!({"id":"nope"}));
}

#[test]
fn add_existing_id_is_a_noop_returning_the_existing_item() {
    let r = run(&abc(), json!({"op":"add","id":"b","title":"ignored","body":"ignored"}), T1).unwrap();
    assert!(!r.changed);
    assert_eq!(r.result["item"]["title"], "B");
    assert_eq!(r.result["item"]["order"], 1);
}

#[test]
fn reset_corrupt_is_not_a_pure_op() {
    // The engine handles it; the pure function never changes anything and reports not_corrupt.
    assert_eq!(code(run(&abc(), json!({"op":"reset_corrupt"}), T1)), ErrorCode::NotCorrupt);
}

#[test]
fn unknown_fields_survive_every_op() {
    let mut v = doc_json(1, vec![item("t1", "One", 0, "2026-01-01T08:00:00.000Z"), item("t2", "Two", 1, "2026-01-01T08:01:00.000Z")]);
    v["meta"] = json!({"theme":"x","n":1});
    v["items"][0]["color"] = json!("red");
    v["items"][0]["tags"] = json!(["a"]);
    let d = doc_of(v);
    for op in [
        json!({"op":"set_status","id":"t1","status":"done"}),
        json!({"op":"update","id":"t1","title":"New"}),
        json!({"op":"move","id":"t1","after":"t2"}),
        json!({"op":"add","id":"t3","title":"x"}),
        json!({"op":"delete","id":"t2"}),
    ] {
        let out = run(&d, op.clone(), T1).unwrap().doc.to_value();
        assert_eq!(out["meta"], json!({"theme":"x","n":1}), "{op}");
        let t1 = out["items"].as_array().unwrap().iter().find(|i| i["id"] == "t1").unwrap();
        assert_eq!(t1["color"], "red", "{op}");
        assert_eq!(t1["tags"], json!(["a"]), "{op}");
    }
}

#[test]
fn item_count_limit() {
    let items: Vec<Value> = (0..1000).map(|i| item(&format!("i{i}"), "x", i, "2026-01-01T08:00:00.000Z")).collect();
    let d = doc_of(doc_json(1, items));
    assert_eq!(code(run(&d, json!({"op":"add","id":"one-more","title":"x"}), T1)), ErrorCode::LimitExceeded);
    // re-adding an existing id is still the idempotent no-op
    assert!(!run(&d, json!({"op":"add","id":"i5","title":"x"}), T1).unwrap().changed);
    // and deleting is always allowed
    assert!(run(&d, json!({"op":"delete","id":"i5"}), T1).unwrap().changed);
}

#[test]
fn file_size_limit_blocks_growth_but_never_blocks_shrinking() {
    let body = "y".repeat(10000);
    let mut items: Vec<Value> = (0..100).map(|i| item(&format!("i{i}"), "x", i, "2026-01-01T08:00:00.000Z")).collect();
    for it in &mut items {
        it["body"] = json!(body);
    }
    let d = doc_of(doc_json(1, items));
    assert!(d.to_json_pretty().len() < 1_048_576, "setup stays under 1 MiB");
    let mut op_body = json!({"op":"add","id":"big","title":"x"});
    op_body["body"] = json!(body.clone());
    // 100 * ~10.25k = ~1.025 MB, so three more 10k bodies cross 1 MiB
    let mut d2 = d.clone();
    let mut crossed = false;
    for n in 0..5 {
        let mut op = op_body.clone();
        op["id"] = json!(format!("big{n}"));
        match run(&d2, op, T1) {
            Ok(r) => d2 = r.doc,
            Err(e) => {
                assert_eq!(e.code, ErrorCode::LimitExceeded);
                crossed = true;
                break;
            }
        }
    }
    assert!(crossed, "growing past 1 MiB must be limit_exceeded");
    // An already-oversized doc can still shrink.
    let mut over = d2.clone();
    over.items.iter_mut().for_each(|i| i.body = body.clone());
    for n in 0..4 {
        over.items.push(ttd_store::Item::new(&format!("o{n}"), "x", &body, "2026-01-01T08:00:00.000Z", 1000 + n as i64));
    }
    assert!(over.to_json_pretty().len() > 1_048_576);
    assert!(run(&over, json!({"op":"delete","id":"o0"}), T1).unwrap().changed);
}

#[test]
fn normalisation_sorts_by_order_created_at_id_and_renumbers() {
    let mut a = item("a", "A", 1, "2026-01-01T08:00:00.000Z");
    let b = item("b", "B", 1, "2026-01-01T08:01:00.000Z");
    let c = item("c", "C", 5, "2026-01-01T08:02:00.000Z");
    let z = item("z", "Z", 1, "2026-01-01T08:00:00.000Z"); // ties with a on (order, createdAt): id decides
    a["order"] = json!(1);
    let d = doc_of(doc_json(9, vec![c, z, b, a])).normalized();
    assert_eq!(ids(&d), ["a", "z", "b", "c"]);
    assert_eq!(d.items.iter().map(|i| i.order).collect::<Vec<_>>(), [0, 1, 2, 3]);
    assert_eq!(d.rev, 9);
    // negative orders sort first
    let d = doc_of(doc_json(1, vec![item("p", "P", 0, "2026-01-01T08:00:00.000Z"), item("n", "N", -3, "2026-01-01T09:00:00.000Z")])).normalized();
    assert_eq!(ids(&d), ["n", "p"]);
}

#[test]
fn apply_works_on_the_normalised_view_but_noop_does_not_persist_it() {
    let d = doc_of(doc_json(9, vec![item("c", "C", 5, "2026-01-01T08:02:00.000Z"), item("a", "A", 1, "2026-01-01T08:00:00.000Z")]));
    let r = run(&d, json!({"op":"add","id":"n","title":"N"}), T1).unwrap();
    assert_eq!(ids(&r.doc), ["a", "c", "n"]);
    assert_eq!(r.result["item"]["order"], 2);
    let r = run(&d, json!({"op":"set_status","id":"a","status":"todo"}), T1).unwrap();
    assert!(!r.changed);
}

#[test]
fn parse_accepts_valid_and_rejects_every_corruption_class() {
    let good = || doc_json(1, vec![item("t1", "One", 0, "2026-01-01T08:00:00.000Z")]);
    assert!(Doc::from_value(good()).is_ok());
    // integral floats are integers in JS, so they are accepted
    let mut v = good();
    v["rev"] = json!(3.0);
    assert_eq!(Doc::from_value(v).unwrap().rev, 3);

    let mutate = |f: &dyn Fn(&mut Value)| {
        let mut v = good();
        f(&mut v);
        Doc::from_value(v)
    };
    let corrupt: Vec<(&str, Mutation)> = vec![
        ("schemaVersion string", Box::new(|v| v["schemaVersion"] = json!("1"))),
        ("schemaVersion float", Box::new(|v| v["schemaVersion"] = json!(1.5))),
        ("schemaVersion missing", Box::new(|v| { v.as_object_mut().unwrap().remove("schemaVersion"); })),
        ("schemaVersion 0", Box::new(|v| v["schemaVersion"] = json!(0))),
        ("rev negative", Box::new(|v| v["rev"] = json!(-1))),
        ("rev float", Box::new(|v| v["rev"] = json!(1.5))),
        ("rev string", Box::new(|v| v["rev"] = json!("1"))),
        ("rev missing", Box::new(|v| { v.as_object_mut().unwrap().remove("rev"); })),
        ("items not array", Box::new(|v| v["items"] = json!({}))),
        ("items missing", Box::new(|v| { v.as_object_mut().unwrap().remove("items"); })),
        ("item not object", Box::new(|v| v["items"][0] = json!("x"))),
        ("item missing id", Box::new(|v| { v["items"][0].as_object_mut().unwrap().remove("id"); })),
        ("item missing title", Box::new(|v| { v["items"][0].as_object_mut().unwrap().remove("title"); })),
        ("item missing body", Box::new(|v| { v["items"][0].as_object_mut().unwrap().remove("body"); })),
        ("item missing createdAt", Box::new(|v| { v["items"][0].as_object_mut().unwrap().remove("createdAt"); })),
        ("item missing updatedAt", Box::new(|v| { v["items"][0].as_object_mut().unwrap().remove("updatedAt"); })),
        ("item missing order", Box::new(|v| { v["items"][0].as_object_mut().unwrap().remove("order"); })),
        ("title number", Box::new(|v| v["items"][0]["title"] = json!(5))),
        ("body null", Box::new(|v| v["items"][0]["body"] = json!(null))),
        ("order float", Box::new(|v| v["items"][0]["order"] = json!(0.5))),
        ("order string", Box::new(|v| v["items"][0]["order"] = json!("0"))),
        ("bad status", Box::new(|v| v["items"][0]["status"] = json!("blocked"))),
        ("status number", Box::new(|v| v["items"][0]["status"] = json!(1))),
        ("bad id chars", Box::new(|v| v["items"][0]["id"] = json!("a b"))),
        ("empty id", Box::new(|v| v["items"][0]["id"] = json!(""))),
        ("duplicate ids", Box::new(|v| { let dup = v["items"][0].clone(); v["items"].as_array_mut().unwrap().push(dup); })),
    ];
    for (name, f) in &corrupt {
        assert_eq!(mutate(f.as_ref()).err(), Some(ParseError::Corrupt), "{name}");
    }
    for bad in [json!([]), json!("x"), json!(null), json!(3)] {
        assert_eq!(Doc::from_value(bad).err(), Some(ParseError::Corrupt));
    }
}

#[test]
fn parse_text_errors_and_versions() {
    assert_eq!(Doc::parse("{not json").err(), Some(ParseError::Corrupt));
    assert_eq!(Doc::parse("").err(), Some(ParseError::Corrupt));
    assert_eq!(Doc::parse("{} trailing").err(), Some(ParseError::Corrupt));
    // A higher schemaVersion wins over anything else being odd about the document.
    assert_eq!(Doc::parse(r#"{"schemaVersion":2,"rev":"weird","items":"new shape"}"#).err(), Some(ParseError::Unsupported));
    assert_eq!(Doc::parse(r#"{"schemaVersion":99,"rev":4,"items":[]}"#).err(), Some(ParseError::Unsupported));
    assert!(Doc::parse(&serde_json::to_string(&doc_json(0, vec![])).unwrap()).is_ok());
}

#[test]
fn serialisation_style() {
    let d = abc();
    let text = d.to_json_pretty();
    assert!(text.ends_with("}\n"));
    assert!(text.starts_with("{\n  \"schemaVersion\": 1,\n  \"rev\": 3,\n  \"items\": [\n    {\n      \"id\": \"a\","));
    assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), d.to_value());
    assert_eq!(Doc::empty().to_json_pretty(), "{\n  \"schemaVersion\": 1,\n  \"rev\": 0,\n  \"items\": []\n}\n");
}

#[test]
fn seeded_random_sequences_keep_invariants() {
    for seed in 0..40u64 {
        let mut rng = fastrand::Rng::with_seed(seed);
        let mut doc = Doc::empty();
        let mut n = 0u32;
        let mut next_id = || {
            n += 1;
            format!("r{n}")
        };
        let pool: Vec<String> = (0..12).map(|i| format!("r{}", i + 1)).collect();
        for step in 0..120 {
            let pick = |rng: &mut fastrand::Rng| pool[rng.usize(..pool.len())].clone();
            let op = match rng.u8(..6) {
                0 | 1 => json!({"op":"add","title":format!("t{step}")}),
                2 => json!({"op":"update","id":pick(&mut rng),"title":format!("u{}", rng.u8(..3))}),
                3 => {
                    let status = ["todo", "in_progress", "done"][rng.usize(..3)];
                    json!({"op":"set_status","id":pick(&mut rng),"status":status})
                }
                4 => {
                    let after = if rng.bool() { Value::Null } else { json!(pick(&mut rng)) };
                    json!({"op":"move","id":pick(&mut rng),"after":after})
                }
                _ => json!({"op":"delete","id":pick(&mut rng)}),
            };
            let before = doc.clone();
            let before_value = before.to_value();
            let now = format!("2026-01-01T09:{:02}:{:02}.000Z", step / 60, step % 60);
            match apply_op(&doc, &op, &now, &mut next_id) {
                Ok(r) => {
                    assert_eq!(doc.to_value(), before_value, "input doc was mutated by {op}");
                    assert_eq!(r.doc.rev, before.rev, "apply must not touch rev");
                    let orders: Vec<i64> = r.doc.items.iter().map(|i| i.order).collect();
                    assert_eq!(orders, (0..orders.len() as i64).collect::<Vec<_>>(), "orders 0..n-1 after {op}");
                    let uniq: HashSet<&str> = r.doc.items.iter().map(|i| i.id.as_str()).collect();
                    assert_eq!(uniq.len(), r.doc.items.len(), "unique ids after {op}");
                    if !r.changed {
                        assert_eq!(r.doc.to_value(), before.clone().normalized().to_value(), "unchanged op must leave the doc as-is: {op}");
                    }
                    if op["op"] == "move" && r.changed {
                        let moved = r.doc.items.iter().find(|i| i.id == op["id"].as_str().unwrap()).unwrap();
                        let was = before.items.iter().find(|i| i.id == moved.id).unwrap();
                        assert_eq!(moved.updated_at, was.updated_at);
                    }
                    assert!(r.doc.items.len() <= 1000);
                    doc = r.doc;
                }
                Err(e) => {
                    assert!(matches!(e.code, ErrorCode::NotFound | ErrorCode::InvalidOp), "unexpected {e:?} for {op}");
                    assert_eq!(doc.to_value(), before_value);
                }
            }
        }
    }
}

fn doc_text_with_title(title_escaped: &str) -> String {
    format!(r#"{{"schemaVersion":1,"rev":1,"items":[{{"id":"t1","title":"{title_escaped}","body":"","status":"todo","order":0,"createdAt":"2026-01-01T08:00:00.000Z","updatedAt":"2026-01-01T08:00:00.000Z"}}]}}"#)
}

#[test]
fn lone_surrogate_escapes_written_by_js_are_not_corruption() {
    // JSON.stringify writes a lone surrogate as "\ud83d"; serde_json rejects it, so the parser
    // reads it as U+FFFD instead of calling a valid TS-written file corrupt (which would quarantine it).
    let title = |t: &str| Doc::parse(&doc_text_with_title(t)).expect("not corrupt").items[0].title.clone();
    assert_eq!(title(r"a\ud83d"), "a\u{fffd}");
    assert_eq!(title(r"\ude00b"), "\u{fffd}b");
    assert_eq!(title(r"\ud83dx\ud83d"), "\u{fffd}x\u{fffd}");
    assert_eq!(title(r"\ud83d\ud83d\ude00"), "\u{fffd}\u{1f600}", "lone high followed by a real pair");
    // well-formed pairs and escaped backslashes are left alone
    assert_eq!(title(r"\ud83d\ude00"), "\u{1f600}");
    assert_eq!(title(r"\\ud83d"), "\\ud83d", "an escaped backslash followed by text that looks like an escape");
    assert_eq!(title(r"\u00e9\n"), "\u{e9}\n");
    // still corrupt when it is genuinely broken
    assert_eq!(Doc::parse(&format!("{}x", doc_text_with_title(r"\ud83d"))).err(), Some(ParseError::Corrupt));
}

#[test]
fn a_generated_id_that_collides_is_redrawn_never_dropped_as_a_noop() {
    let d = abc();
    let mut calls = 0;
    let mut gen = || {
        calls += 1;
        if calls < 3 { "a".to_string() } else { "fresh".to_string() }
    };
    let r = apply_op(&d, &json!({"op":"add","title":"x"}), T1, &mut gen).unwrap();
    assert!(r.changed);
    assert_eq!(r.result["item"]["id"], "fresh");
    let mut always = || "b".to_string();
    let e = apply_op(&d, &json!({"op":"add","title":"x"}), T1, &mut always).unwrap_err();
    assert_eq!(e.code, ErrorCode::IoError);
}
