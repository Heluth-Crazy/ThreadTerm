use super::*;
use crate::db::{CreateSession, Database};

struct HeldWorker { event:ProviderEvent, alive:bool, retired:bool }
impl ChatSession for HeldWorker {
    fn native_id(&self)->Option<String>{Some("native".into())}
    fn is_alive(&self)->bool{self.alive}
    fn send(&mut self,_:&str,_:&str)->Result<Value,ProviderError>{Ok(Value::Null)}
    fn cancel(&mut self,_:&str)->Result<(),ProviderError>{Ok(())}
    fn approve(&mut self,_:&str,_:&str,_:&str,_:&str)->Result<(),ProviderError>{Ok(())}
    fn stop(&mut self)->Result<(),ProviderError>{self.retired=true;Ok(())}
    fn retirement_events(&self)->Vec<ProviderEvent>{vec![self.event.clone()]}
}
struct Adapter;
impl ProviderAdapter for Adapter {
    fn id(&self)->&str{"held-fixture"}
    fn capability(&self)->ProviderCapability{panic!("no probe")}
    fn terminal_command(&self,_:Option<&str>,_:Option<&str>)->Result<TerminalCommand,ProviderError>{panic!("no terminal")}
    fn history_list(&self,_:Option<&str>,_:u32,_:Option<&str>)->Result<Value,ProviderError>{Ok(json!({"items":[]}))}
    fn history_read(&self,_:&str)->Result<Value,ProviderError>{Ok(json!([]))}
    fn open_chat(&self,session:&str,_:&str,_:Option<&str>)->Result<Box<dyn ChatSession>,ProviderError>{Ok(Box::new(HeldWorker{event:held_event(session),alive:true,retired:false}))}
}
fn held_event(session:&str)->ProviderEvent{
    ProviderEvent{provider:"held-fixture".into(),session_id:session.into(),native_id:Some("native".into()),turn_id:Some("turn".into()),kind:"chat.item".into(),data:json!({"item":{"id":"held-plan","type":"plan","text":"# Held plan"}}),worker_token:Some("old-token".into())}
}
#[test]
fn stop_and_reconnect_persist_held_plan_before_invalidating_the_old_token(){
    for path in ["stop","reconnect","poll"] {
        let root=tempfile::tempdir().unwrap();
        let db=Arc::new(Database::open(&root.path().join("runtime.sqlite")).unwrap());
        let session=db.create_session(CreateSession{project_id:None,title:None,provider:"held-fixture",mode:"chat",native_id:None,operation_id:"create"}).unwrap().id;
        let providers=Providers::for_test(vec![Arc::new(Adapter)]);
        let event=held_event(&session);
        let mut slot=ChatSlot::new();
        slot.phase="ready".into();slot.worker_token=Some("old-token".into());slot.requires_scoped_events=true;
        slot.worker=Some(Arc::new(Mutex::new(Box::new(HeldWorker{event:event.clone(),alive:path=="stop",retired:false}))));
        providers.chats.lock().unwrap().insert(session.clone(),slot);
        let persist_db=db.clone();
        providers.set_retirement_projector(Arc::new(move |event|persist_db.record_provider_event(&event.session_id,event.turn_id.as_deref(),&event.kind,&event.data).map_err(|error|ProviderError::new("chat_persistence",error.to_string()))));
        match path {
            "stop"=>providers.chat_stop(&session).unwrap(),
            "reconnect"=>{providers.chat_open(&session,"held-fixture",root.path().to_str().unwrap(),None).unwrap();},
            _=>{providers.chat_connection(&session);},
        }
        let texts:Vec<_>=db.chat_items(&session).unwrap().into_iter().flat_map(|item|item.parts).collect();
        assert_eq!(texts.len(),1,"{path}");assert_eq!(texts[0]["text"],"# Held plan","{path}");
        if path!="poll" {assert!(providers.with_current_event(&event,||panic!("old event survived retirement")).is_none());}
    }
}
#[test]
fn failed_retirement_persistence_leaves_the_original_worker_and_token_available_for_retry(){
    let providers=Providers::for_test(vec![]);
    let mut slot=ChatSlot::new();slot.worker_token=Some("old-token".into());
    slot.worker=Some(Arc::new(Mutex::new(Box::new(HeldWorker{event:held_event("s"),alive:true,retired:false}))));
    providers.chats.lock().unwrap().insert("s".into(),slot);
    providers.set_retirement_projector(Arc::new(|_|Err(ProviderError::new("chat_persistence","injected failure"))));
    assert_eq!(providers.chat_stop("s").unwrap_err().code,"chat_persistence");
    assert_eq!(providers.chats.lock().unwrap()["s"].worker_token.as_deref(),Some("old-token"));
    assert!(providers.chats.lock().unwrap()["s"].worker.is_some());
    providers.set_retirement_projector(Arc::new(|_|Ok(())));
    providers.chat_stop("s").unwrap();
    assert!(providers.chats.lock().unwrap()["s"].worker.is_none());
}
