use super::*;
use crate::providers::{ChatSession, ProviderAdapter, ProviderCapability, ProviderError, TerminalCommand};
use std::sync::atomic::AtomicUsize;

struct Adapter { calls: Arc<AtomicUsize>, partial: bool }
struct Chat { calls: Arc<AtomicUsize>, partial: bool }
impl ProviderAdapter for Adapter {
    fn id(&self) -> &str { "plan-fixture" }
    fn capability(&self) -> ProviderCapability {
        ProviderCapability { source:"test", plugin_id:None, icon:None, sign_in:None, homepage:None, id:self.id().into(), name:"Plan fixture".into(), installed:true, version:None, terminal:false, chat:true, history:false, resume:false, terminal_resume_capture:"none", reason:None, auth:"authenticated".into() }
    }
    fn terminal_command(&self, _:Option<&str>, _:Option<&str>) -> Result<TerminalCommand, ProviderError> { Err(ProviderError::new("unsupported", "no terminal")) }
    fn history_list(&self, _:Option<&str>, _:u32, _:Option<&str>) -> Result<Value, ProviderError> { Ok(json!({"items":[]})) }
    fn history_read(&self, _:&str) -> Result<Value, ProviderError> { Ok(json!([])) }
    fn open_chat(&self, _:&str, _:&str, _:Option<&str>) -> Result<Box<dyn ChatSession>, ProviderError> { Ok(Box::new(Chat { calls:self.calls.clone(), partial:self.partial })) }
}
impl ChatSession for Chat {
    fn native_id(&self) -> Option<String> { Some("native-plan".into()) }
    fn send(&mut self, _:&str, _:&str) -> Result<Value, ProviderError> { Ok(json!({"turnId":"next"})) }
    fn cancel(&mut self, _:&str) -> Result<(), ProviderError> { Ok(()) }
    fn approve(&mut self, _:&str, _:&str, _:&str, _:&str) -> Result<(), ProviderError> { Ok(()) }
    fn stop(&mut self) -> Result<(), ProviderError> { Ok(()) }
    fn plan_response(&mut self, _:&str, _:&str, _:&Value, _:&str) -> Result<Option<String>, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        // Deliberately emit NO event: success must not depend on ingress timing.
        Ok(None)
    }
    fn plan_response_receipt(&self) -> Option<Value> {
        self.partial.then(|| json!({"approvalId":"plan","status":"answered","outcome":"partial","planOutcome":"approved","recovery":"reconnect","message":"Native approval succeeded; mode switch failed."}))
    }
}

struct Fixture { root:tempfile::TempDir, db:Database, providers:Providers, session:String, calls:Arc<AtomicUsize> }
impl Fixture {
    fn new(partial:bool) -> Self {
        let root=tempfile::tempdir().unwrap();
        let db=Database::open(&root.path().join("runtime.sqlite")).unwrap();
        let session=db.create_session(CreateSession { project_id:None, title:None, provider:"plan-fixture", mode:"chat", native_id:None, operation_id:"create" }).unwrap().id;
        let calls=Arc::new(AtomicUsize::new(0));
        let providers=Providers::for_test(vec![Arc::new(Adapter { calls:calls.clone(), partial })]);
        providers.chat_open(&session,"plan-fixture",root.path().to_str().unwrap(),None).unwrap();
        db.record_provider_event(&session,Some("turn"),"message.user",&json!({"text":"Plan"})).unwrap();
        db.record_provider_event(&session,Some("turn"),"chat.approval",&json!({"approvalId":"plan","part":{"data":{"interaction":"plan","plan":"# Plan"}}})).unwrap();
        Self { root, db, providers, session, calls }
    }
    fn answer(&self) -> Result<Value> { answer_chat_request(&self.db,&self.providers,&self.session,"turn","plan",&json!({"action":"approve"}),"answer") }
    fn card(&self) -> Value { self.db.chat_items(&self.session).unwrap().into_iter().flat_map(|item|item.parts).find(|part|part["approvalId"]=="plan").unwrap() }
}

#[test]
fn plan_answer_commits_receipt_before_success_without_waiting_for_provider_events() {
    let fixture=Fixture::new(false);
    fixture.answer().unwrap();
    assert_eq!(fixture.card()["status"],"answered");
    assert_eq!(fixture.card()["data"]["planOutcome"],"approved");
    let reopened=Database::open(&fixture.root.path().join("runtime.sqlite")).unwrap();
    assert_eq!(reopened.operation("answer").unwrap(),Some(Value::Null));
    assert_eq!(reopened.chat_items(&fixture.session).unwrap().into_iter().flat_map(|item|item.parts).find(|part|part["approvalId"]=="plan").unwrap()["status"],"answered");
    fixture.answer().unwrap();
    assert_eq!(fixture.calls.load(Ordering::SeqCst),1);
}

#[test]
fn receipt_and_completed_operation_roll_back_together_at_the_crash_boundary() {
    let fixture=Fixture::new(false);
    fixture.db.transaction(|tx| { tx.execute_batch("CREATE TRIGGER fail_answer BEFORE INSERT ON operations WHEN NEW.id='answer' BEGIN SELECT RAISE(ABORT,'crash boundary'); END;")?; Ok(()) }).unwrap();
    assert!(fixture.answer().is_err());
    assert!(fixture.db.operation("answer").unwrap().is_none());
    assert_eq!(fixture.card()["status"],"pending");
    // The external effect has been attempted; it cannot be automatically replayed.
    assert!(fixture.answer().unwrap_err().to_string().contains("operation_outcome_unknown"));
    assert_eq!(fixture.calls.load(Ordering::SeqCst),1);
    fixture.db.transaction(|tx| { tx.execute_batch("DROP TRIGGER fail_answer;")?; Ok(()) }).unwrap();
    crate::chat_projection::record_answer_receipt(&fixture.db,&fixture.session,"turn","chat.approval.resolved",&json!({"approvalId":"plan","status":"answered","outcome":"submitted","planOutcome":"approved"}),"answer").unwrap();
    assert_eq!(fixture.card()["status"],"answered");
    assert_eq!(fixture.db.operation("answer").unwrap(),Some(Value::Null));
}

#[test]
fn partial_native_plan_receipt_is_durable_nonactionable_and_explains_recovery() {
    let fixture=Fixture::new(true);
    fixture.answer().unwrap();
    let card=fixture.card();
    assert_eq!(card["status"],"answered");
    assert_eq!(card["data"]["outcome"],"partial");
    assert_eq!(card["data"]["recovery"],"reconnect");
    assert!(card["data"]["message"].as_str().unwrap().contains("mode switch failed"));
    fixture.answer().unwrap();
    assert_eq!(fixture.calls.load(Ordering::SeqCst),1);
}
