import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const generated=new Set(['.git','node_modules','coverage','dist','build','.cache','.tmp','tmp','.nyc_output','__pycache__','.pytest_cache']);
const allowed=new Set([
  '.gitignore','.gitattributes','.github','bin','embedded-skills',
  'lib','test','README.md','SECURITY.md','package.json'
]);
async function filesUnder(directory){
  const files=[];
  for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    if(entry.isDirectory()&&generated.has(entry.name))continue;
    const full=path.join(directory,entry.name);
    assert.equal(entry.isSymbolicLink(),false,'symlinks must not enter public sources: '+full);
    if(entry.isDirectory())files.push(...await filesUnder(full));
    else files.push(full);
  }
  return files;
}
test('public repository has a closed source tree without local runtime artifacts',async()=>{
  for(const entry of await fs.readdir(root,{withFileTypes:true})){
    if(generated.has(entry.name))continue;
    assert.ok(allowed.has(entry.name),'unreviewed top-level release entry: '+entry.name);
  }
  for(const file of await filesUnder(root)){
    if(file.includes(path.sep+'.git'+path.sep))continue;
    const rel=path.relative(root,file).replaceAll('\\','/');
    assert.doesNotMatch(rel,/(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|credentials(?:\..*)?|secrets(?:\..*)?|id_rsa.*|id_ed25519.*|state|node_modules)(?:\/|$)/i);
    assert.doesNotMatch(rel,/\.(?:db|sqlite|pem|p12|pfx|key|snapshot|bak|log|tgz|zip)$/i);
  }
});
test('public release excludes local identity and uses an explicit package allowlist',async()=>{
  const manifest=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  assert.equal(manifest.private,true,'no accidental npm publication');
  assert.equal(manifest.license,'UNLICENSED','license choice remains explicit');
  assert.deepEqual(manifest.files,['lib/','bin/','embedded-skills/','README.md','SECURITY.md']);
  const home=os.homedir();
  const user=path.basename(home);
  for(const dir of ['lib','bin','test','embedded-skills']){
    for(const file of await filesUnder(path.join(root,dir))){
      const content=await fs.readFile(file,'utf8');
      assert.ok(!content.includes(home)&&!content.includes(home.replaceAll('\\','\\\\')),
        'absolute user home path exposed: '+path.relative(root,file));
      if(user.length>=5&&!['root','runner','ubuntu'].includes(user.toLowerCase()))
        assert.ok(!content.includes(user),'local account name exposed: '+path.relative(root,file));
    }
  }
});
