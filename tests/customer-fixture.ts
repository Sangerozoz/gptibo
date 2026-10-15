import { DatabaseSync } from 'node:sqlite'
import { readFileSync,readdirSync } from 'node:fs'
import worker from '../worker/index.ts'
import { hash,randomToken,type Env,type Statement,type Value } from '../worker/platform.ts'
import { totpCode } from '../worker/totp.ts'
import { seedAdminEmailCode } from './admin-email-fixture.ts'

export async function customerFixture() {
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON')
  for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())db.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'))
  const states=new WeakMap<Statement,{sql:string;values:Value[]}>()
  const credential='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
  const env:Env={ADMIN_EMAIL: 'admin@example.invalid', ADMIN_USERNAME:'local-test',ADMIN_TOTP_SECRET:credential,PARTNER_AUTH_SECRET:'local-fixture-only-32-character-secret',ORDER_TESTING_ENABLED:'true',PUBLIC_SITE_ORIGIN:'https://shop.example.invalid',ASSETS:{fetch:async()=>new Response('asset')},INTEREST_LIMITER:{limit:async()=>({success:true})},API_LIMITER:{limit:async()=>({success:true})},EXPENSIVE_LIMITER:{limit:async()=>({success:true})},INTEREST_DB:{
    prepare(sql){const state={sql,values:[] as Value[]};const statement:Statement={bind(...values){state.values=values;return this},async first<T>(){return (db.prepare(sql).get(...state.values)??null) as T|null},async all<T>(){return {results:db.prepare(sql).all(...state.values) as T[]}},async run(){return db.prepare(sql).run(...state.values)}};states.set(statement,state);return statement},
    async batch(statements){db.exec('BEGIN');try{const result=statements.map(s=>{const state=states.get(s)!;const q=db.prepare(state.sql);return /^\s*SELECT\b/i.test(state.sql)?{results:q.all(...state.values)}:q.run(...state.values)});db.exec('COMMIT');return result}catch(e){db.exec('ROLLBACK');throw e}},
  }}
  const request=(path:string,data?:unknown,cookie='',origin='https://shop.example.invalid')=>worker.fetch(new Request('https://shop.example.invalid'+path,{method:data===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:data===undefined?undefined:JSON.stringify(data)}),env)
  const login=await request('/api/admin/login',{username:env.ADMIN_USERNAME,code:await totpCode(credential),...await seedAdminEmailCode(db,env)})
  if(login.status!==200)throw new Error(await login.text())
  const admin=login.headers.get('Set-Cookie')!.split(';')[0]
  async function agent(name:string){const id=crypto.randomUUID();const token=randomToken();const now=Date.now();db.prepare('INSERT INTO partners(id,slug,name,email,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id,id.slice(0,6),name,id+'@example.test',now,now);db.prepare('INSERT INTO partner_sessions(token_hash,partner_id,auth_version,credential_version,expires_at) VALUES (?,?,0,?,?)').run(await hash(token),id,await hash(env.PARTNER_AUTH_SECRET!),now+3600000);return {id,cookie:'__Host-ymx_partner='+token}}
  return {db,env,request,admin,agent}
}
