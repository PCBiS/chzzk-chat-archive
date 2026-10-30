import test, {type TestContext} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,rm,utimes,stat} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {gunzipSync} from "node:zlib";
import {DatabaseSync} from "node:sqlite";
import {ArchiveStore,parseBroadcastTimestamp} from "../src/archive-store";
import {ChatIndex} from "../src/chat-index";

const old=Date.now()-10*86400000;
function content(sessionId="10",openedAt="2026-07-01T12:00:00",recordedAt="2026-07-01T04:00:00Z") {
  return JSON.stringify({schemaVersion:1,recordedAt,messageAt:recordedAt,
    streamer:{channelId:"channel",name:"fixture"},broadcast:{sessionId,openedAt,title:"fixture",kind:"live"},
    user:{id:"user",nickname:"fixture"},message:"원문 😀 Mixed CASE",hidden:false,recent:false,event:"chat",extras:{badges:[1,2]}})+"\n";
}
async function fixture(t:TestContext) {
  const root=await mkdtemp(path.join(os.tmpdir(),"archive-release-"));
  const store=new ArchiveStore(root);await store.init();
  t.after(async()=>{try{store.close();}catch{}await rm(root,{recursive:true,force:true});});
  const put=async(id:string,value=content())=>{await mkdir(path.dirname(path.join(root,id)),{recursive:true});await writeFile(path.join(root,id),value);await utimes(path.join(root,id),old/1000,old/1000);};
  const closed=(id:string)=>store.registerClosed(id,{channelId:"channel",sessionId:"10",successorId:"11",lastRecordAt:old});
  return {root,store,put,closed};
}
test("gzip highest level is lossless and preserves logical identity across restart",async t=>{
  const f=await fixture(t);await f.put("old.jsonl");await f.closed("old.jsonl");
  assert.equal((await f.store.compress("old.jsonl")).compressed,true);
  const ref=await f.store.resolve("old.jsonl"),packed=await readFile(ref.physicalPath);
  assert.equal(packed[8],2);assert.equal(gunzipSync(packed).toString(),content());
  f.store.close();const reopened=new ArchiveStore(f.root);await reopened.init();await reopened.recover();
  assert.equal((await reopened.resolve("old.jsonl")).encoding,"gzip");reopened.close();
});
for(const phase of ["after_tmp","after_publish","after_commit","after_unlink"]){
  test(`compression recovery preserves bytes and is repeatable at ${phase}`,async t=>{
    const f=await fixture(t);await f.put("old.jsonl");await f.closed("old.jsonl");
    await assert.rejects(f.store.compress("old.jsonl",Date.now(),phase));
    await f.store.recover();await f.store.recover();
    const ref=await f.store.resolve("old.jsonl");const bytes=await readFile(ref.physicalPath);
    assert.equal((ref.encoding==="gzip"?gunzipSync(bytes):bytes).toString(),content());
  });
}
test("recent writes, active paths, same session and conflicting gzip cannot be compressed",async t=>{
  const f=await fixture(t);await f.put("active.jsonl");await f.store.registerActive("active.jsonl");
  assert.equal((await f.store.compress("active.jsonl")).compressed,false);
  await f.put("recent.jsonl");await utimes(path.join(f.root,"recent.jsonl"),new Date(),new Date());await f.closed("recent.jsonl");
  assert.equal((await f.store.compress("recent.jsonl")).compressed,false);
  await assert.rejects(f.store.registerClosed("active.jsonl",{channelId:"channel",sessionId:"1",successorId:"1",lastRecordAt:old}));
  await f.put("conflict.jsonl");await f.closed("conflict.jsonl");await writeFile(path.join(f.root,"conflict.jsonl.gz"),"preserve");
  await assert.rejects(f.store.compress("conflict.jsonl"));assert.equal(await readFile(path.join(f.root,"conflict.jsonl.gz"),"utf8"),"preserve");
  assert.equal(await readFile(path.join(f.root,"conflict.jsonl"),"utf8"),content());
});
test("confirmed successor seals consistent legacy archives and restores active ownership",async t=>{
  const f=await fixture(t);await f.put("legacy.jsonl");await f.put("active.jsonl");
  await f.store.registerActive("active.jsonl",{channelId:"channel",sessionId:"10",openedAt:"2026-07-01T12:00:00"});
  await f.put("same.jsonl",content("11","2026-07-02T12:00:00","2026-07-02T04:00:00Z"));
  await f.put("partial.jsonl",content().trimEnd());
  const sealed=await f.store.sealPriorCycles({channelId:"channel",sessionId:"11",openedAt:"2026-07-02T12:00:00"});
  assert.deepEqual(sealed.sort(),["active.jsonl","legacy.jsonl"]);
  assert.equal(f.store.getState("same.jsonl"),undefined);assert.equal(f.store.getState("partial.jsonl"),undefined);
  assert.equal((await f.store.compress("legacy.jsonl")).compressed,true);
  await assert.rejects(f.store.registerActive("active.jsonl"));
  assert.deepEqual(await f.store.sealPriorCycles({channelId:"channel",sessionId:"9",openedAt:"2026-06-01T12:00:00"}),[]);
});
test("Korean timestamps are independent of host timezone and invalid dates stay invalid",()=>{
  assert.equal(parseBroadcastTimestamp("2026-07-01T12:00:00"),Date.parse("2026-07-01T03:00:00Z"));
  assert.equal(parseBroadcastTimestamp("2026-07-01 12:00:00"),Date.parse("2026-07-01T03:00:00Z"));
  assert.ok(Number.isNaN(parseBroadcastTimestamp("invalid")));
});
test("manual legacy deletion checks current collector ownership under the same lock",async t=>{
  const f=await fixture(t);await f.put("legacy.jsonl");await assert.rejects(f.store.remove("legacy.jsonl",()=>true));
  assert.equal(await readFile(path.join(f.root,"legacy.jsonl"),"utf8"),content());
  await f.store.remove("legacy.jsonl",()=>false);assert.equal(f.store.getState("legacy.jsonl")?.state,"DELETED");
});
test("failed compressed rebuild leaves the live index unchanged",async t=>{
  const f=await fixture(t);await f.put("old.jsonl");const index=await ChatIndex.open(f.root,f.store);
  t.after(()=>index.close());const expected=await index.analyze("old.jsonl",{offset:0,limit:200});
  await f.closed("old.jsonl");await f.store.compress("old.jsonl");
  const ref=await f.store.resolve("old.jsonl"),packed=await readFile(ref.physicalPath);
  packed[packed.length-5]^=0xff;await writeFile(ref.physicalPath,packed);
  // Simulate late storage corruption after a stat-level identity check.
  const meta=f.store.getState("old.jsonl")!,info=await stat(ref.physicalPath);
  meta.generation={dev:info.dev,ino:info.ino,size:info.size,mtimeMs:info.mtimeMs};
  const db=new DatabaseSync(path.join(f.root,".chzzk-archive/state.sqlite"));
  db.prepare("UPDATE archives SET metadata=? WHERE id=?").run(JSON.stringify(meta),"old.jsonl");db.close();
  await assert.rejects(index.syncFile("old.jsonl",true));
  assert.deepEqual(await index.analyze("old.jsonl",{offset:0,limit:200}),expected);
});
