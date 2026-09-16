import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createAuthenticatedRuntime} from '../src/runtime.mjs';
import {createMoodleChangefeedMcpServer} from '../src/mcp/server.mjs';
import {loadPublicConfig} from '../src/config.mjs';
import {saveVerifiedProfile} from '../src/auth/profiles.mjs';
import {resolveEntryConfig} from '../src/entry-config.mjs';
import {parseCli} from '../src/cli/parse.mjs';
import {login} from '../src/cli/login.mjs';
import {REQUIRED_FUNCTIONS} from '../src/adapters/moodle-mobile/index.mjs';

const siteUrl = 'https://school.example.edu/moodle';
const bytes = Buffer.from('Example lecture notes');
function fakeMoodle(userId = 17) {
  return async (url, options) => {
    if (String(url).includes('/webservice/pluginfile.php/')) return new Response(bytes, {headers: {'content-type':'text/plain'}});
    const fn = options.body.get('wsfunction');
    const data = {
      core_webservice_get_site_info: {userid:userId, functions:REQUIRED_FUNCTIONS.map(name => ({name}))},
      core_enrol_get_users_courses: [{id:42,shortname:'MATH42',fullname:'Example Mathematics'}],
      core_course_get_contents: [{modules:[{contents:[{type:'file',filename:'notes.txt', filesize:bytes.length, mimetype:'text/plain',fileurl:siteUrl+'/webservice/pluginfile.php/42/mod_resource/content/1/notes.txt'}]}]}],
      mod_assign_get_assignments: {courses:[{id:42,assignments:[{id:7,name:'Homework',intro:'<p>Read chapter 1</p>'}]}]},
      mod_forum_get_forums_by_courses: []
    }[fn];
    assert.notEqual(data,undefined, 'Unexpected service '+fn);
    return Response.json(data);
  };
}
const credentials = {siteKey:siteUrl, async getWebServiceToken(){return 'synthetic-token';}, async getIcsUrl(){return null;}};

test('fresh account MCP workflow reads baseline materials and verified bytes end to end', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'moodle-entry-'));
  const config = loadPublicConfig({env:{MOODLE_CHANGEFEED_SITE_URL:siteUrl,MOODLE_CHANGEFEED_DATA_DIR:root}});
  const createRuntime = () => createAuthenticatedRuntime(config, {credentialProvider:credentials,fetchImpl:fakeMoodle()});
  const server = createMoodleChangefeedMcpServer({publicConfig:config, createRuntime, probeEntry:async()=>({canScan:true,status:'compatible'})});
  const client = new Client({name:'portable-test',version:'1'});
  const [a,b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  const call = async(name,args={})=> {
    const result=await client.callTool({name,arguments:args});
    assert.notEqual(result.isError,true,JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  try {
    await call('agent_bootstrap');
    assert.equal((await call('list_moodle_courses')).items.length,1);
    assert.equal((await call('scan_moodle_changes')).baselineCreated,true);
    assert.equal((await call('get_moodle_change_feed')).items.length,0);
    const library=await call('search_moodle_library',{query:'notes'});
    assert.equal(library.items.length,1);
    const item=await call('get_moodle_library_item',{objectId:library.items[0].objectId});
    const resourceId=item.resources[0].resourceId;
    assert.equal((await call('read_moodle_resource',{resourceId})).status,'not_cached');
    assert.equal((await call('cache_moodle_resources',{resourceIds:[resourceId]})).items[0].status,'cached');
    const file=await call('read_moodle_resource',{resourceId,includeText:true});
    assert.equal(file.text,bytes.toString());
    assert.deepEqual(await readFile(file.absolutePath),bytes);
    assert.equal((await call('search_moodle_library')).freshness.lastScanComplete,true);
  } finally {await client.close();await server.close();await rm(root,{recursive:true,force:true});}
});

test('same base directory isolates accounts and rejects changed profile identities', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'moodle-identities-'));
  const config=loadPublicConfig({env:{MOODLE_CHANGEFEED_SITE_URL:siteUrl,MOODLE_CHANGEFEED_DATA_DIR:root}});
  const runtimes=[];
  try {
    for(const id of [17,18]) runtimes.push(await createAuthenticatedRuntime(config,{credentialProvider:credentials,fetchImpl:fakeMoodle(id)}));
    assert.notEqual(runtimes[0].config.dataDir,runtimes[1].config.dataDir);
    await runtimes[0].service.scan();
    assert.equal(runtimes[1].library.list().total,0);
    await assert.rejects(createAuthenticatedRuntime({...config,userId:17},{credentialProvider:credentials,fetchImpl:fakeMoodle(18)}), /account changed/);
  } finally {runtimes.forEach(r=>r.close());await rm(root,{recursive:true,force:true});}
});

test('profile entry preserves custom roots and rejects cross-site and mixed credentials', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'moodle-profile-entry-'));
  const profileRoot=path.join(root,'profiles');
  try {
    saveVerifiedProfile({name:'school',siteUrl,userId:17,token:'synthetic-token',profileRoot});
    const env={MOODLE_CHANGEFEED_PROFILE_ROOT:profileRoot,MOODLE_CHANGEFEED_DATA_DIR:path.join(root,'data'),MOODLE_CHANGEFEED_ARCHIVE_ROOT:path.join(root,'archive')};
    const resolved=await resolveEntryConfig({argv:['--profile','school'],env});
    assert.ok(resolved.publicConfig.dataDir.startsWith(path.join(root,'data')));
    assert.ok(resolved.publicConfig.archiveRoot.startsWith(path.join(root,'archive')));
    assert.doesNotMatch(JSON.stringify(resolved),/synthetic-token/);
    const runtime=await createAuthenticatedRuntime(resolved.publicConfig,{credentialProvider:resolved.credentialProvider,fetchImpl:fakeMoodle()});runtime.close();
    await assert.rejects(resolveEntryConfig({argv:['--profile','school','--site-url','https://other.example.edu'],env}),/site does not match/);
    await assert.rejects(resolveEntryConfig({argv:['--profile','school'],env:{...env,MOODLE_CHANGEFEED_TOKEN:'unbound'}}),/mix/);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('CLI zero offset matches MCP and login never prompts an agent pipe', async () => {
  assert.equal(parseCli(['library','--offset','0']).input.offset,0);
  assert.throws(()=>parseCli(['courses','--type','resource']),/Unknown option/);
  await assert.rejects(login({config:{profile:'school',siteUrl},input:{isTTY:false},output:{isTTY:false}}),/interactive terminal/);
});

test('login saves only after online verification and returns no token', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'moodle-login-'));
  try {
    const result=await login({config:{profile:'school',siteUrl},method:'token',env:{MOODLE_CHANGEFEED_PROFILE_ROOT:root},input:{isTTY:true},output:{isTTY:true,write(){}},readToken:async()=> 'a'.repeat(32),fetchImpl:fakeMoodle()});
    assert.equal(result.connected,true);assert.doesNotMatch(JSON.stringify(result), /a{32}/);
    await assert.rejects(login({config:{profile:'school',siteUrl},method:'token',env:{MOODLE_CHANGEFEED_PROFILE_ROOT:root},input:{isTTY:true},output:{isTTY:true,write(){}},readToken:async()=> 'b'.repeat(32),fetchImpl:async()=>Response.json({exception:'moodle_exception',errorcode:'invalidtoken'})}),/not saved/);
  } finally {await rm(root,{recursive:true,force:true});}
});


test('optional source failures still expose observed files on a new account', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'moodle-partial-'));
  const config=loadPublicConfig({env:{MOODLE_CHANGEFEED_SITE_URL:siteUrl,MOODLE_CHANGEFEED_DATA_DIR:root}});
  const normal=fakeMoodle();
  const fetchImpl=async(url,options)=>options.body?.get('wsfunction')==='mod_assign_get_assignments'
    ? Response.json({exception:'moodle_exception',errorcode:'wsfunctionnotavailable'}) : normal(url,options);
  const runtime=await createAuthenticatedRuntime(config,{credentialProvider:credentials,fetchImpl});
  try {
    const scan=await runtime.service.scan();
    assert.equal(scan.scanComplete,false);
    assert.equal(runtime.store.getCurrentObjects().length,0);
    const files=runtime.library.list({type:'resource'}).items;
    assert.equal(files.length,1);
    assert.equal(files[0].observation.scanComplete,false);
    const resourceId=files[0].resources[0].resourceId;
    assert.equal((await runtime.service.cacheResources({resourceIds:[resourceId]})).items[0].status,'cached');
    assert.equal((await runtime.library.readResource({resourceId,includeText:true})).text,bytes.toString());
  } finally {runtime.close();await rm(root,{recursive:true,force:true});}
});
